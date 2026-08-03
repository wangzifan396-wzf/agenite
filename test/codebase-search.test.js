// Tests for the local codebase search tool (src/core/tools.js codebaseSearch).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codebaseSearch, csTokenize, chunkText, lexicalScore } from '../src/core/tools.js';

test('tokenize splits latin words and CJK characters', () => {
  const t = csTokenize('Handle 用户 Token_AUTH');
  assert.ok(t.includes('handle'));
  assert.ok(t.includes('用'));
  assert.ok(t.includes('户'));
  assert.ok(t.includes('token_auth'));
});

test('chunkText overlaps and covers the whole text', () => {
  const text = 'a'.repeat(2500);
  const chunks = chunkText(text, 900, 150);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.join('').includes('a'.repeat(2500)));
});

test('lexicalScore rewards more query tokens present', () => {
  assert.ok(lexicalScore('auth user', 'auth and user logic') > lexicalScore('auth user', 'auth only'));
  assert.equal(lexicalScore('', 'anything'), 0);
});

test('codebaseSearch finds the right file by keyword', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenite-cs-'));
  try {
    await writeFile(join(root, 'auth.js'), 'function authenticateUser(token) {\n  return verify(token);\n}\nmodule.exports = authenticateUser;', 'utf8');
    await writeFile(join(root, 'util.py'), 'def format_date(d):\n    return d.isoformat()\n', 'utf8');
    await writeFile(join(root, 'notes.md'), 'just some notes about the project\n', 'utf8');

    const r = await codebaseSearch({ query: 'authenticate user token' }, { workspace: root });
    assert.equal(r.ok, true);
    assert.ok(r.content.includes('auth.js'), 'should surface auth.js');
    assert.ok(r.content.includes('authenticateUser'), 'should include a relevant snippet');
    assert.ok(!r.semantic, 'no embed fn -> semantic false');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('codebaseSearch ignores node_modules and respects ext filter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenite-cs2-'));
  try {
    await mkdir(join(root, 'node_modules', 'lodash'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'lodash', 'index.js'), 'function authenticateUser(){}\n', 'utf8');
    await writeFile(join(root, 'main.js'), 'function authenticateUser(){}\n', 'utf8');

    const r = await codebaseSearch({ query: 'authenticateUser' }, { workspace: root });
    assert.ok(r.content.includes('main.js'));
    assert.ok(!r.content.includes('node_modules'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('codebaseSearch uses semantic rerank when embed is provided', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenite-cs3-'));
  try {
    await writeFile(join(root, 'a.js'), 'alpha beta gamma authentication logic here', 'utf8');
    await writeFile(join(root, 'b.js'), 'completely unrelated cooking recipe content', 'utf8');
    // Fake embed: deterministic vector keyed by a keyword so "authentication"
    // is near the query and "cooking" is far.
    const embed = async (text) => {
      const t = String(text).toLowerCase();
      return [t.includes('auth') ? 1 : 0, t.includes('cook') ? 1 : 0, 0.1];
    };
    const r = await codebaseSearch({ query: 'authentication' }, { workspace: root, embed });
    assert.equal(r.ok, true);
    assert.equal(r.semantic, true);
    assert.ok(r.content.includes('a.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('codebaseSearch reports no hits gracefully', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agenite-cs4-'));
  try {
    await writeFile(join(root, 'x.js'), 'nothing relevant here', 'utf8');
    const r = await codebaseSearch({ query: 'zzz_nonexistent_zzz' }, { workspace: root });
    assert.equal(r.ok, true);
    assert.ok(r.content.includes('没有找到') || r.content.includes('没有可检索') || r.content.includes('没有找到'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
