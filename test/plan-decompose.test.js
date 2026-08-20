import test from 'node:test';
import assert from 'node:assert/strict';
import { decomposeGoal, PLAN_DECOMPOSE_VERSION } from '../src/core/plan-decompose.js';
import { runAgent } from '../src/core/agent.js';

// Empty goal → ok:false, zero steps, explicit reason. Never throws.
test('decomposeGoal: empty goal yields no steps and ok:false', () => {
  const r = decomposeGoal('');
  assert.equal(r.ok, false);
  assert.equal(r.stepCount, 0);
  assert.deepEqual(r.steps, []);
  assert.equal(r.reason, 'empty_goal');
  assert.equal(r.hasVerify, false);
});

// A normal goal → full research → action → verify skeleton, hasVerify true.
test('decomposeGoal: normal goal produces research/action/verify skeleton', () => {
  const r = decomposeGoal('实现一个登录接口并编写测试');
  assert.equal(r.ok, true);
  assert.ok(r.stepCount >= 3, 'should have at least 3 steps');
  assert.equal(r.hasResearch, true);
  assert.equal(r.hasAction, true);
  assert.equal(r.hasVerify, true);
  // Order must be research first, verify last.
  assert.equal(r.steps[0].kind, 'research');
  assert.equal(r.steps[r.steps.length - 1].kind, 'verify');
  // kinds counts line up with the steps.
  assert.equal(r.kinds.research, r.steps.filter((s) => s.kind === 'research').length);
  assert.equal(r.kinds.verify, r.steps.filter((s) => s.kind === 'verify').length);
});

// maxSteps cap is honored and never exceeded; skeleton preserved.
test('decomposeGoal: respects maxSteps cap', () => {
  const r = decomposeGoal('部署生产环境并验证可用性与回滚预案', { maxSteps: 4 });
  assert.ok(r.stepCount <= 4);
  assert.equal(r.stepCount, Math.min(4, r.steps.length));
  assert.equal(r.maxSteps, 4);
});

// Longer goals (data-driven deliverable) get a second action step.
test('decomposeGoal: long goal adds a second action step', () => {
  const short = decomposeGoal('读配置');
  const long = decomposeGoal('阅读需求文档，实现登录接口核心逻辑并编写单元测试验证行为');
  assert.equal(long.kinds.action, 2, 'long goal should split into 2 action steps');
  assert.ok(long.kinds.action > short.kinds.action);
});

// A registered tool name is referenced in the matching phase step (advisory).
test('decomposeGoal: references registered tools per phase', () => {
  const r = decomposeGoal('调研竞品并部署上线后验证', {
    tools: ['web_search', 'read_file', 'write_file', 'git', 'run_tests']
  });
  const research = r.steps.find((s) => s.kind === 'research');
  const action = r.steps.find((s) => s.kind === 'action');
  const verify = r.steps.find((s) => s.kind === 'verify');
  assert.equal(research.tool, 'web_search');
  assert.ok(action.tool === 'write_file' || action.tool === 'git', 'action should hint an action tool');
  assert.equal(verify.tool, 'run_tests');
});

// No registered tools matching any phase hint → steps omit the tool field.
test('decomposeGoal: no matching tool → tool omitted', () => {
  const r = decomposeGoal('实现一个功能', { tools: ['teapot_brew'] });
  for (const s of r.steps) assert.equal(s.tool, undefined);
});

// Defensive: malformed / null args never throw.
test('decomposeGoal: null/malformed input is handled gracefully', () => {
  const r1 = decomposeGoal(null);
  assert.equal(r1.ok, false);
  assert.equal(r1.stepCount, 0);
  const r2 = decomposeGoal('做点事', { tools: null, maxSteps: 'abc' });
  assert.ok(r2.stepCount >= 1);
  assert.equal(r2.maxSteps, 6);
});

test('PLAN_DECOMPOSE_VERSION is exported', () => {
  assert.ok(typeof PLAN_DECOMPOSE_VERSION === 'string' && PLAN_DECOMPOSE_VERSION.length > 0);
  assert.equal(PLAN_DECOMPOSE_VERSION, '0.76.0');
});

// Integration: runAgent emits a plan_decompose event at run start (goal set),
// alongside the gate/refine events for the plan the agent writes.
test('runAgent emits plan_decompose when goal is provided', async () => {
  const events = [];
  const messages = [{ role: 'user', content: '实现登录接口' }];
  let callCount = 0;
  const callModel = async (_msgs, { onDelta }) => {
    callCount++;
    if (callCount === 1) {
      return {
        content: '',
        toolCalls: [{
          id: 'p1', name: 'plan',
          args: { steps: ['阅读需求文档并整理要点', '实现登录接口核心逻辑', '编写单元测试验证行为'] }
        }],
        usage: null
      };
    }
    onDelta('done');
    return { content: 'done', toolCalls: [], usage: null };
  };
  const executeTool = async () => ({ ok: true, content: 'ok' });
  await runAgent({
    messages, callModel, executeTool,
    config: {}, tools: [{ name: 'read_file' }, { name: 'write_file' }, { name: 'run_tests' }],
    goal: '实现登录接口',
    onEvent: (t, p) => events.push([t, p])
  });
  const dec = events.find(([t]) => t === 'plan_decompose');
  assert.ok(dec, 'expected a plan_decompose event');
  assert.equal(dec[1].goal, '实现登录接口');
  assert.ok(dec[1].stepCount >= 1);
  assert.equal(dec[1].hasVerify, true, 'decomposed draft should include a verify step');
  // The gate/refine stack still fires for the plan tool, unchanged.
  assert.ok(events.find(([t]) => t === 'plan_gate'), 'plan_gate still emitted');
  assert.ok(events.find(([t]) => t === 'plan_refine'), 'plan_refine still emitted');
});

// Integration: no goal → no plan_decompose event (feature stays silent).
test('runAgent does NOT emit plan_decompose when goal is empty', async () => {
  const events = [];
  const messages = [{ role: 'user', content: 'hi' }];
  let callCount = 0;
  const callModel = async (_msgs, { onDelta }) => {
    callCount++;
    onDelta('hi');
    return { content: 'hi', toolCalls: [], usage: null };
  };
  const executeTool = async () => ({ ok: true, content: 'ok' });
  await runAgent({
    messages, callModel, executeTool,
    config: {}, tools: [], goal: '',
    onEvent: (t, p) => events.push([t, p])
  });
  assert.ok(!events.find(([t]) => t === 'plan_decompose'), 'no plan_decompose when goal empty');
});
