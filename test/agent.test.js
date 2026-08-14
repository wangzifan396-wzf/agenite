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

test('agent loop triggers cost guardrail and stops gracefully', async () => {
  const events = [];
  const messages = [{ role: 'user', content: 'loop me' }];
  let n = 0;
  // gpt-4o-mini pricing: in $0.15 / out $0.6 per 1M. 1000+1000 tokens ~= $0.00075,
  // which exceeds the tiny $0.0001 cap, so the guardrail should trip after turn 1.
  const callModel = async (msgs, { onDelta }) => {
    n++;
    if (n === 1) {
      return {
        content: '',
        toolCalls: [{ id: 't1', name: 'calculator', args: { a: 1 } }],
        usage: { prompt_tokens: 1000, completion_tokens: 1000 }
      };
    }
    onDelta('stopped');
    return { content: '已触发预算护栏并汇总。', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  };
  const executeTool = async () => ({ ok: true, content: '1' });
  const res = await runAgent({
    messages, callModel, executeTool,
    config: { model: 'gpt-4o-mini', budget: { maxCostUSD: 0.0001 } },
    onEvent: (t, p) => events.push([t, p])
  });
  assert.equal(res.stopped, 'guardrail', 'should stop with the guardrail reason');
  assert.ok(events.some(([t, p]) => t === 'guardrail' && p.reason === 'cost'), 'should emit a guardrail event');
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  assert.equal(last.tool_calls, undefined, 'final summary has no tool calls');
});

test('agent loop ignores cost guardrail when cap is 0', async () => {
  // With maxCostUSD <= 0 the guardrail is off; a loop of tool calls should fall
  // through to the normal maxTurns stop, not the guardrail stop.
  const messages = [{ role: 'user', content: 'loop' }];
  let n = 0;
  const callModel = async () => { n++; return { content: '', toolCalls: [{ id: 'x', name: 'calculator', args: {} }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }; };
  const executeTool = async () => ({ ok: true, content: 'n' });
  const res = await runAgent({ messages, callModel, executeTool, config: { model: 'gpt-4o-mini', budget: { maxCostUSD: 0 } }, maxTurns: 2 });
  assert.equal(res.stopped, 'max_turns');
  assert.ok(!res.stopped || res.stopped !== 'guardrail');
});

test('agent loop injects a stuck-loop breaker on consecutive identical tool calls', async () => {
  // trace.js detects exact-repeat loops; the agent should *act* on them. Three
  // turns of the same (name+args) read must trigger one bounded reflection,
  // after which the model can switch approach and finish.
  const messages = [{ role: 'user', content: 'keep reading' }];
  let callCount = 0;
  const callModel = async (msgs, { onDelta }) => {
    callCount++;
    if (callCount <= 3) {
      return { content: '', toolCalls: [{ id: 't' + callCount, name: 'read_file', args: { path: 'a.txt' } }], usage: null };
    }
    onDelta('done');
    return { content: 'I rephrased and finished.', toolCalls: [], usage: null };
  };
  const executeTool = async () => ({ ok: true, content: 'file contents' });
  const res = await runAgent({ messages, callModel, executeTool, config: {}, maxTurns: 10 });
  assert.equal(res.stopped, 'done');
  assert.equal(callCount, 4);
  const breaker = [...messages].reverse().find((m) => m.role === 'user' && m.content.includes('完全相同'));
  assert.ok(breaker, 'a stuck-loop breaker message should have been injected');
});

test('agent loop does not flag non-consecutive identical calls as a loop', async () => {
  // Re-reading the same file in *different* turns (a, b, a) is normal behavior
  // and must NOT trip the breaker — only a sustained consecutive repeat is.
  const messages = [{ role: 'user', content: 'read a few' }];
  let callCount = 0;
  const callModel = async (msgs, { onDelta }) => {
    callCount++;
    const path = callCount === 1 ? 'a.txt' : callCount === 2 ? 'b.txt' : callCount === 3 ? 'a.txt' : null;
    if (path) return { content: '', toolCalls: [{ id: 't' + callCount, name: 'read_file', args: { path } }], usage: null };
    onDelta('done');
    return { content: 'finished', toolCalls: [], usage: null };
  };
  const executeTool = async () => ({ ok: true, content: 'x' });
  const res = await runAgent({ messages, callModel, executeTool, config: {}, maxTurns: 10 });
  assert.equal(res.stopped, 'done');
  assert.equal(callCount, 4);
  const breaker = messages.find((m) => m.role === 'user' && m.content.includes('完全相同'));
  assert.equal(breaker, undefined, 'non-consecutive repeats must not trigger the breaker');
});
