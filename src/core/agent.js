// The agent loop: call the model, and if it requests tools, execute them and
// feed results back, repeating until the model produces a final answer.
// Pure: callModel and executeTool are injected, so the loop is fully testable.
//
// messages: mutable array of internal message objects (OpenAI-ish shape).
// callModel(messages, { onDelta }) -> Promise<{ content, toolCalls, usage }>
// toolContext: extra opts handed to executeTool (workspace, approval hook, ...)
// onEvent(type, payload):
//   'delta'      (text chunk, for streaming UI)
//   'reasoning'  (chain-of-thought chunk, for reasoning models)
//   'assistant'  (full assistant message object)
//   'tool_start' ({ id, name, args })
//   'tool'       ({ id, name, args, result, ok, ms, diff, undoToken })
//   'compact'    ({ before, after, dropped, trimmed })  history was shrunk
//   'todo'       ({ items, progress, updates })  live task checklist changed
//   'usage'      ({ turn, prompt, completion, total })  one API call's usage
//   'done'       ({ usage, cost, stopped, turns, canContinue })

import { compactMessages, contextWindowFor, historyBudget, toolsTokens, totalTokens } from './context.js';
import { addUsage, costOf, emptyUsage, priceFor } from './pricing.js';
import { todoProgress, todoReminder } from './todo.js';

export const DEFAULT_MAX_TURNS = 20;

// Tools safe to execute concurrently within one turn. These are stateless and
// touch no shared mutable resource (no file writes, no singleton browser, no
// atlas/memory stores), so running several at once is always sound. Everything
// else — mutating tools, browser_* (share one page), atlas and memory writes —
// runs sequentially to keep approvals sane and avoid races.
export const PARALLEL_SAFE_TOOLS = new Set([
  'calculator', 'current_datetime', 'system_info',
  'web_fetch', 'web_search',
  'read_file', 'list_dir', 'find_files', 'grep_files', 'codebase_search',
  'memory_recall'
]);

