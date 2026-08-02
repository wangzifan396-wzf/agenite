// Self-evolving skills: the agent crystallizes workflows into local SKILL.md
// files that future sessions auto-load. Tests the file format + catalog logic.
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { saveSkill, listSkills, readSkill, deleteSkill, slugify, injectSkills } from '../src/core/memory.js';

const base = () => mkdtempSync(join(tmpdir(), 'agenite-skills-'));

test('slugify normalizes names (spaces, casing, CJK)', () => {
  assert.equal(slugify('Deploy To Staging'), 'deploy-to-staging');
  assert.equal(slugify('  Hello World! '), 'hello-world');
  assert.equal(slugify('部署流程'), '部署流程');
});

test('saveSkill writes a SKILL.md with frontmatter; list/read round-trip', async () => {
  const dir = base();
  try {
    const r = await saveSkill(dir, {
      name: 'Deploy To Staging',
      description: 'Ship the build to the staging environment.',
      when_to_use: 'after tests pass',
      body: '1. run tests\n2. build\n3. deploy'
    });
    assert.equal(r.ok, true);
    assert.equal(r.slug, 'deploy-to-staging');
    const file = join(dir, 'skills', 'deploy-to-staging.md');
    assert.ok(existsSync(file));
    const text = readFileSync(file, 'utf8');
    assert.match(text, /name: Deploy To Staging/);
    assert.match(text, /when_to_use: after tests pass/);
    assert.match(text, /1\. run tests/);

    const list = await listSkills(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Deploy To Staging');

    const full = await readSkill(dir, 'deploy-to-staging');
    assert.equal(full.ok, true);
    assert.match(full.content, /1\. run tests/);
    const byName = await readSkill(dir, 'Deploy To Staging');
    assert.equal(byName.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injectSkills lists the catalog; empty when none', async () => {
  const dir = base();
  try {
    assert.equal(await injectSkills(dir), '');
    await saveSkill(dir, { name: 'A', description: 'do a', body: 'x' });
    const block = await injectSkills(dir);
    assert.match(block, /技能库/);
    assert.match(block, /do a/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteSkill removes the file', async () => {
  const dir = base();
  try {
    await saveSkill(dir, { name: 'B', description: 'do b', body: 'y' });
    const del = await deleteSkill(dir, 'B');
    assert.equal(del.ok, true);
    assert.equal((await listSkills(dir)).length, 0);
    const missing = await readSkill(dir, 'B');
    assert.equal(missing.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
