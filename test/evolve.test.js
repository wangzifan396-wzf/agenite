import assert from 'node:assert';
import { test } from 'node:test';
import {
  traceHealth,
  rankTraces,
  configSignature,
  diffConfigs,
  computeDrift,
  bestModelFromTraces,
  distillBestPreset
} from '../src/core/evolve.js';
import { buildPreset } from '../src/core/presets.js';

const trace = (over = {}) => ({
  runId: 'run_1',
  title: 'demo',
  model: 'deepseek-chat',
  provider: 'deepseek',
  createdAt: 1000,
  turns: 3,
  cost: 0.01,
  stats: { steps: 10, tools: 5, errors: 0, compactions: 0, memoryOps: 0, subagents: 0, totalMs: 1000 },
  ...over
});

test('traceHealth: a clean run scores high (ok)', () => {
  const h = traceHealth(trace({ turns: 1, cost: 0, stats: { errors: 0, tools: 1 } }));
  assert.strictEqual(h.score, 1);
  assert.strictEqual(h.severity, 'ok');
  assert.strictEqual(h.errors, 0);
});

test('traceHealth: errors and loops drive the score down and severity to bad', () => {
  const h = traceHealth(trace({ stats: { errors: 8, tools: 10, loops: 0 }, stopped: true, cost: 5, turns: 20 }));
  assert.ok(h.score < 0.5, 'should be heavily penalized');
  assert.strictEqual(h.severity, 'bad');
  assert.ok(h.score >= 0 && h.score <= 1);
});

test('traceHealth: score is clamped to [0,1] and rounded', () => {
  const h = traceHealth(trace({ stats: { errors: 999, tools: 999 } }));
  assert.ok(h.score >= 0 && h.score <= 1);
  assert.strictEqual(h.score, Math.round(h.score * 1000) / 1000);
});

test('rankTraces: orders by score (best first) by default', () => {
  const traces = [
    trace({ runId: 'a', stats: { errors: 9, tools: 9 } }),
    trace({ runId: 'b', stats: { errors: 0, tools: 2 } }),
    trace({ runId: 'c', model: 'x', provider: 'p', stats: { errors: 3, tools: 3 } })
  ];
  const ranked = rankTraces(traces);
  assert.strictEqual(ranked[0].runId, 'b');
  assert.strictEqual(ranked[2].runId, 'a');
});

test('rankTraces: can order by cost descending (worst first)', () => {
  const traces = [trace({ runId: 'a', cost: 0.1 }), trace({ runId: 'b', cost: 9.9 })];
  const ranked = rankTraces(traces, 'cost');
  assert.strictEqual(ranked[0].runId, 'b');
});

test('configSignature: stable and sensitive to behavioral fields, ignores apiKey', () => {
  const a = { provider: 'deepseek', model: 'deepseek-chat', approvalMode: 'ask', apiKey: 'sk-SECRET', workspace: '/x', skills: [1, 2] };
  const b = { ...a, apiKey: 'sk-DIFFERENT', workspace: '/y' };
  assert.strictEqual(configSignature(a), configSignature(b), 'secrets/workspace must not affect signature');
  const c = { ...a, approvalMode: 'deny' };
  assert.notStrictEqual(configSignature(a), configSignature(c), 'behavioral change must change signature');
  assert.ok(!configSignature(a).includes('sk-SECRET'));
});

test('diffConfigs: flags changed fields, leaves unchanged ones false', () => {
  const before = { provider: 'deepseek', model: 'deepseek-chat', approvalMode: 'ask', skills: [1, 2] };
  const after = { provider: 'deepseek', model: 'gpt-4', approvalMode: 'ask', skills: [1, 2, 3] };
  const d = diffConfigs(before, after);
  const byField = Object.fromEntries(d.map((x) => [x.field, x]));
  assert.strictEqual(byField.model.changed, true);
  assert.strictEqual(byField.skills.changed, true);
  assert.strictEqual(byField.approvalMode.changed, false);
  assert.strictEqual(byField.provider.changed, false);
});

test('computeDrift: classifies passRate/avgCost/avgTurns as better/worse/same', () => {
  const before = { passRate: 0.9, avgCost: 0.1, avgTurns: 5 };
  const after = { passRate: 0.8, avgCost: 0.2, avgTurns: 8 }; // everything got worse
  const drift = computeDrift(before, after);
  assert.strictEqual(drift.regressed.length, 3);
  assert.strictEqual(drift.improved.length, 0);

  const better = computeDrift(before, { passRate: 0.95, avgCost: 0.05, avgTurns: 3 });
  assert.strictEqual(better.improved.length, 3);
  assert.strictEqual(better.regressed.length, 0);

  const same = computeDrift(before, { ...before });
  assert.strictEqual(same.unchanged.length, 3);
});

test('bestModelFromTraces: picks the highest-average-health model', () => {
  const traces = [
    trace({ runId: 'a', model: 'good', provider: 'p', stats: { errors: 0, tools: 1 } }),
    trace({ runId: 'b', model: 'good', provider: 'p', stats: { errors: 0, tools: 1 } }),
    trace({ runId: 'c', model: 'bad', provider: 'p', stats: { errors: 9, tools: 9 }, cost: 3 }),
    trace({ runId: 'd', model: 'bad', provider: 'p', stats: { errors: 9, tools: 9 }, cost: 3 })
  ];
  const best = bestModelFromTraces(traces);
  assert.strictEqual(best.model, 'good');
  assert.strictEqual(best.samples, 2);
  assert.ok(best.avgHealth > 0.9);
});

test('bestModelFromTraces: tie on health breaks to the cheaper model', () => {
  const traces = [
    trace({ runId: 'a', model: 'x', provider: 'p', cost: 2, stats: { errors: 0, tools: 1 } }),
    trace({ runId: 'b', model: 'y', provider: 'p', cost: 0.01, stats: { errors: 0, tools: 1 } })
  ];
  const best = bestModelFromTraces(traces);
  assert.strictEqual(best.model, 'y');
});

test('bestModelFromTraces: returns null with no runs', () => {
  assert.strictEqual(bestModelFromTraces([]), null);
});

test('distillBestPreset: returns a preset with the best model and no secret', () => {
  const traces = [
    trace({ runId: 'a', model: 'winner', provider: 'deepseek', stats: { errors: 0, tools: 1 } }),
    trace({ runId: 'b', model: 'loser', provider: 'openai', stats: { errors: 8, tools: 8 }, cost: 3 })
  ];
  const base = { provider: 'openai', model: 'loser', apiKey: 'sk-BASE', workspace: '/base', approvalMode: 'ask' };
  const preset = distillBestPreset(traces, base, { name: 'test' });
  assert.ok(preset, 'should produce a preset');
  assert.strictEqual(preset.config.model, 'winner');
  assert.strictEqual(preset.config.provider, 'deepseek');
  assert.strictEqual('apiKey' in preset.config, false, 'preset must never carry apiKey');
  assert.strictEqual('workspace' in preset.config, false, 'preset must never carry workspace');
});

test('distillBestPreset: null when there are no runs to learn from', () => {
  assert.strictEqual(distillBestPreset([], { model: 'x' }), null);
});

test('evolve reuses buildPreset rules (no apiKey even if base has one)', () => {
  const p = buildPreset({ model: 'm', apiKey: 'sk-X', workspace: '/w' });
  assert.strictEqual('apiKey' in p.config, false);
  assert.strictEqual('workspace' in p.config, false);
});
