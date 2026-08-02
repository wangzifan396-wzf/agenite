import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toOpenAITools,
  toAnthropicTools,
  normalizeToolCalls,
  toAnthropicMessages,
  anthropicBlocksToMessage
} from '../src/core/provider.js';

const tools = [
  { name: 'calculator', description: 'calc', parameters: { type: 'object', properties: { expression: { type: 'string' } } } }
];

test('toOpenAITools wraps as function', () => {
  const o = toOpenAITools(tools);
  assert.equal(o[0].type, 'function');
  assert.equal(o[0].function.name, 'calculator');
});

test('toAnthropicTools uses input_schema', () => {
  const a = toAnthropicTools(tools);
  assert.equal(a[0].name, 'calculator');
  assert.ok(a[0].input_schema);
});

test('normalizeToolCalls parses string arguments', () => {
  const raw = [{ id: '1', function: { name: 'calculator', arguments: '{"expression":"2+3"}' } }];
  const n = normalizeToolCalls(raw);
  assert.equal(n[0].name, 'calculator');
  assert.deepEqual(n[0].args, { expression: '2+3' });
});

test('normalizeToolCalls tolerates broken json', () => {
  const raw = [{ id: '1', function: { name: 'x', arguments: '{bad' } }];
  const n = normalizeToolCalls(raw);
  assert.ok(n[0].args._raw !== undefined);
});

test('toAnthropicMessages extracts system and maps tool results', () => {
  const msgs = [
    { role: 'system', content: 'be nice' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"1"}' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'calculator', content: '1' }
  ];
  const { system, messages } = toAnthropicMessages(msgs);
  assert.equal(system, 'be nice');
  const toolUse = messages.find((m) => m.role === 'assistant').content.find((b) => b.type === 'tool_use');
  assert.equal(toolUse.name, 'calculator');
  const lastUser = messages.filter((m) => m.role === 'user').pop();
  const toolResult = lastUser.content.find((b) => b.type === 'tool_result');
  assert.equal(toolResult.tool_use_id, 't1');
  assert.equal(toolResult.content, '1');
});

test('anthropicBlocksToMessage builds tool calls on tool_use stop', () => {
  const blocks = [
    { type: 'text', text: 'thinking' },
    { type: 'tool_use', id: 'u1', name: 'calculator', input: { expression: '1' } }
  ];
  const m = anthropicBlocksToMessage(blocks, 'tool_use');
  assert.equal(m.content, 'thinking');
  assert.equal(m.toolCalls[0].name, 'calculator');
  assert.deepEqual(m.toolCalls[0].args, { expression: '1' });
});
