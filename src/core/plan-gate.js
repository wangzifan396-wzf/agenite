// v0.74.0 — Plan Quality Gate
// --------------------------------------------------------------------------
// A pure, model-free, IO-free validator for an agent's PLAN, evaluated BEFORE
// execution. The `plan` tool (tools.js) and Plan Mode (app.js) only record
// steps and ask a human to approve — but a human often clicks "approve"
// without checking whether the plan is executable, covers the goal, or trips
// a governance denyList. This gate is the missing automated quality check.
//
// Design notes (kept deliberately small so it never needs a model call):
//   * No network, no file IO, no LLM. Pure function → trivially unit-testable.
//   * It is ADVISORY, not a hard block: the plan still requires human approval
//     in Plan Mode. The gate surfaces a score + structured issues so the UI,
//     /api/health ledger and OTel can all consume one source of truth.
//   * It reuses the live guardrail policy (denyList) so "executable plan" and
//     "governance-compliant plan" mean the same thing the runtime enforces.
//
// Emits a `plan_gate` event: { ok, score, level, issues[], stats, goal }.

// Destructive operations the human must explicitly guard before executing.
const DESTRUCTIVE_RE = /\b(rm\s+-rf|rmdir|del\b|delete\s+(file|folder|dir|table)|drop\s+(table|database)|truncate|format|wipe|purge|destroy|shutdown|kill\b|force\s+push|--force|reset\s+--hard|rm\s+-fr)\b/i;
// Secret / credential material — must never be typed into a plan or logged.
const SECRET_RE = /\b(api[_-]?key|secret|token|password|passwd|credential|private[_-]?key|access[_-]?key|sk-[a-z0-9]{8,})\b/i;
// Network / external calls — fine, but worth surfacing for the rate-cap gate.
const NETWORK_RE = /\b(fetch|curl|wget|https?:\/\/|http\s+request|api\s+call|download|upload|post\s+to|get\s+url|scrape|crawl|send\s+email|smtp)\b/i;
// Vague / non-actionable language.
const VAGUE_RE = /\b(fix\s+it|do\s+the\s+thing|handle\s+that|stuff|things|maybe|probably|somehow|as\s+needed|etc\.?|and\s+so\s+on|tbd|later|something|whatever)\b/i;
// Verification / closing-the-loop steps. Latin tokens keep \b; CJK tokens are
// non-word chars so \b never matches around them — list them bare.
const VERIFY_RE = /\b(test|build|verify|check|validate|assert|run\s+(the\s+)?(suite|tests)|smoke\s+test|lint|typecheck|type[- ]?check|review)\b|复核|校验|验证|测试|构建|检查/i;
// Loop / repeat semantics that need an explicit termination condition.
const LOOP_RE = /\b(repeat|loop|again|re-?run|redo|circular|until\s+it|while\s+not|loop\s+until)\b|回到|重复|循环|再跑|重试.*直到/i;

export const PLAN_GATE_VERSION = '0.74.0';

function normSteps(input) {
  if (Array.isArray(input)) return input.map(String).filter(Boolean);
  if (typeof input === 'string') {
    return input.split(/\n+/).map((s) => s.replace(/^\s*\d+[.、)]\s*/, '').trim()).filter(Boolean);
  }
  return [];
}

// Light tokenization: latin/digit/underscore runs + CJK single chars.
function tokenize(text) {
  return (text || '').toLowerCase().match(/[a-z0-9_]+|[一-龥]/g) || [];
}

function finalize({ ok, score, level, issues, stats, goal }) {
  return { ok, score, level, issues, stats, goal: goal || null };
}

