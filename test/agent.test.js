import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/core/agent.js';

test('agent loop executes one tool then returns final answer', async () => {
  const events = [];
  const messages = [
    { role: 'user', content: 'What is 2+3? use calculator' }
  ];
  // First call returns a tool call, second returns final text.
  let callCount = 0;
  const callModel = async (msgs, { onDelta }) => {
    callCount++;
    if (callCount === 1) {
      return {
        content: '',
        toolCalls: [{ id: 't1', name: 'calculator', args: { expression: '2+3' } }],
        usage: null
      };
    }
    onDelta('The answer is 5.');
    return { content: 'The answer is 5.', toolCalls: [], usage: null };
  };
  const executeTool = async (name, args) => ({ ok: true, content: '5' });

  const res = await runAgent({ messages, callModel, executeTool, config: {}, onEvent: (t, p) => events.push([t, p]) });

  assert.equal(res.stopped, 'done');
  assert.equal(callCount, 2);
  // final assistant message has no tool_calls
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  assert.equal(lastAssistant.tool_calls, undefined);
  // a tool message was appended
  assert.ok(messages.some((m) => m.role === 'tool' && m.tool_call_id === 't1'));
  // 'tool' event recorded
  assert.ok(events.some(([t, p]) => t === 'tool' && p.name === 'calculator' && p.result === '5'));
  // 'delta' streamed the final text
  assert.ok(events.some(([t, p]) => t === 'delta' && p === 'The answer is 5.'));
});

test('agent loop stops at maxTurns', async () => {
  const messages = [{ role: 'user', content: 'loop' }];
  const callModel = async () => ({ content: '', toolCalls: [{ id: 'x', name: 'calculator', args: {} }], usage: null });
  const executeTool = async () => ({ ok: true, content: 'n' });
  const res = await runAgent({ messages, callModel, executeTool, config: {}, maxTurns: 3 });
  assert.equal(res.stopped, 'max_turns');
});

test('agent loop returns immediately when no tool call', async () => {
  const messages = [{ role: 'user', content: 'hi' }];
  let calls = 0;
  const callModel = async (m, { onDelta }) => { calls++; onDelta('hello'); return { content: 'hello', toolCalls: [] }; };
  const res = await runAgent({ messages, callModel, executeTool: async () => ({ ok: true }), config: {} });
  assert.equal(res.stopped, 'done');
  assert.equal(calls, 1);
});
