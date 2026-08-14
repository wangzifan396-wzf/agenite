// Experience Compounding — Agenite's self-evolution layer.
//
// Agenite already records every run as a trace and can replay runs as an eval
// suite (v0.48 / v0.52). That gives us *instruments* but not a *loop*. This
// module closes the loop: it turns the firehose of past runs into a small set
// of actionable, rigorous signals — "your agent's best-known configuration",
// "this change regressed 3 historical tasks", "here is the config that worked
// last time, one click away" — so the agent literally compounds experience
// instead of starting from zero every session.
//
// Why this is defensible vs. the 2026 field: Hermes Agent (60k stars) brands
// itself "the agent that grows with you" but its self-improvement is a
// 5-tool-call heuristic. Agenite grounds the same idea in hard signals it
// already has: per-run health (errors / cost / turns / loops) and eval
// pass-rate, so a "best config" is earned from evidence, not guessed.
//
// Pure module: no DOM, no fs, no node: imports. Safe to import from the
// browser bundle (app.js) and from node:test. Depends only on presets.js
// (which pulls in the pure config.js).

import { buildPreset, PRESET_FIELDS } from './presets.js';

// Behavioral config fields that meaningfully change *how the agent behaves*.
// Used for the stable config signature and the human-readable diff. Secrets
// and local paths are deliberately absent (they come from PRESET_FIELDS rules
// upstream and are never diffed/exposed here).
const EVOLVE_FIELDS = [
  'provider', 'model', 'approvalMode', 'planMode', 'dangerTools',
  'autoVerify', 'contextCompress', 'maxReflections', 'selfHeal',
  'gitCheckpoint', 'kbEnabled', 'autoSkill', 'agentEnabled'
];

const FIELD_LABELS = {
  provider: '模型厂商',
  model: '模型',
  approvalMode: '权限模式',
  planMode: '计划模式',
  dangerTools: '危险工具',
  autoVerify: '自动验证',
  contextCompress: '上下文压缩',
  maxReflections: '最大反思轮',
  selfHeal: '自愈',
  gitCheckpoint: 'git 检查点',
  kbEnabled: '知识库',
  autoSkill: '自动技能',
  agentEnabled: '智能体',
  toolAllowlist: '工具白名单数',
  skills: '技能数'
};

// ── Per-run health ──────────────────────────────────────────────────────────

// Grade a single run into a 0..1 health score plus a coarse severity. Uses only
// what a stored trace actually carries (stats / cost / turns / stopped) so it
// works identically in the browser (from /api/traces) and in node:test.
export function traceHealth(trace, opts = {}) {
  const t = trace || {};
  const s = t.stats || {};
  const errors = Number(s.errors) || 0;
  const cost = Number(t.cost) || 0;
  const turns = Number(t.turns) || 0;
  const tools = Number(s.tools) || 0;
  const loops = Number(t.loops) || (t.consecutiveLoop && t.consecutiveLoop.count) || 0;
  const stopped = !!t.stopped;

  let score = 1;
  if (stopped) score -= 0.2;                       // ran but was halted mid-task
  score -= Math.min(errors * 0.06, 0.35);          // each failed tool call hurts
  score -= Math.min(loops * 0.08, 0.3);            // spinning in a loop is bad
  score -= Math.min(cost * 0.05, 0.2);             // burning budget is bad
  score -= Math.min(Math.max(turns - 1, 0) * 0.015, 0.2); // more turns = more risk
  score = Math.max(0, Math.min(1, score));
  score = Math.round(score * 1000) / 1000;

  const severity = score >= 0.85 ? 'ok' : score >= 0.55 ? 'warn' : 'bad';
  return {
    runId: t.runId,
    title: t.title,
    model: t.model,
    provider: t.provider,
    createdAt: t.createdAt,
    errors,
    cost,
    turns,
    tools,
    loops,
    stopped,
    score,
    severity
  };
}

// Rank traces by a metric. dir: 'score' (best first, default), 'cost',
// 'errors', 'turns' (each worst-first). Returns traceHealth objects.
export function rankTraces(traces, dir = 'score') {
  const list = (traces || []).map(traceHealth);
  const cmp = {
    score: (a, b) => b.score - a.score,
    cost: (a, b) => b.cost - a.cost,
    errors: (a, b) => b.errors - a.errors,
    turns: (a, b) => b.turns - a.turns
  }[dir] || ((a, b) => b.score - a.score);
  return list.sort(cmp);
}

// ── Config fingerprint & diff ───────────────────────────────────────────────

// Stable, comparable fingerprint of a config's *behavior*. Two configs that
// behave identically produce the same signature even if their secrets or
// workspace differ — so it's safe to compare "before vs after a change".
export function configSignature(config) {
  const c = config || {};
  const fmt = (v) => (Array.isArray(v) ? v.length : (v === undefined || v === null ? '' : v));
  const parts = EVOLVE_FIELDS.map((k) => k + '=' + fmt(c[k]));
  parts.push('toolAllowlist=' + (Array.isArray(c.toolAllowlist) ? c.toolAllowlist.length : 0));
  parts.push('skills=' + (Array.isArray(c.skills) ? c.skills.length : 0));
  return parts.join('|');
}

