// Fan-out parallel delegation: concurrency, aggregation, failure isolation,
// empty-input handling and the task cap. We exercise the real sub-agent runner
// (createSubAgentRunner) end-to-end where it matters, and use a fake runner to
// prove the scheduler's concurrency and isolation guarantees precisely.
import assert from 'node:assert';
import test from 'node:test';
import { createSubAgentRunner, createFanoutRunner } from '../src/core/subagent.js';

const TOOLS = [{ name: 'delegate' }, { name: 'calculator' }, { name: 'web_fetch' }];

// A fake runSubAgent whose latency we can control, so we can prove that the
// children actually execute concurrently (overlapping in time) rather than
// being awaited one after another.
function makeLatentRunner(answer) {
  return async (args) => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 40));
    return { ok: true, content: `${answer}:${args.goal}`, _start: start, _end: Date.now() };
  };
}

test('createFanoutRunner requires a runSubAgent function', () => {
  assert.throws(() => createFanoutRunner(null));
});

test('children run concurrently (overlapping timelines, not serial)', async () => {
  const calls = [];
  const runSubAgent = async (args) => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 40)); // simulate real work
    calls.push({ goal: args.goal, start, end: Date.now() });
    return { ok: true, content: 'did ' + args.goal };
  };
  const runFanout = createFanoutRunner(runSubAgent);
  const r = await runFanout({ tasks: [{ goal: 'A' }, { goal: 'B' }, { goal: 'C' }] });

  assert.equal(r.ok, true);
  assert.equal(calls.length, 3, 'all three children were spawned');
  const total = Math.max(...calls.map((c) => c.end)) - Math.min(...calls.map((c) => c.start));
  // Three 40ms children: serial would be ~120ms, concurrent ~40ms.
  assert.ok(total < 100, `expected concurrency (total < 100ms), got ${total}ms`);
});

test('aggregates every child summary into one result', async () => {
  const runFanout = createFanoutRunner(makeLatentRunner('ok'));
  const r = await runFanout({
    tasks: [{ goal: 'research X' }, { goal: 'research Y', persona: 'researcher' }]
  });
  assert.equal(r.ok, true);
  assert.match(r.content, /research X/);
  assert.match(r.content, /research Y/);
  assert.match(r.content, /researcher/);
  assert.deepEqual(r.fanout, { total: 2, succeeded: 2, failed: 0 });
});

test('failure isolation: one child failing does not abort the others', async () => {
  let n = 0;
  const runSubAgent = async (args) => {
    n++;
    if (args.goal === 'boom') return Promise.reject(new Error('kaboom'));
    return { ok: true, content: 'fine ' + args.goal };
  };
  const runFanout = createFanoutRunner(runSubAgent);
  const r = await runFanout({ tasks: [{ goal: 'a' }, { goal: 'boom' }, { goal: 'c' }] });

  assert.equal(r.ok, true, 'fanout itself still succeeds');
  assert.equal(n, 3, 'all children were attempted');
  assert.match(r.content, /fine a/);
  assert.match(r.content, /kaboom/); // the failed one is reported, not swallowed
  assert.deepEqual(r.fanout, { total: 3, succeeded: 2, failed: 1 });
});

test('rejects empty tasks and flags missing goal per-task', async () => {
  const runSubAgent = async (args) => ({ ok: true, content: 'did ' + args.goal });
  const runFanout = createFanoutRunner(runSubAgent);

  const empty = await runFanout({ tasks: [] });
  assert.equal(empty.ok, false);

  const mixed = await runFanout({ tasks: [{ goal: '' }, { goal: 'good' }] });
  assert.equal(mixed.ok, true);
  assert.match(mixed.content, /失败/); // task[0] flagged as failed
  assert.match(mixed.content, /did good/);
  assert.deepEqual(mixed.fanout, { total: 2, succeeded: 1, failed: 1 });
});

test('caps the number of concurrent children at 8', async () => {
  let count = 0;
  const runSubAgent = async () => {
    count++;
    return { ok: true, content: 'x' };
  };
  const runFanout = createFanoutRunner(runSubAgent);
  const tasks = Array.from({ length: 12 }, (_, i) => ({ goal: 't' + i }));
  const r = await runFanout({ tasks });
  assert.equal(count, 8, 'only the first 8 tasks were dispatched');
  assert.equal(r.fanout.total, 8);
});

test('end-to-end: drives the real sub-agent runner across parallel children', async () => {
  let modelCalls = 0;
  const callModel = async () => {
    modelCalls++;
    if (modelCalls % 2 === 1) {
      return { content: '', toolCalls: [{ id: 't1', name: 'calculator', args: { expression: '21*2' } }] };
    }
    return { content: '结果是 42', toolCalls: [] };
  };
  const executeTool = async (name) =>
    name === 'calculator' ? { ok: true, content: '42' } : { ok: true, content: 'ok' };

  const runSubAgent = createSubAgentRunner({
    callModel,
    executeTool,
    baseConfig: { maxTurns: 5 },
    tools: TOOLS,
    injectMemory: null,
    onSubEvent: null,
    requestApproval: null,
    platform: 'linux'
  });

  const runFanout = createFanoutRunner(runSubAgent);
  const r = await runFanout({
    tasks: [{ goal: 'compute one angle', persona: 'math' }, { goal: 'compute other angle', persona: 'math' }]
  });

  assert.equal(r.ok, true);
  assert.equal(r.fanout.total, 2);
  assert.equal(r.fanout.succeeded, 2);
  // Both children ran their own 2-turn loop (tool call + final answer).
  assert.match(r.content, /结果是 42/);
  assert.ok((r.content.match(/结果是 42/g) || []).length === 2, 'both children produced a summary');
});
