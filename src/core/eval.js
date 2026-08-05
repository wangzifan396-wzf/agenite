// Agenite Eval — a local-first, trace-driven evaluation loop.
//
// The 2026 pattern (LangChain State of Agent Engineering, Arthur AI, Braintrust):
//   89% of teams have observability, but only 52% run OFFLINE evals before
//   deploying. The fix is a "golden replay" regression suite — capture a real
//   run as a trace, freeze its tool responses, then re-run the agent against
//   frozen tools so the MODEL is the only variable. A regression is then a
//   deterministic, repeatable signal, not a production surprise.
//
// Agenite is uniquely placed to do this locally: every run is already saved as
// a trace under ~/.agenite/traces. We turn those real runs into the test set —
// no synthetic benchmark, no cloud, no API keys for the replay itself (tool
// results are frozen). That is the moat no local-first competitor (OpenJarvis,
// Atomic Agent, OpenHuman, CoPaw) has shipped.
//
// Scoring follows the CLASSic framework (Cost, Latency, Accuracy, Stability,
// Security) — multi-dimensional, not accuracy-only:
//   reachedEnd    Accuracy:      did the run reach a terminal answer?
//   toolAdherence Stability:     did it call the SAME tools in the SAME order?
//   costDelta     Cost:          replay cost vs the reference run's cost
//   diagnosis     Security/Safety: reuse diagnoseTrace (loop/error/budget smells)
//
// Pure functions only (except the persistence block, which takes an injected
// dir), so the whole thing is unit-testable with a fake model — no DOM, no
// network, no API key.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir, readdir, unlink, rename, stat } from 'node:fs/promises';

import { newTrace, addStep, classifyTool, traceCost, diagnoseTrace, TRACE_VERSION } from './trace.js';
import { runAgent } from './agent.js';

export const EVAL_VERSION = 1;
export const EVALS_DIR = join(homedir(), '.agenite', 'evals');
const MAX_EVALS = 100;
const BASELINE_FILE = 'baseline.json';

function eid() {
  return 'eval_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function keyOf(name, args) {
  return name + '|' + JSON.stringify(args || {});
}

// ── Case extraction ────────────────────────────────────────────────────────
// Turn a finished trace into an eval case: the user's input prompt + the
// frozen sequence of tool calls (name/args/result) seen in the run.
export function traceToCase(trace) {
  const toolSteps = (trace.steps || []).filter((s) => s.kind === 'tool');
  const steps = toolSteps.map((s) => ({
    name: s.name,
    args: s.data && s.data.args != null ? s.data.args : {},
    result: s.data ? s.data.result : undefined,
    ok: s.status !== 'error',
    ms: s.ms || 0,
    kind: (s.data && s.data.kind) || classifyTool(s.name)
  }));
  const expectedTools = steps.map((s) => s.name);
  return {
    id: 'case_' + (trace.runId || eid()),
    runId: trace.runId || null,
    title: trace.title || (trace.runId || 'case'),
    input: trace.input || trace.title || '',
    steps,
    expectedTools,
    expectedCost: traceCost(trace),
    expectedStopped: trace.stopped || 'done',
    expectedDiagnosis: diagnoseTrace(trace, { maxCostUSD: 0 }).severity
  };
}

// ── Frozen replay ──────────────────────────────────────────────────────────
// Freeze the golden tool responses. When the model calls a tool present in the
// golden set (by name+args), replay the recorded result. Anything else is a
// "drift": the run continues but toolAdherence fails — surfacing that the agent
// did something the reference run never did (a classic regression signal).
export function frozenExecuteTool(caseObj) {
  const map = new Map();
  for (const s of caseObj.steps) map.set(keyOf(s.name, s.args), s);
  return async (name, args) => {
    const k = keyOf(name, args);
    if (map.has(k)) {
      const s = map.get(k);
      return { ok: s.ok, content: s.result, error: s.ok ? undefined : s.result, frozen: true };
    }
    // Drift: tool/args not in the golden set.
    return { ok: false, content: '', error: `EVAL_DRIFT: 工具调用不在黄金集中（${name}）`, frozen: false };
  };
}

