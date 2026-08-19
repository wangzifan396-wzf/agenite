// Pure unit tests for the context-economy ledger (v0.72).
// No server, no model, no DOM — just the aggregator math.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextEconomy } from '../src/core/context-economy.js';

function fakeStore(entries = 3, bytes = 1234) {
  return { stats: () => ({ entries, bytes }) };
}

test('fresh instance is zeroed', () => {
  const e = new ContextEconomy();
  assert.equal(e.compressed, 0);
  assert.equal(e.savedTokens, 0);
  assert.equal(e.savedChars, 0);
  assert.equal(e.retrieved, 0);
  assert.equal(e.missed, 0);
  assert.equal(e.retrieveHitRate, 0);
  assert.deepEqual(e.ledger, []);
});

test('recordCompress accumulates savings and recent metadata', () => {
  const e = new ContextEconomy();
  e.recordCompress({ tool: 'run_command', method: 'log-fold', before: 4000, after: 200, saved: 3800, savedTokens: 900 });
  e.recordCompress({ tool: 'read_file', method: 'code-outline', before: 2000, after: 300, saved: 1700, savedTokens: 410 });
  assert.equal(e.compressed, 2);
  assert.equal(e.savedTokens, 1310);
  assert.equal(e.savedChars, 5500);
  assert.equal(e.lastTool, 'read_file');
  assert.equal(e.lastMethod, 'code-outline');
  assert.equal(e.ledger.length, 2);
  assert.equal(e.ledger[1].kind, 'compress');
  assert.equal(e.ledger[1].savedTokens, 410);
});

test('recordRetrieve tracks hit and miss and hit-rate', () => {
  const e = new ContextEconomy();
  e.recordRetrieve({ hit: true });
  e.recordRetrieve({ hit: true });
  e.recordRetrieve({ hit: false });
  assert.equal(e.retrieved, 2);
  assert.equal(e.missed, 1);
  assert.equal(e.retrieveHitRate, 0.667);
  assert.equal(e.ledger[2].kind, 'retrieve');
  assert.equal(e.ledger[2].hit, false);
});

test('recordRetrieve captures pattern / hits / total', () => {
  const e = new ContextEconomy();
  e.recordRetrieve({ hit: true, pattern: true, hits: 7, total: 500 });
  const last = e.ledger[e.ledger.length - 1];
  assert.equal(last.pattern, true);
  assert.equal(last.hits, 7);
  assert.equal(last.total, 500);
});

test('syncStore mirrors live cache footprint', () => {
  const e = new ContextEconomy();
  e.syncStore(fakeStore(5, 9999));
  assert.equal(e.cacheEntries, 5);
  assert.equal(e.cacheBytes, 9999);
  // A store without stats is ignored, not thrown.
  e.syncStore(null);
  assert.equal(e.cacheEntries, 5);
});

test('snapshot returns a computed, isolated view', () => {
  const e = new ContextEconomy();
  e.recordCompress({ tool: 'run_command', method: 'log-fold', before: 1000, after: 100, saved: 900, savedTokens: 200 });
  e.recordRetrieve({ hit: true });
  const s = e.snapshot();
  assert.equal(s.compressed, 1);
  assert.equal(s.savedTokens, 200);
  assert.equal(s.retrieveHitRate, 1);
  assert.equal(s.cacheEntries, 0);
  // ledger is a copy, not the live array (one compress + one retrieve = 2)
  s.ledger.push({ injected: true });
  assert.equal(e.ledger.length, 2);
});

test('ledger is capped at the most recent 12 entries', () => {
  const e = new ContextEconomy();
  for (let i = 0; i < 20; i++) e.recordCompress({ tool: 't', method: 'm', before: 10, after: 5, saved: 5, savedTokens: 1 });
  assert.equal(e.ledger.length, 12);
  assert.equal(e.ledger[e.ledger.length - 1].tool, 't');
});

test('reset returns the instance to zero', () => {
  const e = new ContextEconomy();
  e.recordCompress({ tool: 't', method: 'm', before: 10, after: 5, saved: 5, savedTokens: 1 });
  e.recordRetrieve({ hit: true });
  e.reset();
  assert.equal(e.compressed, 0);
  assert.equal(e.retrieved, 0);
  assert.equal(e.ledger.length, 0);
});
