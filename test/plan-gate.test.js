import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, planGateLabel, PLAN_GATE_VERSION } from '../src/core/plan-gate.js';
import { runAgent } from '../src/core/agent.js';

function codes(issues) { return issues.map((i) => i.code); }

test('validatePlan: empty plan fails with score 0', () => {
  const r = validatePlan({ steps: [], text: '' });
  assert.equal(r.ok, false);
  assert.equal(r.level, 'fail');
  assert.equal(r.score, 0);
  assert.ok(codes(r.issues).includes('EMPTY_PLAN'));
});

test('validatePlan: good plan with goal coverage passes', () => {
  const r = validatePlan({
    steps: ['阅读需求文档', '实现登录接口', '编写单元测试验证', '提交并通知评审'],
    goal: '实现登录接口',
    toolNames: ['read_file', 'write_file'],
    guardPolicy: { denyList: [] }
  });
  assert.equal(r.ok, true);
  assert.equal(r.level, 'pass');
  assert.ok(r.score >= 80);
  assert.equal(r.stats.stepCount, 4);
  assert.equal(r.stats.goalCovered, true);
  assert.ok(!codes(r.issues).includes('EMPTY_PLAN'));
});

test('validatePlan: goal not covered warns', () => {
  const r = validatePlan({
    steps: ['整理桌面文件', '清空回收站'],
    goal: '部署生产服务器',
    toolNames: []
  });
  assert.ok(codes(r.issues).includes('GOAL_UNCOVERED'));
  assert.ok(r.score < 100);
});

test('validatePlan: denyList hit is an error', () => {
  const r = validatePlan({
    steps: ['用 git push --force 覆盖远端', '通知团队'],
    goal: '修复提交历史',
    toolNames: ['git'],
    guardPolicy: { denyList: ['--force', 'rm -rf'] }
  });
  assert.ok(codes(r.issues).includes('DENYLIST_HIT'));
  assert.equal(r.level, 'fail');
  assert.ok(r.stats.denyHitCount >= 1);
});

test('validatePlan: destructive step warns', () => {
  const r = validatePlan({
    steps: ['rm -rf ./build 清理缓存', '重新构建'],
    goal: '清理并重建',
    toolNames: []
  });
  assert.ok(codes(r.issues).includes('DESTRUCTIVE_STEP'));
  assert.ok(r.stats.riskyStepCount >= 1);
});

test('validatePlan: loop without termination warns', () => {
  const r = validatePlan({
    steps: ['循环重试直到成功', '返回结果'],
    goal: '稳定地拉取数据',
    toolNames: []
  });
  assert.ok(codes(r.issues).includes('LOOP_STEP'));
  assert.equal(r.stats.loopDetected, true);
});

test('validatePlan: single step is info-only (still pass)', () => {
  const r = validatePlan({ steps: ['发送邮件'], goal: '发送邮件', toolNames: [] });
  assert.ok(codes(r.issues).includes('SINGLE_STEP'));
  // info severity → level stays pass (score still >= 80)
  assert.equal(r.level, 'pass');
});

test('validatePlan: unknown tool reference warns', () => {
  const r = validatePlan({
    steps: ['用 foobar 解析数据', '输出结果'],
    goal: '解析数据',
    toolNames: ['read_file', 'write_file']
  });
  assert.ok(codes(r.issues).includes('UNKNOWN_TOOL'));
});

test('validatePlan: implementation goal without verify warns', () => {
  const r = validatePlan({
    steps: ['编写代码实现功能', '提交代码'],
    goal: '实现新功能',
    toolNames: ['write_file']
  });
  assert.ok(codes(r.issues).includes('NO_VERIFY'));
});

test('validatePlan: text-only plan is analyzed', () => {
  const r = validatePlan({
    text: '1. 读取配置\n2. 启动服务\n3. 验证服务可用',
    goal: '启动服务',
    toolNames: []
  });
  assert.equal(r.stats.stepCount, 3);
  assert.equal(r.ok, true);
});

test('planGateLabel maps levels', () => {
  assert.equal(planGateLabel('pass'), '通过');
  assert.equal(planGateLabel('warn'), '需关注');
  assert.equal(planGateLabel('fail'), '不合格');
});

test('PLAN_GATE_VERSION is exported', () => {
  assert.ok(typeof PLAN_GATE_VERSION === 'string' && PLAN_GATE_VERSION.length > 0);
});

test('runAgent emits a plan_gate event when the plan tool runs', async () => {
  const events = [];
  const messages = [{ role: 'user', content: '帮我规划实现登录功能' }];
  let callCount = 0;
  const callModel = async (msgs, { onDelta }) => {
    callCount++;
    if (callCount === 1) {
      return {
        content: '',
        toolCalls: [{
          id: 'p1', name: 'plan',
          args: { steps: ['阅读需求', '实现登录接口', '编写测试验证', '提交评审'] }
        }],
        usage: null
      };
    }
    onDelta('已为你规划好实现登录功能的步骤。');
    return { content: '已为你规划好实现登录功能的步骤。', toolCalls: [], usage: null };
  };
  const executeTool = async (name, args) => {
    if (name === 'plan') return { ok: true, content: '已记录计划' };
    return { ok: true, content: 'ok' };
  };
  const res = await runAgent({
    messages, callModel, executeTool,
    config: {}, tools: [{ name: 'read_file' }, { name: 'write_file' }],
    goal: '实现登录功能',
    onEvent: (t, p) => events.push([t, p])
  });
  assert.equal(res.stopped, 'done');
  const gate = events.find(([t]) => t === 'plan_gate');
  assert.ok(gate, 'expected a plan_gate event');
  const [, payload] = gate;
  assert.equal(typeof payload.score, 'number');
  assert.ok(['pass', 'warn', 'fail'].includes(payload.level));
  assert.equal(payload.goal, '实现登录功能');
});

test('runAgent: a plan that hits the denyList is flagged fail by the gate', async () => {
  const events = [];
  const messages = [{ role: 'user', content: '清理工作区' }];
  let callCount = 0;
  const callModel = async (msgs, { onDelta }) => {
    callCount++;
    if (callCount === 1) {
      return {
        content: '',
        toolCalls: [{
          id: 'p1', name: 'plan',
          args: { steps: ['rm -rf ./tmp 删除临时目录', 'git push --force 强制推送'] }
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
    config: { guardrails: { denyList: ['--force'] } },
    tools: [{ name: 'git' }],
    goal: '清理工作区',
    onEvent: (t, p) => events.push([t, p])
  });
  const gate = events.find(([t]) => t === 'plan_gate');
  assert.ok(gate, 'expected a plan_gate event');
  assert.equal(gate[1].level, 'fail');
  assert.ok(gate[1].issues.some((i) => i.code === 'DENYLIST_HIT'));
});
