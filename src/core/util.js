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
