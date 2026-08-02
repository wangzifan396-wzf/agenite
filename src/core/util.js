// Pure helpers shared by browser UI and Node tests. No DOM access here.

export function uid(prefix = 'id') {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return `${prefix}_${c.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function now() {
  return Date.now();
}

export function debounce(fn, ms = 200) {
  let t = null;
  return function debounced(...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

// Safe structured clone that won't choke on undefined / functions.
export function clone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  return JSON.parse(JSON.stringify(obj));
}

export function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// Neutralize dangerous URL schemes (XSS guard for rendered links).
export function sanitizeUrl(url) {
  const u = String(url || '').trim();
  const lower = u.toLowerCase();
  if (/^\s*(javascript|data|vbscript):/i.test(lower)) return '#';
  if (lower.startsWith('//')) return '#';
  return u;
}

// ---------- fuzzy matching (used by the "@" file picker and "/" commands) ----------

// Subsequence match with a quality score. Returns null when `query` does not
// fuzzy-match `text` at all, otherwise { score, hits } where `hits` are the
// matched character indices so the UI can bold them.
// Higher score = better. Consecutive runs, word-boundary starts and matches
// inside the basename (after the last slash) are all rewarded.
export function fuzzyMatch(text, query) {
  const str = String(text == null ? '' : text);
  const q = String(query == null ? '' : query).trim();
  if (!q) return { score: 0, hits: [] };

  const lowStr = str.toLowerCase();
  const lowQ = q.toLowerCase();
  const baseStart = lowStr.lastIndexOf('/') + 1;

  const hits = [];
  let score = 0;
  let run = 0;
  let si = 0;

  for (let qi = 0; qi < lowQ.length; qi++) {
    const ch = lowQ[qi];
    const found = lowStr.indexOf(ch, si);
    if (found === -1) return null;
    hits.push(found);

    // consecutive characters are much stronger evidence than scattered ones
    run = found === si && qi > 0 ? run + 1 : 0;
    score += 1 + run * 4;

    // reward matches in the file name rather than deep in the directory path
    if (found >= baseStart) score += 3;
    // reward word-boundary starts: begin of string, or after / - _ . space
    const prev = found > 0 ? lowStr[found - 1] : '';
    if (found === 0 || prev === '/' || prev === '-' || prev === '_' || prev === '.' || prev === ' ') score += 5;

    si = found + 1;
  }

  // prefer shorter candidates when scores are otherwise close
  score -= Math.min(str.length / 12, 8);
  // exact substring is the strongest signal of all
  if (lowStr.includes(lowQ)) score += 12;
  if (lowStr.slice(baseStart).startsWith(lowQ)) score += 10;

  return { score, hits };
}

// Rank a list of candidates against a query. `key` extracts the string to match.
export function fuzzyFilter(items, query, { key = (x) => x, limit = 30 } = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return items.slice(0, limit).map((item) => ({ item, score: 0, hits: [] }));
  const scored = [];
  for (const item of items) {
    const m = fuzzyMatch(key(item), q);
    if (m) scored.push({ item, score: m.score, hits: m.hits });
  }
  scored.sort((a, b) => b.score - a.score || String(key(a.item)).length - String(key(b.item)).length);
  return scored.slice(0, limit);
}

// Human-readable byte size, e.g. 2048 -> "2 KB".
export function formatBytes(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) return '';
  if (num < 1024) return num + ' B';
  if (num < 1024 * 1024) return (num / 1024).toFixed(num < 10240 ? 1 : 0) + ' KB';
  return (num / 1024 / 1024).toFixed(1) + ' MB';
}
