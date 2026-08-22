import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_SCHEMA_VERSION, STEP_KINDS, PLAN_KIND_LABELS, PLAN_KIND_ICONS,
  countKinds, normSteps, tokenize
} from '../src/core/plan-schema.js';

// The schema is the single source of truth for the planning vocabulary shared
// by decompose / gate / refine / cohere. These tests pin the canonical parts.

test('PLAN_SCHEMA_VERSION is exported and at v0.77.0', () => {
  assert.equal(typeof PLAN_SCHEMA_VERSION, 'string');
  assert.equal(PLAN_SCHEMA_VERSION, '0.77.0');
});

test('STEP_KINDS is the fixed three-kind set', () => {
  assert.deepEqual(STEP_KINDS, ['research', 'action', 'verify']);
});

test('PLAN_KIND_LABELS / PLAN_KIND_ICONS cover every kind', () => {
  for (const k of STEP_KINDS) {
    assert.equal(typeof PLAN_KIND_LABELS[k], 'string');
    assert.equal(typeof PLAN_KIND_ICONS[k], 'string');
  }
});

// countKinds returns a complete { research, action, verify } tally and ignores
// unknown kinds so every caller agrees on the shape.
test('countKinds tallies the three kinds and ignores unknown', () => {
  const steps = [
    { kind: 'research' }, { kind: 'action' }, { kind: 'action' },
    { kind: 'verify' }, { kind: 'nonsense' }
  ];
  assert.deepEqual(countKinds(steps), { research: 1, action: 2, verify: 1 });
});

test('countKinds handles non-array input without throwing', () => {
  assert.deepEqual(countKinds(null), { research: 0, action: 0, verify: 0 });
  assert.deepEqual(countKinds(undefined), { research: 0, action: 0, verify: 0 });
  assert.deepEqual(countKinds('oops'), { research: 0, action: 0, verify: 0 });
});

// normSteps normalizes both structured steps and raw newline text, stripping
// numbered prefixes so "1. do X" and "do X" normalize identically.
test('normSteps normalizes arrays and newline text, strips prefixes', () => {
  assert.deepEqual(normSteps(['a', 'b', '']), ['a', 'b']);
  const text = '1. 调研需求\n2、写代码\n3) 跑测试\n\n4. 部署';
  assert.deepEqual(normSteps(text), ['调研需求', '写代码', '跑测试', '部署']);
});

test('normSteps handles empty / non-string / non-array input', () => {
  assert.deepEqual(normSteps(''), []);
  assert.deepEqual(normSteps(null), []);
  assert.deepEqual(normSteps(undefined), []);
});

// tokenize is CJK-aware: latin/digit/underscore runs plus individual CJK chars.
// This guarantees the gate and coherence module agree on "what words are here".
test('tokenize is CJK-aware and lowercases latin runs', () => {
  assert.deepEqual(tokenize('Hello World'), ['hello', 'world']);
  assert.deepEqual(tokenize('实现登录接口'), ['实', '现', '登', '录', '接', '口']);
  assert.deepEqual(tokenize('Test_API v2'), ['test_api', 'v2']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});
