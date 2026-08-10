// Tests for the self-curating skill library (v0.46): metadata, versioning,
// supersede-on-relearn, usage scoring, pruning and prompt-index filtering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  slugify,
  saveSkill,
  listSkills,
  readSkill,
  deleteSkill,
  injectSkills,
  computeSkillScore,
  normalizeSkillMeta,
  serializeSkillMeta,
  recordSkillUse,
  markSuperseded,
  patchSkillFile,
  pruneSkills,
  SKILL_STATUS
} from '../src/core/memory.js';

async function tmpBase(tag) {
  return mkdtemp(join(tmpdir(), `agenite-skilllib-${tag}-`));
}

test('computeSkillScore is Laplace-smoothed and monotonic', () => {
  assert.equal(computeSkillScore(0, 0), 0.5); // unused skill starts neutral
  assert.equal(computeSkillScore(3, 0), 0.2); // tried thrice, never worked
  assert.equal(computeSkillScore(3, 3), 0.8);
  assert.ok(computeSkillScore(10, 9) > computeSkillScore(3, 2));
  // success can never exceed usage, even if a caller lies
  assert.equal(computeSkillScore(2, 99), computeSkillScore(2, 2));
});

test('normalizeSkillMeta fills defaults so pre-v0.46 skill files still load', () => {
  const m = normalizeSkillMeta({ name: 'Old Skill', description: 'legacy' }, 'old-skill');
  assert.equal(m.version, 1);
  assert.equal(m.status, SKILL_STATUS.ACTIVE);
  assert.equal(m.verified, false);
  assert.deepEqual(m.antiPatterns, []);
  assert.equal(m.usageCount, 0);
  assert.equal(m.score, 0.5);
});

test('normalizeSkillMeta parses real metadata and rejects bogus status', () => {
  const m = normalizeSkillMeta(
    {
      name: 'X', description: 'd', when_to_use: 'w',
      version: '3', status: 'nonsense', verified: 'true',
      anti_patterns: '不要改 dist | 先读文件再改', usage_count: '5', success_count: '4'
    },
    'x'
  );
  assert.equal(m.version, 3);
  assert.equal(m.status, SKILL_STATUS.ACTIVE); // unknown status falls back to active
  assert.equal(m.verified, true);
  assert.deepEqual(m.antiPatterns, ['不要改 dist', '先读文件再改']);
  assert.equal(m.usageCount, 5);
  assert.equal(m.successCount, 4);
});

test('serializeSkillMeta round-trips through normalizeSkillMeta', () => {
  const meta = normalizeSkillMeta({}, 'rt');
  meta.name = 'Round Trip';
  meta.description = 'desc';
  meta.antiPatterns = ['a', 'b'];
  meta.verified = true;
  meta.version = 2;
  const text = serializeSkillMeta(meta);
  const parsed = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > -1 && line !== '---') parsed[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const back = normalizeSkillMeta(parsed, 'rt');
  assert.equal(back.name, 'Round Trip');
  assert.equal(back.version, 2);
  assert.equal(back.verified, true);
  assert.deepEqual(back.antiPatterns, ['a', 'b']);
});

