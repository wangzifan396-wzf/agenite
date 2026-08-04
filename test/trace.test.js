import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  newTrace, addStep, classifyTool, detectLoops, detectConsecutiveLoops,
  traceSummary, saveTrace, loadTrace, deleteTrace, pruneTraces
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
