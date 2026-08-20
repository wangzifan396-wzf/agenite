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
import { detectStall, turnMadeProgress } from './stallguard.js';
import { classifyError, decideSelfHeal, dominantCategory, backoffMs } from './fault.js';
import { evaluateGuardrail, resolveMode } from './guardrails.js';
// v0.73.0: A2A Agent Card — advertises this agent's A2A-shaped identity so a
// delegate/fanout peer (or external A2A client) can discover it.
import { cardFromConfig } from './agentcard.js';
// v0.74.0: Plan Quality Gate — validates a plan's executability / goal coverage
// / governance compliance before the human approves it (pure, model-free).
import { validatePlan } from './plan-gate.js';
import { refinePlan } from './plan-refine.js';
// v0.76.0: Plan Decomposition — seeds a structured draft plan (research →
// action → verify) from the run goal BEFORE any turn, completing the planning
// lifecycle (decompose → gate → refine → execute) on the same event stack.
import { decomposeGoal } from './plan-decompose.js';

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
const NEVER_COMPRESS = new Set(['context_retrieve', 'todo_write', 'plan', 'verify', 'git', 'regression_hunt']);

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
  summarize = null,
  // v0.73.0: when true this run is an A2A peer (sub-agent), not the host, so
  // it must NOT advertise a host Agent Card — only the top-level run does.
  isPeer = false,
  // v0.74.0: the run's objective, passed to the Plan Quality Gate so it can
  // check whether the plan actually covers the goal. Optional; empty = skip.
  goal = ''
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

  // ── Action-level blast-radius gate (v0.71.0, governance track) ──
  // Built once per run from config. `denyList`/`allowList`/`networkCap` come
  // from config.guardrails; the approval mode is the existing config.approvalMode
  // (already threaded through opts). networkCap defaults to -1 (unlimited) so
  // existing behavior is unchanged unless an operator sets a cap.
  const guardPolicy = {
    mode: config.approvalMode || 'ask',
    denyList: (config.guardrails && Array.isArray(config.guardrails.denyList)) ? config.guardrails.denyList : [],
    allowList: (config.guardrails && Array.isArray(config.guardrails.allowList)) ? config.guardrails.allowList : [],
    networkCap: (config.guardrails && config.guardrails.networkCap != null) ? Number(config.guardrails.networkCap) : -1
  };
  // v0.73.0: A2A Agent Card. The top-level (host) run advertises its A2A
  // identity once, so a delegate/fanout peer — or an external A2A client — can
  // discover it. Sub-agent (peer) runs skip this via isPeer:true so only the
  // host emits a card. Best-effort: a card failure must never break a run.
  if (!isPeer && typeof onEvent === 'function') {
    try {
      const hostCard = cardFromConfig(config, { tools, version: config.version, name: config.name });
      onEvent('a2a', { phase: 'host_card', card: hostCard, contextId: (opts && opts.contextId) || null });
    } catch { /* Agent Card is strictly best-effort */ }
  }

  // v0.76.0: Plan Decomposition. Before any turn, turn the run goal into a
  // structured draft plan (research → action → verify) and emit a single
  // `plan_decompose` event — seeding the planning lifecycle at the very start
  // (decompose → gate → refine → execute) on the exact same single-source-of-
  // truth stack as v0.74 (gate) and v0.75 (refine). Pure, model-free, no IO.
  // Best-effort: a decomposition failure must never break a run.
  if (!isPeer && typeof onEvent === 'function' && goal) {
    try {
      const toolNames = Array.isArray(tools)
        ? tools.map((t) => (t && t.name) || '').filter(Boolean)
        : [];
      onEvent('plan_decompose', decomposeGoal(goal, { tools: toolNames }));
    } catch { /* decomposition is strictly best-effort */ }
  }

  // Per-run network call counter, fed to the gate for the rate cap. Updated
  // synchronously during the pre-scan so parallel network tools can't race it.
  let netCount = 0;

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
  // Stuck-loop breaker state: signature of the previous turn's tool calls and
  // how many consecutive identical turns we've seen. trace.js already detects
  // exact-repeat loops for display; this makes the agent *act* on them.
  let lastTurnSig = null;
  let loopStreak = 0;
  // Self-heal attempt counter (v0.68): bounds transient retries and keeps the
  // "single reflection budget" door closed on infinite loops. Incremented each
  // time we emit a non-escalate self_heal nudge.
  let selfHealAttempt = 0;
  // Escalation latch (v0.68): once we escalate to the human (auth / retries
  // exhausted / loop hit the cap) we never nudge again — the human must act.
  let escalated = false;
  // v0.70 anti-flapping: remember the *last remedy we actually applied* so the
  // next decideSelfHeal call can refuse to repeat a useless therapy on the same
  // root cause. lastHealAction is the prior decision.action; lastHealCategory
  // is the prior fault category. Both are fed back into decideSelfHeal as
  // lastAction / lastCategory to drive the reflect→replan→escalate upgrade.
  let lastHealAction = null;
  let lastHealCategory = null;

  // ── Runtime Resilience v2 (v0.65): stall detection + graceful degradation ──
  // Complements the exact-repeat loop breaker above: that one catches *identical*
  // consecutive turns; this catches the *semantic* stall — different actions,
  // zero progress, for a long stretch. Deterministic (no model): we count
  // consecutive turns that made no progress (no successful tool call, no todo
  // advance). Config is pre-normalized by normalizeConfig, so a tiny inline
  // guard is enough; we avoid importing clampNum into this hot module.
  const stallGuardOn = config.stallGuard !== 'off';
  const stallTurns = Number.isFinite(Number(config.stallTurns)) ? Math.floor(Number(config.stallTurns)) : 6;
  const stallHardTurns = Math.max(
    stallTurns,
    Number.isFinite(Number(config.stallHardTurns)) ? Math.floor(Number(config.stallHardTurns)) : 12
  );
  let turnsSinceProgress = 0;
  let stallSoftNoted = false;

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
        onEvent('guardrail', { decision: 'cost', reason: 'cost', cost: c.amount, max: guardCost, currency: c.currency || 'CNY' });
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
    // Pre-evaluate the blast-radius gate for every tool call in this turn,
    // synchronously, before any async execution. This makes the per-run network
    // counter race-free even when network tools run in parallel below, and keeps
    // the hard-deny floor (secret / denyList / rate cap / allowList) applied
    // identically whether the call is parallel or serial.
    const guardDecisions = toolCalls.map((tc) => {
      const g = evaluateGuardrail({
        tool: tc.name,
        args: tc.args || {},
        policy: guardPolicy,
        stats: { netCount }
      });
      // Reserve the network slot now so concurrent network tools count correctly.
      if (g.category === 'network' && g.decision !== 'deny') netCount++;
      return g;
    });
    async function runOneTool(i) {
      const tc = toolCalls[i];
      onEvent('tool_start', { id: tc.id, name: tc.name, args: tc.args || {} });
      const g = guardDecisions[i];
      // Hard deny / ask / allow are emitted as a single audit event so the trace,
      // OTel spans and /api/health all consume one source of truth. A denied call
      // never reaches executeTool — we synthesize a GUARDRAIL_DENIED result.
      if (g.decision === 'deny') {
        onEvent('guardrail', {
          decision: 'deny', category: g.category, reason: g.reason,
          tool: tc.name, args: tc.args || {}, mode: resolveMode(guardPolicy.mode)
        });
        toolResults[i] = {
          tc,
          res: {
            ok: false,
            error: 'Guardrail blocked this tool call: ' + g.reason,
            errorClass: 'GUARDRAIL_DENIED',
            content: null, diff: null, undoToken: null
          },
          ms: 0
        };
        return;
      }
      onEvent('guardrail', {
        decision: g.decision, category: g.category, reason: g.reason,
        tool: tc.name, args: tc.args || {}, mode: resolveMode(guardPolicy.mode)
      });
      const started = Date.now();
      const res = await executeTool(tc.name, tc.args || {}, opts);
      toolResults[i] = { tc, res, ms: Date.now() - started };
      // v0.74.0: Plan Quality Gate. The `plan` tool only records steps, so a
      // human may approve a plan that is unexecutable, off-goal, or trips the
      // governance denyList. We validate here (pure, no model call) and emit a
      // single `plan_gate` event so the UI, /api/health ledger and OTel spans
      // all consume one source of truth. Best-effort: a gate failure must never
      // break the run — it is advisory, not a hard block.
      if (tc.name === 'plan' && res && res.ok) {
        try {
          const toolNames = Array.isArray(tools)
            ? tools.map((t) => (t && t.name) || '').filter(Boolean)
            : [];
          const assessment = validatePlan({
            steps: tc.args && tc.args.steps,
            text: tc.args && tc.args.text,
            goal: goal || '',
            toolNames,
            guardPolicy
          });
          onEvent('plan_gate', assessment);
          // v0.75.0: Plan Self-Refinement. The gate only says *what* is wrong;
          // refinePlan turns each issue into a concrete fix suggestion and emits
          // a single `plan_refine` event on the same stack (ledger/SSE/otel/trace)
          // as the gate. Advisory only — the human still decides. Best-effort.
          onEvent('plan_refine', refinePlan(assessment, { goal: goal || '' }));
        } catch { /* gate is strictly best-effort */ }
      }
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

    // ── Root-cause-driven self-healing (Resilient Self-Healing v2, v0.68) ──
    // Upgrades the ad-hoc "自检提醒" nudge into a structured root-cause loop:
    // classify every failed mutation, pick the dominant root cause, then let
    // decideSelfHeal choose the *right* remedy — retry a transient blip,
    // re-read & fix a semantic miss, switch approach on a stuck loop, escalate
    // auth to the human, or compress on a budget blowout. The identical
    // structured decision is emitted as a 'self_heal' event so the trace,
    // OTel spans and the health probe all consume one source of truth. The
    // reflection budget (maxReflections) still bounds nudges so a hopeless
    // case can't nag forever — that is the door we close on infinite loops.
    let failedMutation = 0;
    let succeededMutation = 0;
    const failedNames = [];
    const failedClasses = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const r = toolResults[i];
      if (!r || !MUTATION_TOOLS.has(toolCalls[i].name)) continue;
      if (r.res.ok) succeededMutation++;
      else {
        failedMutation++;
        failedNames.push(toolCalls[i].name);
        if (r.res.errorClass) failedClasses.push(r.res.errorClass);
      }
    }
    // Order-independent signature of this turn's tool calls. Two turns with the
    // same (name+args) set are a stuck loop; scattered re-reads of the same
    // file in *different* turns are normal and must not trip this.
    const thisTurnSig = toolCalls.length
      ? toolCalls.map((tc) => tc.name + ' ' + JSON.stringify(tc.args || {})).sort().join('|')
      : null;
    let looping = false;
    if (thisTurnSig && thisTurnSig === lastTurnSig) loopStreak++;
    else loopStreak = 0;
    lastTurnSig = thisTurnSig;
    if (loopStreak >= 2) looping = true;

    const cap = Number.isFinite(Number(config.maxReflections)) ? Number(config.maxReflections) : 3;

    if (config.selfHeal !== false && (failedMutation > 0 || looping)) {
      // Map every failed mutation to a root cause; a pure stuck-loop (no new
      // failure) is itself a structural dead-end and is folded in as such.
      const cats = failedClasses.map((ec) => classifyError({ errorClass: ec }).category);
      if (looping && failedMutation === 0) cats.push('structural');
      const category = dominantCategory(cats.length ? cats : ['unknown']);

      const decision = decideSelfHeal({
        category, loopStreak, failedMutation, failedNames,
        reflections, cap, attempt: selfHealAttempt, maxAttempts: 3,
        selfHeal: config.selfHeal !== false,
        lastAction: lastHealAction, lastCategory: lastHealCategory
      });

      if (decision.action !== 'none' && decision.message) {
        const isEscalate = decision.action === 'escalate';
        // Escalate (auth / exhausted retries / loop hit the cap) fires once and
        // then stays silent — the human must act. reflect/replan/retry/compress
        // count against the single reflection budget so a hopeless case can't
        // nag forever. That is the door we close on infinite loops.
        const canNudge = isEscalate ? !escalated : reflections < cap;
        // Capture the true loop depth *before* any reset so the self_heal event
        // reports what actually triggered the decision (v0.69: replan clears it).
        const loopAtHeal = loopStreak;
        if (canNudge) {
          // v0.70: record the remedy we are about to apply so the next turn's
          // decideSelfHeal can refuse to repeat a useless therapy on the same
          // root cause (anti-flapping). Set before the replan-reset block so the
          // value already reflects this turn by the time counters are cleared.
          lastHealAction = decision.action;
          lastHealCategory = category;
          // replan executes recovery, not just a nudge (v0.69): clear the
          // no-progress and identical-turn counters so the new approach gets a
          // fair chance instead of being immediately re-killed by the stall
          // guard / loop breaker, and — when a live todo/plan state exists —
          // re-plan it: keep completed items (real progress) but collapse the
          // remainder to pending so the model must re-state its next steps.
          if (decision.action === 'replan') {
            turnsSinceProgress = 0;
            loopStreak = 0;
            lastTurnSig = null;
            if (todo && Array.isArray(todo.items)) {
              const completed = todo.items.filter((t) => t.status === 'completed');
              const remaining = todo.items
                .filter((t) => t.status !== 'completed')
                .map((t) => { const { activeForm, ...keep } = t; return { ...keep, status: 'pending' }; });
              todo.items = [...completed, ...remaining];
              todo.updatedAt = Date.now();
              onEvent('todo', {
                items: todo.items.map((t) => ({ ...t })),
                progress: todoProgress(todo.items),
                updates: (Number(todo.updates) || 0) + 1,
                replanned: true
              });
            }
          }
          messages.push({ role: 'user', content: decision.message });
          // Budget blowout: proactively reclaim context so the run can continue.
          if (decision.action === 'compress' && autoCompact) {
            try {
              const before = totalTokens(messages);
              if (before > budget) {
                const r = await compactMessages(messages, {
                  budget, keepRecentGroups: 3, toolTrimTo: 1200,
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
            } catch { /* compaction is strictly best-effort */ }
          }
          // Machine-consumable event: one source of truth for trace / OTel / health.
          onEvent('self_heal', {
            category, action: decision.action,
            attempt: selfHealAttempt, loopStreak: loopAtHeal, failedNames,
            reason: decision.reason || null,
            resetCounters: decision.action === 'replan',
            replanned: decision.action === 'replan',
            message: decision.message,
            backoffMs: decision.backoffMs != null ? decision.backoffMs : null,
            escalate: !!decision.escalate,
            flap: !!decision.flap,
            lastAction: lastHealAction,
            lastCategory: lastHealCategory
          });
          // Escalate closes the door on blind retries; otherwise consume one nudge.
          if (isEscalate) { escalated = true; reflections = cap; }
          else { reflections++; selfHealAttempt++; }
        }
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

    // ── Runtime Resilience v2 (v0.65): stall detection + graceful degradation ──
    // Update the no-progress counter, then act on it. This runs AFTER every tool
    // turn and is independent of the exact-repeat loop breaker. The hard stop is
    // a graceful degradation — "escalate rather than guess" (2026 playbook): the
    // agent knows it's stuck, says so, and stops cleanly instead of burning the
    // whole budget or crashing. It maps to a distinct 'blocked' goal status.
    if (stallGuardOn) {
      const madeProgress = turnMadeProgress({ toolResults, todoTouched });
      if (madeProgress) turnsSinceProgress = 0;
      else turnsSinceProgress++;
      const lvl = detectStall({ turnsSinceProgress, stallTurns, stallHardTurns });
      if (lvl === 'hard') {
        onEvent('stall', { level: 'hard', turns: turnsSinceProgress });
        // One final, bounded summary turn — never keep spending after this.
        messages.push({
          role: 'system',
          content:
            `⚠️ 停滞护栏触发：已连续 ${turnsSinceProgress} 回合没有任何实质进展（无成功的工具调用、待办也未推进）。` +
            '请立即停止，并输出一份【卡点说明】而非继续空转：你已完成什么、卡在哪里、需要用户澄清或提供什么。'
        });
        const r = await callModel(messages, { onDelta: (t) => onEvent('delta', t), onReasoning: (t) => onEvent('reasoning', t) });
        if (r.usage) { addUsage(usage, r.usage); onEvent('usage', { turn: turn + 1, ...usage, cost: costOf(usage, price) }); }
        const finalMsg = { role: 'assistant', content: r.content || '' };
        if (r.reasoning) finalMsg.reasoning = r.reasoning;
        messages.push(finalMsg);
        onEvent('assistant', finalMsg);
        const payload = finish('stalled', turn + 1, usage, price, limit, shrinkStats);
        onEvent('done', payload);
        return { messages, ...payload };
      } else if (lvl === 'soft' && !stallSoftNoted) {
        stallSoftNoted = true;
        onEvent('stall', { level: 'soft', turns: turnsSinceProgress });
        messages.push({
          role: 'user',
          content:
            `⚠️ 停滞提醒（已 ${turnsSinceProgress} 回合无进展）：你似乎在空转——没有成功的工具调用，待办也没推进。` +
            '请换思路：换用不同工具或参数、重新确认任务要求，或先向用户澄清卡点，而不是继续重复无效动作。'
        });
      }
    }
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
