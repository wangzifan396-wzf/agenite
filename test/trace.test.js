import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  newTrace, addStep, classifyTool, detectLoops, detectConsecutiveLoops,
  traceSummary, saveTrace, loadTrace, deleteTrace, pruneTraces, diagnoseTrace, traceCost,
  matchGitRef, listTracesByGitRef
} from '../src/core/trace.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'agenite-trace-'));
}

test('newTrace seeds a valid empty trace', () => {
  const t = newTrace({ title: 'hi', model: 'gpt', provider: 'openai' });
  assert.equal(t.steps.length, 0);
  assert.equal(t.title, 'hi');
  assert.equal(t.model, 'gpt');
  assert.deepEqual(t.stats, { steps: 0, tools: 0, subagents: 0, errors: 0, compactions: 0, memoryOps: 0, totalMs: 0 });
});

test('classifyTool buckets by prefix', () => {
  assert.equal(classifyTool('memory_save'), 'memory');
  assert.equal(classifyTool('mcp__fs_read'), 'mcp');
  assert.equal(classifyTool('read_file'), 'tool');
});

test('addStep maintains stats, parent index, and children', () => {
  const t = newTrace();
  const turn = addStep(t, { kind: 'turn', name: '推理' });
  const tool = addStep(t, { kind: 'tool', name: 'read_file', parentId: turn.id, ms: 42, status: 'ok' });
  assert.equal(t.stats.steps, 2);
  assert.equal(t.stats.tools, 1);
  assert.equal(t.stats.totalMs, 42);
  // child linked to parent
  const p = t.steps.find((s) => s.id === turn.id);
  assert.ok(p.children.includes(tool.id));
});

test('addStep flags errors and memory ops', () => {
  const t = newTrace();
  addStep(t, { kind: 'tool', name: 'read_file', status: 'error' });
  addStep(t, { kind: 'tool', name: 'memory_save', status: 'ok' });
  assert.equal(t.stats.errors, 1);
  assert.equal(t.stats.memoryOps, 1);
});

test('detectLoops finds heavily reused tools', () => {
  const t = newTrace();
  for (let i = 0; i < 4; i++) addStep(t, { kind: 'tool', name: 'web_search' });
  addStep(t, { kind: 'tool', name: 'read_file' });
  const loops = detectLoops(t, 3);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].name, 'web_search');
  assert.equal(loops[0].count, 4);
});

test('detectConsecutiveLoops finds identical back-to-back calls', () => {
  const t = newTrace();
  const same = { kind: 'tool', name: 'read_file', data: { args: { path: 'a.txt' } } };
  for (let i = 0; i < 5; i++) addStep(t, same);
  addStep(t, { kind: 'tool', name: 'read_file', data: { args: { path: 'b.txt' } } });
  const c = detectConsecutiveLoops(t, 3);
  assert.ok(c, 'should detect a consecutive loop');
  assert.equal(c.name, 'read_file');
  assert.equal(c.count, 5);
});

test('detectConsecutiveLoops ignores interleaved distinct calls', () => {
  const t = newTrace();
  for (let i = 0; i < 4; i++) {
    addStep(t, { kind: 'tool', name: 'read_file', data: { args: { path: 'a' } } });
    addStep(t, { kind: 'tool', name: 'write_file', data: { args: { path: 'b' } } });
  }
  assert.equal(detectConsecutiveLoops(t, 3), null);
});

test('traceSummary aggregates loops and consecutive loops', () => {
  const t = newTrace();
  const same = { name: 'web_search', args: { q: 'x' } };
  for (let i = 0; i < 3; i++) addStep(t, { kind: 'tool', ...same });
  addStep(t, { kind: 'subagent', name: '研究员' });
  t.cost = 0.0123;
  t.stopped = 'done';
  t.turns = 2;
  const s = traceSummary(t);
  assert.equal(s.stopped, 'done');
  assert.equal(s.turns, 2);
  assert.ok(Math.abs(s.cost - 0.0123) < 1e-9);
  assert.equal(s.loops.length, 1);
  assert.ok(s.consecutiveLoop && s.consecutiveLoop.count === 3);
  assert.equal(s.stats.subagents, 1);
});

