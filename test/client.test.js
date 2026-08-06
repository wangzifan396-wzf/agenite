import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError, verifyKey } from '../src/core/client.js';

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
