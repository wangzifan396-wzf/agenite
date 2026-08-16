import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createGoal,
  listGoals,
  getGoal,
  stopGoal,
  deleteGoal,
  initGoals
} from '../src/core/goals.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'agenite-goal-'));
}

// Fake deps: a tool-free model that returns text, a tool executor that says ok,
// and a runAgent that emits a couple of tool events then finishes with a report.
// opts.verify: array of judge verdicts consumed per verify call (defaults to a
// passing "已完成"). The judge is fresh-context (reads execution LOG FACTS, not
// the self-report), so we key it off the "独立验收员" system prompt.
// detectVerify/verifyWorkspace are faked so no real test command ever runs in
// the test sandbox (and we deterministically exercise the judge path).
function fakeDeps(opts = {}) {
  const verifySeq = opts.verify && opts.verify.length ? opts.verify : ['已完成'];
  let vi = 0;
  // v0.59 — Critic (质量评审员) verdicts, consumed per outcome-gate call.
  const criticSeq = opts.critique && opts.critique.length ? opts.critique : ['达标：改动合理。'];
  let ci = 0;
  const cost = opts.costPerAttempt != null ? opts.costPerAttempt : 0.001;
  const turns = opts.turnsPerAttempt != null ? opts.turnsPerAttempt : 1;
  return {
    callModel: async (msgs) => {
      const sys = (msgs && msgs[0] && msgs[0].content) || '';
      if (sys.includes('独立验收员')) {
        const v = vi < verifySeq.length ? verifySeq[vi] : verifySeq[verifySeq.length - 1];
        vi++;
        return { content: v };
      }
      if (sys.includes('高级技术规划师')) return { content: 'PLAN' };
      if (sys.includes('对话压缩器')) return { content: 'SUMMARY' };
      if (sys.includes('质量评审员')) {
        const c = ci < criticSeq.length ? criticSeq[ci] : criticSeq[criticSeq.length - 1];
        ci++;
        return { content: c };
      }
      return { content: 'OK' };
    },
    executeTool: async () => ({ ok: true, content: 'fake tool result' }),
    // v0.58 gate deps: no project test command exists in the sandbox, so the
    // gate always falls through to the fresh-context judge.
    detectVerify: () => null,
    verifyWorkspace: async () => ({ ran: false, ok: true, level: 'full', reason: 'no tests' }),
    // v0.59 — git baseline + diff are injectable so the outcome gate is fully
    // deterministic in tests. Default fakes mean "no baseline" ⇒ gate skipped.
    gitRevParseHead: opts.gitRevParseHead || (async () => null),
    getDiff: opts.getDiff || (async () => null),
    // v0.60 — Verified Experience Memory fakes. When provided, they override the
    // real fs-backed experience module so tests stay deterministic and offline.
    retrieveExperiences: opts.retrieveExperiences || undefined,
    recordExperience: opts.recordExperience || undefined,
    // v0.61 — Procedural Skill Crystallization fakes. When provided, override the
    // real fs-backed skill module so tests stay deterministic and offline.
    matchSkills: opts.matchSkills || undefined,
    loadSkillBody: opts.loadSkillBody || undefined,
    distillSkill: opts.distillSkill || undefined,
    recordSkill: opts.recordSkill || undefined,
    updateSkill: opts.updateSkill || undefined,
    createSubAgentRunner: () => async () => ({ ok: true, content: 'sub' }),
    runAgent: async ({ onEvent, messages }) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      onEvent('tool_start', { id: '1', name: 'run_code', args: { language: 'node', code: '1+1' } });
      onEvent('tool', { id: '1', name: 'run_code', args: {}, result: '2', ok: true, ms: 5 });
      onEvent('usage', { turn: 1, total: 120, cost });
      onEvent('done', { turns: turns, stopped: opts.stopped || 'done' });
      messages.push({ role: 'assistant', content: 'TEST REPORT: implemented and verified.' });
      return { stopped: opts.stopped || 'done', turns, usage: { total: 120 }, cost };
    }
  };
}