test('saveSkill persists metadata, anti-patterns section and slug', async () => {
  const base = await tmpBase('save');
  try {
    const r = await saveSkill(base, {
      name: 'Deploy To Staging',
      description: '构建并发布到预发',
      whenToUse: 'CI 通过之后',
      body: '1. npm run build\n2. scp dist',
      antiPatterns: ['不要直接改 dist/，它是构建产物'],
      verified: true,
      source: 'auto'
    });
    assert.equal(r.ok, true);
    assert.equal(r.slug, 'deploy-to-staging');
    assert.equal(r.version, 1);

    const text = await readFile(join(base, 'skills', 'deploy-to-staging.md'), 'utf8');
    assert.ok(text.includes('name: Deploy To Staging'));
    assert.ok(text.includes('verified: true'));
    assert.ok(text.includes('source: auto'));
    assert.ok(text.includes('anti_patterns: 不要直接改 dist/，它是构建产物'));
    assert.ok(text.includes('## 反模式'), 'body should carry a readable anti-pattern section');

    const [s] = await listSkills(base);
    assert.equal(s.verified, true);
    assert.equal(s.status, SKILL_STATUS.ACTIVE);
    assert.deepEqual(s.antiPatterns, ['不要直接改 dist/，它是构建产物']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('re-saving the same skill bumps the version and parks the old revision', async () => {
  const base = await tmpBase('supersede');
  try {
    await saveSkill(base, { name: 'Build Flow', description: 'v1 desc', body: 'old steps' });
    const second = await saveSkill(base, { name: 'Build Flow', description: 'v2 desc', body: 'new steps', verified: true });
    assert.equal(second.version, 2);
    assert.equal(second.supersedes, 'build-flow.v1');

    const list = await listSkills(base);
    const live = list.find((s) => s.slug === 'build-flow');
    const old = list.find((s) => s.slug === 'build-flow.v1');
    assert.ok(live && old, 'both the new and the archived revision exist on disk');
    assert.equal(live.version, 2);
    assert.equal(live.status, SKILL_STATUS.ACTIVE);
    assert.equal(live.description, 'v2 desc');
    assert.equal(old.status, SKILL_STATUS.SUPERSEDED);
    assert.equal(old.supersededBy, 'build-flow');

    // rollback material is intact
    const rolled = await readSkill(base, 'build-flow.v1');
    assert.ok(rolled.content.includes('old steps'));

    // createdAt is inherited, so the skill keeps its real birthday
    assert.equal(live.createdAt, old.createdAt);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('saveSkill with supersede:false updates in place without a new revision', async () => {
  const base = await tmpBase('inplace');
  try {
    await saveSkill(base, { name: 'Patch Me', description: 'a', body: 'x' });
    const r = await saveSkill(base, { name: 'Patch Me', description: 'b', body: 'y', supersede: false });
    assert.equal(r.version, 1);
    const list = await listSkills(base);
    assert.equal(list.length, 1);
    assert.equal(list[0].description, 'b');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('recordSkillUse increments usage and recomputes the score', async () => {
  const base = await tmpBase('usage');
  try {
    await saveSkill(base, { name: 'Recall Me', description: 'd', body: 'b' });
    await recordSkillUse(base, 'Recall Me', { success: true });
    await recordSkillUse(base, 'recall-me', { success: true });
    await recordSkillUse(base, 'recall-me'); // outcome unknown → usage only
    const [s] = await listSkills(base);
    assert.equal(s.usageCount, 3);
    assert.equal(s.successCount, 2);
    assert.equal(s.score, computeSkillScore(3, 2));
    const missing = await recordSkillUse(base, 'nope');
    assert.equal(missing.ok, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('markSuperseded and patchSkillFile flip status without losing the body', async () => {
  const base = await tmpBase('patch');
  try {
    await saveSkill(base, { name: 'Legacy Way', description: 'd', body: 'unique-body-token' });
    await markSuperseded(base, 'legacy-way', 'new-way');
    const [s] = await listSkills(base);
    assert.equal(s.status, SKILL_STATUS.SUPERSEDED);
    assert.equal(s.supersededBy, 'new-way');
    const raw = await readSkill(base, 'legacy-way');
    assert.ok(raw.content.includes('unique-body-token'));

    const patched = await patchSkillFile(base, 'legacy-way', { verified: true });
    assert.equal(patched.ok, true);
    assert.equal((await listSkills(base))[0].verified, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('pruneSkills archives only proven losers, never the untested or the good', async () => {
  const base = await tmpBase('prune');
  try {
    await saveSkill(base, { name: 'Loser', description: 'keeps failing', body: 'b' });
    await saveSkill(base, { name: 'Winner', description: 'works', body: 'b' });
    await saveSkill(base, { name: 'Rookie', description: 'never tried', body: 'b' });

    for (let i = 0; i < 4; i++) await recordSkillUse(base, 'loser'); // 0/4 → score 0.167
    for (let i = 0; i < 4; i++) await recordSkillUse(base, 'winner', { success: true }); // 4/4 → 0.833

    const r = await pruneSkills(base, { minUses: 3, minScore: 0.4 });
    assert.equal(r.pruned.length, 1);
    assert.equal(r.pruned[0].slug, 'loser');

    const byslug = Object.fromEntries((await listSkills(base)).map((s) => [s.slug, s]));
    assert.equal(byslug.loser.status, SKILL_STATUS.ARCHIVED);
    assert.equal(byslug.winner.status, SKILL_STATUS.ACTIVE);
    assert.equal(byslug.rookie.status, SKILL_STATUS.ACTIVE, 'an unused skill has not earned retirement yet');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('injectSkills hides retired revisions, ranks by score and shows evidence badges', async () => {
  const base = await tmpBase('inject');
  try {
    assert.equal(await injectSkills(base), '', 'no skills → no prompt bloat');

    await saveSkill(base, { name: 'Alpha', description: 'a-desc', whenToUse: '触发 A', body: 'x', verified: true, antiPatterns: ['不要 A'] });
    await saveSkill(base, { name: 'Beta', description: 'b-desc', whenToUse: '触发 B', body: 'x' });
    await saveSkill(base, { name: 'Alpha', description: 'a-desc v2', body: 'x2', verified: true }); // creates alpha.v1 (superseded)
    await saveSkill(base, { name: 'Zombie', description: 'archived one', body: 'x' });
    await patchSkillFile(base, 'zombie', { status: SKILL_STATUS.ARCHIVED });
    for (let i = 0; i < 3; i++) await recordSkillUse(base, 'alpha', { success: true });

    const block = await injectSkills(base);
    assert.ok(block.includes('**Alpha**'));
    assert.ok(block.includes('**Beta**'));
    assert.ok(!block.includes('archived one'), 'archived skills stay out of the prompt');
    assert.ok(!block.includes('a-desc（'), 'superseded revision must not appear');
    assert.ok(block.includes('v2'), 'version badge');
    assert.ok(block.includes('✓已验证'), 'verification badge');
    assert.ok(block.includes('用过3次'), 'usage badge');
    assert.ok(block.indexOf('**Alpha**') < block.indexOf('**Beta**'), 'higher score is listed first');
    assert.ok(block.includes('（适用：触发 B）'), 'when_to_use is rendered when present');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('injectSkills truncates a runaway catalog', async () => {
  const base = await tmpBase('trunc');
  try {
    for (let i = 0; i < 40; i++) {
      await saveSkill(base, { name: `Skill Number ${i}`, description: 'x'.repeat(120), body: 'b' });
    }
    const block = await injectSkills(base, { maxChars: 400 });
    assert.ok(block.includes('技能库已截断'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a hand-written pre-v0.46 skill file is still listed, injected and readable', async () => {
  const base = await tmpBase('legacy');
  try {
    await mkdir(join(base, 'skills'), { recursive: true });
    await writeFile(
      join(base, 'skills', 'hand-written.md'),
      '---\nname: Hand Written\ndescription: 老格式技能\nwhen_to_use: 任何时候\n---\n\n步骤一\n',
      'utf8'
    );
    const list = await listSkills(base);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Hand Written');
    assert.equal(list[0].version, 1);
    assert.equal(list[0].status, SKILL_STATUS.ACTIVE);
    const block = await injectSkills(base);
    assert.ok(block.includes('Hand Written'));
    const read = await readSkill(base, 'Hand Written');
    assert.ok(read.content.includes('步骤一'));
    // and it upgrades cleanly on the next save
    await saveSkill(base, { name: 'Hand Written', description: '新格式', body: '步骤二', verified: true });
    const after = (await listSkills(base)).find((s) => s.slug === 'hand-written');
    assert.equal(after.version, 2);
    assert.equal(after.verified, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('slugify and deleteSkill keep working on the new layout', async () => {
  const base = await tmpBase('misc');
  try {
    assert.equal(slugify('Deploy To Staging!'), 'deploy-to-staging');
    assert.equal(slugify(''), 'skill');
    await saveSkill(base, { name: '中文技能', description: 'd', body: 'b' });
    const del = await deleteSkill(base, '中文技能');
    assert.equal(del.ok, true);
    assert.equal((await listSkills(base)).length, 0);
    assert.equal((await deleteSkill(base, 'ghost')).ok, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
