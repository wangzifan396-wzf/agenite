// Parallel tool execution: read-only tools in the same model turn must run
// concurrently; mutating / stateful tools must stay serial. Flake-free: we
// track how many tool executions are in-flight at once instead of wall-clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/core/agent.js';

function fakeModel(toolCalls) {
  let n = 0;
  return async () => {
    n++;
    if (n === 1) return { content: '', toolCalls, usage: null };
    return { content: 'done', toolCalls: [], usage: null };
  };
}

test('read-only tool calls in one turn run concurrently', async () => {
  const messages = [{ role: 'user', content: 'read two files' }];
  const callModel = fakeModel([
    { id: 'a', name: 'read_file', args: { path: 'x' } },
    { id: 'b', name: 'read_file', args: { path: 'y' } }
  ]);

  let active = 0;
  let maxActive = 0;
  const executeTool = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 40));
    active--;
    return { ok: true, content: 'data' };
  };

  await runAgent({ messages, callModel, executeTool, config: {}, tools: [] });

  // Both tools were executing at the same time.
  assert.equal(maxActive, 2, 'expected read-only tools to overlap (maxActive=2)');
  // Result-message order is preserved exactly.
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  assert.equal(toolMsgs[0].tool_call_id, 'a');
  assert.equal(toolMsgs[1].tool_call_id, 'b');
});

test('parallelTools:false forces sequential execution', async () => {
  const messages = [{ role: 'user', content: 'read two' }];
  const callModel = fakeModel([
    { id: 'a', name: 'read_file', args: { path: 'x' } },
    { id: 'b', name: 'read_file', args: { path: 'y' } }
  ]);

  let active = 0;
  let maxActive = 0;
  const executeTool = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 40));
    active--;
    return { ok: true, content: 'x' };
  };

  await runAgent({ messages, callModel, executeTool, config: { parallelTools: false }, tools: [] });
  assert.equal(maxActive, 1, 'with parallel off, only one tool may run at a time');
});

test('danger tools never parallelize — run after read-only tools', async () => {
  const messages = [{ role: 'user', content: 'read then write' }];
  const callModel = fakeModel([
    { id: 'a', name: 'read_file', args: { path: 'x' } },
    { id: 'b', name: 'write_file', args: { path: 'y', content: 'z' } }
  ]);

  const order = [];
  const executeTool = async (name) => {
    order.push(name);
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, content: 'ok' };
  };

  await runAgent({ messages, callModel, executeTool, config: {}, tools: [] });
  assert.deepEqual(order, ['read_file', 'write_file'], 'write_file must wait for read_file');
});

test('mixed: all read-only run together, mutating ones wait', async () => {
  const messages = [{ role: 'user', content: 'many' }];
  const callModel = fakeModel([
    { id: 'a', name: 'read_file', args: { path: 'x' } },
    { id: 'b', name: 'grep_files', args: { pattern: 'x' } },
    { id: 'c', name: 'run_command', args: { command: 'ls' } },
    { id: 'd', name: 'read_file', args: { path: 'z' } }
  ]);

  let active = 0;
  let maxActive = 0;
  const executeTool = async (name) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
    return { ok: true, content: 'ok' };
  };

  await runAgent({ messages, callModel, executeTool, config: {}, tools: [] });
  // read_file + grep_files + read_file overlap (3); run_command is serial and
  // runs afterwards, so peak concurrency is exactly the 3 read-only tools.
  assert.equal(maxActive, 3, 'three read-only tools should overlap; run_command stays serial');
});
