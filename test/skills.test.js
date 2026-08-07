// Curated skill packs (the "Agent Skills" gallery). Validates the data shape,
// the resolver that injects active packs into the system prompt, and that the
// config normalizer keeps `skills` a clean string array.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_SKILLS, resolveBuiltinSkills, listBuiltinSkills } from '../src/core/skills.js';
import { normalizeConfig } from '../src/core/config.js';

test('BUILTIN_SKILLS has the required shape and no duplicates', () => {
  assert.ok(BUILTIN_SKILLS.length >= 8, 'expected at least 8 curated packs');
  const names = new Set();
  for (const s of BUILTIN_SKILLS) {
    for (const k of ['name', 'icon', 'tagline', 'description', 'category', 'system_prompt']) {
      assert.ok(s[k], `skill ${s.name || '?'} missing field ${k}`);
    }
    assert.ok(!names.has(s.name), `duplicate skill name: ${s.name}`);
    names.add(s.name);
    assert.ok(s.system_prompt.length >= 40, `system_prompt too short: ${s.name}`);
  }
});

test('listBuiltinSkills omits the full system_prompt', () => {
  const list = listBuiltinSkills();
  assert.equal(list.length, BUILTIN_SKILLS.length);
  assert.equal(list[0].system_prompt, undefined);
  assert.ok(list[0].name && list[0].category);
});

test('resolveBuiltinSkills returns empty string when nothing is active', () => {
  assert.equal(resolveBuiltinSkills([]), '');
  assert.equal(resolveBuiltinSkills(undefined), '');
  assert.equal(resolveBuiltinSkills(['does-not-exist']), '');
});

test('resolveBuiltinSkills injects active packs and ignores unknown names', () => {
  const block = resolveBuiltinSkills(['tdd', 'security-audit', 'nope']);
  assert.ok(block.startsWith('## 已启用的技能包'));
  assert.ok(block.includes('测试驱动'), 'TDD methodology missing');
  assert.ok(block.includes('安全审计'), 'security methodology missing');
  assert.ok(!block.includes('nope'), 'unknown name leaked');
});

test('normalizeConfig keeps skills as a clean string array', () => {
  const c1 = normalizeConfig({ skills: ['tdd', 1, '', ' security-audit ', null, undefined] });
  assert.deepEqual(c1.skills, ['tdd', 'security-audit']);
  const c2 = normalizeConfig({});
  assert.deepEqual(c2.skills, []);
  const c3 = normalizeConfig({ skills: 'tdd' });
  assert.deepEqual(c3.skills, []);
});
