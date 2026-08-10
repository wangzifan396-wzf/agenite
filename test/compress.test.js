// Context economy: shrink oversized tool output *before* it enters the history,
// and make every byte of it retrievable afterwards.
//
// The tests below lean hard on one invariant: compression must never be able to
// destroy information. So alongside "did it get smaller" we always check "can we
// still get the original back", and the agent-loop tests assert that no store
// means no compression at all.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContextStore,
  codeOutline,
  compressBudget,
  compressContent,
  detectKind,
  foldRepeats,
  jsonSkeleton,
  lineSignature,
  retrieveHint,
  trimLines,
  COMPRESS_MODES
} from '../src/core/compress.js';
import { runAgent } from '../src/core/agent.js';
import { normalizeConfig } from '../src/core/config.js';
import { executeTool } from '../src/core/tools.js';

// ── kind detection ──────────────────────────────────────────────────────────

test('detectKind: JSON wins over the tool hint', () => {
  const payload = JSON.stringify({ ok: true, items: [1, 2, 3], note: 'x'.repeat(60) });
  assert.equal(detectKind(payload, 'run_command'), 'json');
});

test('detectKind: the producing tool is the strongest hint', () => {
  assert.equal(detectKind('some plain output\nmore output', 'run_command'), 'log');
  assert.equal(detectKind('a.js:1: foo\nb.js:2: bar', 'grep_files'), 'listing');
  assert.equal(detectKind('hello world', 'web_fetch'), 'text');
});

test('detectKind: falls back to the file extension for read_file', () => {
  assert.equal(detectKind('export function a() {}', 'read_file', 'src/a.js'), 'code');
  assert.equal(detectKind('# title\n\ntext', 'read_file', 'README.md'), 'text');
  assert.equal(detectKind('{"a":1}', 'read_file', 'pkg.json'), 'json');
});

test('detectKind: sniffs logs and code when there is no hint at all', () => {
  const log = Array.from({ length: 20 }, (_, i) => `2026-01-01T10:00:${String(i).padStart(2, '0')} INFO tick ${i}`).join('\n');
  assert.equal(detectKind(log), 'log');
  const code = Array.from({ length: 12 }, (_, i) => `export function f${i}() { return ${i}; }`).join('\n');
  assert.equal(detectKind(code), 'code');
  assert.equal(detectKind('just a sentence.'), 'text');
});

test('detectKind: empty input is text, never a crash', () => {
  assert.equal(detectKind(''), 'text');
  assert.equal(detectKind(null), 'text');
});

// ── log folding ─────────────────────────────────────────────────────────────

test('lineSignature masks values but never words', () => {
  const a = lineSignature('2026-01-01T10:00:00 INFO served /users in 12ms');
  const b = lineSignature('2026-01-02T11:30:59 INFO served /users in 4310ms');
  assert.equal(a, b);
  // Different words must stay different, or a directory listing would collapse.
  assert.notEqual(lineSignature('alpha.txt'), lineSignature('beta.txt'));
});

test('foldRepeats collapses repeats and annotates the count', () => {
  const text = Array.from({ length: 137 }, (_, i) => `WARN retrying connection attempt ${i}`).join('\n');
  const r = foldRepeats(text);
  assert.equal(r.folded, 136);
  assert.match(r.text, /×137/);
  assert.equal(r.text.split('\n').length, 1);
});

test('foldRepeats leaves genuinely distinct lines alone', () => {
  const text = ['alpha.js', 'beta.js', 'gamma.js', 'delta.js'].join('\n');
  const r = foldRepeats(text);
  assert.equal(r.folded, 0);
  assert.equal(r.text, text);
});

test('foldRepeats preserves the order of first appearance', () => {
  const text = ['start', 'tick 1', 'tick 2', 'tick 3', 'end'].join('\n');
  const r = foldRepeats(text);
  const lines = r.text.split('\n');
  assert.equal(lines[0], 'start');
  assert.match(lines[1], /^tick 1\s+×3$/);
  assert.equal(lines[2], 'end');
});

