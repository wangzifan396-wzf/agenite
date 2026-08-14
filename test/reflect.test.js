import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRun,
  mergeLessons,
  selectForPrompt,
  lessonToPromptText,
  enrichLesson,
  detectLoopFromTrace,
  serializeLessons,
  deserializeLessons,
  LESSON_TYPES
} from '../src/core/reflect.js';

test('classifyRun: stuck loop → executionLapse lesson', () => {
  const ls = classifyRun({ loopDetected: true, stopped: 'max_turns' });
  assert.ok(ls.some((l) => l.type === 'executionLapse' && l.context === '卡死循环'));
  // ids are stable & content-derived
  const a = classifyRun({ loopDetected: true });
  const b = classifyRun({ loopDetected: true });
  assert.equal(a[0].id, b[0].id);
});

test('classifyRun: verify failure → procedure lesson', () => {
  const ls = classifyRun({ verifyOk: false, verifyLabel: 'npm test' });
  const p = ls.find((l) => l.type === 'procedure');
  assert.ok(p);
  assert.ok(p.context.includes('npm test'));
});

test('classifyRun: clean finish with verify + git → principle lesson', () => {
  const ls = classifyRun({ stopped: 'done', verifyOk: true, gitCommit: 'abc123' });
  assert.ok(ls.some((l) => l.type === 'principle'));
});

test('classifyRun: mutation without verify → warning', () => {
  const ls = classifyRun({ destructiveUsed: true, verifyOk: null });
  assert.ok(ls.some((l) => l.type === 'warning' && l.context === '变更后缺验证'));
});

test('classifyRun: multiple signals produce multiple distinct lessons', () => {
  // loop + clean-finish(done & verify & git) → executionLapse + principle
  const ls = classifyRun({ loopDetected: true, verifyOk: true, destructiveUsed: true, stopped: 'done', gitCommit: 'x' });
  const types = ls.map((l) => l.type);
  assert.ok(types.includes('executionLapse'));
  assert.ok(types.includes('principle'));
  // verify-fail + mutation-without-verify → procedure + warning (separate run)
  const ls2 = classifyRun({ verifyOk: false, destructiveUsed: true, errorTools: 2 });
  const types2 = ls2.map((l) => l.type);
  assert.ok(types2.includes('procedure'));
  assert.ok(types2.includes('warning'));
});

test('classifyRun: no notable signal → empty', () => {
  const ls = classifyRun({ stopped: 'done', verifyOk: true });
  assert.equal(ls.length, 0);
});

test('mergeLessons: identical lessons collapse (dedup) and score reinforces', () => {
  const a = classifyRun({ loopDetected: true });
  const once = mergeLessons([], a);
  assert.equal(once.length, 1);
  const base = once[0].score;
  const twice = mergeLessons(once, a);
  assert.equal(twice.length, 1);
  assert.ok(twice[0].score > base, 'reinforcement should raise score');
  assert.equal(twice[0].seen, 2);
});

test('mergeLessons: respects a prior user disable', () => {
  const a = classifyRun({ loopDetected: true });
  const merged = mergeLessons([], a);
  merged[0].enabled = false;
  const again = mergeLessons(merged, classifyRun({ loopDetected: true }));
  assert.equal(again[0].enabled, false);
});

test('mergeLessons: caps to max', () => {
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ type: 'warning', text: 'unique-' + i, score: 0.5, enabled: true });
  const capped = mergeLessons([], many, { max: 5 });
  assert.equal(capped.length, 5);
});

test('selectForPrompt: excludes disabled, sorts by score, respects limit', () => {
  const ls = [
    { type: 'warning', text: 'a'.repeat(50), score: 0.9, enabled: true },
    { type: 'warning', text: 'b', score: 0.1, enabled: false },
    { type: 'warning', text: 'c', score: 0.5, enabled: true }
  ];
  const picks = selectForPrompt(ls, { limit: 10 });
  assert.equal(picks.length, 2);
  assert.equal(picks[0].text, 'a'.repeat(50));
  assert.equal(picks[1].text, 'c');
});