async function waitFor(id, dir, pred, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const g = await getGoal(id, dir);
    if (g && pred(g)) return g;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

test('createGoal rejects an empty goal', async () => {
  const dir = tmpDir();
  try {
    const stale = await createGoal({ goal: '   ', config: { provider: 'openai', model: 'x' } }, dir);
    assert.equal(stale.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('full lifecycle: queued -> running -> done with plan/log/report', async () => {
  const dir = tmpDir();
  try {
    const r = await createGoal(
      { goal: '写一个 hello world', title: 'HW', config: { provider: 'openai', model: 'x', apiKey: 'k' } },
      dir,
      fakeDeps()
    );
    assert.equal(r.ok, true);
    assert.ok(r.id);

    const done = await waitFor(r.id, dir, (g) => (g.status === 'done' || g.status === 'failed') && g.finalized);
    assert.ok(done, 'goal should reach a terminal state');
    assert.equal(done.status, 'done');
    assert.match(done.plan, /PLAN/);
    assert.match(done.report, /TEST REPORT/);
    assert.ok(Array.isArray(done.log) && done.log.length > 0, 'log should be populated');
    const toolLine = done.log.find((l) => l.type === 'tool');
    assert.ok(toolLine, 'should have recorded a tool event');
    assert.equal(done.turns, 1);
    assert.ok(done.usage && done.usage.cost >= 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listGoals returns created goals, newest first', async () => {
  const dir = tmpDir();
  try {
    const a = await createGoal({ goal: 'task A', config: { provider: 'openai', model: 'x' } }, dir, fakeDeps());
    const b = await createGoal({ goal: 'task B', config: { provider: 'openai', model: 'x' } }, dir, fakeDeps());
    await waitFor(a.id, dir, (g) => g.status === 'done' && g.finalized);
    await waitFor(b.id, dir, (g) => g.status === 'done' && g.finalized);
    const all = await listGoals(dir);
    assert.ok(all.length >= 2);
    const ids = all.map((g) => g.id);
    assert.ok(ids.includes(a.id) && ids.includes(b.id));
    // newest first (B created after A)
    assert.equal(all[0].id, b.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopGoal is a no-op when nothing is active (does not throw)', async () => {
  const dir = tmpDir();
  try {
    const r = stopGoal('does-not-exist');
    assert.equal(r.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteGoal removes the goal file', async () => {
  const dir = tmpDir();
  try {
    const r = await createGoal({ goal: 'to delete', config: { provider: 'openai', model: 'x' } }, dir, fakeDeps());
    let g = await getGoal(r.id, dir);
    assert.ok(g);
    // Wait for the autonomous run to reach a terminal state before deleting,
    // otherwise its final flush would recreate the file.
    await waitFor(r.id, dir, (x) => (x.status === 'done' || x.status === 'failed') && x.finalized);
    const d = await deleteGoal(r.id, dir);
    assert.equal(d.ok, true);
    g = await getGoal(r.id, dir);
    assert.equal(g, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initGoals marks stale running/queued goals as interrupted', async () => {
  const dir = tmpDir();
  try {
    await createGoal({ goal: 'stale', config: { provider: 'openai', model: 'x' } }, dir);
    // Simulate a left-over running state from a previous process.
    const list = await listGoals(dir);
    const id = list[0].id;
    const g = await getGoal(id, dir);
    g.status = 'running';
    g.phase = 'execute';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, `${id}.json`), JSON.stringify(g, null, 2));
    await initGoals(dir);
    const after = await getGoal(id, dir);
    assert.equal(after.status, 'interrupted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('self-heal retry: re-runs a tighter attempt when verification fails', async () => {
  const dir = tmpDir();
  try {
    // First verification says not-done, second says done.
    const r = await createGoal(
      { goal: '让测试通过', config: { provider: 'openai', model: 'x' } },
      dir,
      fakeDeps({ verify: ['未完成：测试仍报错', '已完成'] })
    );
    assert.equal(r.ok, true);
    const done = await waitFor(r.id, dir, (g) => g.status === 'done' || g.status === 'failed');
    assert.equal(done.status, 'done');
    assert.equal(done.attempt, 2, 'should have retried once');
    assert.match(done.verdict, /已完成/);
    assert.ok(done.turns >= 2, 'turns should accumulate across attempts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('budget: cost cap stops the goal as failed', async () => {
  const dir = tmpDir();
  try {
    const r = await createGoal(
      { goal: '贵任务', config: { provider: 'openai', model: 'x', budget: { maxCostUSD: 0.0005 } } },
      dir,
      fakeDeps({ costPerAttempt: 0.001 })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'failed' || g.status === 'done');
    assert.equal(done.status, 'failed');
    assert.match(done.error, /成本上限/);
    assert.equal(done.attempt, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('budget: turn cap stops the goal as failed', async () => {
  const dir = tmpDir();
  try {
    const r = await createGoal(
      { goal: '步数任务', config: { provider: 'openai', model: 'x', budget: { maxTurns: 1 } } },
      dir,
      fakeDeps({ turnsPerAttempt: 1 })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'failed' || g.status === 'done');
    assert.equal(done.status, 'failed');
    assert.match(done.error, /步数上限/);
    assert.equal(done.attempt, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('budget: retries=0 means no self-heal on failed verification', async () => {
  const dir = tmpDir();
  try {
    const r = await createGoal(
      { goal: '不重试', config: { provider: 'openai', model: 'x', budget: { retries: 0 } } },
      dir,
      fakeDeps({ verify: ['未完成'] })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'failed' || g.status === 'done');
    assert.equal(done.status, 'failed');
    assert.match(done.error, /自愈重试上限/);
    assert.equal(done.attempt, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('budget: timeout cap stops the goal as failed', async () => {
  const dir = tmpDir();
  try {
    const r = await createGoal(
      { goal: '超时任务', config: { provider: 'openai', model: 'x', budget: { timeoutMs: 5 } } },
      dir,
      fakeDeps({ delayMs: 10 })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'failed' || g.status === 'done');
    assert.equal(done.status, 'failed');
    assert.match(done.error, /时长上限/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.58 gate: goalVerify=off completes without a judge, ignoring a failing verdict', async () => {
  const dir = tmpDir();
  try {
    // Judge would say "未完成", but goalVerify=off disables the gate entirely.
    const r = await createGoal(
      { goal: '关掉验证', config: { provider: 'openai', model: 'x', goalVerify: 'off' } },
      dir,
      fakeDeps({ verify: ['未完成'] })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'done' || g.status === 'failed');
    assert.equal(done.status, 'done');
    assert.equal(done.attempt, 1, 'should not retry when the gate is off');
    assert.equal(done.verdictMeta && done.verdictMeta.source, 'none');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.58 gate: goalVerify=full with no detected test command fails (proof required)', async () => {
  const dir = tmpDir();
  try {
    // detectVerify returns null for every attempt ⇒ no deterministic proof ⇒
    // the goal can never be marked done and fails at the retry ceiling.
    const r = await createGoal(
      { goal: '必须有测试', config: { provider: 'openai', model: 'x', goalVerify: 'full', budget: { retries: 1 } } },
      dir,
      fakeDeps({ verify: ['已完成'] })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'done' || g.status === 'failed');
    assert.equal(done.status, 'failed');
    assert.match(done.verdict, /未探测到任何测试命令/);
    assert.equal(done.verdictMeta && done.verdictMeta.source, 'test');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.58 gate: auto mode with no tests uses the fresh-context judge', async () => {
  const dir = tmpDir();
  try {
    const r = await createGoal(
      { goal: '写个功能', config: { provider: 'openai', model: 'x' } },
      dir,
      fakeDeps({ verify: ['已完成'] })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'done' || g.status === 'failed');
    assert.equal(done.status, 'done');
    assert.equal(done.verdictMeta && done.verdictMeta.source, 'judge');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.59 outcome gate: goalCritic=off skips the quality gate entirely (even if critic would reject)', async () => {
  const dir = tmpDir();
  try {
    const r = await createGoal(
      { goal: '关掉复核', config: { provider: 'openai', model: 'x', goalVerify: 'auto', goalCritic: 'off' } },
      dir,
      fakeDeps({ verify: ['已完成'], critique: ['未达标：只改了测试断言'] })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'done' || g.status === 'failed');
    assert.equal(done.status, 'done');
    assert.equal(done.attempt, 1, 'should not retry when the outcome gate is off');
    assert.equal(done.outcome, undefined, 'outcome gate should not have run');
    assert.equal(done.verdictMeta && done.verdictMeta.source, 'judge');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.59 outcome gate: critic 未达标 loops back into self-heal, then passes', async () => {
  const dir = tmpDir();
  try {
    const r = await createGoal(
      { goal: '实现功能 X', config: { provider: 'openai', model: 'x' } },
      dir,
      fakeDeps({
        verify: ['已完成', '已完成'],
        critique: [
          '未达标：仅修改测试断言，未修复真正实现',
          '达标：已修复真正实现，改动最小且针对性'
        ],
        gitRevParseHead: async () => 'BASESHA',
        getDiff: async () => ({
          empty: false,
          files: ['src/a.js', 'test/a.test.js'],
          deletedTestFiles: [],
          diff: '+ fix implementation\n- bad assert'
        })
      })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'done' || g.status === 'failed');
    assert.equal(done.status, 'done');
    assert.equal(done.attempt, 2, 'critic rejection should have triggered one self-heal retry');
    assert.ok(done.outcome, 'outcome gate should have run');
    assert.equal(done.outcome.stage, 'critic');
    assert.equal(done.outcome.done, true, 'final critic should pass');
    assert.match(done.report, /成果复核/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.59 outcome gate: anti-exploit rejects empty diff / no-op (loops to retry ceiling)', async () => {
  const dir = tmpDir();
  try {
    const r = await createGoal(
      { goal: '做点什么', config: { provider: 'openai', model: 'x', budget: { retries: 1 } } },
      dir,
      fakeDeps({
        verify: ['已完成', '已完成'],
        gitRevParseHead: async () => 'BASESHA',
        getDiff: async () => ({ empty: true, files: [], deletedTestFiles: [], diff: '' })
      })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'done' || g.status === 'failed');
    assert.equal(done.status, 'failed');
    assert.ok(done.outcome, 'outcome gate should have run');
    assert.equal(done.outcome.stage, 'antiexploit');
    assert.equal(done.outcome.done, false);
    assert.match(done.error, /成果复核未达标（antiexploit）/);
    assert.equal(done.attempt, 2, 'should exhaust retries');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// In-memory experience store shared between retrieve/record so a test can seed a
// "past verified" experience and assert it is both recalled and (a new goal
// being crystallized) appended.
function memoryExperience() {
  const store = [];
  return {
    retrieve: async ({ k = 3 } = {}) => ({ entries: store.slice(0, k), used: store.slice(0, k).map((e) => e.id) }),
    record: async ({ entry }) => {
      const id = 'exp_new_' + store.length;
      store.push({ id, ...entry });
      return id;
    },
    store
  };
}

test('v0.60 memory on: recalls a seeded verified experience and crystallizes a new one', async () => {
  const dir = tmpDir();
  try {
    const mem = memoryExperience();
    // Seed a DIFFERENT but related goal so it is recalled (token overlap) yet not
    // an exact-match duplicate of the current goal (which would skip recording).
    mem.store.push({
      id: 'exp_seed_1',
      goal: '为登录模块添加单元测试覆盖',
      approach: '用 node --test 覆盖边界条件',
      verification: '测试全部通过',
      outcome: '达标',
      model: 'x',
      ts: Date.now()
    });
    const r = await createGoal(
      { goal: '为注册模块添加单元测试', config: { provider: 'openai', model: 'x', goalMemory: 'on' } },
      dir,
      fakeDeps({
        verify: ['已完成'],
        critique: ['达标：改动合理'],
        gitRevParseHead: async () => 'BASESHA',
        getDiff: async () => ({ empty: false, files: ['src/b.js', 'test/b.test.js'], deletedTestFiles: [], diff: '+ add tests' }),
        retrieveExperiences: mem.retrieve,
        recordExperience: mem.record
      })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'done' || g.status === 'failed');
    assert.equal(done.status, 'done');
    // Recalled the seeded experience (used carries its id).
    assert.ok(done.experience && Array.isArray(done.experience.used), 'experience.used should be an array');
    assert.ok(done.experience.used.includes('exp_seed_1'), 'should have recalled the seeded experience');
    // Crystallized exactly one new experience (recorded length 1).
    assert.ok(done.experience.recorded && done.experience.recorded.length === 1, 'should crystallize one new experience');
    assert.notEqual(done.experience.recorded[0], 'exp_seed_1', 'new experience should get a fresh id');
    assert.equal(mem.store.length, 2, 'store should now hold the seeded + new experience');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.60 memory off: neither recalls nor crystallizes', async () => {
  const dir = tmpDir();
  try {
    const mem = memoryExperience();
    const r = await createGoal(
      { goal: '关掉经验记忆跑一次', config: { provider: 'openai', model: 'x', goalMemory: 'off' } },
      dir,
      fakeDeps({
        verify: ['已完成'],
        critique: ['达标：改动合理'],
        gitRevParseHead: async () => 'BASESHA',
        getDiff: async () => ({ empty: false, files: ['src/c.js'], deletedTestFiles: [], diff: '+ done' }),
        // Even if fakes exist, goalMemory=off must keep them uncalled.
        retrieveExperiences: mem.retrieve,
        recordExperience: mem.record
      })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'done' || g.status === 'failed');
    assert.equal(done.status, 'done');
    assert.deepEqual(done.experience, { used: [], recorded: [] }, 'memory off must not read or write');
    assert.equal(mem.store.length, 0, 'recordExperience must not be called when memory is off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// In-memory skill library store shared between match/load/distill/record so a
// test can seed/observe skill behaviour deterministically (no real fs, no model).
function memorySkills() {
  const store = [];
  return {
    match: async () => ({ skills: [], used: [] }),
    loadBody: async () => null,
    distill: async () => ({
      name: '测试编写技能',
      tags: ['测试', '单测'],
      summary: '为某模块编写单元测试覆盖',
      body:
        '## 适用场景\n需要补全单测的模块\n## 做法步骤\n1. 用 node --test 覆盖边界条件\n## 已知失败点\n无\n## 验证步骤\n跑测试全绿'
    }),
    record: async ({ skill }) => {
      const id = 'skl_new_' + store.length;
      store.push({ id, ...skill });
      return id;
    },
    update: async () => true,
    store
  };
}

test('v0.61 skill on + complex: distills and crystallizes a new skill', async () => {
  const dir = tmpDir();
  try {
    const sk = memorySkills();
    const r = await createGoal(
      { goal: '为网络模块编写单元测试', config: { provider: 'openai', model: 'x', skillCrystallization: 'on' } },
      dir,
      fakeDeps({
        verify: ['已完成'],
        critique: ['达标：改动合理'],
        gitRevParseHead: async () => 'BASESHA',
        getDiff: async () => ({ empty: false, files: ['src/n.js', 'test/n.test.js'], deletedTestFiles: [], diff: '+ tests' }),
        turnsPerAttempt: 5, // makes the run "complex" (turns >= 5) ⇒ eligible to crystallize
        matchSkills: sk.match,
        loadSkillBody: sk.loadBody,
        distillSkill: sk.distill,
        recordSkill: sk.record,
        updateSkill: sk.update
      })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'done' || g.status === 'failed');
    assert.equal(done.status, 'done');
    assert.ok(done.skills, 'state.skills should be present');
    assert.ok(done.skills.crystallized && done.skills.crystallized.length === 1, 'should crystallize exactly one new skill');
    assert.equal(sk.store.length, 1, 'recordSkill should have been called once');
    assert.equal(done.skills.crystallized[0], sk.store[0].id, 'crystallized id should match the recorded skill');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.61 skill off: no distillation and no record (even if complex)', async () => {
  const dir = tmpDir();
  try {
    let distillCalls = 0;
    let recordCalls = 0;
    const r = await createGoal(
      { goal: '关掉技能结晶跑一次', config: { provider: 'openai', model: 'x', skillCrystallization: 'off' } },
      dir,
      fakeDeps({
        verify: ['已完成'],
        critique: ['达标：改动合理'],
        gitRevParseHead: async () => 'BASESHA',
        getDiff: async () => ({ empty: false, files: ['src/d.js'], deletedTestFiles: [], diff: '+ done' }),
        turnsPerAttempt: 5, // complex, but mode off must suppress crystallization
        matchSkills: () => {
          throw new Error('matchSkills must not be called when skill mode is off');
        },
        distillSkill: async () => {
          distillCalls++;
          return null;
        },
        recordSkill: async () => {
          recordCalls++;
          return null;
        }
      })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'done' || g.status === 'failed');
    assert.equal(done.status, 'done');
    assert.equal(distillCalls, 0, 'distillSkill must not be called when skill mode is off');
    assert.equal(recordCalls, 0, 'recordSkill must not be called when skill mode is off');
    assert.deepEqual(done.skills, { used: [], crystallized: [] }, 'skill mode off must not touch skills');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.61 skill on + simple: no distillation (guarded by complexity)', async () => {
  const dir = tmpDir();
  try {
    let distillCalls = 0;
    const sk = memorySkills();
    const r = await createGoal(
      { goal: '做一件简单的事', config: { provider: 'openai', model: 'x', skillCrystallization: 'on' } },
      dir,
      fakeDeps({
        verify: ['已完成'],
        // Simple path: goalCritic=off + no git baseline ⇒ no outcome gate;
        // turns=1, attempt=1 ⇒ not "complex", so distillation must be skipped.
        goalCritic: 'off',
        matchSkills: sk.match,
        loadSkillBody: sk.loadBody,
        distillSkill: async () => {
          distillCalls++;
          return null;
        }
      })
    );
    const done = await waitFor(r.id, dir, (g) => g.status === 'done' || g.status === 'failed');
    assert.equal(done.status, 'done');
    assert.equal(distillCalls, 0, 'distillSkill must not run for a simple (non-complex) goal');
    assert.ok(done.skills, 'skills state should exist');
    assert.deepEqual(done.skills.crystallized, [], 'no skill crystallized for a simple goal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
