// v0.77.0 — Plan Coherence
// --------------------------------------------------------------------------
// v0.74 (gate) checks a plan is executable, v0.75 (refine) turns findings into
// fixes, v0.76 (decompose) seeds a research → action → verify DRAFT at the
// start of a run. But nothing checked whether the plan the agent actually WROTE
// stayed coherent with that seeded draft and with the original objective. A
// model could accept the draft's skeleton in spirit yet quietly drop the verify
// step, reorder research after action, or drift onto a different task — and the
// gate/refine would never notice because they only see the final plan in
// isolation.
//
// This module closes that gap: `assessCoherence` compares the agent's written
// plan against (a) the decompose draft skeleton and (b) the run goal, and
// reports structural drift. It completes the planning lifecycle:
//   decompose → gate → refine → cohere → execute
// like the siblings it flows through the EXACT same single-source-of-truth
// stack: event → server ledger/SSE → otel span → app trace/toast.
//
// Design constraints (identical to the sibling planning modules):
//   * Pure function → unit-testable in isolation, zero side effects.
//   * MODEL-FREE, IO-FREE, NETWORK-FREE → purely deterministic heuristics.
//   * ADVISORY, never a hard block: it surfaces drift so the human/model can
//     reconcile the plan; it never rejects or rewrites it.
//   * CJK-aware: every matcher lists CJK terms explicitly, never \b.
//   * Shares the canonical vocabulary (step kinds, counts, normalization,
//     tokenization) with decompose/gate/refine via plan-schema.js.

import { STEP_KINDS, PLAN_KIND_LABELS, countKinds, normSteps, tokenize } from './plan-schema.js';

export const PLAN_COHERE_VERSION = '0.77.0';

// Per-step kind inference from free text. Priority verify > research > action
// (a verify step mentioning 检查/测试 must win over a stray research verb),
// and an unmatched step defaults to 'action' (the most common plan step). This
// is a lightweight, deterministic heuristic — coherence only needs a rough
// shape, not a classifier.
const RESEARCH_RE = /调研|研究|查|搜索|分析|了解|读取|探索|厘清|理解|回顾|审视|investigate|research|search|find|read|explore|analy[sz]e|understand/i;
const ACTION_RE = /实现|创建|生成|编写|开发|搭建|构建|部署|修复|重构|做|执行|写|运行|修改|添加|整理|落盘|produce|implement|create|build|develop|fix|generate|deploy|write|run|modify|add|execute|edit/i;
const VERIFY_RE = /验证|校验|确认|检查|核实|核对|测试|复核|评审|test|verify|check|confirm|assert|lint|typecheck|review|smoke/i;

function inferKind(text) {
  const t = String(text || '');
  if (VERIFY_RE.test(t)) return 'verify';
  if (RESEARCH_RE.test(t)) return 'research';
  if (ACTION_RE.test(t)) return 'action';
  return 'action';
}

