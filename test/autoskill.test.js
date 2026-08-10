// Tests for the automatic skill-precipitation module (src/core/autoskill.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countToolActivity,
  isComplexEnough,
  compactTranscript,
  buildSkillReflectionMessages,
  parseSkillDecision,
  autoSaveSkill,
  computeVerified,
  shouldDistill,
  extractAntiHints
} from '../src/core/autoskill.js';
import { listSkills } from '../src/core/memory.js';

// A transcript that is complex enough to clear isComplexEnough().
const BUSY = [
  { role: 'tool', name: 'a', content: '1' },
  { role: 'tool', name: 'a', content: '2' },
  { role: 'tool', name: 'a', content: '3' }
];

test('countToolActivity counts calls and distinct tools', () => {
  const msgs = [
    { role: 'user', content: 'do stuff' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file' } }, { function: { name: 'run_command' } }] },
    { role: 'tool', name: 'read_file', content: 'x' },
    { role: 'tool', name: 'run_command', content: 'y' },
    { role: 'tool', name: 'run_command', content: 'z' }
  ];
  const { calls, distinct } = countToolActivity(msgs);
  assert.equal(calls, 3);
  assert.equal(distinct, 2);
});

test('isComplexEnough gates trivial vs real work', () => {
  const trivial = [{ role: 'assistant', content: 'hi', tool_calls: [{ function: { name: 'calculator' } }] }, { role: 'tool', name: 'calculator', content: '5' }];
  assert.equal(isComplexEnough(trivial), false);
  const real = [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'a' } }] }, { role: 'tool', name: 'a', content: '1' }, { role: 'tool', name: 'a', content: '2' }, { role: 'tool', name: 'a', content: '3' }];
  assert.equal(isComplexEnough(real), true);
});

test('compactTranscript drops system and keeps roles', () => {
  const t = compactTranscript([
    { role: 'system', content: 'you are...' },
    { role: 'user', content: 'find the bug' },
    { role: 'assistant', content: 'looking', tool_calls: [{ function: { name: 'grep_files' } }] },
    { role: 'tool', name: 'grep_files', content: 'huge result '.repeat(200) }
  ]);
  assert.ok(!t.includes('you are'));
  assert.ok(t.includes('USER: find the bug'));
  assert.ok(t.includes('grep_files'));
  assert.ok(t.length <= 6000);
});

test('buildSkillReflectionMessages returns system+user pair', () => {
  const m = buildSkillReflectionMessages('abc');
  assert.equal(m.length, 2);
  assert.equal(m[0].role, 'system');
  assert.equal(m[1].role, 'user');
  assert.ok(m[1].content.includes('abc'));
});

test('parseSkillDecision handles bare, fenced and noisy output', () => {
  const plain = parseSkillDecision('{"save":true,"name":"x","description":"y","when_to_use":"z","body":"b","reason":"r"}');
  assert.equal(plain.save, true);
  assert.equal(plain.name, 'x');

  const fenced = parseSkillDecision('Sure:\n```json\n{"save":false,"reason":"too trivial"}\n```\nthanks');
  assert.equal(fenced.save, false);
  assert.equal(fenced.reason, 'too trivial');

  const garbage = parseSkillDecision('no json here');
  assert.equal(garbage.save, false);

  // save:true but missing name/description -> not actually saveable
  const incomplete = parseSkillDecision('{"save":true,"name":"","description":""}');
  assert.equal(incomplete.save, true);
  assert.equal(incomplete.name, '');
});

