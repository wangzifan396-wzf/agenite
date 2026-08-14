import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError, verifyKey, callOpenAIStream, callAnthropicStream, ModelCallError } from '../src/core/client.js';

// Build a fake fetch response whose body is a ReadableStream yielding the given
// raw SSE string chunks (mirrors what a real provider streams over HTTP).
function fakeSseResponse(chunks) {
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(ctrl) {
        for (const c of chunks) ctrl.enqueue(enc.encode(c));
        ctrl.close();
      }
    })
  };
}

test('classifyProviderError maps status to friendly classes', () => {
  assert.equal(classifyProviderError(401).errorClass, 'AUTH');
  assert.equal(classifyProviderError(403).errorClass, 'AUTH');
  assert.equal(classifyProviderError(404).errorClass, 'NOT_FOUND');
  assert.equal(classifyProviderError(429).errorClass, 'RATE_LIMIT');
  assert.equal(classifyProviderError(400).errorClass, 'BAD_REQUEST');
  assert.equal(classifyProviderError(500).errorClass, 'SERVER');
  assert.match(classifyProviderError(401).message, /API Key/);
});

test('verifyKey returns ok for ollama without a key', async () => {
  const r = await verifyKey({ provider: 'ollama', baseURL: 'http://localhost:11434/v1', model: 'llama3.1' });
  assert.equal(r.ok, true);
  assert.equal(r.errorClass, 'OK');
});

test('verifyKey rejects a missing key for cloud providers', async () => {
  const r = await verifyKey({ provider: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: '' });
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'AUTH');
});

test('verifyKey validates the baseURL shape', async () => {
  const r = await verifyKey({ provider: 'openai', baseURL: 'notaurl', model: 'gpt-4o', apiKey: 'sk-x' });
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'BAD_REQUEST');
});

test('verifyKey calls the provider and reports ok on 200', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.method, 'POST');
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  const r = await verifyKey({ provider: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'sk-x' }, { fetchImpl, timeoutMs: 100 });
  assert.equal(r.ok, true);
});

test('verifyKey posts to /messages for Anthropic', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://api.anthropic.com/messages');
    assert.equal(opts.headers['x-api-key'], 'sk-ant-x');
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  const r = await verifyKey({ provider: 'anthropic', protocol: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-3-5-sonnet', apiKey: 'sk-ant-x' }, { fetchImpl, timeoutMs: 100 });
  assert.equal(r.ok, true);
});

test('verifyKey maps a 401 to AUTH with a friendly message', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'invalid' });
  const r = await verifyKey({ provider: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'sk-bad' }, { fetchImpl, timeoutMs: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'AUTH');
  assert.match(r.message, /API Key/);
});

test('verifyKey maps a network failure to NETWORK', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await verifyKey({ provider: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'sk-x' }, { fetchImpl, timeoutMs: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'NETWORK');
});

test('verifyKey maps a timeout (AbortError) to TIMEOUT', async () => {
  const fetchImpl = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const r = await verifyKey({ provider: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'sk-x' }, { fetchImpl, timeoutMs: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'TIMEOUT');
});

test('callOpenAIStream captures reasoning_content separately from content', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"让我先拆解需求"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"，再决定实现方案"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好的，开始。"}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  const fetchImpl = async () => fakeSseResponse(chunks);
  const r = await callOpenAIStream({
    config: { model: 'deepseek-reasoner', baseURL: 'https://api.openai.com/v1', apiKey: 'k' },
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl
  });
  assert.equal(r.content, '好的，开始。');
  assert.equal(r.reasoning, '让我先拆解需求，再决定实现方案');
});

test('callAnthropicStream captures thinking_delta as reasoning', async () => {
  const chunks = [
    'data: {"type":"content_block_start","content_block":{"type":"thinking"}}\n',
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm, let me think"}}\n',
    'data: {"type":"content_block_start","content_block":{"type":"text"}}\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi there"}}\n',
    'data: {"type":"message_stop"}\n'
  ];
  const fetchImpl = async () => fakeSseResponse(chunks);
  const r = await callAnthropicStream({
    config: { model: 'claude-3-7-sonnet', protocol: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-x' },
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl
  });
  assert.equal(r.content, 'hi there');
  assert.equal(r.reasoning, 'hmm, let me think');
});

test('callModelStream throws a typed ModelCallError carrying the provider class', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  await assert.rejects(
    () => callOpenAIStream({
      config: { model: 'gpt-4o', baseURL: 'https://api.openai.com/v1', apiKey: 'k' },
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl
    }),
    (e) => e instanceof ModelCallError && e.errorClass === 'RATE_LIMIT'
  );
});

test('callOpenAIStream retries a transient 429 then succeeds', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    if (attempts === 1) return { ok: false, status: 429, text: async () => 'rate limited' };
    const chunks = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'];
    return fakeSseResponse(chunks);
  };
  const r = await callOpenAIStream({
    config: { model: 'gpt-4o', baseURL: 'https://api.openai.com/v1', apiKey: 'k' },
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl
  });
  assert.equal(r.content, 'ok');
  assert.equal(attempts, 2, 'should retry exactly once after the 429');
});

test('callOpenAIStream does not retry a permanent 401', async () => {
  let attempts = 0;
  const fetchImpl = async () => { attempts++; return { ok: false, status: 401, text: async () => 'invalid key' }; };
  await assert.rejects(
    () => callOpenAIStream({
      config: { model: 'gpt-4o', baseURL: 'https://api.openai.com/v1', apiKey: 'bad' },
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl
    }),
    (e) => e.errorClass === 'AUTH'
  );
  assert.equal(attempts, 1, 'a 401 must not be retried');
});

test('callOpenAIStream gives up after maxAttempts on a persistent 429', async () => {
  let attempts = 0;
  const fetchImpl = async () => { attempts++; return { ok: false, status: 429, text: async () => 'rate limited' }; };
  await assert.rejects(
    () => callOpenAIStream({
      config: { model: 'gpt', baseURL: 'https://api.openai.com/v1', apiKey: 'k' },
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl
    }),
    (e) => e.errorClass === 'RATE_LIMIT'
  );
  assert.equal(attempts, 3, 'should attempt exactly 3 times then throw');
});
