// Tool failure handling: every failure carries a structured errorClass and
// retryable network tools recover from transient blips internally (the model
// never sees the retries). This is the 2026 "validate -> error -> retry"
// reliability pattern, unit-tested with an injected fetch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../src/core/tools.js';

describe('tool error taxonomy + bounded retry', () => {
  test('unknown tool is classified NOT_FOUND', async () => {
    const r = await executeTool('totally_unknown_tool', {});
    assert.equal(r.ok, false);
    assert.equal(r.errorClass, 'NOT_FOUND');
  });

  test('web_fetch retries transient 429s then succeeds (model sees one result)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls < 3) return { ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'rate limited' };
      return { ok: true, status: 200, text: async () => '<html>hi</html>' };
    };
    const r = await executeTool('web_fetch', { url: 'https://x.test' }, { fetchImpl, retryCount: 4 });
    assert.equal(r.ok, true, 'should succeed after transient retries');
    assert.equal(calls, 3, 'should have retried until success');
  });

  test('transient 5xx is retried up to the cap, then reported TRANSIENT', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => 'down' };
    };
    const r = await executeTool('web_fetch', { url: 'https://x.test' }, { fetchImpl, retryCount: 3 });
    assert.equal(r.ok, false);
    assert.equal(r.errorClass, 'TRANSIENT');
    assert.equal(r.retryable, true);
    assert.equal(calls, 3, 'default retry budget is 3 attempts');
  });

  test('404 is treated as permanent and NOT retried', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => 'missing' };
    };
    const r = await executeTool('web_fetch', { url: 'https://x.test/missing' }, { fetchImpl, retryCount: 3 });
    assert.equal(r.ok, false);
    assert.equal(calls, 1, 'permanent error must not be retried');
    assert.notEqual(r.errorClass, 'TRANSIENT');
  });

  test('non-retryable tool failure returns once, classified SCHEMA_ERROR', async () => {
    const r = await executeTool('calculator', { expression: '' });
    assert.equal(r.ok, false);
    assert.equal(r.errorClass, 'SCHEMA_ERROR');
  });

  test('web_search also retries on a transient network error', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls < 2) throw new Error('socket hang up');
      return { ok: true, status: 200, text: async () => '<html>result</html>' };
    };
    const r = await executeTool('web_search', { query: 'node modules' }, { fetchImpl, retryCount: 3 });
    assert.ok(calls >= 2, 'should have retried the transient failure (calls=' + calls + ')');
  });
});
