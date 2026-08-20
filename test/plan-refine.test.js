import test from 'node:test';
import assert from 'node:assert/strict';
import { refinePlan, PLAN_REFINE_VERSION } from '../src/core/plan-refine.js';
import { runAgent } from '../src/core/agent.js';

// A clean assessment (the gate produced no issues) → no suggestions, still ok.
test('refinePlan: clean assessment yields no suggestions and stays pass', () => {
  const r = refinePlan({ ok: true, score: 95, level: 'pass', issues: [], goal: '实现登录接口' });
  assert.equal(r.ok, true);
  assert.equal(r.level, 'pass');
  assert.equal(r.score, 95);
  assert.deepEqual(r.suggestions, []);
});

// Every issue becomes one suggestion, severity-sorted error → warning → info.
test('refinePlan: suggestions mirror issues, sorted by severity', () => {
  const assessment = {
    ok: false, score: 30, level: 'fail',
    issues: [
      { severity: 'info', code: 'SINGLE_STEP', message: '只有 1 步' },
      { severity: 'error', code: 'DENYLIST_HIT', message: '命中 denyList', step: 2 },
      { severity: 'warning', code: 'GOAL_UNCOVERED', message: '偏离目标' }
    ],
    goal: '部署'
  };
  const r = refinePlan(assessment);
  assert.equal(r.suggestions.length, 3);
  assert.equal(r.suggestions[0].severity, 'error');
  assert.equal(r.suggestions[1].severity, 'warning');
  assert.equal(r.suggestions[2].severity, 'info');
  // error-level → level fail, ok false
  assert.equal(r.level, 'fail');
  assert.equal(r.ok, false);
  assert.equal(r.score, 30);
});

// The UNKNOWN_TOOL remediation should weave in the extracted tool name.
test('refinePlan: UNKNOWN_TOOL suggestion extracts the tool name', () => {
  const r = refinePlan({
    ok: true, score: 80, level: 'warn',
    issues: [{ severity: 'warning', code: 'UNKNOWN_TOOL', step: 2, message: '第 2 步引用了未在工具集中注册的工具「foobar」，该步骤无法执行。' }]
  });
  assert.equal(r.suggestions.length, 1);
  assert.ok(r.suggestions[0].message.includes('foobar'));
  assert.equal(r.suggestions[0].step, 2);
});

// Coverage: one of every gate code produces a concrete, non-empty suggestion.
test('refinePlan: every known gate code gets a remediation', () => {
  const codes = [
    'EMPTY_PLAN', 'SINGLE_STEP', 'GOAL_UNCOVERED', 'UNKNOWN_TOOL',
    'DESTRUCTIVE_STEP', 'SECRET_REF', 'DENYLIST_HIT', 'LOOP_STEP',
    'VAGUE_STEP', 'NO_VERIFY', 'NETWORK_STEP'
  ];
  const issues = codes.map((code, i) => ({
    severity: i % 2 ? 'warning' : 'error',
    code,
    step: i + 1,
    message: '第 ' + (i + 1) + ' 步引用了未在工具集中注册的工具「x」' // only matters for UNKNOWN_TOOL
  }));
  const r = refinePlan({ ok: false, score: 0, level: 'fail', issues });
  // All 11 codes map to a suggestion; NETWORK_STEP has no step so step is null.
  assert.equal(r.suggestions.length, 11);
  // Suggestions are severity-sorted, so compare codes as a set, not by position.
  const gotCodes = r.suggestions.map((s) => s.code).sort();
  assert.deepEqual(gotCodes, [...codes].sort());
  for (const s of r.suggestions) {
    assert.ok(s.message && s.message.length > 4, 'suggestion should be concrete: ' + s.code);
  }
});

// Defensive: malformed / null assessment never throws.
test('refinePlan: null/malformed assessment is handled gracefully', () => {
  const r1 = refinePlan(null);
  assert.equal(r1.ok, true);
  assert.equal(r1.level, 'pass');
  assert.deepEqual(r1.suggestions, []);
  const r2 = refinePlan({});
  assert.deepEqual(r2.suggestions, []);
});

test('PLAN_REFINE_VERSION is exported', () => {
  assert.ok(typeof PLAN_REFINE_VERSION === 'string' && PLAN_REFINE_VERSION.length > 0);
  assert.equal(PLAN_REFINE_VERSION, '0.75.0');
});

// Integration: the runAgent pipeline emits a plan_refine event next to plan_gate
// and its suggestions correspond to the gate's findings.
test('runAgent emits plan_refine alongside plan_gate for a failing plan', async () => {
  const events = [];
  const messages = [{ role: 'user', content: '清理工作区' }];
  let callCount = 0;
  const callModel = async (_msgs, { onDelta }) => {
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
  const refine = events.find(([t]) => t === 'plan_refine');
  assert.ok(gate, 'expected a plan_gate event');
  assert.ok(refine, 'expected a plan_refine event');
  assert.equal(refine[1].goal, '清理工作区');
  // The failing plan (denyList hit) must yield a non-empty, error-level list.
  assert.equal(refine[1].level, 'fail');
  assert.ok(refine[1].suggestions.length >= 1);
  assert.ok(refine[1].suggestions.some((s) => s.severity === 'error'));
  // Suggestion count should equal the gate's issue count (every issue remediates).
  assert.equal(refine[1].suggestions.length, gate[1].issues.length);
});

// Integration: a clean plan yields a plan_refine event with zero suggestions.
test('runAgent emits plan_refine with no suggestions for a clean plan', async () => {
  const events = [];
  const messages = [{ role: 'user', content: '帮我规划实现登录功能' }];
  let callCount = 0;
  const callModel = async (_msgs, { onDelta }) => {
    callCount++;
    if (callCount === 1) {
      return {
        content: '',
        toolCalls: [{
          id: 'p1', name: 'plan',
          args: { steps: ['阅读需求文档并整理要点', '实现登录接口核心逻辑', '编写单元测试验证行为', '提交代码并通知评审'] }
        }],
        usage: null
      };
    }
    onDelta('已规划好实现登录功能的步骤。');
    return { content: '已规划好实现登录功能的步骤。', toolCalls: [], usage: null };
  };
  const executeTool = async () => ({ ok: true, content: 'ok' });
  await runAgent({
    messages, callModel, executeTool,
    config: {}, tools: [{ name: 'read_file' }, { name: 'write_file' }],
    goal: '实现登录接口',
    onEvent: (t, p) => events.push([t, p])
  });
  const refine = events.find(([t]) => t === 'plan_refine');
  assert.ok(refine, 'expected a plan_refine event');
  assert.equal(refine[1].goal, '实现登录接口');
  assert.equal(refine[1].level, 'pass');
  assert.deepEqual(refine[1].suggestions, []);
});
