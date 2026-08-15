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
      return { content: 'OK' };
    },
    executeTool: async () => ({ ok: true, content: 'fake tool result' }),
    // v0.58 gate deps: no project test command exists in the sandbox, so the
    // gate always falls through to the fresh-context judge.
    detectVerify: () => null,
    verifyWorkspace: async () => ({ ran: false, ok: true, level: 'full', reason: 'no tests' }),
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
