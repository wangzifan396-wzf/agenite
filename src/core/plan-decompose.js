// v0.77.0: shares the canonical plan vocabulary (step kinds + counts) with gate
// / refine / cohere via plan-schema.js, so the four planning stages can never
// disagree about what a "plan" is. Import kept at the top for module clarity.
import { countKinds } from './plan-schema.js';

// v0.76.0 — Plan Decomposition
// --------------------------------------------------------------------------
// v0.74.0 shipped the Plan Quality Gate (validate a plan BEFORE execution) and
// v0.75.0 shipped Plan Self-Refinement (turn gate findings into concrete fix
// suggestions). Both operate on a plan the AGENT already wrote — but nothing
// helped the agent write that first draft. A blank plan canvas made the gate
// and refine fire late, after the model had already committed to a shape.
//
// This module closes that gap at the very start of a run. `decomposeGoal`
// turns a run objective into a structured DRAFT plan — a research → action →
// verify skeleton — before any turn, so the planning lifecycle is complete:
//   decompose → gate → refine → cohere → execute
// The agent emits the result as a single `plan_decompose` event that flows
// through the EXACT same single-source-of-truth stack as v0.74 (gate) and
// v0.75 (refine) and v0.77 (cohere): event → server ledger/SSE → otel span
// → app trace/toast.
//
// Design constraints (kept identical to plan-gate.js / plan-refine.js so the
// feature stays tiny and testable):
//   * Pure function → unit-testable in isolation, zero side effects.
//   * MODEL-FREE, IO-FREE, NETWORK-FREE → purely deterministic heuristics.
//   * ADVISORY, never a hard block: the draft is a seed the human/model edits;
//     it never forces a particular plan shape.
//   * No \b word boundaries: CJK has no word breaks, so every matcher uses
//     explicit character lists / substring tests, never \b.
//   * It never re-runs validation or refinement; it only *seeds* the plan, so
//     the three modules can never disagree about the facts on the ground.

export const PLAN_DECOMPOSE_VERSION = '0.76.0';

const DEFAULT_MAX_STEPS = 6;

// Tool-name hints per phase. `pickTool` returns the first REGISTERED tool name
// (passed in by the caller) that matches a hint, so the draft only ever
// references tools the agent actually owns. No hint match → step has no tool.
const RESEARCH_HINTS = ['web_search', 'search', 'read_file', 'glob', 'grep', 'lookup', 'fetch', 'http_get', 'current_datetime', 'calculator', 'browse'];
const ACTION_HINTS = ['write_file', 'edit_file', 'apply_patch', 'shell', 'git', 'create', 'run', 'sql', 'db', 'browser_navigate', 'scaffold', 'build'];
const VERIFY_HINTS = ['run_tests', 'test', 'verify', 'check', 'lint', 'typecheck', 'read_file', 'shell', 'assert'];

// Goal-signal matchers. Explicit CJK term lists — no \b, which fails on CJK.
const WANTS_VERIFY = /验证|校验|确认|测试|检查|核实|核对|test|verify|check|confirm|assert|lint|typecheck/i;
const WANTS_RESEARCH = /调研|研究|查一下|查找|搜索|分析|了解|读取|探索|搞清|厘清|investigate|research|search|find|read|explore|analy[sz]e|understand/i;
const WANTS_DELIVERABLE = /实现|创建|生成|编写|开发|搭建|构建|部署|修复|重构|写|做|produce|implement|create|build|develop|fix|generate|deploy|write/i;

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// First registered tool name (from `names`) that contains any hint substring.
function pickTool(names, hints) {
  if (!Array.isArray(names) || !names.length) return undefined;
  for (const h of hints) {
    const hit = names.find((n) => typeof n === 'string' && n.toLowerCase().includes(h.toLowerCase()));
    if (hit) return hit;
  }
  return undefined;
}

