// Custom agents (personas) persistence: the user-created agents that make the
// gallery feel like a real platform (mirrors Cherry's user assistants / Hermes
// self-authored skills). Validates the file-backed store end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  savePersona,
  listPersonas,
  readPersona,
  deletePersona,
} from '../src/core/memory.js';

function tmpBase() {
  return mkdtempSync(join(tmpdir(), 'agenite-agents-'));
}

test('save then list then read a custom agent', async () => {
  const base = tmpBase();
  const r = await savePersona(base, {
    name: '周报助手',
    description: '帮你把周报写得又快又好',
    system_prompt: '你是一名周报助手，用要点式总结本周进展、风险与下周计划。',
  });
  assert.equal(r.ok, true);
  assert.equal(typeof r.slug, 'string');
  assert.ok(r.slug.length > 0);

  const list = await listPersonas(base);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '周报助手');
  assert.equal(list[0].system_prompt.includes('周报助手'), true);

  const read = await readPersona(base, '周报助手');
  assert.equal(read.ok, true);
  assert.equal(read.content.includes('要点式'), true);
});

test('save rejects empty name or empty prompt', async () => {
  const base = tmpBase();
  assert.equal((await savePersona(base, { name: '', system_prompt: 'x' })).ok, false);
  assert.equal((await savePersona(base, { name: '无指令', system_prompt: '  ' })).ok, false);
  assert.equal((await savePersona(base, { name: 'ok' })).ok, false);
});

test('delete removes the agent', async () => {
  const base = tmpBase();
  const r = await savePersona(base, { name: 'Temp', system_prompt: 'do things' });
  assert.equal(r.ok, true);
  const del = await deletePersona(base, r.slug);
  assert.equal(del.ok, true);
  assert.equal((await listPersonas(base)).length, 0);
  const read = await readPersona(base, 'Temp');
  assert.equal(read.ok, false);
});

test('same-name save overwrites (slug collision)', async () => {
  const base = tmpBase();
  await savePersona(base, { name: 'Dup', system_prompt: 'v1' });
  await savePersona(base, { name: 'Dup', system_prompt: 'v2' });
  const list = await listPersonas(base);
  assert.equal(list.length, 1);
  assert.equal(list[0].system_prompt, 'v2');
});
