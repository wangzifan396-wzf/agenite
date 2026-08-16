// v0.63 — Skill Curation & Pruning unit tests.
// Exercises the pure, deps-injectable curateSkills / bumpUsage logic with an
// in-memory fs so no real disk or network is touched.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { curateSkills, bumpUsage, resolveSkillCurationMode, loadIndex } from '../src/core/skillMemory.js';

// Minimal in-memory fs implementing the subset skillMemory.js uses.
function memFs() {
  const files = new Map();
  const norm = (p) => p.replace(/\\/g, '/');
  return {
    _files: files,
    existsSync: (p) => files.has(norm(p)),
    readFileSync: (p) => {
      const k = norm(p);
      if (!files.has(k)) throw new Error('ENOENT ' + k);
      return files.get(k);
    },
    writeFileSync: (p, data) => files.set(norm(p), String(data)),
    mkdirSync: () => {}
  };
}

function writeIndex(fs, dir, skills) {
  fs.writeFileSync(dir + '/index.json', JSON.stringify({ skills }));
}

const today = new Date().toISOString().slice(0, 10);
const old = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);

describe('skillMemory curation (v0.63)', () => {
  it('resolveSkillCurationMode defaults on, off when set', () => {
    assert.equal(resolveSkillCurationMode({}), 'on');
    assert.equal(resolveSkillCurationMode({ skillCuration: 'on' }), 'on');
    assert.equal(resolveSkillCurationMode({ skillCuration: 'off' }), 'off');
  });

  it('skips curation when mode is off', () => {
    const fs = memFs();
    writeIndex(fs, '/sk', [{ id: 'a', name: 'A', used: 0, confidence: 0.5, created: old, status: 'active' }]);
    const r = curateSkills({ dir: '/sk', config: { skillCuration: 'off' }, deps: { fs } });
    assert.equal(r.skipped, true);
    assert.deepEqual(r.archived, []);
  });

  it('caps the library: archives lowest-value actives beyond maxSkills', () => {
    const fs = memFs();
    // 5 active skills; distinct goals; value = (used+1)*(0.3+0.7*conf).
    // Make them differ by usage so the ranking is deterministic.
    const skills = [
      { id: 's1', name: 'S1', goal: 'g1', used: 0, confidence: 0.5, created: old, status: 'active' }, // low
      { id: 's2', name: 'S2', goal: 'g2', used: 1, confidence: 0.5, created: old, status: 'active' },
      { id: 's3', name: 'S3', goal: 'g3', used: 2, confidence: 0.5, created: old, status: 'active' },
      { id: 's4', name: 'S4', goal: 'g4', used: 3, confidence: 0.5, created: old, status: 'active' },
      { id: 's5', name: 'S5', goal: 'g5', used: 4, confidence: 0.9, created: today, status: 'active' } // high
    ];
    writeIndex(fs, '/sk', skills);
    const r = curateSkills({ dir: '/sk', config: { maxSkills: 2, skillDecayDays: 90 }, deps: { fs } });
    assert.equal(r.archived.length, 3, 'should archive 3 to reach cap of 2');
    // The two survivors must be the highest-value: s5 (used 4, conf .9) and s4 (used 3).
    const kept = loadIndex({ dir: '/sk', deps: { fs } }).skills.filter((s) => s.status !== 'archived').map((s) => s.id).sort();
    assert.deepEqual(kept, ['s4', 's5']);
  });

  it('dedupes by goal: keeps the better, archives the duplicate', () => {
    const fs = memFs();
    const skills = [
      { id: 'keep', name: 'Keep', goal: 'same goal', used: 5, confidence: 0.9, created: today, status: 'active' },
      { id: 'drop', name: 'Drop', goal: 'same goal', used: 0, confidence: 0.5, created: old, status: 'active' } // identical goal, weaker
    ];
    writeIndex(fs, '/sk', skills);
    const r = curateSkills({ dir: '/sk', config: { maxSkills: 60, skillDecayDays: 90 }, deps: { fs } });
    assert.deepEqual(r.archived, ['drop']);
    const idx = loadIndex({ dir: '/sk', deps: { fs } }).skills;
    assert.equal(idx.find((s) => s.id === 'keep').status, 'active');
    assert.equal(idx.find((s) => s.id === 'drop').status, 'archived');
  });

  it('does NOT dedupe skills with different goals', () => {
    const fs = memFs();
    // Fresh dates + used>0 so neither decay nor cap triggers; only dedup could.
    const skills = [
      { id: 'a', name: 'A', goal: 'deploy web', used: 1, confidence: 0.5, created: today, status: 'active' },
      { id: 'b', name: 'B', goal: 'deploy api', used: 1, confidence: 0.5, created: today, status: 'active' }
    ];
    writeIndex(fs, '/sk', skills);
    const r = curateSkills({ dir: '/sk', config: { maxSkills: 60, skillDecayDays: 90 }, deps: { fs } });
    assert.deepEqual(r.archived, []);
  });

  it('decays unused skills older than skillDecayDays', () => {
    const fs = memFs();
    const skills = [
      { id: 'stale', name: 'Stale', goal: 'g-stale', used: 0, confidence: 0.5, created: old, status: 'active' },
      { id: 'fresh', name: 'Fresh', goal: 'g-fresh', used: 0, confidence: 0.9, created: today, status: 'active' }
    ];
    writeIndex(fs, '/sk', skills);
    const r = curateSkills({ dir: '/sk', config: { maxSkills: 60, skillDecayDays: 90 }, deps: { fs } });
    assert.deepEqual(r.archived, ['stale']); // only the old, unused one is archived
  });

  it('keeps a used-but-old skill (decay only targets zero-use)', () => {
    const fs = memFs();
    const skills = [
      { id: 'oldbutused', name: 'Old', goal: 'g', used: 3, confidence: 0.5, created: old, status: 'active' }
    ];
    writeIndex(fs, '/sk', skills);
    const r = curateSkills({ dir: '/sk', config: { maxSkills: 60, skillDecayDays: 90 }, deps: { fs } });
    assert.deepEqual(r.archived, []);
  });

  it('never deletes files: archived entries stay in index.json', () => {
    const fs = memFs();
    writeIndex(fs, '/sk', [{ id: 'x', name: 'X', goal: 'gx', used: 0, confidence: 0.5, created: old, status: 'active' }]);
    curateSkills({ dir: '/sk', config: { maxSkills: 60, skillDecayDays: 90 }, deps: { fs } });
    const idx = loadIndex({ dir: '/sk', deps: { fs } }).skills;
    assert.equal(idx.length, 1, 'entry still present, just flagged archived');
    assert.equal(idx[0].status, 'archived');
  });

  it('bumpUsage increments used and sets lastUsed, reactivates archived', () => {
    const fs = memFs();
    writeIndex(fs, '/sk', [{ id: 'u', name: 'U', used: 0, confidence: 0.9, created: today, status: 'archived' }]);
    const ok = bumpUsage({ dir: '/sk', id: 'u', deps: { fs } });
    assert.equal(ok, true);
    const s = loadIndex({ dir: '/sk', deps: { fs } }).skills[0];
    assert.equal(s.used, 1);
    assert.ok(s.lastUsed && s.lastUsed.length >= 10);
    assert.equal(s.status, 'active', 'a pulled archived skill is reactivated');
  });
});
