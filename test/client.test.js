import test from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAIStream, callAnthropicStream, parseSSELine } from '../src/core/client.js';

function fakeResponse(chunks) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    }
  });
  return { ok: true, status: 200, body: stream, text: async () => '' };
}

function openAIFetch(objs) {
  const chunks = objs.map((o) => `data: ${JSON.stringify(o)}\n\n`);
  chunks.push('data: [DONE]\n\n');
  return async () => fakeResponse(chunks);
}

test('parseSSELine parses data lines', () => {
  assert.deepEqual(parseSSELine('data: {"a":1}'), { a: 1 });
  assert.equal(parseSSELine('data: [DONE]').__done, true);
  assert.equal(parseSSELine('event: ping'), null);
});

test('callOpenAIStream streams text content', async () => {
  const fetchImpl = openAIFetch([
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [{ delta: { content: ' world' } }] },
    { choices: [{}], usage: { total_tokens: 5 } }
  ]);
  const config = { baseURL: 'https://api.x/v1', apiKey: 'k', model: 'm', temperature: 0.7, maxTokens: 100, topP: 1 };
  const deltas = [];
  const r = await callOpenAIStream({ config, messages: [{ role: 'user', content: 'hi' }], tools: [], onDelta: (t) => deltas.push(t), fetchImpl });
  assert.equal(r.content, 'Hello world');
  assert.deepEqual(deltas, ['Hello', ' world']);
  assert.equal(r.toolCalls.length, 0);
});

test('callOpenAIStream accumulates tool calls across deltas', async () => {
  const fetchImpl = openAIFetch([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'calculator', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"expression":"2+3"}' } }] } }] }
  ]);
  const config = { baseURL: 'https://api.x/v1', apiKey: 'k', model: 'm', temperature: 0.7, maxTokens: 100, topP: 1 };
  const r = await callOpenAIStream({ config, messages: [], tools: [{ name: 'calculator' }], fetchImpl });
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, 'calculator');
  assert.deepEqual(r.toolCalls[0].args, { expression: '2+3' });
});

test('callOpenAIStream surfaces API errors', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  const config = { baseURL: 'https://api.x/v1', apiKey: 'k', model: 'm', temperature: 0.7, maxTokens: 100, topP: 1 };
  await assert.rejects(
    () => callOpenAIStream({ config, messages: [], tools: [], fetchImpl }),
    /401/
  );
});

test('callAnthropicStream streams text and tool_use', async () => {
  const chunks = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"calculator"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"expression\\":\\"2+3\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ];
  const fetchImpl = async () => fakeResponse(chunks);
  const config = { baseURL: 'https://api.anthropic.com', apiKey: 'k', model: 'm', temperature: 0.7, maxTokens: 100 };
  const r = await callAnthropicStream({ config, messages: [{ role: 'user', content: 'calc' }], tools: [{ name: 'calculator' }], fetchImpl });
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, 'calculator');
  assert.deepEqual(r.toolCalls[0].args, { expression: '2+3' });
});