// Field-level diff between two configs. Only the behavioral fields are compared
// (arrays reduced to their length). Returns one row per field with `changed`.
export function diffConfigs(before, after) {
  const a = before || {};
  const b = after || {};
  const keys = [...EVOLVE_FIELDS, 'toolAllowlist', 'skills'];
  return keys.map((k) => {
    let av = a[k];
    let bv = b[k];
    if (Array.isArray(av)) av = av.length;
    if (Array.isArray(bv)) bv = bv.length;
    const changed = JSON.stringify(av) !== JSON.stringify(bv);
    return { field: k, label: FIELD_LABELS[k] || k, before: av, after: bv, changed };
  });
}

// ── Eval drift (generalizes diffBaseline into a reusable reporter) ───────────

const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;

// Compare two eval summaries (passRate / avgCost / avgTurns) and classify each
// metric as better / worse / same. Higher passRate is better; lower cost and
// lower turns are better. Thresholds mirror the v0.52 baseline gate so the
// sentinel and the eval harness agree on what counts as a regression.
export function computeDrift(before = {}, after = {}) {
  const items = [];
  if ('passRate' in before || 'passRate' in after) {
    const b = r3(before.passRate), a = r3(after.passRate);
    const worse = a < b - 1e-4;
    const better = a > b + 1e-4;
    items.push({ metric: 'passRate', label: '通过率', before: b, after: a, delta: r3(a - b), direction: worse ? 'worse' : better ? 'better' : 'same' });
  }
  if ('avgCost' in before || 'avgCost' in after) {
    const b = r3(before.avgCost), a = r3(after.avgCost);
    const worse = a > b * 1.05 + 1e-9;
    const better = a < b * 0.95 - 1e-9;
    items.push({ metric: 'avgCost', label: '平均成本', before: b, after: a, delta: r3(a - b), direction: worse ? 'worse' : better ? 'better' : 'same' });
  }
  if ('avgTurns' in before || 'avgTurns' in after) {
    const b = r3(before.avgTurns), a = r3(after.avgTurns);
    const worse = a > b * 1.10 + 1e-9;
    const better = a < b * 0.90 - 1e-9;
    items.push({ metric: 'avgTurns', label: '平均轮次', before: b, after: a, delta: r3(a - b), direction: worse ? 'worse' : better ? 'better' : 'same' });
  }
  return {
    improved: items.filter((i) => i.direction === 'better'),
    regressed: items.filter((i) => i.direction === 'worse'),
    unchanged: items.filter((i) => i.direction === 'same'),
    items
  };
}

// ── Best-config distillation ─────────────────────────────────────────────────

// Group runs by (provider / model) and pick the combo with the highest average
// health; ties break toward the cheaper one. This is the "your agent's best
// self so far" — earned from real runs, not a guess.
export function bestModelFromTraces(traces) {
  const list = (traces || []).map(traceHealth).filter((h) => h.model);
  if (!list.length) return null;
  const groups = new Map();
  for (const h of list) {
    const key = (h.provider || '?') + '/' + h.model;
    if (!groups.has(key)) groups.set(key, { model: h.model, provider: h.provider, scores: [], costs: [] });
    const g = groups.get(key);
    g.scores.push(h.score);
    g.costs.push(h.cost);
  }
  const mean = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  let best = null;
  for (const g of groups.values()) {
    const avgHealth = Math.round(mean(g.scores) * 1000) / 1000;
    const avgCost = Math.round(mean(g.costs) * 1000) / 1000;
    const samples = g.scores.length;
    if (
      !best ||
      avgHealth > best.avgHealth + 1e-9 ||
      (Math.abs(avgHealth - best.avgHealth) <= 1e-9 && avgCost < best.avgCost - 1e-9)
    ) {
      best = { model: g.model, provider: g.provider, avgHealth, avgCost, samples };
    }
  }
  return best;
}

// Distill the best-performing model into a shareable preset built on top of the
// user's current config. Reuses buildPreset, which hard-excludes apiKey /
// workspace — so the distilled preset can never carry a secret or relocate the
// sandbox. Returns null when there are no runs to learn from.
export function distillBestPreset(traces, baseConfig, meta = {}) {
  const best = bestModelFromTraces(traces);
  if (!best) return null;
  const cfg = { ...(baseConfig || {}), model: best.model, provider: best.provider };
  return buildPreset(cfg, {
    name: meta.name || ('经验最佳配置 · ' + best.model),
    description:
      meta.description ||
      `从 ${best.samples} 次真实运行中蒸馏出表现最佳的模型配置（平均健康分 ${best.avgHealth}，平均成本 $${best.avgCost}）。`,
    author: meta.author || 'Agenite 自进化'
  });
}

// Re-export for callers that want the allowlist without importing presets.js.
export { PRESET_FIELDS };