// ── Scoring ────────────────────────────────────────────────────────────────
function seqEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Score one replayed run against its golden case. Builds a synthetic trace so
// the existing diagnoseTrace (which reads stats + args) can grade it too.
export function scoreCase(caseObj, res, actualToolCalls, config) {
  const reachedEnd = res.stopped === 'done' || res.stopped === 'guardrail';
  const expected = caseObj.expectedTools || [];
  const actual = actualToolCalls.map((t) => t.name);
  const toolAdherence = seqEqual(expected, actual);
  const cost = (res.cost && typeof res.cost.amount === 'number')
    ? res.cost.amount
    : (Number(res.cost) || 0);
  const costDelta = cost - (caseObj.expectedCost || 0);

  const synth = newTrace({ title: caseObj.title, cost });
  for (const t of actualToolCalls) {
    addStep(synth, {
      kind: 'tool', name: t.name, ms: t.ms || 0,
      status: t.ok === false ? 'error' : 'ok',
      data: { args: t.args || {}, result: t.result, ok: t.ok, kind: classifyTool(t.name) }
    });
  }
  synth.turns = res.turns || 0;
  synth.stopped = res.stopped || null;
  const maxCostUSD = (config && config.budget && Number(config.budget.maxCostUSD) > 0)
    ? config.budget.maxCostUSD : 0;
  const diag = diagnoseTrace(synth, { maxCostUSD });

  // pass = reached a conclusion, called the right tools in the right order,
  // and the self-check didn't flag a 'bad' (e.g. a stuck loop).
  const pass = reachedEnd && toolAdherence && diag.severity !== 'bad';

  return {
    pass,
    reachedEnd,
    toolAdherence,
    actualTools: actual,
    expectedTools: expected,
    cost,
    expectedCost: caseObj.expectedCost || 0,
    costDelta,
    turns: res.turns || 0,
    stopped: res.stopped || null,
    diagnosis: diag.severity,
    findings: diag.findings.length,
    budgetUSD: maxCostUSD || null
  };
}

// ── Per-case run (multi-trial aggregation) ─────────────────────────────────
export async function runEvalCase(caseObj, { callModel, config, tools, trials = 1, onEvent, executeTool }) {
  const t = Math.max(1, trials);
  let passCount = 0;
  const trialScores = [];
  for (let i = 0; i < t; i++) {
    const actualToolCalls = [];
    const onEv = (type, payload) => {
      if (type === 'tool') {
        actualToolCalls.push({
          name: payload.name, args: payload.args, ok: payload.ok, result: payload.result, ms: payload.ms
        });
      }
      if (onEvent) onEvent(type, payload);
    };
    const res = await runAgent({
      messages: [{ role: 'user', content: caseObj.input || '' }],
      callModel,
      executeTool: frozenExecuteTool(caseObj),
      onEvent: onEv,
      config,
      tools
    });
    const s = scoreCase(caseObj, res, actualToolCalls, config);
    if (s.pass) passCount++;
    trialScores.push(s);
  }
  const last = trialScores[trialScores.length - 1];
  const worstDiag = trialScores.some((x) => x.diagnosis === 'bad')
    ? 'bad'
    : (trialScores.some((x) => x.diagnosis === 'warn') ? 'warn' : 'ok');
  return {
    caseId: caseObj.id,
    runId: caseObj.runId,
    title: caseObj.title,
    trials: t,
    passRate: passCount / t,
    pass: passCount === t,
    ...last,
    avgCost: mean(trialScores.map((x) => x.cost)),
    avgTurns: mean(trialScores.map((x) => x.turns)),
    avgCostDelta: mean(trialScores.map((x) => x.costDelta)),
    diagnosisWorst: worstDiag
  };
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

// ── Baseline diff (CI-gate style regression detection) ─────────────────────
function r3(n) { return Math.round(n * 1000) / 1000; }

export function diffBaseline(summary, baseline) {
  if (!baseline) return [];
  const reg = [];
  if (baseline.passRate > summary.passRate + 1e-4) {
    reg.push({ metric: 'passRate', before: r3(baseline.passRate), after: r3(summary.passRate), delta: r3(summary.passRate - baseline.passRate), worse: true });
  }
  if (summary.avgCost > baseline.avgCost * 1.05) {
    reg.push({ metric: 'avgCost', before: r3(baseline.avgCost), after: r3(summary.avgCost), delta: r3(summary.avgCost - baseline.avgCost), worse: true });
  }
  if (summary.avgTurns > baseline.avgTurns * 1.1) {
    reg.push({ metric: 'avgTurns', before: r3(baseline.avgTurns), after: r3(summary.avgTurns), delta: r3(summary.avgTurns - baseline.avgTurns), worse: true });
  }
  return reg;
}

// ── Full eval run ───────────────────────────────────────────────────────────
export async function runEval({ cases, callModel, config, tools, trials = 1, onEvent, dir = EVALS_DIR }) {
  const results = [];
  for (const c of cases) {
    if (onEvent) onEvent('eval_case_start', { caseId: c.id, title: c.title });
    const rec = await runEvalCase(c, { callModel, config, tools, trials, onEvent });
    results.push(rec);
    if (onEvent) onEvent('eval_case_done', { caseId: c.id, pass: rec.pass });
  }
  const passCount = results.filter((r) => r.pass).length;
  const summary = {
    cases: results.length,
    passRate: results.length ? passCount / results.length : 0,
    avgCost: mean(results.map((r) => r.avgCost)),
    avgTurns: mean(results.map((r) => r.avgTurns)),
    avgToolAdherence: results.length ? results.filter((r) => r.toolAdherence).length / results.length : 0,
    diagnosisOkRate: results.length ? results.filter((r) => r.diagnosisWorst !== 'bad').length / results.length : 0
  };
  const baseline = await loadBaseline(dir);
  const regressions = diffBaseline(summary, baseline);
  const report = {
    version: EVAL_VERSION,
    evalId: eid(),
    createdAt: Date.now(),
    model: config.model,
    provider: config.provider,
    trials: Math.max(1, trials),
    summary,
    regressions,
    hasBaseline: !!baseline,
    results
  };
  await saveEval(report, dir);
  await saveBaseline(summary, dir);
  return report;
}

// ── Persistence (injected directory) ────────────────────────────────────────
function evalFile(id) { return id + '.json'; }

export async function saveEval(report, dir = EVALS_DIR) {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, evalFile(report.evalId) + '.tmp');
  const final = join(dir, evalFile(report.evalId));
  await writeFile(tmp, JSON.stringify(report), 'utf8');
  await rename(tmp, final);
  return report;
}

