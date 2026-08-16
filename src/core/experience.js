// Verified Experience Memory (v0.60)
//
// Hermes-style "the agent that grows with you", but structurally incapable of
// the 2026 consensus failure mode (memory that silently remembers its own
// mistakes). Experiences are ONLY written for goals that pass BOTH the v0.58
// verification gate AND the v0.59 outcome gate. Recall is a cheap token-overlap
// search over a local JSONL file; writes are atomic appends.
//
// Every I/O path takes an injectable `deps` so goals.test.js can run the whole
// lifecycle with an in-memory fs — no real disk, no network.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Default location of the experience pool, relative to the workspace.
export function defaultExperienceDir() {
  return 'memory/experiences';
}

// Resolve the absolute directory where experiences.jsonl lives.
export function resolveExperienceDir(config, workspace) {
  const rel = config && config.experienceDir ? config.experienceDir : defaultExperienceDir();
  if (path.isAbsolute(rel)) return rel;
  return path.join(workspace || process.cwd(), rel);
}

// Lightweight, dependency-free tokenizer: latin/number runs + CJK bigrams.
// Bigrams let us catch phrase similarity in Chinese without a dictionary.
function tokenize(text) {
  if (!text) return [];
  const s = String(text).toLowerCase();
  const out = [];
  const latin = s.match(/[a-z0-9_]+/g) || [];
  for (const w of latin) out.push(w);
  const cjk = s.match(/[一-鿿]+/g) || [];
  for (const seg of cjk) {
    if (seg.length <= 2) out.push(seg);
    else for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}

// Cosine-ish overlap in [0,1]: count shared unique tokens over sqrt(|a|*|b|).
function overlap(aTok, bTok) {
  if (!aTok.length || !bTok.length) return 0;
  const setB = new Set(bTok);
  const seen = new Set();
  let hit = 0;
  for (const t of aTok) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (setB.has(t)) hit++;
  }
  return hit / Math.sqrt(aTok.length * bTok.length);
}

// Recall up to k past verified experiences relevant to `goal`.
// Returns { entries: [...], used: [ids] }. Never throws.
export function retrieveExperiences({ dir, goal, k = 3, deps } = {}) {
  const f = (deps && deps.fs) || fs;
  const p = (deps && deps.path) || path;
  const qTok = tokenize(goal);
  if (!qTok.length) return { entries: [], used: [] };
  let raw = '';
  try {
    const file = p.join(dir, 'experiences.jsonl');
    if (!f.existsSync(file)) return { entries: [], used: [] };
    raw = f.readFileSync(file, 'utf8');
  } catch {
    return { entries: [], used: [] };
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    const t = line && line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t));
    } catch {
      /* skip corrupt line */
    }
  }
  const scored = [];
  for (const rec of entries) {
    const corpus = tokenize(
      [rec.goal, rec.approach, rec.diff, rec.verification].filter(Boolean).join(' ')
    );
    const sc = overlap(qTok, corpus);
    if (sc > 0) scored.push({ rec, sc });
  }
  scored.sort((a, b) => b.sc - a.sc);
  const top = scored.slice(0, k);
  return { entries: top.map((x) => x.rec), used: top.map((x) => x.rec.id) };
}

// Atomically append one experience. Returns the id (or null on failure).
export function recordExperience({ dir, entry, deps } = {}) {
  const f = (deps && deps.fs) || fs;
  const p = (deps && deps.path) || path;
  const c = (deps && deps.crypto) || crypto;
  if (!dir) return null;
  try {
    f.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  const id = (entry && entry.id) || genId(c);
  const rec = {
    id,
    goal: (entry && entry.goal) || '',
    approach: (entry && entry.approach) || '',
    diff: (entry && entry.diff) || '',
    verification: (entry && entry.verification) || '',
    outcome: (entry && entry.outcome) || '',
    model: (entry && entry.model) || '',
    ts: (entry && entry.ts) || Date.now()
  };
  try {
    const file = p.join(dir, 'experiences.jsonl');
    f.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch {
    return null;
  }
  return id;
}

function genId(c) {
  try {
    return 'exp_' + c.randomBytes(8).toString('hex');
  } catch {
    return 'exp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}

// Render retrieved experiences as a system-prompt block the agent can lean on.
export function formatExperiences(entries) {
  if (!entries || !entries.length) return '';
  const blocks = entries.map((e, i) => {
    const parts = [`【经验 ${i + 1}】${e.goal || '(未命名目标)'}`];
    if (e.approach) parts.push(`做法：${e.approach}`);
    if (e.verification) parts.push(`验证：${e.verification}`);
    if (e.outcome) parts.push(`复核：${e.outcome}`);
    if (e.model) parts.push(`（模型：${e.model}）`);
    return parts.join('\n');
  });
  return (
    '以下是你过去【已通过验证与成果复核】的同类目标经验，可借鉴但需结合本次实际情况判断，不要盲从：\n' +
    blocks.join('\n\n')
  );
}
