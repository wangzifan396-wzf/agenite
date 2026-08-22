import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCoherence, PLAN_COHERE_VERSION } from '../src/core/plan-cohere.js';
import { runAgent } from '../src/core/agent.js';

// assessCoherence compares the agent's WRITTEN plan against the decompose draft
// + the run goal and reports structural drift. These tests pin the pure logic.

const draftFull = { goal: '实现登录接口', kinds: { research: 1, action: 1, verify: 1 }, ok: true };

test('PLAN_COHERE_VERSION is exported and at v0.77.0', () => {
  assert.equal(typeof PLAN_COHERE_VERSION, 'string');
  assert.equal(PLAN_COHERE_VERSION, '0.77.0');
});

// Empty plan → advisory fail with a dedicated code (gate already flags this,
// but coherence reports it on its own stack so the timeline shows the gap).
test('assessCoherence: empty plan is a fail (COHERENCE_NO_PLAN)', () => {
  const r = assessCoherence({ goal: '实现登录接口', draft: draftFull, plan: [] });
  assert.equal(r.ok, false);
  assert.equal(r.level, 'fail');
  assert.equal(r.score, 0);
  assert.ok(r.issues.some((i) => i.code === 'COHERENCE_NO_PLAN'));
});

// A plan that matches the seeded draft shape and the goal → coherent (pass).
test('assessCoherence: plan coherent with draft + goal → pass', () => {
  const plan = ['调研登录的需求', '实现登录接口核心逻辑', '编写测试验证行为'];
  const r = assessCoherence({ goal: '实现登录接口', draft: draftFull, plan });
  assert.equal(r.level, 'pass');
  assert.equal(r.ok, true);
  assert.equal(r.stats.orderOk, true);
  assert.equal(r.stats.goalAligned, true);
  assert.deepEqual(r.stats.droppedKinds, []);
});

// The draft seeded a verify step; the written plan dropped it → DROPPED_KIND.
test('assessCoherence: dropped kind vs draft → warning + droppedKinds', () => {
  const plan = ['调研登录的需求', '实现登录接口核心逻辑'];
  const r = assessCoherence({ goal: '实现登录接口', draft: draftFull, plan });
  assert.equal(r.level, 'warn');
  assert.ok(r.issues.some((i) => i.code === 'DROPPED_KIND'));
  assert.ok(r.issues.some((i) => i.code === 'NO_VERIFY_COHERENCE'));
  assert.deepEqual(r.stats.droppedKinds, ['verify']);
  assert.equal(r.stats.orderOk, true);
});

// verify before action → ordering incoherent (ORDER_INCOHERENT).
test('assessCoherence: verify before action → ORDER_INCOHERENT', () => {
  const plan = ['验证行为符合预期', '调研需求', '实现逻辑'];
  const r = assessCoherence({ goal: '实现登录接口', draft: draftFull, plan });
  assert.equal(r.stats.orderOk, false);
  assert.ok(r.issues.some((i) => i.code === 'ORDER_INCOHERENT'));
  assert.equal(r.level, 'warn');
});

// Plan unrelated to the goal → GOAL_DRIFT (goal-alignment stat is false).
test('assessCoherence: goal drift → GOAL_DRIFT warning', () => {
  const plan = ['调研天气情况', '做一顿饭', '检查桌子是否干净'];
  const r = assessCoherence({ goal: '实现登录接口', draft: draftFull, plan });
  assert.equal(r.stats.goalAligned, false);
  assert.ok(r.issues.some((i) => i.code === 'GOAL_DRIFT'));
});

// No draft (run had no goal) → draft-completeness is skipped; a structurally
// sound plan still passes without spurious DROPPED_KIND issues.
test('assessCoherence: null draft skips completeness, still coherent', () => {
  const plan = ['调研X', '实现X', '验证X'];
  const r = assessCoherence({ goal: '', draft: null, plan });
  assert.equal(r.level, 'pass');
  assert.equal(r.stats.orderOk, true);
  assert.deepEqual(r.stats.droppedKinds, []);
  assert.ok(!r.issues.some((i) => i.code === 'DROPPED_KIND'));
});

// Integration: runAgent emits plan_cohere for the plan the agent writes, with
// the draft (from decompose) and goal threaded in, on the same event stack.
test('runAgent emits plan_cohere with coherent assessment', async () => {
  const events = [];
  let callCount = 0;
  const callModel = async (_msgs, { onDelta }) => {
    callCount++;
    if (callCount === 1) {
      return {
        content: '',
        toolCalls: [{
          id: 'p1', name: 'plan',
          args: { steps: ['调研登录需求', '实现登录接口核心逻辑', '编写测试验证行为'] }
        }],
        usage: null
      };
    }
    onDelta('done');
    return { content: 'done', toolCalls: [], usage: null };
  };
  const executeTool = async () => ({ ok: true, content: 'ok' });
  await runAgent({
    messages: [{ role: 'user', content: '实现登录接口' }],
    callModel, executeTool,
    config: {}, tools: [{ name: 'read_file' }, { name: 'write_file' }, { name: 'run_tests' }],
    goal: '实现登录接口',
    onEvent: (t, p) => events.push([t, p])
  });
  const cohere = events.find(([t]) => t === 'plan_cohere');
  assert.ok(cohere, 'expected a plan_cohere event');
  assert.equal(cohere[1].goal, '实现登录接口');
  assert.equal(typeof cohere[1].score, 'number');
  assert.ok(['pass', 'warn', 'fail'].includes(cohere[1].level));
  assert.equal(typeof cohere[1].stats.orderOk, 'boolean');
  assert.ok(cohere[1].version, 'should carry a version');
  // The full planning lifecycle fires in order: decompose → gate → refine → cohere.
  const order = events.map(([t]) => t);
  const di = order.indexOf('plan_decompose');
  const gi = order.indexOf('plan_gate');
  const ri = order.indexOf('plan_refine');
  const ci = order.indexOf('plan_cohere');
  assert.ok(di >= 0 && gi >= 0 && ri >= 0 && ci >= 0);
  assert.ok(di < gi && gi < ri && ri < ci, 'planning lifecycle order: decompose→gate→refine→cohere');
});
