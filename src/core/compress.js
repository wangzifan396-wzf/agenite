// Context economy: content-aware, *reversible* tool-output compression.
//
// Why this exists: `context.js` already keeps a run from dying of "context
// length exceeded" — but it does so late and bluntly. It waits until the whole
// history busts the budget, then chops old tool results in half and throws the
// oldest turns away. By then you have already paid for every one of those
// tokens, on every turn since they were produced.
//
// This module attacks the other end of the pipe: the moment a tool returns
// something big, shrink it *before* it ever enters the history. Two rules make
// that safe enough to leave on by default:
//
//   1. Content-aware, not character-aware. A 4000-line JSON blob becomes its
//      schema plus samples plus anomalies; 900 lines of npm output become
//      ~30 lines with `×137` fold markers; a 2000-line source file becomes its
//      signatures plus the lines you actually searched for. Blind head/tail
//      truncation throws away the middle, which is usually where the answer is.
//
//   2. Reversible. The original is kept verbatim in a TTL store and the
//      compressed text carries a handle. If the model needs the part we cut,
//      it calls `context_retrieve` and gets it back — optionally grepped. This
//      is the difference between compression and data loss, and it is why the
//      agent loop refuses to compress at all when no store is available.
//
// Pure-ish: no fs, no network, no DOM. Only `estimateTokens`/`trimText` are
// borrowed from context.js so savings are measured on the same ruler the
// budgeting code uses.

import { estimateTokens, trimText } from './context.js';

export { COMPRESS_MODES } from './config.js';

// ---------------------------------------------------------------------------
// kind detection
// ---------------------------------------------------------------------------

// Extensions we can outline structurally. Everything else falls back to
// line-wise trimming, which is lossy but never wrong.
const CODE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'kt', 'c',
  'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'scala', 'sh', 'bash'
]);

// The tool that produced the text is a far stronger signal than sniffing it.
// `run_command` output is log-shaped even when it has no timestamps; a
// `grep_files` result is a listing even though every line looks like code.
const TOOL_KIND = {
  run_command: 'log',
  run_code: 'log',
  grep_files: 'listing',
  find_files: 'listing',
  list_dir: 'listing',
  codebase_search: 'listing',
  web_search: 'listing',
  web_fetch: 'text'
};

export function detectKind(text, name = '', path = '') {
  const s = String(text == null ? '' : text);
  const t = s.trim();
  if (!t) return 'text';

  // JSON wins over any hint: a tool that *usually* returns logs can still
  // return a JSON error envelope, and the skeleton view is strictly better.
  if ((t[0] === '{' || t[0] === '[') && t.length > 40 && isJson(t)) return 'json';

  const hinted = TOOL_KIND[name];
  if (hinted) return hinted;

  const ext = extOf(path);
  if (ext === 'json') return isJson(t) ? 'json' : 'text';
  if (CODE_EXT.has(ext)) return 'code';
  if (ext) return 'text';

  // No hint at all — sniff. Order matters: log detection is cheap and its
  // false positives (a file of timestamps) are harmless, code detection is
  // the expensive guess so it goes last.
  const lines = t.split('\n');
  if (lines.length >= 12 && logRatio(lines) >= 0.4) return 'log';
  if (lines.length >= 8 && codeRatio(lines) >= 0.15) return 'code';
  return 'text';
}

function isJson(t) {
  try { JSON.parse(t); return true; } catch { return false; }
}

function extOf(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p || '').trim());
  return m ? m[1].toLowerCase() : '';
}