export async function runAgent({
  messages,
  callModel,
  executeTool,
  onEvent = () => {},
  config = {},
  toolContext = {},
  maxTurns,
  tools = [],
  summarize = null
}) {
  const opts = {
    dangerTools: config.dangerTools,
    approvalMode: config.approvalMode,
    workspace: config.workspace,
    allowOutsideWorkspace: config.allowOutsideWorkspace,
    toolAllowlist: config.toolAllowlist,
    autoApproveReadonly: config.mcpAutoApproveReadonly,
    ...toolContext
  };

  const limit = clampTurns(maxTurns != null ? maxTurns : config.maxTurns);
  const price = priceFor(config.model, config);
  const usage = emptyUsage();

  // Budget is computed once: the tool list and the reply reservation do not
  // change during a run.
  const budget = historyBudget({
    contextWindow: config.contextWindow || contextWindowFor(config.model),
    maxTokens: config.maxTokens,
    toolTokens: toolsTokens(tools)
  });
  const autoCompact = config.autoCompact !== false;

  // Live task checklist (todo_write). The state object is owned by the caller
  // (one per conversation) so the list survives across turns and across
  // requests. Keeping it in front of the model every turn is what stops a long
  // run from quietly forgetting what it set out to do; `turnsSinceTodo` lets us
  // poke it when the list goes stale relative to what it's actually doing.
  const todo = (opts.todoState && typeof opts.todoState === 'object') ? opts.todoState : null;
  const todoNagEnabled = config.todoReminders !== false;
  let turnsSinceTodo = 0;

  // Cost guardrail (interactive budget): when cumulative spend crosses the cap,
  // stop the agent gracefully — inject a "stop and summarize" instruction and
  // let the model produce one final answer instead of silently burning budget
  // in a loop. Goals carry their own rails (goals.js); this only guards the
  // interactive chat turn. Off when maxCostUSD <= 0.
  const guardCost = (config.budget && Number(config.budget.maxCostUSD) > 0)
    ? Number(config.budget.maxCostUSD) : 0;
  let guardNoted = false;

  let turn = 0;
  for (; turn < limit; turn++) {
    // ── Budget guardrail ──
    // Check AFTER each turn's spend has been folded into `usage`. The first
    // iteration always runs (usage is still empty then), so we never abort
    // before the model has spoken at least once.
    const spend = costOf(usage, price).amount;
    if (guardCost && spend >= guardCost) {
      if (!guardNoted) {
        guardNoted = true;
        const c = costOf(usage, price);
        const sym = c.currency === 'USD' ? '$' : '¥';
        onEvent('guardrail', { reason: 'cost', cost: c.amount, max: guardCost, currency: c.currency || 'CNY' });
        messages.push({
          role: 'system',
          content:
            `⚠️ 预算护栏触发：本轮已花费约 ${sym}${c.amount.toFixed(4)}，已达上限 ${sym}${guardCost.toFixed(2)}。` +
            `请立即停止任何新的工具调用，并输出最终总结（做了什么、改了哪些文件、遗留问题）。`
        });
      }
      // One final summary turn. We ignore any tool_calls it returns — the
      // instruction above already told the model to stop; if it still asks for
      // tools we end the run anyway rather than keep spending.
      const r = await callModel(messages, { onDelta: (t) => onEvent('delta', t), onReasoning: (t) => onEvent('reasoning', t) });
      if (r.usage) { addUsage(usage, r.usage); onEvent('usage', { turn: turn + 1, ...usage, cost: costOf(usage, price) }); }
      const finalMsg = { role: 'assistant', content: r.content || '' };
      if (r.reasoning) finalMsg.reasoning = r.reasoning;
      messages.push(finalMsg);
      onEvent('assistant', finalMsg);
      const payload = finish('guardrail', turn + 1, usage, price, limit);
      onEvent('done', payload);
      return { messages, ...payload };
    }

    if (autoCompact) {
      const before = totalTokens(messages);
      if (before > budget) {
        const r = await compactMessages(messages, {
          budget,
          keepRecentGroups: 3,
          toolTrimTo: 1200,
          summarize: config.smartCompact === false ? null : summarize
        });
        if (r.compacted) {
          messages.length = 0;
          for (const m of r.messages) messages.push(m);
          onEvent('compact', {
            before: r.before, after: r.after, dropped: r.droppedGroups, trimmed: r.trimmed, budget
          });
        }
      }
    }

    // ── Ephemeral checklist reminder ──
    // Injected right before the call and pulled back out right after, so the
    // model always sees the *current* list without history filling up with
    // stale copies of it (and without polluting what we persist/compact).
    let reminder = '';
    if (todo && todoNagEnabled) {
      reminder = todoReminder(todo, { turn, turnsSinceTodo });
      if (reminder) messages.push({ role: 'system', content: reminder });
    }

    let reasoningAcc = '';
    let modelResult;
    try {
      modelResult = await callModel(messages, {
        onDelta: (t) => onEvent('delta', t),
        onReasoning: (t) => { reasoningAcc += t; onEvent('reasoning', t); }
      });
    } finally {
      if (reminder) {
        const last = messages.length - 1;
        if (last >= 0 && messages[last].role === 'system' && messages[last].content === reminder) {
          messages.splice(last, 1);
        }
      }
    }
    const { content, toolCalls, usage: turnUsage } = modelResult;

    if (turnUsage) {
      addUsage(usage, turnUsage);
      onEvent('usage', { turn: turn + 1, ...usage, cost: costOf(usage, price) });
    }

    const assistantMsg = { role: 'assistant', content: content || '' };
    if (reasoningAcc) assistantMsg.reasoning = reasoningAcc;
    if (toolCalls && toolCalls.length) {
      assistantMsg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) }
      }));
    }
    messages.push(assistantMsg);
    onEvent('assistant', assistantMsg);

    if (!toolCalls || !toolCalls.length) {
      const payload = finish('done', turn + 1, usage, price, limit);
      onEvent('done', payload);
      return { messages, ...payload };
    }

    // ── Tool execution: parallelize read-only tools, serialize the rest ──
    // Competitive agents (Claude Code, Goose) run independent tool calls of the
    // same turn concurrently. We parallelize only the stateless read-only set
    // (read 5 files / search web + code at once) for a real speedup with zero
    // correctness risk, and keep mutating + stateful tools one-at-a-time so the
    // approval UI stays sane and file/state races can't happen. Result-message
    // order is preserved exactly (indexed by the original tool_call position).
    const parallelEnabled = config.parallelTools !== false;
    const safeIdx = [];
    const serialIdx = [];
    toolCalls.forEach((tc, i) => {
      (parallelEnabled && PARALLEL_SAFE_TOOLS.has(tc.name) ? safeIdx : serialIdx).push(i);
    });

    const toolResults = new Array(toolCalls.length);
    async function runOneTool(i) {
      const tc = toolCalls[i];
      onEvent('tool_start', { id: tc.id, name: tc.name, args: tc.args || {} });
      const started = Date.now();
      const res = await executeTool(tc.name, tc.args || {}, opts);
      toolResults[i] = { tc, res, ms: Date.now() - started };
    }

    // Read-only tools fire off together; the harness resolves each as it lands.
    await Promise.all(safeIdx.map((i) => runOneTool(i)));
    // Stateful / mutating tools run in order, so approvals never pile up.
    for (const i of serialIdx) await runOneTool(i);

    let todoTouched = false;
    for (let i = 0; i < toolCalls.length; i++) {
      const r = toolResults[i];
      if (!r) continue;
      const { tc, res, ms } = r;
      if (tc.name === 'todo_write' && res.ok && todo) {
        todoTouched = true;
        onEvent('todo', {
          items: (todo.items || []).map((t) => ({ ...t })),
          progress: todoProgress(todo.items || []),
          updates: Number(todo.updates) || 0
        });
      }
      const isParallel = parallelEnabled && PARALLEL_SAFE_TOOLS.has(tc.name);
      onEvent('tool', {
        id: tc.id,
        name: tc.name,
        args: tc.args,
        result: res.ok ? res.content : res.error,
        ok: res.ok,
        errorClass: res.errorClass || null,
        ref: res.ref || null,
        diff: res.diff,
        undoToken: res.undoToken,
        ms,
        parallel: isParallel
      });
      // Prefix failures with a structured error class so the model can
      // self-correct: SCHEMA_ERROR → fix args, PERMISSION_DENIED → ask the
      // user, TRANSIENT → it already retried. Plain "Error: ..." hides this.
      const toolContent = res.ok
        ? res.content
        : `Error [${res.errorClass || 'UNKNOWN'}]: ${res.error}`;
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: toolContent
      });
    }
    turnsSinceTodo = todoTouched ? 0 : turnsSinceTodo + 1;
  }

  // Hit the ceiling with tools still pending. Say so out loud — silently
  // truncating a half-finished task is the worst possible failure mode.
  const payload = finish('max_turns', limit, usage, price, limit);
  onEvent('done', payload);
  return { messages, ...payload };
}

function finish(stopped, turns, usage, price, limit) {
  return {
    stopped,
    turns,
    usage: { ...usage },
    cost: costOf(usage, price),
    limit,
    canContinue: stopped === 'max_turns'
  };
}

export function clampTurns(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_MAX_TURNS;
  return Math.min(100, Math.max(1, Math.floor(n)));
}