// ── JSON skeleton ───────────────────────────────────────────────────────────

test('jsonSkeleton describes shape instead of dumping data', () => {
  const data = { ok: true, items: Array.from({ length: 1247 }, (_, i) => ({ id: i, name: 'n' + i })) };
  const sk = jsonSkeleton(JSON.stringify(data));
  assert.match(sk, /Array\(1247\)/);
  assert.match(sk, /"id": number/);
  assert.match(sk, /样本/);
  assert.ok(sk.length < JSON.stringify(data).length / 10);
});

test('jsonSkeleton keeps the odd one out — the whole point of sampling safely', () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ id: i, ok: true }));
  items[57] = { id: 57, ok: false, error: 'disk full' };
  const sk = jsonSkeleton(JSON.stringify({ items }));
  assert.match(sk, /结构异常/);
  assert.match(sk, /disk full/);
});

test('jsonSkeleton respects the depth cap and returns null on non-JSON', () => {
  const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
  const sk = jsonSkeleton(JSON.stringify(deep), { maxDepth: 3 });
  assert.match(sk, /keys\}/);
  assert.equal(jsonSkeleton('not json at all'), null);
});

// ── code outline ────────────────────────────────────────────────────────────

test('codeOutline keeps declarations and drops bodies', () => {
  const lines = [];
  for (let i = 0; i < 30; i++) {
    lines.push(`export function fn${i}(a, b) {`);
    for (let j = 0; j < 12; j++) lines.push(`  const tmp${j} = a + b + ${j};`);
    lines.push('}');
  }
  const src = lines.join('\n');
  const out = codeOutline(src);
  assert.match(out, /代码轮廓/);
  assert.match(out, /fn0/);
  assert.match(out, /省略 \d+ 行/);
  assert.ok(out.length < src.length / 3);
});

test('codeOutline pulls in context around the thing being searched for', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `  const filler${i} = ${i};`);
  lines[120] = '  const NEEDLE_VALUE = 42;';
  lines.unshift('export function big() {');
  const out = codeOutline(lines.join('\n'), { query: 'NEEDLE_VALUE' });
  assert.match(out, /NEEDLE_VALUE = 42/);
  assert.match(out, /filler119/); // ±context lines came along
});

test('codeOutline declines when outlining would not help', () => {
  // Almost every line is a declaration (a barrel / .d.ts) → nothing to gain.
  const src = Array.from({ length: 30 }, (_, i) => `export const a${i} = ${i};`).join('\n');
  assert.equal(codeOutline(src), null);
  // Nothing recognizable at all → also null, caller falls back to trimming.
  assert.equal(codeOutline('lorem\nipsum\ndolor'), null);
});

// ── line trimming ───────────────────────────────────────────────────────────

test('trimLines cuts on line boundaries and says how much it dropped', () => {
  const src = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  const out = trimLines(src, 800);
  assert.ok(out.length <= 900);
  assert.match(out, /中间 \d+ 行已省略/);
  assert.match(out, /^line 0 /);
  assert.match(out, /line 499/);
});

test('trimLines is a no-op below the limit', () => {
  assert.equal(trimLines('short', 100), 'short');
});

// ── budgets ─────────────────────────────────────────────────────────────────

test('compressBudget: aggressive bites earlier and squeezes harder', () => {
  const smart = compressBudget('smart', 2000);
  const agg = compressBudget('aggressive', 2000);
  assert.equal(smart.threshold, 2000);
  assert.ok(agg.threshold < smart.threshold);
  assert.ok(agg.target < smart.target);
  assert.ok(COMPRESS_MODES.includes('smart'));
});

// ── the orchestrator ────────────────────────────────────────────────────────

