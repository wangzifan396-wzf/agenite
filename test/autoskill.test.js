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
  autoSaveSkill
} from '../src/core/autoskill.js';

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
