import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toOpenAITools,
  toOpenAIMessages,
  toAnthropicTools,
  normalizeToolCalls,
  toAnthropicMessages,
  anthropicBlocksToMessage,
  parseDataUrl
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

// --- multimodal image support ---
test('toOpenAIMessages keeps plain messages untouched', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' }
  ];
  const out = toOpenAIMessages(msgs);
  assert.equal(out[1].content, 'hi');
  assert.equal(out[2].content, 'hello');
  // reference must be preserved (no accidental mutation)
  assert.equal(out[0].content, 'sys');
});

test('toOpenAIMessages expands user images into image_url parts', () => {
  const msgs = [{ role: 'user', content: '看这张图', images: ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB'] }];
  const out = toOpenAIMessages(msgs);
  const content = out[0].content;
  assert.equal(content.length, 3);
  assert.deepEqual(content[0], { type: 'text', text: '看这张图' });
  assert.deepEqual(content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  assert.deepEqual(content[2], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } });
});

test('toAnthropicMessages attaches images as base64 source blocks', () => {
  const msgs = [{ role: 'user', content: '看图', images: ['data:image/png;base64,ABC123'] }];
  const { messages } = toAnthropicMessages(msgs);
  const user = messages[0];
  assert.equal(user.role, 'user');
  const textBlock = user.content[0];
  const imgBlock = user.content[1];
  assert.equal(textBlock.type, 'text');
  assert.equal(imgBlock.type, 'image');
  assert.equal(imgBlock.source.type, 'base64');
  assert.equal(imgBlock.source.media_type, 'image/png');
  assert.equal(imgBlock.source.data, 'ABC123');
});

test('parseDataUrl splits media type and base64 payload', () => {
  assert.deepEqual(parseDataUrl('data:image/jpeg;base64,XYZ'), { mediaType: 'image/jpeg', data: 'XYZ' });
  assert.deepEqual(parseDataUrl('garbage'), { mediaType: 'image/png', data: '' });
});
