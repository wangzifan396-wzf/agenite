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
//   'shrink'     ({ tool, handle, kind, method, before, after, savedTokens })
//                a single oversized tool result was compressed on the way in
//   'todo'       ({ items, progress, updates })  live task checklist changed
//   'usage'      ({ turn, prompt, completion, total })  one API call's usage
//   'done'       ({ usage, cost, stopped, turns, canContinue })

import { compressBudget, compressContent, retrieveHint } from './compress.js';
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
  'memory_recall', 'context_retrieve'
]);

// Results we never shrink. `context_retrieve` is the escape hatch out of
// compression — compressing its output would be a loop with no exit. The rest
// are short, structured, and load-bearing: a truncated todo echo or plan would
// make the model think its own state was corrupted.
const NEVER_COMPRESS = new Set(['context_retrieve', 'todo_write', 'plan', 'verify', 'git']);

// Tools that can change the workspace on disk (or run commands that do). The
// git safety net commits after any turn where one of these *succeeded*, and the
// self-healing loop watches these for repeated failures. `git` itself is
// excluded — we never try to commit the commits it makes.
export const MUTATION_TOOLS = new Set([
  'write_file', 'edit_file', 'make_dir', 'apply_patch', 'run_command', 'run_code'
]);

/**
 * Which files a turn actually rewrote. The syntax-level verifier only needs to
 * look at these, which is what keeps "verify after every edit" cheap enough to
 * leave on by default — we never re-scan the whole tree.
 * `make_dir` creates no parseable file, and run_command/run_code touch unknown
 * paths, so they contribute nothing here (at 'full' level they still trigger
 * the project's own test command).
 */
export function changedPathsFrom(toolCalls = [], toolResults = []) {
  const out = [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const r = toolResults[i];
    if (!tc || !r || !r.res || !r.res.ok) continue;
    const a = tc.args || {};
    if (tc.name === 'write_file' || tc.name === 'edit_file') {
      if (typeof a.path === 'string' && a.path.trim()) out.push(a.path.trim());
    } else if (tc.name === 'apply_patch') {
      const re = /^\+\+\+ (?:b\/)?(.+)$/gm;
      let m;
      while ((m = re.exec(String(a.patch || better(r)))) !== null) {
        const p = m[1].trim();
        if (p && p !== '/dev/null') out.push(p);
      }
    }
  }
  return [...new Set(out)];
}

