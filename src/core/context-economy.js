// Context economy observability: aggregate accounting for the reversible
// compression system (compress.js / context.js).
//
// Agenite already *does* reversible compression — oversized tool results are
// shrunk on the way into the history and the original is kept verbatim in a
// TTL ContextStore, retrievable on demand via `context_retrieve`. What it did
// NOT do is *measure* that economy: how many tokens it actually kept out of
// the window, and whether retrievals hit the cache. This module is the single
// ledger those numbers flow into, so operators can prove the context economy
// is working instead of trusting it — the same "audit question resolves to one
// query against one store" principle that governs the guardrail (v0.71) and
// self-heal (v0.70) ledgers.
//
// Pure: no fs / network / DOM, so it is trivially unit-testable.

const LEDGER_MAX = 12;

/**
 * Cumulative context-economy counters. One instance lives at the server level
 * and is rolled from the `shrink` (a result was compressed) and `tool`
 * (a `context_retrieve` was answered) events the agent loop already emits — no
 * change to the loop itself. `syncStore` keeps the live cache footprint in the
 * same ledger so a single `/api/health` read shows the whole picture.
 */
export class ContextEconomy {
  constructor() {
    this.reset();
  }

  reset() {
    this.compressed = 0; // number of tool results compressed
    this.savedTokens = 0; // cumulative tokens kept out of the window
    this.savedChars = 0; // cumulative characters removed by compression
    this.retrieved = 0; // context_retrieve calls that hit the cache
    this.missed = 0; // context_retrieve calls that missed (expired / unknown)
    this.cacheEntries = 0; // originals currently held in the store
    this.cacheBytes = 0; // bytes currently held in the store
    this.lastMethod = null;
    this.lastTool = null;
    this.lastAt = null;
    this.ledger = [];
  }

  recordCompress({ tool, method, before, after, saved = 0, savedTokens = 0 } = {}) {
    this.compressed++;
    this.savedTokens += savedTokens || 0;
    this.savedChars += saved || 0;
    this.lastMethod = method || this.lastMethod;
    this.lastTool = tool || this.lastTool;
    this.lastAt = new Date().toISOString();
    this._push({
      kind: 'compress',
      tool: tool || '',
      method: method || '',
      before: before || 0,
      after: after || 0,
      savedTokens: savedTokens || 0
    });
    return this;
  }

  recordRetrieve({ hit = false, pattern = false, hits = 0, total = 0 } = {}) {
    if (hit) this.retrieved++; else this.missed++;
    this.lastAt = new Date().toISOString();
    this._push({
      kind: 'retrieve',
      hit: !!hit,
      pattern: !!pattern,
      hits: hits || 0,
      total: total || 0
    });
    return this;
  }

  /** Mirror the live cache footprint from a ContextStore into the ledger. */
  syncStore(store) {
    if (store && typeof store.stats === 'function') {
      const s = store.stats();
      this.cacheEntries = s.entries || 0;
      this.cacheBytes = s.bytes || 0;
    }
    return this;
  }

  _push(entry) {
    this.ledger.push({ at: new Date().toISOString(), ...entry });
    if (this.ledger.length > LEDGER_MAX) this.ledger.shift();
  }

  /** Live cache hit-rate (retrieved / (retrieved + missed)), 0 when no retrieval yet. */
  get retrieveHitRate() {
    const total = this.retrieved + this.missed;
    return total ? +(this.retrieved / total).toFixed(3) : 0;
  }

  snapshot() {
    return {
      compressed: this.compressed,
      savedTokens: this.savedTokens,
      savedChars: this.savedChars,
      retrieved: this.retrieved,
      missed: this.missed,
      retrieveHitRate: this.retrieveHitRate,
      cacheEntries: this.cacheEntries,
      cacheBytes: this.cacheBytes,
      lastMethod: this.lastMethod,
      lastTool: this.lastTool,
      lastAt: this.lastAt,
      ledger: this.ledger.slice()
    };
  }
}

export default ContextEconomy;