test('autoSaveSkill persists a skill and emits skill_auto when model says save', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agenite-autoskill-'));
  try {
    const sseEvents = [];
    const callModel = async () => ({
      content: '{"save":true,"name":"Deploy to Staging","description":"Build and ship to staging","when_to_use":"after CI passes","body":"1. run build 2. scp dist","reason":"reusable"}'
    });
    const res = await autoSaveSkill({ messages: [{ role: 'tool', name: 'a', content: '1' }, { role: 'tool', name: 'a', content: '2' }, { role: 'tool', name: 'a', content: '3' }], callModel, sse: (e, p) => sseEvents.push([e, p]), memoryBase: base });
    assert.equal(res.saved, true);
    assert.equal(res.name, 'Deploy to Staging');
    const ev = sseEvents.find((e) => e[0] === 'skill_auto');
    assert.ok(ev, 'should emit skill_auto');
    assert.equal(ev[1].saved, true);

    const slug = 'deploy-to-staging';
    const file = await readFile(join(base, 'skills', slug + '.md'), 'utf8');
    assert.ok(file.includes('name: Deploy to Staging'));
    assert.ok(file.includes('Build and ship to staging'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('autoSaveSkill does not save when model declines', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agenite-autoskill2-'));
  try {
    let saved = false;
    const origWrite = writeFile;
    const sseEvents = [];
    const callModel = async () => ({ content: '{"save":false,"reason":"one-off"}' });
    const res = await autoSaveSkill({ messages: [{ role: 'tool', name: 'a', content: '1' }, { role: 'tool', name: 'a', content: '2' }, { role: 'tool', name: 'a', content: '3' }], callModel, sse: (e, p) => sseEvents.push([e, p]), memoryBase: base });
    assert.equal(res.saved, false);
    assert.equal(saved, false);
    const ev = sseEvents.find((e) => e[0] === 'skill_auto');
    assert.ok(ev && ev[1].saved === false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('autoSaveSkill skips trivial tasks without calling the model', async () => {
  let called = 0;
  const callModel = async () => { called++; return { content: '{"save":true}' }; };
  const res = await autoSaveSkill({ messages: [{ role: 'assistant', content: 'hi', tool_calls: [{ function: { name: 'calculator' } }] }, { role: 'tool', name: 'calculator', content: '5' }], callModel, sse: () => {}, memoryBase: await mkdtemp(join(tmpdir(), 'agenite-autoskill3-')) });
  assert.equal(called, 0);
  assert.equal(res.skipped, true);
});

test('autoSaveSkill is resilient to a failing model call', async () => {
  const callModel = async () => { throw new Error('network'); };
  const res = await autoSaveSkill({ messages: [{ role: 'tool', name: 'a', content: '1' }, { role: 'tool', name: 'a', content: '2' }, { role: 'tool', name: 'a', content: '3' }], callModel, sse: () => {}, memoryBase: await mkdtemp(join(tmpdir(), 'agenite-autoskill4-')) });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'reflection call failed');
});

// ---- v0.46: the verification gate ----

test('computeVerified only trusts a real green verification', () => {
  assert.equal(computeVerified(null), false);
  assert.equal(computeVerified({}), false);
  assert.equal(computeVerified({ verifyOk: null }), false);
  assert.equal(computeVerified({ verifyOk: false }), false);
  assert.equal(computeVerified({ verifyOk: true }), true);
});

test('shouldDistill blocks red verifications and aborted runs, allows the rest', () => {
  // legacy callers (no gate) keep the old behaviour
  const legacy = shouldDistill(null);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.verified, false);

  const red = shouldDistill({ verifyOk: false, verifyLabel: 'npm test' });
  assert.equal(red.ok, false);
  assert.ok(red.reason.includes('npm test'));

  const aborted = shouldDistill({ verifyOk: true, aborted: true });
  assert.equal(aborted.ok, false, 'an interrupted run is not a success story');

  const green = shouldDistill({ verifyOk: true, verifyLabel: 'node --check' });
  assert.equal(green.ok, true);
  assert.equal(green.verified, true);

  const committed = shouldDistill({ verifyOk: null, gitCommit: 'abc1234' });
  assert.equal(committed.ok, true);
  assert.equal(committed.verified, false);

  const quiet = shouldDistill({ verifyOk: null });
  assert.equal(quiet.ok, true);
  assert.equal(quiet.verified, false);
});

test('extractAntiHints mines verify failures, self-heal nags and tool errors', () => {
  const hints = extractAntiHints([
    { role: 'user', content: '❌ 自动验证未通过（第 1/2 次）——单元测试：\ntest/foo.test.js 断言失败: expected 1\n这是你刚才改动后的【真实】结果' },
    { role: 'user', content: '⚠️ 自检提醒（第 1/3 次）：本回合有工具调用未成功（edit_file）。请先重新读取相关文件' },
    { role: 'tool', name: 'run_command', content: 'Error [PERMISSION_DENIED]: 命令超出沙箱范围' },
    { role: 'tool', name: 'read_file', content: '一切正常，没有错误' }
  ]);
  assert.equal(hints.length, 3);
  assert.ok(hints[0].includes('单元测试曾失败'));
  assert.ok(hints[0].includes('断言失败'));
  assert.ok(hints[1].includes('edit_file'));
  assert.ok(hints[2].includes('PERMISSION_DENIED'));
  assert.ok(hints.every((h) => h.length <= 160 && !h.includes('\n')));
  assert.deepEqual(extractAntiHints([]), []);
});

test('buildSkillReflectionMessages frames verified runs and injects stumbles', () => {
  const plain = buildSkillReflectionMessages('t');
  assert.ok(plain[0].content.includes('no automated verification ran'));
  assert.ok(plain[0].content.includes('anti_patterns'));

  const rich = buildSkillReflectionMessages('t', { verified: true, verifyLabel: 'npm test', antiHints: ['不要改 dist'] });
  assert.ok(rich[0].content.includes('PASSED a real automated verification'));
  assert.ok(rich[0].content.includes('npm test'));
  assert.ok(rich[1].content.includes('不要改 dist'));
  assert.ok(rich[1].content.includes('Transcript:'));
});

test('parseSkillDecision captures anti_patterns as array or pipe string', () => {
  const arr = parseSkillDecision('{"save":true,"name":"n","description":"d","body":"b","anti_patterns":["x","y","","z"]}');
  assert.deepEqual(arr.antiPatterns, ['x', 'y', 'z']);

  const piped = parseSkillDecision('{"save":true,"name":"n","description":"d","body":"b","anti_patterns":"a | b"}');
  assert.deepEqual(piped.antiPatterns, ['a', 'b']);

  const none = parseSkillDecision('{"save":true,"name":"n","description":"d","body":"b"}');
  assert.deepEqual(none.antiPatterns, []);

  const many = parseSkillDecision('{"save":true,"name":"n","description":"d","body":"b","anti_patterns":["1","2","3","4","5","6","7"]}');
  assert.equal(many.antiPatterns.length, 5, 'capped so a chatty model cannot bloat the file');
});

test('autoSaveSkill refuses to crystallize a run whose verification went red', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agenite-gate-red-'));
  try {
    let called = 0;
    const sseEvents = [];
    const callModel = async () => { called++; return { content: '{"save":true,"name":"Bad","description":"d","body":"b"}' }; };
    const res = await autoSaveSkill({
      messages: BUSY,
      callModel,
      sse: (e, p) => sseEvents.push([e, p]),
      memoryBase: base,
      gate: { verifyOk: false, verifyLabel: '单元测试' }
    });
    assert.equal(called, 0, 'the gate must run before we spend a model call');
    assert.equal(res.gated, true);
    assert.ok(res.reason.includes('单元测试'));
    assert.equal((await listSkills(base)).length, 0);
    const ev = sseEvents.find((e) => e[0] === 'skill_auto');
    assert.ok(ev && ev[1].gated === true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('autoSaveSkill stamps ✓verified and persists anti-patterns on a green run', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agenite-gate-green-'));
  try {
    const sseEvents = [];
    const callModel = async () => ({
      content: '{"save":true,"name":"Fix Build","description":"修复构建","when_to_use":"构建报错时","body":"步骤","anti_patterns":["不要跳过 node --check"],"reason":"reusable"}'
    });
    const res = await autoSaveSkill({
      messages: BUSY,
      callModel,
      sse: (e, p) => sseEvents.push([e, p]),
      memoryBase: base,
      gate: { verifyOk: true, verifyLabel: 'node --check', gitCommit: 'abc1234' }
    });
    assert.equal(res.saved, true);
    assert.equal(res.verified, true);
    assert.deepEqual(res.antiPatterns, ['不要跳过 node --check']);

    const [s] = await listSkills(base);
    assert.equal(s.verified, true);
    assert.equal(s.source, 'auto');
    assert.deepEqual(s.antiPatterns, ['不要跳过 node --check']);

    const ev = sseEvents.find((e) => e[0] === 'skill_auto');
    assert.equal(ev[1].verified, true);
    assert.equal(ev[1].version, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('autoSaveSkill falls back to mined hints when the model omits anti_patterns', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agenite-gate-hints-'));
  try {
    const callModel = async () => ({ content: '{"save":true,"name":"Recover","description":"d","body":"b"}' });
    const res = await autoSaveSkill({
      messages: [
        ...BUSY,
        { role: 'tool', name: 'edit_file', content: 'Error [SCHEMA_ERROR]: old_string 未找到完全匹配' }
      ],
      callModel,
      sse: () => {},
      memoryBase: base,
      gate: { verifyOk: true }
    });
    assert.equal(res.saved, true);
    assert.equal(res.antiPatterns.length, 1);
    assert.ok(res.antiPatterns[0].includes('SCHEMA_ERROR'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('re-learning a skill through autoSaveSkill bumps its version', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agenite-gate-ver-'));
  try {
    const callModel = async () => ({ content: '{"save":true,"name":"Same Name","description":"d","body":"b"}' });
    await autoSaveSkill({ messages: BUSY, callModel, sse: () => {}, memoryBase: base, gate: { verifyOk: true } });
    const second = await autoSaveSkill({ messages: BUSY, callModel, sse: () => {}, memoryBase: base, gate: { verifyOk: true } });
    assert.equal(second.version, 2);
    const list = await listSkills(base);
    assert.equal(list.length, 2, 'the previous revision is archived, not deleted');
    assert.ok(list.some((s) => s.slug === 'same-name.v1' && s.status === 'superseded'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
