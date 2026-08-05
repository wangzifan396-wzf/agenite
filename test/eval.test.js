import assert from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  traceToCase, frozenExecuteTool, scoreCase, runEvalCase, runEval,
  diffBaseline, saveEval, loadEval, listEvals, deleteEval, loadBaseline, saveBaseline, pruneEvals
} from '../src/core/eval.js';
import { newTrace, addStep, diagnoseTrace, TRACES_DIR } from '../src/core/trace.js';

// Build a synthetic finished trace with the given tool calls.
function makeTrace({ steps, cost = 0.02, input = 'do the thing' } = {}) {
  const t = newTrace({ title: input.slice(0, 80), input, model: 'fake', provider: 'fake' });
  for (const s of steps) {
    addStep(t, {
      kind: 'tool', name: s.name, ms: s.ms || 10,
      status: s.ok === false ? 'error' : 'ok',
      data: { args: s.args || {}, result: s.result, ok: s.ok !== false, kind: (s.kind || 'tool') }
    });
  }
  t.cost = cost;
  t.stopped = 'done';
  t.turns = steps.length;
  return t;
}

// A fake model that replays a case's golden tool sequence exactly, then finishes.
function replayModel(caseObj) {
  return async (messages, { onDelta } = {}) => {
    const toolCount = (messages || []).filter((m) => m.role === 'tool').length;
    if (toolCount < caseObj.steps.length) {
      const s = caseObj.steps[toolCount];
      if (onDelta) onDelta('');
      return { content: '', toolCalls: [{ id: 'c' + toolCount, name: s.name, args: s.args }] };
    }
    if (onDelta) onDelta('final');
    return { content: 'final answer', toolCalls: [] };
  };
}

// A fake model that calls a tool NOT in the golden set (drift), then finishes.
function driftModel(unknownName = 'drift_tool') {
  return async (_messages, { onDelta } = {}) => {
    if (onDelta) onDelta('');
    return { content: '', toolCalls: [{ id: 'x1', name: unknownName, args: {} }] };
  };
}

const CONFIG = { model: 'fake', budget: { maxCostUSD: 3 }, maxTurns: 20 };

test('traceToCase extracts input and frozen tool sequence', () => {
  const t = makeTrace({
    steps: [
      { name: 'read_file', args: { path: 'a' }, result: 'x' },
      { name: 'write_file', args: { path: 'b' }, result: 'y' }
    ]
  });
  const c = traceToCase(t);
  assert.equal(c.input, 'do the thing');
  assert.deepEqual(c.expectedTools, ['read_file', 'write_file']);
  assert.equal(c.steps.length, 2);
  assert.equal(c.steps[0].name, 'read_file');
  assert.equal(c.steps[0].result, 'x');
  assert.equal(c.expectedCost, 0.02);
});

test('frozenExecuteTool replays golden results and flags drift', async () => {
  const t = makeTrace({ steps: [{ name: 'read_file', args: { path: 'a' }, result: 'x' }] });
  const c = traceToCase(t);
  const exec = frozenExecuteTool(c);
  const hit = await exec('read_file', { path: 'a' });
  assert.equal(hit.ok, true);
  assert.equal(hit.content, 'x');
  assert.equal(hit.frozen, true);
  const miss = await exec('read_file', { path: 'OTHER' });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /EVAL_DRIFT/);
  assert.equal(miss.frozen, false);
});

test('scoreCase: a faithful replay passes (reachedEnd + toolAdherence + ok diagnosis)', async () => {
  const t = makeTrace({
    steps: [
      { name: 'read_file', args: { path: 'a' }, result: 'x' },
      { name: 'write_file', args: { path: 'b' }, result: 'y' }
    ]
  });
  const c = traceToCase(t);
  const actual = [];
  const { runAgent } = await import('../src/core/agent.js');
  const res = await runAgent({
    messages: [{ role: 'user', content: c.input }],
    callModel: replayModel(c),
    executeTool: frozenExecuteTool(c),
    onEvent: (type, payload) => {
      if (type === 'tool') actual.push({ name: payload.name, args: payload.args, ok: payload.ok, result: payload.result, ms: payload.ms });
    },
    config: CONFIG,
    tools: []
  });
  const score = scoreCase(c, res, actual, CONFIG);
  assert.equal(score.pass, true);
  assert.equal(score.toolAdherence, true);
  assert.equal(score.reachedEnd, true);
  assert.equal(score.diagnosis, 'ok');
  assert.deepEqual(score.actualTools, ['read_file', 'write_file']);
});

