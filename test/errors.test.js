import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorHint, errorSeverity } from '../src/core/errors.js';

test('errorHint maps auth failures to a key hint', () => {
  assert.match(errorHint('Incorrect API key provided'), /API Key/);
  assert.match(errorHint('401 Unauthorized'), /API Key/);
  assert.equal(errorSeverity('401'), 'auth');
});

test('errorHint maps rate limiting', () => {
  assert.match(errorHint('429 Too Many Requests'), /限流/);
  assert.equal(errorSeverity('Rate limit reached'), 'auth');
});

test('errorHint maps network/timeout failures', () => {
  assert.match(errorHint('request timed out'), /超时/);
  assert.match(errorHint('Failed to fetch'), /无法连接/);
  assert.equal(errorSeverity('ECONNREFUSED'), 'net');
});

test('errorHint maps missing model', () => {
  assert.match(errorHint('The model "x" does not exist'), /模型名/);
  assert.equal(errorSeverity('model_not_found'), 'model');
});

test('errorHint maps context overflow', () => {
  assert.match(errorHint('maximum context length exceeded'), /上下文/);
});

test('errorHint falls back to a generic actionable hint', () => {
  const h = errorHint('something totally unexpected exploded');
  assert.match(h, /重试|轨迹/);
  assert.equal(errorSeverity('weird error'), 'generic');
});

test('errorHint tolerates non-string input', () => {
  assert.equal(typeof errorHint(undefined), 'string');
  assert.equal(typeof errorHint(null), 'string');
});