test('compressContent picks the method that matches the content', () => {
  const json = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ i, v: 'val' + i })) });
  assert.equal(compressContent(json, { target: 600 }).method.split('+')[0], 'json-skeleton');

  const log = Array.from({ length: 300 }, (_, i) => `INFO handled request ${i} in ${i}ms`).join('\n');
  assert.equal(compressContent(log, { name: 'run_command', target: 600 }).method.split('+')[0], 'log-fold');

  const listing = Array.from({ length: 300 }, (_, i) => `src/mod${i}.js`).join('\n');
  assert.equal(compressContent(listing, { name: 'find_files', target: 600 }).method, 'line-trim');
});

test('compressContent reports honest savings', () => {
  const log = Array.from({ length: 200 }, () => 'WARN same thing happened again').join('\n');
  const r = compressContent(log, { name: 'run_command', target: 500 });
  assert.ok(r.saved > 0);
  assert.ok(r.savedTokens > 0);
  assert.equal(r.before, log.length);
  assert.equal(r.after, r.text.length);
  assert.equal(r.before - r.after, r.saved);
});

test('compressContent gives up rather than inflate', () => {
  const tiny = 'ok';
  const r = compressContent(tiny, { target: 10 });
  assert.equal(r.saved, 0);
  assert.equal(r.method, 'none');
  assert.equal(r.text, tiny);
});

test('retrieveHint carries the handle and tells the model not to re-run the tool', () => {
  const h = retrieveHint('ctx-1-abcd', { kind: 'json', method: 'json-skeleton', before: 9000, after: 300, savedTokens: 2400 });
  assert.match(h, /ctx-1-abcd/);
  assert.match(h, /context_retrieve/);
  assert.match(h, /不要因为看不到细节就重跑/);
});

// ── the store ───────────────────────────────────────────────────────────────

test('ContextStore round-trips the original verbatim', () => {
  const store = new ContextStore();
  const original = 'line A\nline B\nline C';
  const h = store.put(original, { tool: 'read_file' });
  const r = store.slice(h, { limit: 1000 });
  assert.equal(r.ok, true);
  assert.ok(r.content.includes(original));
});

test('ContextStore paginates and points at the next offset', () => {
  const store = new ContextStore();
  const h = store.put('x'.repeat(5000));
  const first = store.slice(h, { limit: 1000 });
  assert.match(first.content, /0-1000 \/ 5000/);
  assert.match(first.content, /offset=1000/);
  const last = store.slice(h, { offset: 4500, limit: 1000 });
  assert.match(last.content, /已到原文末尾/);
});

test('ContextStore greps — the cheap way back in', () => {
  const store = new ContextStore();
  const lines = Array.from({ length: 500 }, (_, i) => `row ${i}`);
  lines[321] = 'row 321 ERROR disk full';
  const h = store.put(lines.join('\n'));
  const r = store.slice(h, { pattern: 'ERROR' });
  assert.equal(r.ok, true);
  assert.equal(r.hits, 1);
  assert.match(r.content, /disk full/);
  assert.match(r.content, /322\|/); // 1-based line number
  assert.ok(r.content.length < 500);
});

