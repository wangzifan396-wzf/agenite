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
function fakeDeps() {
  return {
    callModel: async () => ({ content: 'FAKE PLAN / VERDICT', toolCalls: [] }),
    executeTool: async () => ({ ok: true, content: 'fake tool result' }),
    createSubAgentRunner: () => async () => ({ ok: true, content: 'sub' }),
    runAgent: async ({ onEvent, messages }) => {
      onEvent('tool_start', { id: '1', name: 'run_code', args: { language: 'node', code: '1+1' } });
      onEvent('tool', { id: '1', name: 'run_code', args: {}, result: '2', ok: true, ms: 5 });
      onEvent('usage', { turn: 1, total: 120, cost: 0.001 });
      onEvent('done', { turns: 1, stopped: 'done' });
      messages.push({ role: 'assistant', content: 'TEST REPORT: implemented and verified.' });
      return { stopped: 'done', turns: 1, usage: { total: 120 }, cost: 0.001 };
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