// validatePlan({ steps, text, goal, toolNames, guardPolicy })
//   steps:       string[] | string  (structured plan steps, or raw text)
//   text:        string              (free-text plan fallback)
//   goal:        string              (the run's objective, optional)
//   toolNames:   string[]            (tools registered for this run)
//   guardPolicy: { denyList: string[] }  (reuses v0.71 governance policy)
// → { ok, score, level, issues[], stats, goal }
export function validatePlan({ steps, text, goal, toolNames, guardPolicy } = {}) {
  const rawSteps = normSteps(steps);
  if (!rawSteps.length && typeof text === 'string' && text.trim()) {
    rawSteps.push(...normSteps(text));
  }
  // For analysis we always work on the expanded step list (never mutate input).
  const analysis = rawSteps.slice();

  const issues = [];
  const stats = {
    stepCount: analysis.length,
    goalCovered: false,
    riskyStepCount: 0,
    loopDetected: false,
    vagueStepCount: 0,
    toolUnknownCount: 0,
    denyHitCount: 0,
    networkStepCount: 0
  };

  // 1. Empty plan — structurally unexecutable.
  if (!analysis.length) {
    issues.push({
      severity: 'error',
      code: 'EMPTY_PLAN',
      message: '计划为空：既没有 steps 也没有 text，无法执行。请先列出具体步骤。'
    });
    return finalize({ ok: false, score: 0, level: 'fail', issues, stats, goal });
  }

  let score = 100;

  // 2. Single-step plan — works for trivial tasks, but flags missing milestones.
  if (analysis.length === 1) {
    issues.push({
      severity: 'info',
      code: 'SINGLE_STEP',
      message: '计划只有 1 步，缺少中间里程碑，难以追踪进度或在出错时回退。'
    });
    score -= 5;
  }

  // 3. Goal coverage — does the plan mention anything from the objective?
  const goalTokens = tokenize(goal || '');
  if (goalTokens.length) {
    const planText = analysis.join(' ').toLowerCase();
    const covered = goalTokens.some((t) => planText.includes(t));
    stats.goalCovered = covered;
    if (!covered) {
      issues.push({
        severity: 'warning',
        code: 'GOAL_UNCOVERED',
        message: '计划中未出现任何与目标相关的关键词，可能偏离任务方向。'
      });
      score -= 20;
    }
  }

  // 4. Governance tie-in — steps must not reference a denyList tool/action.
  const denyList = (guardPolicy && Array.isArray(guardPolicy.denyList))
    ? guardPolicy.denyList.map(String).filter(Boolean)
    : [];

  // 5. Per-step analysis: tool feasibility, risk, loop, vagueness.
  const knownLower = new Set(
    (Array.isArray(toolNames) ? toolNames : []).map((t) => String(t).toLowerCase()).filter(Boolean)
  );
  const skipTools = new Set(['the', 'a', 'an', 'my', 'our', 'this', 'that', 'it', 'tool', 'api', 'cli', 'all', 'each', 'them']);

  analysis.forEach((raw, idx) => {
    const s = String(raw);
    const lower = s.toLowerCase();
    const stepNo = idx + 1;

    // Tool feasibility: "use X / call X / run X / via X" referencing an
    // unregistered tool name means the plan cannot be executed as written.
    // Latin refs keep \b; CJK refs (用/调用/运行) are bare — \b never matches
    // around non-word (CJK) chars.
    const toolRef = lower.match(/\b(?:use|call|run|invoke|via|with)\b\s+([a-z_][a-z0-9_]*)|(?:用|调用|运行)\s+([a-z_][a-z0-9_]*)/);
    const toolName = toolRef ? (toolRef[1] || toolRef[2]) : null;
    if (toolName && !knownLower.has(toolName) && !skipTools.has(toolName)) {
      stats.toolUnknownCount++;
      issues.push({
        severity: 'warning',
        code: 'UNKNOWN_TOOL',
        message: `第 ${stepNo} 步引用了未在工具集中注册的工具「${toolName}」，该步骤无法执行。`,
        step: stepNo
      });
      score -= 6;
    }

    if (DESTRUCTIVE_RE.test(s)) {
      stats.riskyStepCount++;
      issues.push({
        severity: 'warning',
        code: 'DESTRUCTIVE_STEP',
        message: `第 ${stepNo} 步含破坏性操作，建议加护栏/审批后再执行。`,
        step: stepNo
      });
      score -= 12;
    }

    if (SECRET_RE.test(s)) {
      stats.riskyStepCount++;
      issues.push({
        severity: 'warning',
        code: 'SECRET_REF',
        message: `第 ${stepNo} 步涉及密钥/凭据，切勿明文写入计划或日志。`,
        step: stepNo
      });
      score -= 10;
    }

    if (denyList.some((d) => d && lower.includes(String(d).toLowerCase()))) {
      stats.denyHitCount++;
      issues.push({
        severity: 'error',
        code: 'DENYLIST_HIT',
        message: `第 ${stepNo} 步命中治理 denyList（${denyList.join(', ')}），将在运行时被硬性拒绝。`,
        step: stepNo
      });
      score -= 40;
    }

    if (LOOP_RE.test(s)) {
      stats.loopDetected = true;
      issues.push({
        severity: 'warning',
        code: 'LOOP_STEP',
        message: `第 ${stepNo} 步含循环/重复语义，需明确终止条件，避免无限循环。`,
        step: stepNo
      });
      score -= 15;
    }

    if (VAGUE_RE.test(s) || s.trim().length < 6) {
      stats.vagueStepCount++;
      issues.push({
        severity: 'info',
        code: 'VAGUE_STEP',
        message: `第 ${stepNo} 步过于模糊或太短，建议写成可验证的具体动作。`,
        step: stepNo
      });
      score -= 5;
    }

    if (NETWORK_RE.test(s)) stats.networkStepCount++;
  });

  // 6. Implementation-type goals need a verification/closing step.
  const implGoal = /(实现|开发|写|构建|修|重构|创建|添加|fix|implement|build|code|refactor|develop|create|add|write)/i.test(goal || '');
  const implStep = analysis.some((s) => /(实现|开发|写|构建|修|重构|fix|implement|build|code|refactor)/i.test(s));
  if ((implGoal || implStep) && !analysis.some((s) => VERIFY_RE.test(s))) {
    issues.push({
      severity: 'warning',
      code: 'NO_VERIFY',
      message: '计划缺少验证/测试步骤（"完成"不等于"正确"），建议追加验证项。'
    });
    score -= 10;
  }

  // 7. Network awareness (info only — not a deduction).
  if (stats.networkStepCount) {
    issues.push({
      severity: 'info',
      code: 'NETWORK_STEP',
      message: `计划含 ${stats.networkStepCount} 处网络/外部调用，注意网络护栏与速率上限。`,
      stepCount: stats.networkStepCount
    });
  }

  score = Math.max(0, Math.min(100, score));

  let level;
  if (issues.some((i) => i.severity === 'error') || score < 50) level = 'fail';
  else if (score >= 80 && !issues.some((i) => i.severity === 'warning')) level = 'pass';
  else level = 'warn';

  const ok = level !== 'fail';
  return finalize({ ok, score, level, issues, stats, goal });
}

// Convenience for the UI: textual level label + color hint.
export function planGateLabel(level) {
  if (level === 'pass') return '通过';
  if (level === 'warn') return '需关注';
  if (level === 'fail') return '不合格';
  return '未知';
}