// apply_patch results echo the patch when the model streamed it oddly; fall
// back to the result text so we still learn which files moved.
function better(r) {
  return (r && r.res && typeof r.res.content === 'string') ? r.res.content : '';
}

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
  // Self-healing reflection budget: how many bounded nudges we've injected for
  // stuck mutating tools this run (capped by config.maxReflections).
  let reflections = 0;
  // Verification loop budget: how many times we've handed a failing check back
  // to the model to fix (capped by config.maxVerifyFixes). `verifyGaveUp` makes
  // the "stop and tell the user" message fire exactly once.
  let verifyFixes = 0;
  let verifyGaveUp = false;

  // ── Context economy ──
  // Shrink oversized tool output on the way into the history instead of waiting
  // for the window to overflow. autoCompact fixes the symptom once per run and
  // charges you for every wasted token until then; this fixes the cause on the
  // very first turn, and every later turn stops re-sending the bloat.
  //
  // The hard invariant: we only compress when a ContextStore is present, so a
  // compressed result is *always* retrievable in full via context_retrieve.
  // Without that guarantee this would just be truncation with better PR.
  const store = opts.contextStore && typeof opts.contextStore.put === 'function' ? opts.contextStore : null;
  const compressMode = config.contextCompress || 'smart';
  const compressOn = store && compressMode !== 'off';
  const cbudget = compressBudget(compressMode, config.compressThreshold);
  const shrinkStats = { count: 0, savedTokens: 0, savedChars: 0 };

  function shrinkToolResult(tc, content, res) {
    if (!compressOn) return content;
    if (typeof content !== 'string' || content.length <= cbudget.threshold) return content;
    if (NEVER_COMPRESS.has(tc.name)) return content;
    // A failed call's text is an error message; it is short, and every word of
    // it is the thing the model needs to recover. Never touch it.
    if (res && res.ok === false) return content;

    const a = tc.args || {};
    const info = compressContent(content, {
      name: tc.name,
      path: typeof a.path === 'string' ? a.path : '',
      // Give the code outliner something to aim at: what the model was
      // actually looking for is far more useful than the first 40 lines.
      query: String(a.query || a.pattern || a.q || ''),
      target: cbudget.target
    });
    if (!info.saved || info.savedTokens <= 0) return content;

    const handle = store.put(content, { tool: tc.name, args: a, at: Date.now() });
    const out = info.text + retrieveHint(handle, info);
    // Guard against the pathological case where the hint costs more than the
    // compression saved (a result barely over the threshold).
    if (out.length >= content.length) { store.drop(handle); return content; }

    shrinkStats.count++;
    shrinkStats.savedTokens += info.savedTokens;
    shrinkStats.savedChars += info.saved;
    onEvent('shrink', {
      tool: tc.name,
      handle,
      kind: info.kind,
      method: info.method,
      before: info.before,
      after: info.after,
      savedTokens: info.savedTokens,
      totalSavedTokens: shrinkStats.savedTokens
    });
    return out;
  }

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
      const payload = finish('guardrail', turn + 1, usage, price, limit, shrinkStats);
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
      const payload = finish('done', turn + 1, usage, price, limit, shrinkStats);
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
      const rawContent = res.ok
        ? res.content
        : `Error [${res.errorClass || 'UNKNOWN'}]: ${res.error}`;
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: shrinkToolResult(tc, rawContent, res)
      });
    }

    // ── Self-healing reflection (Loop Engineering, 2026) ──
    // When a mutating tool failed this turn, nudge the model with a bounded
    // user-side reflection so it re-reads live state and stops repeating a
    // broken edit. Mirrors Aider's edit→validate→reflect→retry, capped by
    // maxReflections so a hopeless edit can't loop forever (the Codex "same
    // fix again" failure mode the 2026 reviews call out).
    let failedMutation = 0;
    let succeededMutation = 0;
    const failedNames = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const r = toolResults[i];
      if (!r || !MUTATION_TOOLS.has(toolCalls[i].name)) continue;
      if (r.res.ok) succeededMutation++;
      else { failedMutation++; failedNames.push(toolCalls[i].name); }
    }
    if (failedMutation > 0 && config.selfHeal !== false) {
      const cap = Number.isFinite(Number(config.maxReflections)) ? Number(config.maxReflections) : 3;
      if (reflections < cap) {
        reflections++;
        messages.push({
          role: 'user',
          content:
            `⚠️ 自检提醒（第 ${reflections}/${cap} 次）：本回合有工具调用未成功（${failedNames.join('、')}）。` +
            '请先重新读取相关文件确认其【当前】内容，再核对参数后重试——不要原样重复刚才失败的调用。' +
            '若连续多次失败，停下来向用户说明卡点，而不是继续盲试。'
        });
      }
    }

    // ── Auto git checkpoint (Aider-style safety net) ──
    // After any turn that actually changed files, hand off to the harness so it
    // snapshots the workspace. The user can then `git undo` a bad edit. Best
    // effort: a git failure must never break the agent run.
    if (succeededMutation > 0 && typeof opts.autoGit === 'function') {
      try {
        await opts.autoGit({
          tools: toolCalls
            .filter((tc, i) => toolResults[i] && toolResults[i].res.ok && MUTATION_TOOLS.has(tc.name))
            .map((tc) => tc.name)
        });
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[agenite] autoGit 失败:', e && e.message);
      }
    }

    // ── Verification loop (Plan → Execute → Verify → Rollback) ──
    // Checking the work is what separates an agent that *looks* done from one
    // that *is* done. Runs after the git checkpoint on purpose: a restore point
    // must exist before we start reacting to failures. A failing check comes
    // back as a compact structured summary (never raw test spew) and is handed
    // to the model as a concrete fix request, capped by maxVerifyFixes so a
    // genuinely broken build can't burn the whole turn budget.
    if (succeededMutation > 0 && typeof opts.autoVerify === 'function') {
      const fixCap = Number.isFinite(Number(config.maxVerifyFixes)) ? Number(config.maxVerifyFixes) : 2;
      let vr = null;
      try {
        vr = await opts.autoVerify({
          tools: toolCalls
            .filter((tc, i) => toolResults[i] && toolResults[i].res.ok && MUTATION_TOOLS.has(tc.name))
            .map((tc) => tc.name),
          files: changedPathsFrom(toolCalls, toolResults)
        });
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[agenite] autoVerify 失败:', e && e.message);
      }
      if (vr && vr.ran) {
        onEvent('verify', {
          ok: !!vr.ok,
          level: vr.level || null,
          kind: vr.kind || null,
          label: vr.label || '',
          summary: vr.summary || '',
          failures: Array.isArray(vr.failures) ? vr.failures.slice(0, 12) : [],
          ms: vr.ms || 0
        });
        if (!vr.ok) {
          if (verifyFixes < fixCap) {
            verifyFixes++;
            messages.push({
              role: 'user',
              content:
                `❌ 自动验证未通过（第 ${verifyFixes}/${fixCap} 次）——${vr.label || '校验'}：\n` +
                `${vr.summary || '(无输出)'}\n\n` +
                '这是你刚才改动后的【真实】结果，不是假设。请据此定位并修复：' +
                '先读取相关文件确认当前内容，再做最小必要修改；不要为了让检查通过而删改测试本身。'
            });
          } else if (!verifyGaveUp) {
            verifyGaveUp = true;
            messages.push({
              role: 'user',
              content:
                `❌ 自动验证仍未通过，且已达 ${fixCap} 次自动修复上限。请立即停止继续改动，` +
                '向用户说明：失败的是什么、你尝试过什么、你判断的根因，以及建议的下一步（必要时提示可用 `git undo` 回退）。'
            });
          }
        }
      }
    }

    turnsSinceTodo = todoTouched ? 0 : turnsSinceTodo + 1;
  }

  // Hit the ceiling with tools still pending. Say so out loud — silently
  // truncating a half-finished task is the worst possible failure mode.
  const payload = finish('max_turns', limit, usage, price, limit, shrinkStats);
  onEvent('done', payload);
  return { messages, ...payload };
}

function finish(stopped, turns, usage, price, limit, shrink) {
  return {
    stopped,
    turns,
    usage: { ...usage },
    cost: costOf(usage, price),
    limit,
    // What the context economy layer saved this run. Surfacing it next to the
    // cost figure is the point: "we shrank things" is a claim, a token count
    // sitting beside the bill is evidence.
    shrink: shrink ? { ...shrink } : { count: 0, savedTokens: 0, savedChars: 0 },
    canContinue: stopped === 'max_turns'
  };
}

export function clampTurns(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_MAX_TURNS;
  return Math.min(100, Math.max(1, Math.floor(n)));
}
