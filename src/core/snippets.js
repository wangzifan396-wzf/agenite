// Local-first reusable prompt snippets (the "指令库"). Persisted to
// localStorage; falls back to an in-memory store when storage is unavailable
// (e.g. during tests). Pure logic so it can be unit-tested without the DOM.
const KEY = 'agenite.snippets.v1';

function _store() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* ignore */ }
  return null;
}

let _mem = null; // fallback store when localStorage is unavailable

function _read() {
  const s = _store();
  if (s) {
    try { return JSON.parse(s.getItem(KEY) || '[]'); } catch { return []; }
  }
  return _mem || [];
}

function _write(arr) {
  const s = _store();
  if (s) { try { s.setItem(KEY, JSON.stringify(arr)); } catch { /* ignore */ } }
  else _mem = arr;
}

export function listSnippets() {
  return _read().slice();
}

export function addSnippet(name, body) {
  name = String(name || '').trim();
  body = String(body || '').trim();
  if (!name || !body) return { ok: false, error: '名称和正文都不能为空' };
  const arr = _read();
  const id = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  arr.push({ id, name, body, created: Date.now() });
  _write(arr);
  return { ok: true, id };
}

export function removeSnippet(id) {
  const arr = _read().filter((s) => s.id !== id);
  _write(arr);
  return { ok: true };
}

export function getSnippet(id) {
  return _read().find((s) => s.id === id) || null;
}

// Merge a snippet body into an existing textarea value, inserting at the end
// with a sensible separator so it can be appended to an in-progress prompt.
export function insertSnippetInto(text, body) {
  text = String(text || '');
  body = String(body || '').trim();
  if (!body) return text;
  if (!text.trim()) return body;
  const sep = /\s$/.test(text) ? '' : '\n';
  return text + sep + body;
}
