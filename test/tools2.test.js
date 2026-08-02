import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unifiedDiff, applyUnifiedPatch, grepFiles, applyPatchTool, setUndoStore, applyUndo
} from '../src/core/tools.js';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('unifiedDiff marks added and removed lines', () => {
  const d = unifiedDiff('a\nb\nc', 'a\nB\nc');
  assert.ok(d.includes('-b'), 'should show removed line');
  assert.ok(d.includes('+B'), 'should show added line');
  assert.ok(d.includes(' a') && d.includes(' c'), 'context lines preserved');
});

test('applyUnifiedPatch applies a single hunk', () => {
  const before = 'function add(a, b) {\n  return a + b;\n}\n';
  const patch = [
    '--- a/math.js',
    '+++ b/math.js',
    '@@ -1,3 +1,3 @@',
    ' function add(a, b) {',
    '-  return a + b;',
    '+  return a + b; // sum',
    ' }'
  ].join('\n');
  const after = applyUnifiedPatch(before, patch);
  assert.equal(after, 'function add(a, b) {\n  return a + b; // sum\n}\n');
});

test('applyUnifiedPatch throws on unmatched context', () => {
  const before = 'one\ntwo\nthree\n';
  const patch = '@@ -1,2 +1,2 @@\n one\n-NO_SUCH_LINE\n+new\n';
  assert.throws(() => applyUnifiedPatch(before, patch));
});

test('grepFiles finds content matches (case-insensitive)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenite-grep-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'Hello World\nfoo bar\n');
    writeFileSync(join(dir, 'b.txt'), 'nothing here\n');
    const r = await grepFiles({ pattern: 'world' }, { workspace: dir });
    assert.ok(r.ok, 'should succeed');
    assert.match(r.content, /a\.txt:1:/, 'should report file:line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grepFiles rejects bad regex', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenite-grep2-'));
  try {
    const r = await grepFiles({ pattern: '(' }, { workspace: dir });
    assert.equal(r.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyPatchTool applies a diff and supports undo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenite-patch-'));
  const store = new Map();
  setUndoStore(store);
  try {
    writeFileSync(join(dir, 'x.txt'), 'line1\nline2\n');
    const patch = [
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1,2 +1,2 @@',
      ' line1',
      '-line2',
      '+line2-modified'
    ].join('\n');
    const r = await applyPatchTool({ patch }, { workspace: dir });
    assert.ok(r.ok, 'patch applied');
    const updated = readFileSync(join(dir, 'x.txt'), 'utf8');
    assert.match(updated, /line2-modified/);
    // undo
    const token = store.keys().next().value;
    const u = applyUndo(token, store);
    assert.ok(u.ok, 'undo works');
    const reverted = readFileSync(join(dir, 'x.txt'), 'utf8');
    assert.match(reverted, /line2\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyPatchTool errors on missing target file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenite-patch2-'));
  try {
    const r = await applyPatchTool({ patch: '--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-a\n+b\n' }, { workspace: dir });
    assert.equal(r.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