export async function loadEval(dir = EVALS_DIR, id) {
  const text = await readFile(join(dir, evalFile(id)), 'utf8');
  const r = JSON.parse(text);
  if (!r || !Array.isArray(r.results)) throw new Error('损坏的评估文件');
  return r;
}

export async function listEvals(dir = EVALS_DIR) {
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json') && n !== BASELINE_FILE);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const r = JSON.parse(await readFile(join(dir, n), 'utf8'));
      out.push({
        evalId: r.evalId,
        createdAt: r.createdAt,
        model: r.model,
        provider: r.provider,
        trials: r.trials,
        summary: r.summary,
        regressions: (r.regressions || []).length,
        cases: (r.results || []).length
      });
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function deleteEval(dir = EVALS_DIR, id) {
  try {
    await unlink(join(dir, evalFile(id)));
    return true;
  } catch {
    return false;
  }
}

export async function loadBaseline(dir = EVALS_DIR) {
  try {
    const text = await readFile(join(dir, BASELINE_FILE), 'utf8');
    const j = JSON.parse(text);
    return j && j.summary ? j : null;
  } catch {
    return null;
  }
}

export async function saveBaseline(summary, dir = EVALS_DIR) {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, BASELINE_FILE + '.tmp');
  const final = join(dir, BASELINE_FILE);
  await writeFile(tmp, JSON.stringify({ savedAt: Date.now(), summary }), 'utf8');
  await rename(tmp, final);
  return summary;
}

// Keep at most MAX_EVALS, dropping the oldest by createdAt.
export async function pruneEvals(dir = EVALS_DIR, max = MAX_EVALS) {
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json') && n !== BASELINE_FILE);
  } catch {
    return 0;
  }
  if (names.length <= max) return 0;
  const withTime = [];
  for (const n of names) {
    try {
      const s = await stat(join(dir, n));
      withTime.push({ n, t: s.mtimeMs });
    } catch { /* ignore */ }
  }
  withTime.sort((a, b) => a.t - b.t);
  let removed = 0;
  for (const { n } of withTime.slice(0, withTime.length - max)) {
    try { await unlink(join(dir, n)); removed++; } catch { /* ignore */ }
  }
  return removed;
}

export { TRACE_VERSION };