test('lessonToPromptText: empty when nothing to inject, formatted otherwise', () => {
  assert.equal(lessonToPromptText([]), '');
  const txt = lessonToPromptText([{ type: 'principle', text: '做完要验证', context: '收尾' }]);
  assert.ok(txt.includes('[原则'));
  assert.ok(txt.includes('收尾'));
  assert.ok(txt.includes('做完要验证'));
});

test('detectLoopFromTrace: true for 3 identical consecutive tool turns', () => {
  const trace = {
    steps: [
      { kind: 'turn', id: 't1' },
      { kind: 'tool', parentId: 't1', name: 'read_file', data: { args: '{"path":"a"}' } },
      { kind: 'turn', id: 't2' },
      { kind: 'tool', parentId: 't2', name: 'read_file', data: { args: '{"path":"a"}' } },
      { kind: 'turn', id: 't3' },
      { kind: 'tool', parentId: 't3', name: 'read_file', data: { args: '{"path":"a"}' } },
      { kind: 'turn', id: 't4' } // final answer, no tools
    ]
  };
  assert.equal(detectLoopFromTrace(trace), true);
});

test('detectLoopFromTrace: false when turns differ', () => {
  const trace = {
    steps: [
      { kind: 'turn', id: 't1' },
      { kind: 'tool', parentId: 't1', name: 'read_file', data: { args: '{"path":"a"}' } },
      { kind: 'turn', id: 't2' },
      { kind: 'tool', parentId: 't2', name: 'read_file', data: { args: '{"path":"b"}' } },
      { kind: 'turn', id: 't3' },
      { kind: 'tool', parentId: 't3', name: 'read_file', data: { args: '{"path":"a"}' } }
    ]
  };
  assert.equal(detectLoopFromTrace(trace), false);
});

test('detectLoopFromTrace: ignores sub-agent tools', () => {
  const trace = {
    steps: [
      { kind: 'turn', id: 't1' },
      { kind: 'tool', parentId: 't1', name: 'read_file', data: { args: '{"path":"a"}', sub: true } },
      { kind: 'turn', id: 't2' },
      { kind: 'tool', parentId: 't2', name: 'read_file', data: { args: '{"path":"a"}', sub: true } },
      { kind: 'turn', id: 't3' },
      { kind: 'tool', parentId: 't3', name: 'read_file', data: { args: '{"path":"a"}', sub: true } }
    ]
  };
  assert.equal(detectLoopFromTrace(trace), false);
});

test('enrichLesson: no fn returns original unchanged', async () => {
  const l = classifyRun({ verifyOk: false })[0];
  const out = await enrichLesson(l, null);
  assert.equal(out.text, l.text);
  assert.equal(out.enriched, undefined);
});

test('enrichLesson: fn rewrites text and flags enriched', async () => {
  const l = classifyRun({ verifyOk: false })[0];
  const fn = async () => ({ content: '改动后务必跑一次测试验证，确认没有破坏既有功能再交付。' });
  const out = await enrichLesson(l, fn);
  assert.equal(out.enriched, true);
  assert.ok(out.text.includes('测试'));
});

test('serialize/deserialize round-trips and defaults', () => {
  const st = { meta: { injectionEnabled: false, enrich: true }, lessons: [{ type: 'warning', text: 'hi', score: 0.7, enabled: true }] };
  const round = deserializeLessons(JSON.parse(JSON.stringify(serializeLessons(st))));
  assert.equal(round.meta.injectionEnabled, false);
  assert.equal(round.meta.enrich, true);
  assert.equal(round.lessons.length, 1);
  const def = deserializeLessons(null);
  assert.equal(def.meta.injectionEnabled, true);
  assert.equal(def.lessons.length, 0);
});

test('LESSON_TYPES covers the typed taxonomy', () => {
  for (const t of ['principle', 'procedure', 'warning', 'skillDefect', 'executionLapse', 'preference']) {
    assert.ok(LESSON_TYPES[t], 'missing type ' + t);
  }
});
