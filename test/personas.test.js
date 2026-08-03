import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePersona, listPersonas, readPersona, deletePersona } from '../src/core/memory.js';

let base;
function fresh() { return base; }

test.beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'agenite-persona-'));
});
test.afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

test('savePersona requires name + instructions', async () => {
  const r = await savePersona(fresh(), { name: '', system_prompt: '' });
  assert.equal(r.ok, false);
});

test('save -> list -> read -> delete lifecycle', async () => {
  const saved = await savePersona(fresh(), {
    name: 'SQL 专家',
    description: '擅长复杂查询与优化',
    system_prompt: '你是一位 SQL 专家，优先给出可执行的查询与执行计划分析。'
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.slug, 'sql-专家');

  const list = await listPersonas(fresh());
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'SQL 专家');
  assert.equal(list[0].slug, 'sql-专家');
  assert.match(list[0].system_prompt, /SQL 专家/);

  const read = await readPersona(fresh(), 'sql-专家');
  assert.equal(read.ok, true);
  assert.match(read.content, /执行计划/);

  const del = await deletePersona(fresh(), 'sql-专家');
  assert.equal(del.ok, true);
  assert.equal((await listPersonas(fresh())).length, 0);
});

test('readPersona resolves by name or slug', async () => {
  await savePersona(fresh(), { name: '研究员', system_prompt: '论证要有依据。' });
  assert.equal((await readPersona(fresh(), '研究员')).ok, true);
  assert.equal((await readPersona(fresh(), '研究员')).slug, '研究员');
});

test('deletePersona on missing returns error', async () => {
  const r = await deletePersona(fresh(), 'nope');
  assert.equal(r.ok, false);
  assert.match(r.error, /未找到/);
});