const LOG_LINE = /^(?:\s*[\[(]?\d{4}-\d{2}-\d{2}|\s*\d{2}:\d{2}:\d{2}|\s*[\[(]?(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL|NOTICE)\b)/i;

function logRatio(lines) {
  let hit = 0;
  let seen = 0;
  for (const ln of lines) {
    if (!ln.trim()) continue;
    seen++;
    if (LOG_LINE.test(ln)) hit++;
  }
  return seen ? hit / seen : 0;
}

const CODE_LINE = /^\s*(?:export\s+|public\s+|private\s+|protected\s+|async\s+)*(?:function|class|def|const|let|var|import|from|interface|type|enum|struct|impl|fn|package|func)\b/;

function codeRatio(lines) {
  let hit = 0;
  let seen = 0;
  for (const ln of lines) {
    if (!ln.trim()) continue;
    seen++;
    if (CODE_LINE.test(ln)) hit++;
  }
  return seen ? hit / seen : 0;
}

// ---------------------------------------------------------------------------
// log folding
// ---------------------------------------------------------------------------

// Turn a line into a template by masking the parts that vary between otherwise
// identical events. We mask *values* (timestamps, ids, numbers, hashes) but
// never words or paths — otherwise a directory listing, where every line is a
// different filename, would collapse into one line and lose everything.
const SIG_RULES = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  [/\b\d{4}-\d{2}-\d{2}\b/g, '<date>'],
  [/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>'],
  [/\b0x[0-9a-f]+\b/gi, '<hex>'],
  [/\b[0-9a-f]{32,}\b/gi, '<hash>'],
  // A value *followed by a unit* (12ms, 4310ms, 100px) is still a value and must
  // be masked, or two log lines that differ only in their timing would never
  // fold. The leading \b (not a trailing one) is what keeps words like `item12`
  // or paths like `v2`/`build3` intact — the digit there has no word boundary
  // in front of it, so it is not a standalone value at all.
  [/\b\d+(?:\.\d+)?\w*/g, '<n>']
];

export function lineSignature(line) {
  let s = String(line == null ? '' : line);
  for (const [re, rep] of SIG_RULES) s = s.replace(re, rep);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Collapse repeated log lines, keeping the first occurrence in place and
 * annotating it with the repeat count. Order of first appearance is preserved,
 * which is what makes the folded log still readable as a narrative.
 */
export function foldRepeats(text, { minRepeat = 2 } = {}) {
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  const seen = new Map();
  let folded = 0;
  for (const ln of lines) {
    const sig = lineSignature(ln);
    if (!sig) { out.push(ln); continue; }
    const hit = seen.get(sig);
    if (hit) { hit.count++; folded++; continue; }
    seen.set(sig, { pos: out.length, count: 1 });
    out.push(ln);
  }
  if (!folded) return { text: String(text == null ? '' : text), folded: 0 };
  for (const info of seen.values()) {
    if (info.count >= minRepeat) out[info.pos] = out[info.pos] + `   ×${info.count}`;
  }
  return { text: out.join('\n'), folded };
}

// ---------------------------------------------------------------------------
// JSON skeleton
// ---------------------------------------------------------------------------

// Which keys an object has, as a stable fingerprint. Used to spot the three
// error entries hiding inside a thousand successful ones — losing those to
// "sampled the first 2 items" would be the worst kind of silent failure.
function keySig(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return typeof v;
  return Object.keys(v).sort().join(',');
}

function scalar(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'string') return v.length <= 32 ? JSON.stringify(v) : `string(${v.length})`;
  // Numbers and booleans are summarised by TYPE in the skeleton — their actual
  // value is not part of the shape, and the samples/anomalies below already
  // carry real values where it matters. Showing `0` instead of `number` would
  // make the skeleton read like a data dump and mislead the model about the
  // field's nature.
  if (t === 'number' || t === 'boolean') return t;
  return t;
}

function shape(v, depth, ctx, path) {
  if (v === null || typeof v !== 'object') return scalar(v);

  if (Array.isArray(v)) {
    if (!v.length) return 'Array(0)';
    if (depth >= ctx.maxDepth) return `Array(${v.length})`;
    // Majority key-set defines "normal"; everything else is an anomaly.
    const counts = new Map();
    for (const it of v) {
      const k = keySig(it);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let major = null;
    let best = -1;
    for (const [k, n] of counts) if (n > best) { best = n; major = k; }
    if (counts.size > 1) {
      for (let i = 0; i < v.length && ctx.anomalies.length < ctx.maxAnomalies; i++) {
        if (keySig(v[i]) === major) continue;
        ctx.anomalies.push(`${path}[${i}] → ${oneLine(JSON.stringify(v[i]), 160)}`);
      }
    }
    const rep = v.find((it) => keySig(it) === major);
    return `Array(${v.length}) of ${shape(rep, depth + 1, ctx, path + '[]')}`;
  }

  const keys = Object.keys(v);
  if (depth >= ctx.maxDepth) return `{…${keys.length} keys}`;
  const shown = keys.slice(0, ctx.maxKeys);
  const body = shown.map((k) => `${JSON.stringify(k)}: ${shape(v[k], depth + 1, ctx, path ? path + '.' + k : k)}`);
  if (keys.length > shown.length) body.push(`…+${keys.length - shown.length} keys`);
  return `{ ${body.join(', ')} }`;
}

function oneLine(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * Structure-preserving view of a JSON payload: the schema, a couple of real
 * samples, and any element whose shape differs from its siblings.
 * Returns null when the text is not JSON.
 */
export function jsonSkeleton(text, opts = {}) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const ctx = {
    maxDepth: Math.max(1, opts.maxDepth || 4),
    maxKeys: Math.max(1, opts.maxKeys || 24),
    maxAnomalies: Math.max(0, opts.maxAnomalies == null ? 3 : opts.maxAnomalies),
    anomalies: []
  };
  const skeleton = shape(data, 0, ctx, '');
  const parts = ['【JSON 结构骨架】', skeleton];

  const sampleCount = Math.max(0, opts.sampleItems == null ? 2 : opts.sampleItems);
  const arr = Array.isArray(data) ? data : firstBigArray(data);
  if (sampleCount && arr && arr.length) {
    const s = arr.slice(0, sampleCount).map((x) => oneLine(JSON.stringify(x), 200));
    parts.push(`样本（前 ${s.length}/${arr.length} 条）: ${s.join(' , ')}`);
  }
  if (ctx.anomalies.length) {
    parts.push('⚠ 结构异常元素（与多数元素字段不同，已保留原文）:\n  ' + ctx.anomalies.join('\n  '));
  }
  return parts.join('\n');
}

function firstBigArray(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v) && v.length) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// code outline
// ---------------------------------------------------------------------------

const SIGNATURE_LINE = /^\s*(?:@|#\[|\/\/\/)|^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+|async\s+)*(?:function|class|interface|type|enum|struct|impl|trait|def|fn|func|package|module|const\s+\w+\s*=\s*(?:async\s*)?\(|let\s+\w+\s*=\s*(?:async\s*)?\()/;

/**
 * Keep the parts of a source file that answer "what is in here" and "where is
 * the thing I asked about": declaration lines, plus a window around every line
 * matching `query`. Everything between is replaced by a gap marker so the model
 * can see that something was elided (and retrieve it if it matters).
 */
export function codeOutline(text, { query = '', context = 3, maxLines = 200 } = {}) {
  const lines = String(text == null ? '' : text).split('\n');
  const keep = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (SIGNATURE_LINE.test(lines[i])) keep.add(i);
  }
  const q = String(query || '').trim();
  if (q) {
    const needle = q.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().indexOf(needle) < 0) continue;
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j);
    }
  }
  if (!keep.size) return null;
  // A file that is almost all signatures (a .d.ts, a barrel file) gains
  // nothing from outlining — say so and let the caller trim instead.
  if (keep.size > maxLines || keep.size > lines.length * 0.8) return null;

  const idx = [...keep].sort((a, b) => a - b);
  const out = [];
  let prev = -1;
  for (const i of idx) {
    if (prev >= 0 && i > prev + 1) out.push(`… 省略 ${i - prev - 1} 行 …`);
    out.push(`${String(i + 1).padStart(4)}| ${lines[i]}`);
    prev = i;
  }
  if (prev < lines.length - 1) out.push(`… 省略 ${lines.length - 1 - prev} 行 …`);
  return `【代码轮廓：${lines.length} 行 → 保留 ${idx.length} 行（声明${q ? ' + 命中 "' + oneLine(q, 40) + '" 的上下文' : ''}）】\n` + out.join('\n');
}

// ---------------------------------------------------------------------------
// line-wise trimming
// ---------------------------------------------------------------------------

// Cut on line boundaries rather than mid-token: a half-truncated JSON line or
// stack frame reads like corruption and invites the model to "fix" it.
export function trimLines(text, maxChars) {
  const s = String(text == null ? '' : text);
  if (s.length <= maxChars) return s;
  const lines = s.split('\n');
  if (lines.length < 4) return trimText(s, maxChars);
  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = Math.max(0, maxChars - headBudget - 60);
  const head = [];
  let used = 0;
  let i = 0;
  for (; i < lines.length && used + lines[i].length + 1 <= headBudget; i++) {
    head.push(lines[i]);
    used += lines[i].length + 1;
  }
  const tail = [];
  used = 0;
  let j = lines.length - 1;
  for (; j > i && used + lines[j].length + 1 <= tailBudget; j--) {
    tail.unshift(lines[j]);
    used += lines[j].length + 1;
  }
  const omitted = j - i + 1;
  if (omitted <= 0) return s;
  return head.concat([`… 中间 ${omitted} 行已省略以节省上下文 …`], tail).join('\n');
}

// ---------------------------------------------------------------------------
// mode budgets
// ---------------------------------------------------------------------------

/**
 * How hard to squeeze. `threshold` is the size at which compression kicks in,
 * `target` is roughly what we aim to end up with. `smart` is tuned to be
 * invisible on normal output and only bite on genuinely huge results;
 * `aggressive` is for small context windows where every token hurts.
 */
export function compressBudget(mode = 'smart', threshold = 2000) {
  const th = Math.max(400, Number(threshold) || 2000);
  if (mode === 'aggressive') return { threshold: Math.max(400, Math.floor(th / 2)), target: 700 };
  return { threshold: th, target: Math.max(900, Math.floor(th * 0.6)) };
}

// ---------------------------------------------------------------------------
// the orchestrator
// ---------------------------------------------------------------------------

/**
 * Compress one tool result according to its detected kind.
 *
 * @returns {{text, kind, method, before, after, saved, savedTokens}}
 *          `saved` is characters, `savedTokens` uses the same estimator the
 *          budgeting code uses so the number shown in the UI is comparable.
 */
export function compressContent(text, opts = {}) {
  const raw = String(text == null ? '' : text);
  const target = Math.max(200, Number(opts.target) || 1200);
  const kind = opts.kind || detectKind(raw, opts.name || '', opts.path || '');
  const before = raw.length;
  let out = null;
  let method = 'none';

  if (kind === 'json') {
    const sk = jsonSkeleton(raw, { sampleItems: opts.sampleItems });
    if (sk && sk.length < before) { out = sk; method = 'json-skeleton'; }
  } else if (kind === 'log') {
    const f = foldRepeats(raw);
    if (f.folded > 0 && f.text.length < before) { out = f.text; method = 'log-fold'; }
  } else if (kind === 'code') {
    const co = codeOutline(raw, { query: opts.query });
    if (co && co.length < before) { out = co; method = 'code-outline'; }
  }

  // Whatever the structural pass produced, it still has to fit. A folded log
  // of 5000 distinct lines is folded but not small.
  let final = out == null ? raw : out;
  if (final.length > target) {
    final = trimLines(final, target);
    method = method === 'none' ? 'line-trim' : method + '+trim';
  }
  if (final.length >= before) {
    return { text: raw, kind, method: 'none', before, after: before, saved: 0, savedTokens: 0 };
  }
  return {
    text: final,
    kind,
    method,
    before,
    after: final.length,
    saved: before - final.length,
    savedTokens: Math.max(0, estimateTokens(raw) - estimateTokens(final))
  };
}

/** The footer that makes compression reversible instead of lossy. */
export function retrieveHint(handle, info = {}) {
  const k = info.kind ? `${info.kind}/${info.method}` : 'compressed';
  const save = info.savedTokens ? `，省约 ${info.savedTokens} tokens` : '';
  return (
    `\n\n[⧉ 此结果已压缩 ${info.before}→${info.after} 字符（${k}）${save}。` +
    `原文完整保留，需要被省略的部分时调用 context_retrieve(handle="${handle}")，` +
    `可加 pattern 只取匹配行、或 offset/limit 分页。不要因为看不到细节就重跑刚才的工具。]`
  );
}

// ---------------------------------------------------------------------------
// the reversible store
// ---------------------------------------------------------------------------

/**
 * A bounded TTL store for pre-compression originals.
 *
 * Bounded three ways on purpose — entries, bytes and age. A long agent run
 * against a big repo can otherwise pin hundreds of megabytes of file contents
 * in a Node process that is expected to sit idle in the background all day.
 * Eviction is oldest-first, and eviction of a handle simply means retrieval
 * fails with a clear message rather than returning wrong data.
 */
export class ContextStore {
  constructor({ ttlMs = 1800000, maxEntries = 200, maxBytes = 8 * 1024 * 1024 } = {}) {
    this.ttlMs = Math.max(10000, Number(ttlMs) || 1800000);
    this.maxEntries = Math.max(1, Number(maxEntries) || 200);
    this.maxBytes = Math.max(64 * 1024, Number(maxBytes) || 8 * 1024 * 1024);
    this.map = new Map();
    this.bytes = 0;
    this.seq = 0;
  }

  put(text, meta = {}) {
    const content = String(text == null ? '' : text);
    const handle = `ctx-${(++this.seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.map.set(handle, { handle, content, meta, at: Date.now(), hits: 0 });
    this.bytes += content.length;
    this.evict();
    return handle;
  }

  get(handle, now = Date.now()) {
    const e = this.map.get(String(handle || '').trim());
    if (!e) return null;
    if (now - e.at > this.ttlMs) { this.drop(e.handle); return null; }
    e.hits++;
    return e;
  }

  drop(handle) {
    const e = this.map.get(handle);
    if (!e) return false;
    this.bytes -= e.content.length;
    this.map.delete(handle);
    return true;
  }

  sweep(now = Date.now()) {
    let n = 0;
    for (const e of [...this.map.values()]) {
      if (now - e.at > this.ttlMs) { this.drop(e.handle); n++; }
    }
    return n;
  }

  evict() {
    // Map iterates in insertion order, so the first key is always the oldest.
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.drop(first.value);
    }
  }

  stats() {
    return { entries: this.map.size, bytes: this.bytes, ttlMs: this.ttlMs };
  }

  /**
   * Read back part of an original. `pattern` turns this into a grep over the
   * stored text, which is the cheap path: the model usually wants three lines
   * out of four thousand, not the whole thing back in its window.
   */
  slice(handle, { offset = 0, limit = 4000, pattern = '', context = 2 } = {}, now = Date.now()) {
    const e = this.get(handle, now);
    if (!e) {
      return {
        ok: false,
        error: `句柄 ${handle} 不存在或已过期（原文缓存有 TTL 与容量上限）。请重新调用原工具获取内容。`
      };
    }
    const total = e.content.length;
    const pat = String(pattern || '').trim();
    if (pat) {
      let re;
      try { re = new RegExp(pat, 'i'); } catch { return { ok: false, error: `pattern 不是合法正则：${pat}` }; }
      const lines = e.content.split('\n');
      const keep = new Set();
      let hits = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        hits++;
        for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j);
      }
      if (!hits) {
        return { ok: true, content: `（原文 ${lines.length} 行中没有匹配 /${pat}/i 的行）`, hits: 0, total };
      }
      const idx = [...keep].sort((a, b) => a - b);
      const out = [];
      let prev = -1;
      for (const i of idx) {
        if (prev >= 0 && i > prev + 1) out.push(`… ${i - prev - 1} 行 …`);
        out.push(`${String(i + 1).padStart(5)}| ${lines[i]}`);
        prev = i;
      }
      let body = out.join('\n');
      if (body.length > limit) body = trimLines(body, limit);
      return { ok: true, content: `【原文中匹配 /${pat}/i 的 ${hits} 处】\n${body}`, hits, total };
    }
    const start = Math.max(0, Math.min(total, Math.floor(Number(offset) || 0)));
    const len = Math.max(1, Math.min(200000, Math.floor(Number(limit) || 4000)));
    const chunk = e.content.slice(start, start + len);
    const end = start + chunk.length;
    const nav = end < total
      ? `\n\n[还有 ${total - end} 字符未显示，继续调用 context_retrieve(handle="${e.handle}", offset=${end})]`
      : '\n\n[已到原文末尾]';
    return { ok: true, content: `【原文 ${start}-${end} / ${total} 字符】\n${chunk}${nav}`, total };
  }
}
