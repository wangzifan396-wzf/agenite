// The agent loop: call the model, and if it requests tools, execute them and
// feed results back, repeating until the model produces a final answer.
// Pure: callModel and executeTool are injected, so the loop is fully testable.
//
// messages: mutable array of internal message objects (OpenAI-ish shape).
// callModel(messages, { onDelta }) -> Promise<{ content, toolCalls, usage }>
// toolContext: extra opts handed to executeTool (workspace, approval hook, ...)
// onEvent(type, payload):
//   'delta'      (text chunk, for streaming UI)
//   'assistant'  (full assistant message object)
//   'tool_start' ({ id, name, args })
//   'tool'       ({ id, name, args, result, ok, ms, diff, undoToken })
//   'compact'    ({ before, after, dropped, trimmed })  history was shrunk
//   'usage'      ({ turn, prompt, completion, total })  one API call's usage
//   'done'       ({ usage, cost, stopped, turns, canContinue })

import { compactMessages, contextWindowFor, historyBudget, toolsTokens, totalTokens } from './context.js';
import { addUsage, costOf, emptyUsage, priceFor } from './pricing.js';

export const DEFAULT_MAX_TURNS = 20;

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
      const r = await callModel(messages, { onDelta: (t) => onEvent('delta', t) });
      if (r.usage) { addUsage(usage, r.usage); onEvent('usage', { turn: turn + 1, ...usage, cost: costOf(usage, price) }); }
      const finalMsg = { role: 'assistant', content: r.content || '' };
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

    const { content, toolCalls, usage: turnUsage } = await callModel(messages, {
      onDelta: (t) => onEvent('delta', t)
    });

    if (turnUsage) {
      addUsage(usage, turnUsage);
      onEvent('usage', { turn: turn + 1, ...usage, cost: costOf(usage, price) });
    }

    const assistantMsg = { role: 'assistant', content: content || '' };
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

    for (const tc of toolCalls) {
      onEvent('tool_start', { id: tc.id, name: tc.name, args: tc.args || {} });
      const started = Date.now();
      const res = await executeTool(tc.name, tc.args || {}, opts);
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
        ms: Date.now() - started
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
