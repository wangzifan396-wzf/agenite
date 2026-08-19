import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, completeTask, failTask, wrapDelegation } from '../src/core/a2a.js';
import { classifyTool } from '../src/core/guardrails.js';
import { createSubAgentRunner } from '../src/core/subagent.js';

test('Task lifecycle: create -> complete carries artifacts and status', () => {
  const task = createTask({ message: 'do X', contextId: 'ctx-1' });
  assert.equal(task.status, 'submitted');
  assert.equal(task.message, 'do X');
  assert.equal(task.contextId, 'ctx-1');
  assert.deepEqual(task.artifacts, []);
  completeTask(task, [{ name: 'summary', mimeType: 'text/plain', data: 'done' }]);
  assert.equal(task.status, 'completed');
  assert.equal(task.artifacts.length, 1);
  assert.equal(task.artifacts[0].data, 'done');
});

test('Task lifecycle: fail marks the task failed with an error', () => {
  const task = createTask({ message: 'do Y' });
  failTask(task, 'boom');
  assert.equal(task.status, 'failed');
  assert.equal(task.error, 'boom');
});

test('wrapDelegation emits the full A2A event stream and returns the peer result', async () => {
  const events = [];
  const runPeer = async () => ({ ok: true, content: 'child output', turns: 3, stopped: 'done' });
  const peerCard = { name: 'Sub', version: '1', protocolVersion: '0.3.0', url: 'local://x', description: 'd', skills: [], defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], capabilities: {} };
  const result = await wrapDelegation({
    runPeer,
    onEvent: (phase, payload) => events.push([phase, payload]),
    peerCard,
    args: { goal: 'research' },
    contextId: 'ctx-9'
  });
  assert.equal(result.content, 'child output');
  const phases = events.map(([p]) => p);
  assert.deepEqual(phases, ['peer_card', 'task_submitted', 'task_completed']);
  // peer_card carries the card
  assert.equal(events[0][1].card.name, 'Sub');
  // task_submitted -> task_completed: the task resolved to completed with the summary artifact
  const submitted = events[1][1].task;
  const completed = events[2][1].task;
  assert.equal(submitted.status, 'submitted');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.artifacts[0].name, 'summary');
  assert.equal(completed.artifacts[0].data, 'child output');
});

test('wrapDelegation emits task_failed and rethrows on peer error', async () => {
  const events = [];
  const runPeer = async () => { throw new Error('peer died'); };
  let threw = false;
  try {
    await wrapDelegation({
      runPeer,
      onEvent: (phase, payload) => events.push([phase, payload]),
      peerCard: { name: 'Sub', version: '1', protocolVersion: '0.3.0', url: 'u', description: 'd', skills: [], defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], capabilities: {} },
      args: { goal: 'g' },
      contextId: null
    });
  } catch (e) {
    threw = true;
    assert.equal(e.message, 'peer died');
  }
  assert.ok(threw, 'wrapDelegation should rethrow the peer error');
  const phases = events.map(([p]) => p);
  assert.deepEqual(phases[phases.length - 1], 'task_failed');
  assert.equal(events[events.length - 1][1].task.status, 'failed');
});

test('classifyTool routes delegate / fanout through the v0.71 blast-radius gate as exec', () => {
  assert.equal(classifyTool('delegate'), 'exec');
  assert.equal(classifyTool('fanout'), 'exec');
});

test('createSubAgentRunner with onA2A emits the A2A event stream around a real child loop', async () => {
  const events = [];
  // A model that immediately returns a final answer (no tool calls) so the
  // child loop completes in one turn — this exercises the REAL runAgent path
  // inside the sub-agent, not a stub.
  const fakeModel = async () => ({ content: 'child final answer', toolCalls: [], usage: null });
  const fakeExecute = async () => ({ ok: true, content: 'x' });
  const runner = createSubAgentRunner({
    callModel: fakeModel,
    executeTool: fakeExecute,
    baseConfig: { maxTurns: 5 },
    tools: [{ name: 'read_file', description: 'r' }],
    onA2A: (phase, payload) => events.push([phase, payload])
  });
  const res = await runner({ goal: 'research the topic' });
  assert.equal(res.ok, true);
  const phases = events.map(([p]) => p);
  assert.ok(phases.includes('peer_card'), 'expected peer_card');
  assert.ok(phases.includes('task_submitted'), 'expected task_submitted');
  assert.ok(phases.includes('task_completed'), 'expected task_completed');
  // a real child loop produces a summary artifact
  const completed = events.find(([p]) => p === 'task_completed')[1];
  assert.equal(completed.task.status, 'completed');
  assert.ok(completed.task.artifacts[0].data.includes('child final answer'));
});

test('createSubAgentRunner without a goal returns early and emits NO a2a events', async () => {
  const events = [];
  const fakeModel = async () => ({ content: 'ok', toolCalls: [], usage: null });
  const runner = createSubAgentRunner({
    callModel: fakeModel,
    executeTool: async () => ({ ok: true, content: 'x' }),
    baseConfig: {},
    tools: [{ name: 'read_file', description: 'r' }],
    onA2A: (phase) => events.push(phase)
  });
  const res = await runner({}); // no goal
  assert.equal(res.ok, false);
  assert.equal(events.length, 0);
});
