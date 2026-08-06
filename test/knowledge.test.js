import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledge, chunkText, cleanFtsQuery } from '../src/core/knowledge.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpKB() {
  const dir = mkdtempSync(join(tmpdir(), 'agenite-kb-'));
  return createKnowledge(join(dir, 'kb.sqlite'));
}

test('chunkText splits long text and keeps min length', () => {
  const big = '这是一段用于测试分块的较长中文文本。'.repeat(200);
  const chunks = chunkText(big);
  assert.ok(chunks.length >= 2, 'should produce multiple chunks');
  for (const c of chunks) assert.ok(c.length >= 12, 'chunk too small');
});

test('cleanFtsQuery keeps CJK and enforces >=3 chars', () => {
  assert.equal(cleanFtsQuery('知'), '');
  assert.equal(cleanFtsQuery('知识库'), '知识库');
  assert.equal(cleanFtsQuery('a b! c@#'), 'a b c');
});

test('ingest → retrieve (CJK substring) → list → stats → remove', () => {
  const kb = tmpKB();
  const doc = kb.ingestText({
    title: '产品文档',
    text: '我们的产品支持本地知识库检索，用户可以把文档导入做问答。知识库完全在本机运行，不上云。',
    source: 'pasted'
  });
  assert.ok(doc && doc.id > 0, 'doc created');
  assert.ok(doc.chunks >= 1, 'chunks created');

  const hits = kb.retrieve('知识库', 5);
  assert.ok(hits.length >= 1, 'should retrieve 知识库');
  assert.ok(hits[0].text.includes('知识库'), 'hit contains query');

  const docs = kb.listDocs();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].title, '产品文档');

  const st = kb.stats();
  assert.equal(st.docs, 1);
  assert.ok(st.chunks >= 1);

  kb.removeDoc(doc.id);
  assert.equal(kb.listDocs().length, 0);
  kb.close();
});

test('retrieve returns [] for short or empty query', () => {
  const kb = tmpKB();
  kb.ingestText({ title: 't', text: '本地知识库检索测试内容。', source: 'p' });
  assert.deepEqual(kb.retrieve('', 5), []);
  assert.deepEqual(kb.retrieve('库', 5), []); // < 3 chars -> no match
  kb.close();
});

test('clear empties the base', () => {
  const kb = tmpKB();
  kb.ingestText({ title: 'x', text: '另一段关于智能体与本地运行的内容。', source: 'p' });
  kb.clear();
  assert.equal(kb.stats().docs, 0);
  kb.close();
});

test('ingestUrl stores kind=url with source', () => {
  const kb = tmpKB();
  const doc = kb.ingestUrl({ url: 'https://example.com/doc', text: '网页内容详细介绍了本地知识库检索的实现方式，以及它如何在本机离线运行。', title: '示例网页' });
  assert.equal(doc.kind, 'url');
  const hits = kb.retrieve('知识库', 3);
  assert.ok(hits.length >= 1 && hits[0].source === 'https://example.com/doc', 'hit should come from the url source');
  kb.close();
});
