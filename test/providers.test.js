import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_PRESETS, modelsForProvider, ALL_MODELS, normalizeConfig, validateConfig
} from '../src/core/config.js';

test('catalog includes Gemini and SiliconFlow with valid model lists', () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.ok(ids.includes('gemini'), 'has gemini');
  assert.ok(ids.includes('siliconflow'), 'has siliconflow');

  const gem = PROVIDER_PRESETS.find((p) => p.id === 'gemini');
  assert.equal(gem.protocol, 'openai');
  assert.ok(gem.baseURL.includes('generativelanguage.googleapis.com'));
  assert.ok(gem.models.some((m) => m.id === 'gemini-2.0-flash'));
  assert.ok(gem.models.every((m) => typeof m.ctx === 'number' && m.ctx > 0), 'ctx positive');

  const sf = PROVIDER_PRESETS.find((p) => p.id === 'siliconflow');
  assert.ok(sf.models.some((m) => m.id === 'deepseek-ai/DeepSeek-V3'));
});

test('every provider carries an icon + non-empty model list (except custom)', () => {
  for (const p of PROVIDER_PRESETS) {
    assert.ok(p.icon, 'provider needs icon: ' + p.id);
    if (p.id === 'custom') {
      assert.deepEqual(p.models, []);
    } else {
      assert.ok(Array.isArray(p.models) && p.models.length > 0, 'provider needs models: ' + p.id);
      assert.ok(p.models.every((m) => m.ctx > 0));
    }
  }
});

test('modelsForProvider returns the catalog and [] for custom', () => {
  const ms = modelsForProvider('openai');
  assert.ok(ms.length >= 4);
  assert.deepEqual(modelsForProvider('custom'), []);
});

test('ALL_MODELS is a flattened, non-empty catalog', () => {
  assert.ok(ALL_MODELS.length >= 30, 'expected a rich catalog');
  assert.ok(ALL_MODELS.every((m) => m.provider && m.id && m.ctx > 0));
});

test('normalizeConfig defaults KB fields and resolves Gemini preset', () => {
  const c = normalizeConfig({ provider: 'gemini', apiKey: 'AIza', model: 'gemini-2.0-flash' });
  assert.equal(c.kbEnabled, false);
  assert.equal(c.kbTopK, 5);
  assert.equal(c.protocol, 'openai');
  assert.equal(c.baseURL, 'https://generativelanguage.googleapis.com/v1beta/openai/');
  // custom kbTopK is respected
  const c2 = normalizeConfig({ kbTopK: 8 });
  assert.equal(c2.kbTopK, 8);
});

test('validateConfig accepts the OpenAI-compatible Gemini endpoint', () => {
  const c = normalizeConfig({ provider: 'gemini', apiKey: 'AIza', model: 'gemini-2.0-flash' });
  const v = validateConfig(c);
  assert.equal(v.ok, true, v.errors.join('; '));
});
