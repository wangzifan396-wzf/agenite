// Cost estimation. Wrong numbers here are worse than no numbers, so the rules
// that decide WHICH price applies are the part under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  priceFor, isLocalProvider, normalizeUsage, emptyUsage, addUsage, costOf,
  formatTokens, formatCost
} from '../src/core/pricing.js';

test('known models resolve to a table price', () => {
  const p = priceFor('deepseek-chat', {});
  assert.equal(p.source, 'table');
  assert.ok(p.in > 0 && p.out > 0);
  assert.ok(p.out >= p.in, 'output is never cheaper than input');
});

test('an unknown model is reported as unknown rather than guessed at', () => {
  const p = priceFor('totally-made-up-model-v9', {});
  assert.equal(p.source, 'unknown');
  assert.equal(p.in, 0);
  assert.equal(p.out, 0);
});

test('local providers are free, even for a model name that exists in the table', () => {
  assert.equal(isLocalProvider({ provider: 'ollama' }), true);
  assert.equal(isLocalProvider({ baseURL: 'http://localhost:11434/v1' }), true);
  assert.equal(isLocalProvider({ baseURL: 'http://127.0.0.1:1234/v1' }), true);
  assert.equal(isLocalProvider({ provider: 'openai', baseURL: 'https://api.openai.com/v1' }), false);

  const p = priceFor('gpt-4o', { provider: 'ollama' });
  assert.equal(p.source, 'local');
  assert.equal(p.in, 0);
  assert.equal(p.out, 0);
});

test('a user-supplied price overrides everything else', () => {
  const p = priceFor('gpt-4o', { priceIn: 1.5, priceOut: 6, priceCurrency: 'USD' });
  assert.equal(p.source, 'config');
  assert.equal(p.in, 1.5);
  assert.equal(p.out, 6);
  assert.equal(p.currency, 'USD');
});

test('normalizeUsage understands both OpenAI and Anthropic shapes', () => {
  const openai = normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  assert.deepEqual(openai, { prompt: 100, completion: 20, total: 120 });

  const anthropic = normalizeUsage({ input_tokens: 100, output_tokens: 20 });
  assert.equal(anthropic.prompt, 100);
  assert.equal(anthropic.completion, 20);
  assert.equal(anthropic.total, 120, 'total is derived when the provider omits it');

  assert.deepEqual(normalizeUsage(null), { prompt: 0, completion: 0, total: 0 });
  assert.deepEqual(normalizeUsage('nonsense'), { prompt: 0, completion: 0, total: 0 });
});

test('cached input tokens are counted, not dropped', () => {
  const u = normalizeUsage({ input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 });
  assert.equal(u.prompt, 100, 'cache reads are still input tokens you pay (something) for');
});

test('addUsage accumulates across turns', () => {
  const acc = emptyUsage();
  addUsage(acc, { prompt_tokens: 10, completion_tokens: 5 });
  addUsage(acc, { prompt_tokens: 7, completion_tokens: 3 });
  assert.equal(acc.prompt, 17);
  assert.equal(acc.completion, 8);
  assert.equal(acc.total, 25);
  assert.equal(acc.calls, 2);
});

test('costOf computes per-million-token pricing and flags unknown prices', () => {
  const c = costOf({ prompt: 1000000, completion: 1000000 }, { in: 2, out: 8, currency: 'CNY', source: 'table' });
  assert.equal(c.amount, 10);
  assert.equal(c.currency, 'CNY');
  assert.equal(c.known, true);

  const unknown = costOf({ prompt: 1000, completion: 1000 }, { in: 0, out: 0, currency: 'CNY', source: 'unknown' });
  assert.equal(unknown.amount, 0);
  assert.equal(unknown.known, false, 'a zero price we invented must not look authoritative');

  const local = costOf({ prompt: 999999, completion: 999999 }, { in: 0, out: 0, currency: 'CNY', source: 'local' });
  assert.equal(local.known, true, 'local really is free, and we know it');
});

test('formatters stay readable at every magnitude', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.match(formatTokens(1500), /1\.5k/);
  assert.match(formatTokens(2500000), /2\.50?M/);
  assert.match(formatCost(0, 'CNY'), /0/);
  assert.match(formatCost(0.0001234, 'CNY'), /¥/);
  assert.match(formatCost(12.3456, 'USD'), /\$12\.3/);
});
