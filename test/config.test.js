import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, normalizeConfig, validateConfig, PROVIDER_PRESETS } from '../src/core/config.js';

test('defaultConfig has sane values', () => {
  const c = defaultConfig();
  assert.equal(c.provider, 'deepseek');
  assert.equal(c.agentEnabled, true);
  assert.ok(c.temperature >= 0 && c.temperature <= 2);
});

test('normalizeConfig applies preset for deepseek', () => {
  const c = normalizeConfig({ provider: 'deepseek', apiKey: 'sk-x' });
  assert.equal(c.baseURL, 'https://api.deepseek.com/v1');
  assert.equal(c.protocol, 'openai');
  assert.equal(c.model, 'deepseek-chat');
});

test('normalizeConfig applies preset for anthropic and clamps temperature', () => {
  const c = normalizeConfig({ provider: 'anthropic', temperature: 99, model: 'claude-x' });
  assert.equal(c.protocol, 'anthropic');
  assert.equal(c.temperature, 2);
});

test('normalizeConfig falls back to default for invalid temperature', () => {
  const c = normalizeConfig({ temperature: 'abc' });
  assert.equal(c.temperature, 0.7);
});

test('validateConfig fails without api key (non-ollama)', () => {
  const { ok, errors } = validateConfig(normalizeConfig({ provider: 'openai', apiKey: '' }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /API Key/.test(e)));
});

test('validateConfig passes for ollama with empty key', () => {
  const { ok } = validateConfig(normalizeConfig({ provider: 'ollama', apiKey: '' }));
  assert.equal(ok, true);
});

test('validateConfig rejects bad baseURL', () => {
  const { ok } = validateConfig(normalizeConfig({ provider: 'custom', baseURL: 'ftp://x', model: 'm', apiKey: 'k' }));
  assert.equal(ok, false);
});

test('presets cover common providers', () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  for (const id of ['openai', 'deepseek', 'qwen', 'moonshot', 'zhipu', 'groq', 'ollama', 'anthropic', 'custom']) {
    assert.ok(ids.includes(id), 'missing preset ' + id);
  }
});
