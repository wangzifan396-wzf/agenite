// Long-term memory: file-based, survives restarts, cross-session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveMemory, recall, logDaily, injectMemory, defaultMemoryDir
} from '../src/core/memory.js';

const base = () => mkdtempSync(join(tmpdir(), 'agenite-mem-'));

test('defaultMemoryDir points under ~/.agenite/memory', () => {
  assert.ok(defaultMemoryDir().replace(/\\/g, '/').endsWith('.agenite/memory'), defaultMemoryDir());
});

test('saveMemory creates a categorized bullet and update replaces it', async () => {
  const dir = base();
  let r = await saveMemory(dir, 'Preferences', 'language', '中文');
  assert.equal(r.ok, true);
  let md = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  assert.match(md, /## Preferences/);
  assert.match(md, /- \*\*language\*\*: 中文/);

  // update same key -> replaces, does not duplicate
  await saveMemory(dir, 'Preferences', 'language', 'English');
  md = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  const hits = md.split('\n').filter((l) => /- \*\*language\*\*:/.test(l));
  assert.equal(hits.length, 1, 'key should appear exactly once');
  assert.match(md, /- \*\*language\*\*: English/);

  // second key under same category appends a new bullet
  await saveMemory(dir, 'Preferences', 'theme', 'dark');
  md = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  assert.match(md, /- \*\*theme\*\*: dark/);
});

test('saveMemory adds a brand new section when the category is missing', async () => {
  const dir = base();
  await saveMemory(dir, 'Projects', 'agenite', 'local-first agent');
  const md = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  assert.match(md, /## Projects/);
  assert.match(md, /- \*\*agenite\*\*: local-first agent/);
});

test('recall finds matching lines and reports when nothing matches', async () => {
  const dir = base();
  await saveMemory(dir, 'Preferences', 'language', '中文');
  const hit = await recall(dir, '中文');
  assert.equal(hit.ok, true);
  assert.match(hit.content, /中文/);

  const miss = await recall(dir, 'zzz-no-such-memory');
  assert.match(miss.content, /没有/);
});

test('logDaily appends a dated note', async () => {
  const dir = base();
  const today = new Date().toISOString().slice(0, 10);
  const r = await logDaily(dir, 'Progress', 'wrote the memory module');
  assert.equal(r.ok, true);
  const file = join(dir, `${today}.md`);
  assert.ok(existsSync(file));
  const text = readFileSync(file, 'utf8');
  assert.match(text, /## Progress/);
  assert.match(text, /wrote the memory module/);
});

test('injectMemory returns the curated block, empty when nothing remembered', async () => {
  const dir = base();
  assert.equal(await injectMemory(dir), '');
  await saveMemory(dir, 'Preferences', 'language', '中文');
  const block = await injectMemory(dir);
  assert.match(block, /长期记忆/);
  assert.match(block, /中文/);
});
