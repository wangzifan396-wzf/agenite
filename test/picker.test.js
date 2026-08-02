// Tests for the pure helpers behind the "@" file picker, "/" commands,
// the workspace index and the Markdown transcript export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fuzzyMatch, fuzzyFilter, formatBytes } from '../src/core/util.js';
import { scanWorkspaceFiles } from '../src/core/tools.js';

// ---------- fuzzyMatch ----------

test('fuzzyMatch returns null when characters are missing', () => {
  assert.equal(fuzzyMatch('src/app.js', 'xyz'), null);
  assert.equal(fuzzyMatch('README.md', 'zzz'), null);
});

test('fuzzyMatch matches a scattered subsequence', () => {
  const m = fuzzyMatch('src/core/tools.js', 'stj');
  assert.ok(m, 'should match s-t-j as a subsequence');
  assert.equal(m.hits.length, 3);
});

test('fuzzyMatch returns zero-score for an empty query', () => {
  const m = fuzzyMatch('anything', '');
  assert.deepEqual(m, { score: 0, hits: [] });
});

test('fuzzyMatch scores a contiguous substring above a scattered match', () => {
  const contiguous = fuzzyMatch('src/core/tools.js', 'tools');
  const scattered = fuzzyMatch('src/core/tools.js', 'scoj');
  assert.ok(contiguous.score > scattered.score);
});

test('fuzzyMatch prefers hits in the basename over the directory', () => {
  const inBase = fuzzyMatch('deep/nested/dir/app.js', 'app');
  const inDir = fuzzyMatch('app/nested/dir/zzzz.js', 'app');
  assert.ok(inBase.score > inDir.score, 'basename match should win');
});

test('fuzzyMatch is case-insensitive', () => {
  assert.ok(fuzzyMatch('README.md', 'readme'));
  assert.ok(fuzzyMatch('src/App.JS', 'app.js'));
});

test('fuzzyMatch hit indices point at the matched characters', () => {
  const m = fuzzyMatch('abc', 'ac');
  assert.deepEqual(m.hits, [0, 2]);
});

// ---------- fuzzyFilter ----------

test('fuzzyFilter ranks the most relevant candidate first', () => {
  const files = [
    { path: 'src/core/provider.js' },
    { path: 'src/app.js' },
    { path: 'test/agent.test.js' }
  ];
  const out = fuzzyFilter(files, 'app', { key: (f) => f.path });
  assert.equal(out[0].item.path, 'src/app.js');
});

test('fuzzyFilter drops non-matching items', () => {
  const files = [{ path: 'a.js' }, { path: 'b.js' }];
  const out = fuzzyFilter(files, 'zzz', { key: (f) => f.path });
  assert.equal(out.length, 0);
});

test('fuzzyFilter with an empty query returns the head of the list', () => {
  const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
  const out = fuzzyFilter(files, '', { key: (f) => f.path, limit: 2 });
  assert.equal(out.length, 2);
  assert.equal(out[0].item.path, 'a');
});

test('fuzzyFilter honours the limit option', () => {
  const files = Array.from({ length: 50 }, (_, i) => ({ path: `file${i}.js` }));
  const out = fuzzyFilter(files, 'file', { key: (f) => f.path, limit: 5 });
  assert.equal(out.length, 5);
});

test('fuzzyFilter matches slash commands by name', () => {
  const cmds = [{ name: '/export' }, { name: '/model' }, { name: '/rename' }];
  const out = fuzzyFilter(cmds, 'exp', { key: (c) => c.name.slice(1) });
  assert.equal(out[0].item.name, '/export');
});

// ---------- formatBytes ----------

test('formatBytes renders B / KB / MB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 3), '3.0 MB');
});

test('formatBytes tolerates junk input', () => {
  assert.equal(formatBytes(-1), '');
  assert.equal(formatBytes('abc'), '');
  assert.equal(formatBytes(null), '0 B');
});

// ---------- scanWorkspaceFiles ----------

async function makeTree() {
  const root = await mkdtemp(join(tmpdir(), 'agenite-scan-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<h1>hi</h1>');
  await writeFile(join(root, 'src', 'app.js'), 'export const a = 1;');
  await writeFile(join(root, 'node_modules', 'pkg', 'junk.js'), 'nope');
  await writeFile(join(root, '.git', 'HEAD'), 'ref: main');
  await writeFile(join(root, '.hidden'), 'secret');
  return root;
}

test('scanWorkspaceFiles lists real files with sizes', async () => {
  const root = await makeTree();
  try {
    const files = await scanWorkspaceFiles({ root });
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes('index.html'));
    assert.ok(paths.includes('src/app.js'));
    const idx = files.find((f) => f.path === 'index.html');
    assert.equal(idx.size, '<h1>hi</h1>'.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceFiles skips node_modules, .git and dotfiles', async () => {
  const root = await makeTree();
  try {
    const paths = (await scanWorkspaceFiles({ root })).map((f) => f.path);
    assert.ok(!paths.some((p) => p.includes('node_modules')), 'node_modules must be skipped');
    assert.ok(!paths.some((p) => p.includes('.git')), '.git must be skipped');
    assert.ok(!paths.includes('.hidden'), 'dotfiles must be skipped');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceFiles respects the limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenite-limit-'));
  try {
    for (let i = 0; i < 12; i++) await writeFile(join(root, `f${i}.txt`), 'x');
    const files = await scanWorkspaceFiles({ root, limit: 5 });
    assert.equal(files.length, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceFiles returns paths with forward slashes and sorted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenite-sort-'));
  try {
    await mkdir(join(root, 'b'), { recursive: true });
    await writeFile(join(root, 'b', 'z.txt'), 'x');
    await writeFile(join(root, 'a.txt'), 'x');
    const paths = (await scanWorkspaceFiles({ root })).map((f) => f.path);
    assert.deepEqual(paths, ['a.txt', 'b/z.txt']);
    assert.ok(!paths.some((p) => p.includes('\\')), 'no backslashes in output');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanWorkspaceFiles on a missing directory yields an empty list', async () => {
  const files = await scanWorkspaceFiles({ root: join(tmpdir(), 'agenite-does-not-exist-xyz') });
  assert.deepEqual(files, []);
});