test('runEvalCase: faithful replay => pass=true, toolAdherence=true', async () => {
  const t = makeTrace({
    steps: [
      { name: 'read_file', args: { path: 'a' }, result: 'x' },
      { name: 'write_file', args: { path: 'b' }, result: 'y' }
    ]
  });
  const c = traceToCase(t);
  const rec = await runEvalCase(c, {
    callModel: replayModel(c), config: CONFIG, tools: [], trials: 1
  });
  assert.equal(rec.pass, true);
  assert.equal(rec.toolAdherence, true);
  assert.equal(rec.reachedEnd, true);
  assert.equal(rec.diagnosisWorst, 'ok');
  assert.deepEqual(rec.actualTools, ['read_file', 'write_file']);
});

test('runEvalCase: drift (wrong tool) => toolAdherence=false, pass=false', async () => {
  const t = makeTrace({ steps: [{ name: 'read_file', args: { path: 'a' }, result: 'x' }] });
  const c = traceToCase(t);
  const rec = await runEvalCase(c, {
    callModel: driftModel('unknown_tool'), config: CONFIG, tools: [], trials: 1
  });
  assert.equal(rec.pass, false);
  assert.equal(rec.toolAdherence, false);
  assert.equal(rec.actualTools[0], 'unknown_tool');
});

test('runEvalCase: a stuck loop (identical calls) => diagnosis bad => pass=false', async () => {
  const steps = [];
  for (let i = 0; i < 5; i++) steps.push({ name: 'spin', args: {}, result: '...' });
  const t = makeTrace({ steps });
  const c = traceToCase(t);
  const rec = await runEvalCase(c, {
    callModel: replayModel(c), config: CONFIG, tools: [], trials: 1
  });
  // toolAdherence true (it replayed the same sequence), but diagnosis is bad.
  assert.equal(rec.toolAdherence, true);
  assert.equal(rec.diagnosisWorst, 'bad');
  assert.equal(rec.pass, false);
});

test('runEvalCase: trials aggregate passRate', async () => {
  const t = makeTrace({ steps: [{ name: 'read_file', args: { path: 'a' }, result: 'x' }] });
  const c = traceToCase(t);
  const rec = await runEvalCase(c, {
    callModel: replayModel(c), config: CONFIG, tools: [], trials: 3
  });
  assert.equal(rec.trials, 3);
  assert.equal(rec.passRate, 1);
  assert.equal(rec.pass, true);
});

test('diffBaseline flags passRate / cost / turns regressions', () => {
  const base = { passRate: 1, avgCost: 0.01, avgTurns: 2 };
  const worse = diffBaseline({ passRate: 0.5, avgCost: 0.05, avgTurns: 10 }, base);
  const metrics = worse.map((r) => r.metric).sort();
  assert.deepEqual(metrics, ['avgCost', 'avgTurns', 'passRate']);
  const same = diffBaseline({ passRate: 1, avgCost: 0.0101, avgTurns: 2 }, base);
  assert.equal(same.length, 0);
  const none = diffBaseline({ passRate: 1, avgCost: 0.01, avgTurns: 2 }, null);
  assert.equal(none.length, 0);
});

test('runEval: full run saves report + baseline, and second run detects baseline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenite-eval-'));
  try {
    const t = makeTrace({ steps: [{ name: 'read_file', args: { path: 'a' }, result: 'x' }] });
    const c = traceToCase(t);
    const r1 = await runEval({ cases: [c], callModel: replayModel(c), config: CONFIG, tools: [], trials: 1, dir });
    assert.equal(r1.summary.passRate, 1);
    assert.equal(r1.hasBaseline, false);
    assert.equal((await loadBaseline(dir)) !== null, true);
    // second identical run: now hasBaseline true, no regression
    const r2 = await runEval({ cases: [c], callModel: replayModel(c), config: CONFIG, tools: [], trials: 1, dir });
    assert.equal(r2.hasBaseline, true);
    assert.equal(r2.regressions.length, 0);
    const list = await listEvals(dir);
    assert.equal(list.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eval persistence: save/load/list/delete + prune', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenite-eval-'));
  try {
    const report = {
      version: 1, evalId: 'eval_test', createdAt: Date.now(),
      model: 'fake', provider: 'fake', trials: 1,
      summary: { cases: 1, passRate: 1, avgCost: 0.01, avgTurns: 1, avgToolAdherence: 1, diagnosisOkRate: 1 },
      regressions: [], hasBaseline: false, results: [{ caseId: 'c1', pass: true }]
    };
    await saveEval(report, dir);
    const loaded = await loadEval(dir, 'eval_test');
    assert.equal(loaded.evalId, 'eval_test');
    assert.equal((await listEvals(dir)).length, 1);
    assert.equal(await deleteEval(dir, 'eval_test'), true);
    assert.equal((await listEvals(dir)).length, 0);
    assert.equal(await deleteEval(dir, 'nope'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