// decomposeGoal(goal, { tools = [], maxSteps = 6 } = {}) → draft plan object
//   goal:     the run objective (string). Empty → ok:false, stepCount:0.
//   tools:    optional array of REGISTERED tool names (strings) so the draft
//             can hint at concrete tools the agent actually has.
//   maxSteps: hard cap on step count (≥1, clamped to DEFAULT_MAX_STEPS).
// → { goal, steps[], stepCount, hasVerify, hasAction, hasResearch, kinds, ok, maxSteps, version }
export function decomposeGoal(goal, { tools = [], maxSteps = DEFAULT_MAX_STEPS } = {}) {
  const raw = typeof goal === 'string' ? goal : '';
  const cleanGoal = raw.trim();
  if (!cleanGoal) {
    return {
      goal: '', steps: [], stepCount: 0,
      hasVerify: false, hasAction: false, hasResearch: false,
      kinds: { research: 0, action: 0, verify: 0 },
      ok: false, reason: 'empty_goal',
      maxSteps: clampMax(maxSteps), version: PLAN_DECOMPOSE_VERSION
    };
  }

  const names = Array.isArray(tools) ? tools.filter((t) => typeof t === 'string' && t) : [];
  const n = clampMax(maxSteps);

  const wantsVerify = WANTS_VERIFY.test(cleanGoal);
  const wantsResearch = WANTS_RESEARCH.test(cleanGoal);
  const wantsDeliverable = WANTS_DELIVERABLE.test(cleanGoal);

  const steps = [];

  // ── RESEARCH ── anchor the goal: clarify intent, gather context, read docs.
  // Always present — even a pure "do X" goal benefits from a one-line framing
  // step so the agent states its understanding before acting.
  steps.push({
    kind: 'research',
    text: wantsResearch
      ? `调研与厘清目标：「${truncate(cleanGoal, 48)}」`
      : `厘清目标与约束：「${truncate(cleanGoal, 48)}」`,
    tool: pickTool(names, RESEARCH_HINTS)
  });

  // ── ACTION ── the core work. Phrase it from the goal's deliverable verb.
  const actionVerb = wantsDeliverable ? '执行核心操作' : '推进任务';
  steps.push({
    kind: 'action',
    text: `${actionVerb}以推进「${truncate(cleanGoal, 36)}」`,
    tool: pickTool(names, ACTION_HINTS)
  });

  // Richer goals (longer than ~24 chars) get a second action step that turns
  // the work into a concrete, reviewable deliverable (write/commit/produce).
  if (cleanGoal.length > 24) {
    steps.push({
      kind: 'action',
      text: wantsDeliverable
        ? '整理产出并落盘/提交，形成可评审的中间产物'
        : '沉淀阶段性结果，便于后续验证与回退',
      tool: pickTool(names, ACTION_HINTS)
    });
  }

  // ── VERIFY ── close the loop. A verify step is what the gate's NO_VERIFY
  // check rewards, so every draft ends by checking the result against the goal.
  steps.push({
    kind: 'verify',
    text: wantsVerify
      ? `按目标执行验证：「${truncate(cleanGoal, 36)}」`
      : '运行验证/自检，确认结果符合目标且无回归',
    tool: pickTool(names, VERIFY_HINTS)
  });

  // Cap to maxSteps while preserving the research → action → verify skeleton:
  // drop optional middle action steps first, never the opening research or the
  // closing verify, until we fit.
  let trimmed = steps;
  if (steps.length > n) {
    const actionIdx = steps.map((s, i) => (s.kind === 'action' ? i : -1)).filter((i) => i > 0);
    trimmed = steps.filter((s, i) => !(actionIdx.includes(i) && steps.length - actionIdx.filter((x) => x <= i).length >= n));
    // Fallback: simple slice if the smart drop didn't fit (tiny maxSteps).
    if (trimmed.length > n) trimmed = steps.slice(0, n);
  }

  const kinds = countKinds(trimmed);
  const hasVerify = trimmed.some((s) => s.kind === 'verify');
  const hasAction = trimmed.some((s) => s.kind === 'action');
  const hasResearch = trimmed.some((s) => s.kind === 'research');

  return {
    goal: cleanGoal,
    steps: trimmed,
    stepCount: trimmed.length,
    hasVerify,
    hasAction,
    hasResearch,
    kinds,
    ok: hasResearch && hasAction && hasVerify,
    maxSteps: n,
    version: PLAN_DECOMPOSE_VERSION
  };
}

function clampMax(maxSteps) {
  const v = Number.isFinite(Number(maxSteps)) ? Math.floor(Number(maxSteps)) : DEFAULT_MAX_STEPS;
  if (v < 1) return 1;
  return Math.min(v, DEFAULT_MAX_STEPS);
}