test('saveTrace + loadTrace round-trips atomically', async () => {
  const dir = tempDir();
  try {
    const t = newTrace({ title: 'roundtrip' });
    addStep(t, { kind: 'turn', name: '推理' });
    await saveTrace(t, dir);
    const loaded = await loadTrace(dir, t.runId);
    assert.equal(loaded.title, 'roundtrip');
    assert.equal(loaded.steps.length, 1);
    // corrupt file is rejected
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, t.runId + '.json'), '{ bad json ', 'utf8');
    await assert.rejects(() => loadTrace(dir, t.runId));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneTraces caps the folder to MAX_TRACES', async () => {
  const dir = tempDir();
  try {
    // write 5 traces but cap at 2
    for (let i = 0; i < 5; i++) {
      const t = newTrace({ title: 't' + i });
      await saveTrace(t, dir);
    }
    const removed = await pruneTraces(dir, 2);
    assert.equal(removed, 3);
    const { readdir } = await import('node:fs/promises');
    const remaining = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    assert.equal(remaining.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteTrace removes the file', async () => {
  const dir = tempDir();
  try {
    const t = newTrace({ title: 'del' });
    await saveTrace(t, dir);
    assert.equal(await deleteTrace(dir, t.runId), true);
    assert.equal(await deleteTrace(dir, t.runId), false, 'deleting twice is safe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('traceCost normalises number and object shapes', () => {
  assert.equal(traceCost({ cost: 0.5 }), 0.5);
  assert.equal(traceCost({ cost: { amount: 0.25, currency: 'USD' } }), 0.25);
  assert.equal(traceCost({}), 0);
  assert.equal(traceCost({ cost: 'nope' }), 0);
});

test('diagnoseTrace flags an identical-call loop as bad', () => {
  const t = newTrace();
  const same = { kind: 'tool', name: 'read_file', data: { args: { path: 'a.txt' } } };
  for (let i = 0; i < 5; i++) addStep(t, same);
  t.stopped = 'guardrail';
  t.turns = 5;
  const d = diagnoseTrace(t, { loopThreshold: 6 });
  assert.equal(d.severity, 'bad');
  assert.equal(d.healthy, false);
  assert.ok(d.consecutiveLoop && d.consecutiveLoop.count === 5);
  const bad = d.findings.find((f) => f.level === 'bad');
  assert.ok(bad, 'should have a bad finding');
  assert.ok(bad.title.includes('空转'));
});

test('diagnoseTrace is ok for a clean trace', () => {
  const t = newTrace();
  addStep(t, { kind: 'turn', name: '推理' });
  addStep(t, { kind: 'tool', name: 'read_file', data: { args: { path: 'a' } } });
  addStep(t, { kind: 'tool', name: 'write_file', data: { args: { path: 'b' } } });
  const d = diagnoseTrace(t);
  assert.equal(d.severity, 'ok');
  assert.equal(d.healthy, true);
  assert.equal(d.findings.length, 0);
});

test('diagnoseTrace warns on heavy but non-looped reuse', () => {
  const t = newTrace();
  // 7 distinct-arg calls to the same tool: counts as heavy, but not consecutive
  for (let i = 0; i < 7; i++) addStep(t, { kind: 'tool', name: 'web_search', data: { args: { q: 'x' + i } } });
  const d = diagnoseTrace(t, { loopThreshold: 6 });
  assert.equal(d.severity, 'warn');
  assert.ok(d.findings.some((f) => f.title.includes('web_search')));
});

test('diagnoseTrace warns when over the budget cap', () => {
  const t = newTrace();
  addStep(t, { kind: 'tool', name: 'read_file', data: { args: { path: 'a' } } });
  t.cost = 0.05;
  const d = diagnoseTrace(t, { maxCostUSD: 0.01 });
  assert.equal(d.severity, 'warn');
  assert.ok(d.findings.some((f) => f.title.includes('预算')));
  // without a cap, the same cost is fine
  assert.equal(diagnoseTrace(t, { maxCostUSD: 0 }).severity, 'ok');
});

// --- v0.48: git anchoring + regression-hunter linkage ---

test('matchGitRef matches by full hash, short hash, and prefix (both directions)', () => {
  const git = { hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', short: 'a1b2c3d', branch: 'main', dirty: false };
  // exact full hash
  assert.equal(matchGitRef(git, 'a1b2c3d4e5f60718293a4b5c6d7e8f90'), true);
  // exact short hash
  assert.equal(matchGitRef(git, 'a1b2c3d'), true);
  // ref is a prefix of the full hash (regression-hunter blames a long sha)
  assert.equal(matchGitRef(git, 'a1b2c3d4e5'), true);
  // stored short hash is a prefix of the ref (only short was captured)
  assert.equal(matchGitRef(git, 'a1b2c3d4e5f6'), true);
  // case-insensitive
  assert.equal(matchGitRef(git, 'A1B2C3D4E5F6'), true);
  // whitespace is tolerated
  assert.equal(matchGitRef(git, '  a1b2c3d  '), true);
});

test('matchGitRef rejects non-matches and degenerate inputs', () => {
  const git = { hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', short: 'a1b2c3d', branch: 'main', dirty: false };
  assert.equal(matchGitRef(git, 'ffeeddcc'), false);
  assert.equal(matchGitRef(null, 'a1b2c3d'), false);
  assert.equal(matchGitRef(git, null), false);
  assert.equal(matchGitRef(git, ''), false);
  assert.equal(matchGitRef(git, '   '), false);
  // a completely different anchor does not match
  assert.equal(matchGitRef({ hash: '1111111', short: '1111' }, 'a1b2c3d'), false);
});

test('listTracesByGitRef filters traces anchored to a commit', async () => {
  const dir = tempDir();
  try {
    // trace A: anchored to commit deadbeef
    const a = newTrace({ title: 'at-deadbeef' });
    a.gitStart = { hash: 'deadbeef00', short: 'deadbe', branch: 'main', dirty: false };
    addStep(a, { kind: 'turn', name: '推理' });
    await saveTrace(a, dir);

    // trace B: anchored to commit cafe1234 (short only)
    const b = newTrace({ title: 'at-cafe' });
    b.gitStart = { hash: 'cafe1234cafe1234cafe1234cafe1234', short: 'cafe1234', branch: 'main', dirty: true };
    await saveTrace(b, dir);

    // trace C: no git anchor (e.g. workspace isn't a repo)
    const c = newTrace({ title: 'no-git' });
    c.gitStart = null;
    await saveTrace(c, dir);

    // query by full hash of A
    const byFull = await listTracesByGitRef(dir, 'deadbeef00');
    assert.equal(byFull.length, 1);
    assert.equal(byFull[0].runId, a.runId);

    // query by short hash of B
    const byShort = await listTracesByGitRef(dir, 'cafe1234');
    assert.equal(byShort.length, 1);
    assert.equal(byShort[0].runId, b.runId);

    // query by a prefix of B's full hash
    const byPrefix = await listTracesByGitRef(dir, 'cafe1234cafe');
    assert.equal(byPrefix.length, 1);
    assert.equal(byPrefix[0].runId, b.runId);

    // a commit with no traces -> empty
    const none = await listTracesByGitRef(dir, 'ffffffff');
    assert.equal(none.length, 0);

    // empty / blank ref is a no-op
    assert.deepEqual(await listTracesByGitRef(dir, ''), []);
    assert.deepEqual(await listTracesByGitRef(dir, '   '), []);

    // the summary object exposes the git anchor so the UI can show it
    assert.equal(byFull[0].git && byFull[0].git.hash, 'deadbeef00');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