// assessCoherence({ goal, draft, plan })
//   goal:  string — the run objective (matches what decompose was seeded with).
//   draft: object|null — the decomposeGoal() output (has .kinds + .steps), or
//          null when the run had no goal and therefore no seeded draft.
//   plan:  string[]|string|null — the agent's WRITTEN plan (same shape the
//          `plan` tool records: a steps array, or raw text).
// → { ok, score, level, issues[], stats, goal, version }
export function assessCoherence({ goal, draft, plan } = {}) {
  const steps = normSteps(plan);
  const n = steps.length;

  const stats = {
    stepCount: n,
    planKinds: { research: 0, action: 0, verify: 0 },
    draftKinds: (draft && draft.kinds) || null,
    orderOk: true,
    goalAligned: null,
    droppedKinds: []
  };

  // Empty plan — structurally nothing to be coherent with. Advisory fail; the
  // gate already flags EMPTY_PLAN, but coherence reports it on its own stack so
  // the timeline shows WHY a draft→plan handoff produced nothing.
  if (n === 0) {
    return {
      ok: false,
      score: 0,
      level: 'fail',
      issues: [{
        severity: 'error',
        code: 'COHERENCE_NO_PLAN',
        message: '规划连贯性校验无可评估的步骤：计划为空，无法与自分解草稿或目标比对。'
      }],
      stats,
      goal: goal || null,
      version: PLAN_COHERE_VERSION
    };
  }

  // Infer a kind per step, then tally via the shared counter so the result is
  // identical in shape to decompose's `kinds`.
  const kinds = steps.map(inferKind);
  const planKinds = countKinds(kinds.map((k) => ({ kind: k })));
  stats.planKinds = planKinds;

  // Ordering coherence: the canonical skeleton is research → action → verify.
  // Only pairs that are present are checked, so a plan legitimately omitting
  // research (rare) is not penalized for ordering.
  const firstIdx = { research: -1, action: -1, verify: -1 };
  kinds.forEach((k, i) => { if (firstIdx[k] === -1) firstIdx[k] = i; });
  let orderOk = true;
  if (firstIdx.research >= 0 && firstIdx.action >= 0 && firstIdx.research > firstIdx.action) orderOk = false;
  if (firstIdx.action >= 0 && firstIdx.verify >= 0 && firstIdx.action > firstIdx.verify) orderOk = false;
  if (firstIdx.research >= 0 && firstIdx.verify >= 0 && firstIdx.research > firstIdx.verify) orderOk = false;
  stats.orderOk = orderOk;

  const issues = [];
  let score = 100;

  if (!orderOk) {
    issues.push({
      severity: 'warning',
      code: 'ORDER_INCOHERENT',
      message: '计划步骤顺序不连贯：建议保持「调研 → 执行 → 验证」的先后次序。'
    });
    score -= 15;
  }

  // Draft-consistency: the seeded draft contained certain kinds; the written
  // plan must preserve each of them. Dropping a kind the decomposition judged
  // necessary is the headline coherence failure.
  const dropped = [];
  if (draft && draft.kinds) {
    for (const k of STEP_KINDS) {
      if ((draft.kinds[k] || 0) > 0 && (planKinds[k] || 0) === 0) {
        dropped.push(k);
        issues.push({
          severity: 'warning',
          code: 'DROPPED_KIND',
          message: `自分解草稿包含「${PLAN_KIND_LABELS[k]}」环节，但当前计划已丢弃该步骤，与草稿不连贯。`,
          kind: k
        });
        score -= 12;
      }
    }
  }
  stats.droppedKinds = dropped;

  // Closing-the-loop: a plan with no verify step can never confirm it matched
  // the goal. Flagged as info (not a deduction-heavy error) since some trivial
  // plans genuinely need no verification — but coherence still wants it visible.
  if ((planKinds.verify || 0) === 0) {
    issues.push({
      severity: 'info',
      code: 'NO_VERIFY_COHERENCE',
      message: '计划缺少验证/闭环步骤，难以确认结果符合目标。'
    });
    score -= 8;
  }

  // Goal alignment: does the written plan still touch the objective the draft
  // was seeded from? Reported as a stat for telemetry; surfaced as an issue
  // only when there is clear drift, so coherence adds signal without merely
  // re-litigating the gate's goal-coverage check.
  const goalTokens = tokenize(goal || '');
  if (goalTokens.length) {
    const planText = steps.join(' ').toLowerCase();
    const aligned = goalTokens.some((t) => planText.includes(t));
    stats.goalAligned = aligned;
    if (!aligned) {
      issues.push({
        severity: 'warning',
        code: 'GOAL_DRIFT',
        message: '计划与原始目标的关键词无重叠，可能已偏离任务方向。'
      });
      score -= 15;
    }
  }

  score = Math.max(0, Math.min(100, score));

  let level;
  if (issues.some((i) => i.severity === 'error') || score < 50) level = 'fail';
  else if (score >= 80 && !issues.some((i) => i.severity === 'warning')) level = 'pass';
  else level = 'warn';

  const ok = level !== 'fail';
  return { ok, score, level, issues, stats, goal: goal || null, version: PLAN_COHERE_VERSION };
}
