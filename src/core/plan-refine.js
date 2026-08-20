// v0.75.0 — Plan Self-Refinement
// --------------------------------------------------------------------------
// v0.74.0 shipped the Plan Quality Gate: a model-free, IO-free validator that
// scores a plan BEFORE execution and emits a `plan_gate` event. But the gate
// only said *what* was wrong — it did not tell the agent (or the human) *how*
// to fix it. That gap made the gate advisory-but-inert: a failing plan stayed
// failing until someone manually reworked it.
//
// This module closes that gap. `refinePlan` consumes a `validatePlan`
// assessment and turns each structured issue into a concrete, actionable fix
// suggestion — sorted by severity so the worst problems rise to the top. The
// agent emits the result as a `plan_refine` event, reusing the exact same
// single-source-of-truth stack as v0.74 (event → server ledger/SSE → otel
// span → app trace/toast). No model, no IO, no network — purely deterministic.
//
// Design constraints (kept identical to plan-gate.js so the feature stays
// tiny and testable):
//   * Pure function → unit-testable in isolation, zero side effects.
//   * ADVISORY, never a hard block: a failing plan is still the human's to
//     approve or reject. The suggestion list just makes the fix obvious.
//   * It never re-runs validation; it only *interprets* the assessment, so the
//     two modules can never disagree about the facts on the ground.

// Remediation text per issue code. Functions receive the issue so they can
// weave in the step number / extracted tool name for a concrete fix.
const REMEDIATION = {
  EMPTY_PLAN: '先列出可执行的步骤清单（例如「1. 读取配置；2. 修改字段；3. 运行验证」），空计划无法执行。',
  SINGLE_STEP: '补充中间里程碑步骤，便于追踪进度并在出错时安全回退。',
  GOAL_UNCOVERED: '在步骤中显式呼应目标关键词，确保计划朝任务方向推进而非跑偏。',
  UNKNOWN_TOOL: (it) => {
    const m = (it.message || '').match(/「(.+?)」/);
    const t = m ? m[1] : '该';
    return `第 ${it.step} 步：改用已注册工具，或先在工具集中接入「${t}」再引用，否则该步骤无法执行。`;
  },
  DESTRUCTIVE_STEP: (it) => `第 ${it.step} 步：破坏性操作前加显式护栏/审批步骤，并准备回滚方案。`,
  SECRET_REF: (it) => `第 ${it.step} 步：移除明文密钥/凭据，改用凭据注入或环境变量，切勿写入计划或日志。`,
  DENYLIST_HIT: (it) => `第 ${it.step} 步：撤销命中治理 denyList 的动作，改走合规路径（运行时会硬性拒绝）。`,
  LOOP_STEP: (it) => `第 ${it.step} 步：为循环/重复语义补明确终止条件，避免无限循环。`,
  VAGUE_STEP: (it) => `第 ${it.step} 步：改写为可验证的具体动作（谁、做什么、产出是什么），避免模糊表述。`,
  NO_VERIFY: '追加验证/测试步骤（如「运行测试套件」「校验输出」），"完成"不等于"正确"。',
  NETWORK_STEP: (it) => `计划含 ${it.stepCount || ''} 处网络/外部调用：注意网络护栏与速率上限，必要时加重试与超时。`,
  UNKNOWN: null
};

// Codes that v0.74.0 may emit but are best phrased from context rather than a
// hard-coded map alone. Kept adjacent to REMEDIATION for discoverability.
function remediationFor(it) {
  if (!it || !it.code) return null;
  const fn = REMEDIATION[it.code];
  if (fn === undefined) {
    // Fallback: any unknown code still gets a generic, severity-aware nudge so
    // the suggestion list is never empty when issues exist.
    return `第 ${it.step || '?'} 步存在${it.severity === 'error' ? '硬性' : '需关注'}问题（${it.code}），请复核。`;
  }
  if (fn === null) return null;
  return typeof fn === 'function' ? fn(it) : fn;
}

const SEV_RANK = { error: 0, warning: 1, info: 2 };

export const PLAN_REFINE_VERSION = '0.75.0';

// refinePlan(assessment, { goal = '' } = {}) → { ok, level, score, suggestions[], goal }
//   assessment: the object returned by validatePlan ({ ok, score, level, issues[], stats, goal })
//   goal:       optional run objective, echoed back for trace continuity
// → suggestions: [{ severity, code, step, message }] sorted error → warning → info
export function refinePlan(assessment, { goal = '' } = {}) {
  const a = assessment || {};
  const issues = Array.isArray(a.issues) ? a.issues : [];
  const suggestions = issues
    .map((it) => {
      const text = remediationFor(it);
      if (!text) return null;
      return {
        severity: it.severity || 'info',
        code: it.code || 'UNKNOWN',
        step: (typeof it.step === 'number') ? it.step : null,
        message: text
      };
    })
    .filter(Boolean)
    .sort((x, y) => (SEV_RANK[x.severity] ?? 9) - (SEV_RANK[y.severity] ?? 9));

  const hasError = suggestions.some((s) => s.severity === 'error');
  const hasWarn = suggestions.some((s) => s.severity === 'warning');
  const level = hasError ? 'fail' : hasWarn ? 'warn' : 'pass';
  const ok = !hasError;
  const score = Math.max(0, Number(a.score) || 0);
  return {
    ok,
    level,
    score,
    suggestions,
    goal: goal || a.goal || null
  };
}