test('ContextStore reports a clean miss instead of pretending', () => {
  const store = new ContextStore();
  const h = store.put('alpha\nbeta');
  const r = store.slice(h, { pattern: 'gamma' });
  assert.equal(r.ok, true);
  assert.equal(r.hits, 0);
  assert.match(r.content, /没有匹配/);
  const bad = store.slice(h, { pattern: '([' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /合法正则/);
});

test('ContextStore expires and evicts, and says so on retrieval', () => {
  const store = new ContextStore({ ttlMs: 60000, maxEntries: 2 });
  const h = store.put('one');
  store.put('two');
  store.put('three'); // pushes the oldest out
  assert.equal(store.map.size, 2);
  const gone = store.slice(h, {});
  assert.equal(gone.ok, false);
  assert.match(gone.error, /不存在或已过期/);

  const st2 = new ContextStore({ ttlMs: 10000 });
  const h2 = st2.put('later');
  assert.equal(st2.sweep(Date.now() + 20000), 1);
  assert.equal(st2.get(h2), null);
});

test('ContextStore keeps its byte accounting straight', () => {
  const store = new ContextStore();
  const h = store.put('12345');
  assert.equal(store.stats().bytes, 5);
  store.drop(h);
  assert.equal(store.stats().bytes, 0);
  assert.equal(store.stats().entries, 0);
});

// ── config ──────────────────────────────────────────────────────────────────

test('config: smart compression is the default and inputs are clamped', () => {
  const d = normalizeConfig({});
  assert.equal(d.contextCompress, 'smart');
  assert.equal(d.compressThreshold, 2000);
  assert.equal(d.retrieveTtlMs, 1800000);
  assert.equal(normalizeConfig({ contextCompress: 'nonsense' }).contextCompress, 'smart');
  assert.equal(normalizeConfig({ contextCompress: 'off' }).contextCompress, 'off');
  assert.equal(normalizeConfig({ compressThreshold: 1 }).compressThreshold, 400);
  assert.equal(normalizeConfig({ compressThreshold: 9e9 }).compressThreshold, 200000);
  assert.equal(normalizeConfig({ retrieveTtlMs: 5 }).retrieveTtlMs, 60000);
});

// ── the context_retrieve tool ───────────────────────────────────────────────

test('context_retrieve reads back through the tool interface', async () => {
  const store = new ContextStore();
  const h = store.put('alpha\nbeta ERROR here\ngamma');
  const r = await executeTool('context_retrieve', { handle: h, pattern: 'ERROR' }, { contextStore: store });
  assert.equal(r.ok, true);
  assert.match(r.content, /beta ERROR here/);
});

test('context_retrieve fails legibly with a bad or missing handle', async () => {
  const store = new ContextStore();
  const noHandle = await executeTool('context_retrieve', {}, { contextStore: store });
  assert.equal(noHandle.ok, false);
  assert.equal(noHandle.errorClass, 'SCHEMA_ERROR');

  const stale = await executeTool('context_retrieve', { handle: 'ctx-nope' }, { contextStore: store });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /不存在或已过期/);

  const noStore = await executeTool('context_retrieve', { handle: 'ctx-1' }, {});
  assert.equal(noStore.ok, false);
  assert.match(noStore.error, /未启用/);
});

// ── the agent loop ──────────────────────────────────────────────────────────

function loopHarness({ toolOutput, config = {}, store, tool = 'run_command', args = {} }) {
  const messages = [{ role: 'user', content: 'go' }];
  const events = [];
  let calls = 0;
  const callModel = async () => {
    calls++;
    if (calls >= 2) return { content: 'done' };
    return { content: '', toolCalls: [{ id: 't1', name: tool, args }] };
  };
  const executeToolStub = async () => ({ ok: true, content: toolOutput });
  return {
    messages,
    events,
    run: () => runAgent({
      messages,
      callModel,
      executeTool: executeToolStub,
      onEvent: (t, p) => events.push([t, p]),
      config: { maxTurns: 3, ...config },
      toolContext: store ? { contextStore: store } : {}
    })
  };
}

const BIG_LOG = Array.from({ length: 400 }, (_, i) => `INFO worker handled job ${i} in ${i}ms`).join('\n');

test('agent loop: a huge tool result is shrunk on the way in and stays retrievable', async () => {
  const store = new ContextStore();
  const h = loopHarness({ toolOutput: BIG_LOG, store });
  const out = await h.run();

  const toolMsg = h.messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg.content.length < BIG_LOG.length / 4, 'should be much smaller');
  assert.match(toolMsg.content, /×400/);
  assert.match(toolMsg.content, /context_retrieve/);

  const [, ev] = h.events.find(([t]) => t === 'shrink');
  assert.equal(ev.tool, 'run_command');
  assert.ok(ev.savedTokens > 0);
  assert.equal(ev.method, 'log-fold');
  assert.equal(out.shrink.count, 1);
  assert.equal(out.shrink.savedTokens, ev.savedTokens);

  // The invariant: nothing was actually lost.
  const back = store.slice(ev.handle, { limit: 100000 });
  assert.ok(back.content.includes('job 399'));
});

test('agent loop: no store means no compression — never lossy by accident', async () => {
  const h = loopHarness({ toolOutput: BIG_LOG }); // no store injected
  const out = await h.run();
  assert.equal(h.messages.find((m) => m.role === 'tool').content, BIG_LOG);
  assert.equal(h.events.filter(([t]) => t === 'shrink').length, 0);
  assert.equal(out.shrink.count, 0);
});

test('agent loop: contextCompress=off is honoured', async () => {
  const h = loopHarness({ toolOutput: BIG_LOG, store: new ContextStore(), config: { contextCompress: 'off' } });
  await h.run();
  assert.equal(h.messages.find((m) => m.role === 'tool').content, BIG_LOG);
  assert.equal(h.events.filter(([t]) => t === 'shrink').length, 0);
});

test('agent loop: results under the threshold are untouched', async () => {
  const small = 'all good';
  const h = loopHarness({ toolOutput: small, store: new ContextStore() });
  await h.run();
  assert.equal(h.messages.find((m) => m.role === 'tool').content, small);
  assert.equal(h.events.filter(([t]) => t === 'shrink').length, 0);
});

test('agent loop: aggressive mode compresses what smart mode leaves alone', async () => {
  const mid = Array.from({ length: 40 }, (_, i) => `INFO tick ${i} of the loop here`).join('\n');
  assert.ok(mid.length > 1000 && mid.length < 2000, 'fixture must sit between the two thresholds');

  const smart = loopHarness({ toolOutput: mid, store: new ContextStore() });
  await smart.run();
  assert.equal(smart.events.filter(([t]) => t === 'shrink').length, 0);

  const agg = loopHarness({ toolOutput: mid, store: new ContextStore(), config: { contextCompress: 'aggressive' } });
  await agg.run();
  assert.equal(agg.events.filter(([t]) => t === 'shrink').length, 1);
});

test('agent loop: context_retrieve output is never itself compressed', async () => {
  const h = loopHarness({ toolOutput: BIG_LOG, store: new ContextStore(), tool: 'context_retrieve' });
  await h.run();
  assert.equal(h.messages.find((m) => m.role === 'tool').content, BIG_LOG);
  assert.equal(h.events.filter(([t]) => t === 'shrink').length, 0);
});

test('agent loop: a failed tool keeps its error text intact', async () => {
  const store = new ContextStore();
  const messages = [{ role: 'user', content: 'go' }];
  const events = [];
  let calls = 0;
  await runAgent({
    messages,
    callModel: async () => (++calls >= 2 ? { content: 'done' } : { content: '', toolCalls: [{ id: 't1', name: 'run_command', args: {} }] }),
    executeTool: async () => ({ ok: false, error: BIG_LOG, errorClass: 'TRANSIENT' }),
    onEvent: (t, p) => events.push([t, p]),
    config: { maxTurns: 3 },
    toolContext: { contextStore: store }
  });
  assert.ok(messages.find((m) => m.role === 'tool').content.includes('job 399'));
  assert.equal(events.filter(([t]) => t === 'shrink').length, 0);
});

test('agent loop: the code outliner is aimed by the search query', async () => {
  const lines = Array.from({ length: 300 }, (_, i) => `  const filler${i} = ${i};`);
  lines[200] = '  const SECRET_FLAG = true;';
  lines.unshift('export function huge() {');
  const store = new ContextStore();
  const h = loopHarness({
    toolOutput: lines.join('\n'),
    store,
    tool: 'read_file',
    args: { path: 'src/huge.js', query: 'SECRET_FLAG' }
  });
  await h.run();
  const toolMsg = h.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /SECRET_FLAG/);
  assert.match(toolMsg.content, /代码轮廓/);
});
