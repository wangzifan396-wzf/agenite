// Procedural Skill Crystallization (v0.61)
//
// Hermes-style "procedural memory" layer, sitting ON TOP of the v0.60 verified
// experience pool. Where experiences store "what worked for THIS goal" as raw
// narrative, skills store DISTILLED, REUSABLE procedures: a structured recipe
// (applicable-when / steps / known-failure-points / verification) that can be
// re-applied to a whole CLASS of future goals.
//
// Progressive (3-level) disclosure keeps token cost flat as the library grows:
//   Level 1 — index.json holds name + summary (~20-40 tokens) for EVERY skill.
//   Level 2 — on a goal, we match the index and load ONLY the matched SKILL.md
//             bodies (the full procedure), never the whole library.
//   Level 3 — a matched skill can be REFINED after a better run (updateSkill).
//
// Safety: skills are ONLY crystallized from goals that pass BOTH the v0.58
// verify gate and the v0.59 outcome gate (and that were "complex": turns>=5 or
// a self-heal retry or an outcome gate ran). This structurally prevents the
// 2026 failure mode of "memory that remembers its own mistakes" — the only
// thing that ever reaches the skill library is proven-correct procedure.
//
// Every I/O path takes an injectable `deps` so goals.test.js can run the whole
// lifecycle with an in-memory fs — no real disk, no network. Token overlap
// scoring is reused from experience.js (single source of truth).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tokenize, overlap } from './experience.js';

// Default location of the skill library, relative to the workspace.
export function defaultSkillsDir() {
  return 'memory/skills';
}

// Resolve the absolute directory where the skill library lives.
export function resolveSkillsDir(config, workspace) {
  const rel = config && config.skillsDir ? config.skillsDir : defaultSkillsDir();
  if (path.isAbsolute(rel)) return rel;
  return path.join(workspace || process.cwd(), rel);
}

// index.json schema: { skills: [ { id, name, tags:[], summary, file } ] }
// Only the cheap metadata lives here; the heavy procedure body lives in <id>.md.

// Load the skill index (name + summary only). Never throws.
export function loadIndex({ dir, deps } = {}) {
  const f = (deps && deps.fs) || fs;
  const p = (deps && deps.path) || path;
  const file = p.join(dir, 'index.json');
  try {
    if (!f.existsSync(file)) return { skills: [] };
    const raw = f.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.skills)) return obj;
  } catch {
    /* corrupt or absent index — treat as empty */
  }
  return { skills: [] };
}

// Match the goal against the index, returning the top-k skill METADATA only
// (progressive disclosure: no body loaded here). Returns { skills, used }.
export function matchSkills({ dir, goal, k = 3, deps } = {}) {
  const idx = loadIndex({ dir, deps });
  const qTok = tokenize(goal);
  if (!qTok.length) return { skills: [], used: [] };
  const scored = [];
  for (const s of idx.skills) {
    // v0.63 — archived skills are parked for review, never recalled into context.
    if (s.status === 'archived') continue;
    const corpus = tokenize(
      [s.name, (s.tags || []).join(' '), s.summary].filter(Boolean).join(' ')
    );
    const sc = overlap(qTok, corpus);
    if (sc > 0) scored.push({ s, sc });
  }
  scored.sort((a, b) => b.sc - a.sc);
  const top = scored.slice(0, k).map((x) => x.s);
  return { skills: top, used: top.map((x) => x.id) };
}

// Load the FULL body of a single skill (Level 2/3 disclosure). Returns
// { id, name, summary, tags, body } or null.
export function loadSkillBody({ dir, id, deps } = {}) {
  const f = (deps && deps.fs) || fs;
  const p = (deps && deps.path) || path;
  const idx = loadIndex({ dir, deps });
  const meta = idx.skills.find((s) => s.id === id);
  if (!meta) return null;
  const file = p.join(dir, meta.file || `${id}.md`);
  try {
    const body = f.readFileSync(file, 'utf8');
    return { id: meta.id, name: meta.name, summary: meta.summary, tags: meta.tags || [], body };
  } catch {
    return null;
  }
}

// Atomically write a new skill: the <id>.md body + a merged index.json entry.
// Returns the id (or null on failure).
export function recordSkill({ dir, skill, deps } = {}) {
  const f = (deps && deps.fs) || fs;
  const p = (deps && deps.path) || path;
  const c = (deps && deps.crypto) || crypto;
  if (!dir || !skill || !skill.name) return null;
  try {
    f.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  const id = (skill && skill.id) || genId(c);
  const file = `${id}.md`;
  // v0.63 — every skill carries lightweight bookkeeping metadata so the library
  // can curate itself. A freshly crystallized skill is PROVEN (it passed the
  // v0.58 verify + v0.59 outcome gates before reaching here), so it starts with
  // high confidence; usage accrues over time via bumpUsage().
  const nowDate = new Date().toISOString().slice(0, 10);
  const confidence = Number.isFinite(Number(skill.confidence))
    ? Math.min(1, Math.max(0, Number(skill.confidence)))
    : 0.9;
  const rec = {
    id,
    name: skill.name,
    tags: Array.isArray(skill.tags) ? skill.tags.filter((x) => typeof x === 'string').slice(0, 12) : [],
    summary: String(skill.summary || '').slice(0, 240),
    file,
    used: Math.max(0, Number(skill.used) || 0),
    confidence,
    lastUsed: skill.lastUsed || '',
    created: skill.created || nowDate,
    goal: String(skill.goal || '').slice(0, 400),
    status: skill.status === 'archived' ? 'archived' : 'active',
    // v0.64 — umbrella consolidation bookkeeping (absent on normal skills).
    umbrella: !!skill.umbrella,
    mergedIds: Array.isArray(skill.mergedIds) ? skill.mergedIds.filter((x) => typeof x === 'string').slice(0, 64) : [],
    consolidatedInto: typeof skill.consolidatedInto === 'string' && skill.consolidatedInto ? skill.consolidatedInto : ''
  };
  try {
    f.writeFileSync(p.join(dir, file), skill.body || '', 'utf8');
  } catch {
    return null;
  }
  const idx = loadIndex({ dir, deps });
  const existing = idx.skills.findIndex((s) => s.id === id);
  if (existing >= 0) idx.skills[existing] = rec;
  else idx.skills.push(rec);
  try {
    f.writeFileSync(p.join(dir, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');
  } catch {
    return null;
  }
  return id;
}

// Refine an existing skill after a better run: replace its body summary/tags
// and append a refinement note so the evolution is visible. Returns boolean.
export function updateSkill({ dir, id, patch, deps } = {}) {
  const f = (deps && deps.fs) || fs;
  const p = (deps && deps.path) || path;
  if (!dir || !id || !patch) return false;
  const cur = loadSkillBody({ dir, id, deps });
  if (!cur) return false;
  const idx = loadIndex({ dir, deps });
  const metaIdx = idx.skills.findIndex((s) => s.id === id);
  if (metaIdx < 0) return false;
  const newBody = patch.body != null ? patch.body : cur.body;
  const stamp = new Date().toISOString().slice(0, 10);
  const refined = `${newBody}\n\n## 精炼记录\n- ${stamp} 基于一次更优运行自动更新做法/失败点。`;
  try {
    f.writeFileSync(p.join(dir, idx.skills[metaIdx].file || `${id}.md`), refined, 'utf8');
  } catch {
    return false;
  }
  if (patch.summary != null) idx.skills[metaIdx].summary = String(patch.summary).slice(0, 240);
  if (patch.tags) idx.skills[metaIdx].tags = Array.isArray(patch.tags) ? patch.tags.filter((x) => typeof x === 'string').slice(0, 12) : idx.skills[metaIdx].tags;
  try {
    f.writeFileSync(p.join(dir, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');
  } catch {
    return false;
  }
  return true;
}

// Distill a structured, reusable skill from a goal's proven record, via `cm`
// (a callModel-like function: cm(messages, {}) => { content }). Returns
// { name, tags, summary, body } or null if the model didn't comply with format.
export async function distillSkill({ cm, goal, approach, verification, outcome, model } = {}) {
  if (!cm || typeof cm !== 'function') return null;
  const evidence = [
    goal ? `目标：${goal}` : '',
    approach ? `做法概要：${approach}` : '',
    verification ? `验证结论：${verification}` : '',
    outcome ? `成果复核：${outcome}` : ''
  ]
    .filter(Boolean)
    .join('\n');
  const prompt = [
    '你是一个"程序性技能"蒸馏器。下面是一段已通过验证门控与成果复核的目标执行记录。',
    '请把它蒸馏成一个可复用的结构化技能（procedure），供未来同类目标直接套用。',
    '只输出如下格式，不要任何额外说明或代码围栏：',
    'NAME: <简洁技能名，2-6 个中文词>',
    'TAGS: <3-6 个逗号或顿号分隔的关键词/标签>',
    'SUMMARY: <一句话适用场景摘要，<=60 字>',
    '---',
    '<技能正文，使用以下小标题：## 适用场景 / ## 做法步骤（编号列表） / ## 已知失败点 / ## 验证步骤>',
    '',
    '证据记录：',
    evidence
  ].join('\n');
  let content = '';
  try {
    const r = await cm(
      [
        { role: 'system', content: '你是技能蒸馏器。严格按 NAME/TAGS/SUMMARY/--- 格式输出，不要额外说明。' },
        { role: 'user', content: prompt }
      ],
      {}
    );
    content = (r && r.content) || '';
  } catch {
    return null;
  }
  return parseSkill(content);
}

// Parse the NAME/TAGS/SUMMARY/--- body format emitted by the distiller.
function parseSkill(text) {
  if (!text) return null;
  const lines = String(text).split('\n');
  let name = '';
  let tags = [];
  let summary = '';
  let bodyStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = line.match(/^NAME:\s*(.+)$/);
    if (m) {
      name = m[1].trim();
      continue;
    }
    m = line.match(/^TAGS:\s*(.+)$/);
    if (m) {
      tags = m[1]
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
      continue;
    }
    m = line.match(/^SUMMARY:\s*(.+)$/);
    if (m) {
      summary = m[1].trim();
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      bodyStart = i + 1;
      break;
    }
  }
  if (!name) return null;
  const body = bodyStart >= 0 ? lines.slice(bodyStart).join('\n').trim() : text.trim();
  return {
    name,
    tags: tags.slice(0, 12),
    summary: summary.slice(0, 240),
    body
  };
}

// Render matched skill bodies as a system-prompt block the agent can lean on.
export function formatSkills(skills) {
  if (!skills || !skills.length) return '';
  const blocks = skills.map((s, i) => {
    const head = `【技能 ${i + 1}】${s.name || '(未命名技能)'}${s.summary ? ' — ' + s.summary : ''}`;
    const body = s.body || '';
    return `${head}\n${body}`;
  });
  return (
    '以下是与你目标相关的、已结晶的可复用技能（来自通过验证+复核的历史复杂目标）。' +
    '优先套用其做法步骤，但需结合本次实际情况判断，不要盲从：\n\n' +
    blocks.join('\n\n')
  );
}

// ── v0.63 Skill Curation & Pruning ────────────────────────────────────
// Hermes-style procedural memory has a documented failure mode: without
// curation, the skill library grows into a noisy "junk drawer" (Hermes's own
// operators must prune by hand). We close it with three cheap, deterministic
// operations that run AFTER every crystallization:
//   Cap    — if active skills exceed maxSkills, archive the lowest-value ones.
//   Dedup  — skills targeting the same goal keep the best, archive the rest.
//   Decay  — skills with no recorded use AND older than decayDays are archived.
// Archiving is a status flip in index.json; the .md body stays on disk, so the
// library is self-cleaning but never loses history. Every path is deps-injectable.

export function resolveSkillCurationMode(config = {}) {
  return config && config.skillCuration === 'off' ? 'off' : 'on';
}

// Normalize an index entry into typed metadata with safe defaults, so a skill
// written before v0.63 (no meta fields) keeps working untouched.
function withSkillMeta(s = {}) {
  const used = Math.max(0, Number(s.used) || 0);
  const conf = Number.isFinite(Number(s.confidence)) ? Math.min(1, Math.max(0, Number(s.confidence))) : 0.5;
  return {
    id: s.id || '',
    name: s.name || '',
    tags: Array.isArray(s.tags) ? s.tags : [],
    summary: s.summary || '',
    file: s.file || '',
    used,
    confidence: conf,
    lastUsed: s.lastUsed || '',
    created: s.created || '',
    goal: s.goal || '',
    status: s.status === 'archived' ? 'archived' : 'active',
    umbrella: !!s.umbrella,
    mergedIds: Array.isArray(s.mergedIds) ? s.mergedIds.filter((x) => typeof x === 'string').slice(0, 64) : [],
    consolidatedInto: typeof s.consolidatedInto === 'string' && s.consolidatedInto ? s.consolidatedInto : ''
  };
}

// Usage-weighted value used to rank skills for capping/dedup. A proven-but-unused
// skill still ranks above a stale, never-used one, so curation trims dead weight
// before it trims fresh, high-confidence procedure.
function skillValue(s) {
  const used = Math.max(0, Number(s.used) || 0);
  let conf = Number(s.confidence);
  if (!Number.isFinite(conf)) conf = 0.5;
  conf = Math.min(1, Math.max(0, conf));
  return (used + 1) * (0.3 + 0.7 * conf);
}

function normGoalKey(g) {
  return String(g || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// Record that a skill was actually pulled/used. Pure bookkeeping that lets the
// curation step tell "trusted, reused" from "dead weight".
export function bumpUsage({ dir, id, deps } = {}) {
  const f = (deps && deps.fs) || fs;
  const p = (deps && deps.path) || path;
  if (!dir || !id) return false;
  const idx = loadIndex({ dir, deps });
  const i = idx.skills.findIndex((s) => s.id === id);
  if (i < 0) return false;
  idx.skills[i].used = Math.max(0, Number(idx.skills[i].used) || 0) + 1;
  idx.skills[i].lastUsed = new Date().toISOString().slice(0, 10);
  if (idx.skills[i].status === 'archived') idx.skills[i].status = 'active';
  try {
    f.writeFileSync(p.join(dir, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Curate the library. Returns { skipped, archived:[ids], active, total }.
export function curateSkills({ dir, config = {}, deps } = {}) {
  const f = (deps && deps.fs) || fs;
  const p = (deps && deps.path) || path;
  if (resolveSkillCurationMode(config) === 'off') return { skipped: true, archived: [], active: 0, total: 0 };
  if (!dir) return { skipped: false, archived: [], active: 0, total: 0 };
  const maxSkills = Math.max(1, Math.round(Number(config.maxSkills) || 60));
  const decayDays = Math.max(0, Math.round(Number(config.skillDecayDays) || 90));
  const idx = loadIndex({ dir, deps });
  const skills = (idx.skills || []).map(withSkillMeta);
  const now = Date.now();
  const decayMs = decayDays * 86400000;
  const archived = [];
  const archive = (s) => {
    if (s.status === 'archived') return;
    s.status = 'archived';
    archived.push(s.id);
  };

  // 1) Dedup by goal — keep the highest-value, archive the rest. Only skills with
  // a real goal key are deduplicated, so distinct named skills are never merged.
  const groups = new Map();
  for (const s of skills) {
    if (s.status === 'archived' || !s.goal) continue;
    const key = normGoalKey(s.goal);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    group.sort((a, b) => skillValue(b) - skillValue(a));
    for (let i = 1; i < group.length; i++) archive(group[i]);
  }

  // 2) Decay — never-used skills older than decayDays are archived. A skill that
  // has proven useful at least once is kept regardless of age.
  if (decayDays > 0) {
    for (const s of skills) {
      if (s.status === 'archived' || Number(s.used) > 0) continue;
      const created = s.created ? Date.parse(s.created) : 0;
      if (created && now - created > decayMs) archive(s);
    }
  }

  // 3) Cap — archive lowest-value actives until within maxSkills.
  const active = skills.filter((s) => s.status !== 'archived');
  active.sort((a, b) => skillValue(b) - skillValue(a));
  for (let i = maxSkills; i < active.length; i++) archive(active[i]);

  if (archived.length) {
    idx.skills = skills;
    try {
      f.writeFileSync(p.join(dir, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');
    } catch {
      /* write failure must never throw out of curation */
    }
  }

  // 4) Umbrella Consolidation (v0.64) — group narrow siblings that share a
  // concept into one findable skill, archiving the siblings (bodies preserved,
  // so the merge is fully reversible). Deterministic; no LLM call.
  let consolidated = [];
  if (resolveSkillUmbrellaMode(config) === 'on') {
    try {
      consolidated = runConsolidate({ dir, idx, config, deps });
    } catch {
      consolidated = [];
    }
  }

  const finalActive = idx.skills.filter((s) => s.status !== 'archived').length;
  return { skipped: false, archived, consolidated, active: finalActive, total: idx.skills.length };
}

function genId(c) {
  try {
    return 'skl_' + c.randomBytes(8).toString('hex');
  } catch {
    return 'skl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}

// ── v0.64 Skill Umbrella Consolidation (雨伞式合并) ──────────────────────
// v0.63's dedup only removes EXACT duplicates ("do these two target the same
// goal?"). Hermes' Curator exposes a higher-value operation it calls "Umbrella
// Consolidation": narrow sibling skills that serve ONE larger concept get
// merged into a single concept-level skill with sub-sections. The point is
// FINDABILITY, not disk savings — a library of 50 narrow `pr-*` skills is a
// junk drawer even if none are duplicates; one `PR 技能集` entry you can find
// is not. This is the documented differentiator of Hermes over naive dedup.
//
// Design choices (kept deterministic + deps-injectable, no LLM call):
//   - The "shared concept" is the token with the highest DOCUMENT FREQUENCY
//     across active skills (computed via the existing tokenizer). A token that
//     appears in every skill is universal, not a concept, so it is excluded.
//   - Only clusters of >= umbrellaMin DISTINCT skills are merged, so we never
//     collapse near-duplicates (dedup already handled those) or singletons.
//   - The umbrella is a NEW active skill whose body concatenates each sibling's
//     procedure under a `## <sibling name>` heading; siblings are ARCHIVED
//     (status flip + consolidatedInto pointer) — their .md bodies stay on disk,
//     so knowledge is never lost and the merge is fully reversible (restore the
//     siblings, drop the umbrella). The umbrella itself is recalled normally.
//   - Generic stopwords (function words) never become a namespace.

const SKILL_STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'this', 'that', 'with', 'how', 'what', 'when',
  'need', 'use', 'run', 'can', 'are',
  '可以', '我们', '这个', '一个', '如何', '什么', '时候', '需要', '应该', '因为',
  '如果', '这样', '那样', '他们', '这些', '那些'
]);

export function resolveSkillUmbrellaMode(config = {}) {
  return config && config.skillUmbrella === 'off' ? 'off' : 'on';
}

function umbrellaNameFor(ns) {
  if (/^[a-z0-9_]+$/.test(ns)) return ns.toUpperCase() + ' 技能集';
  return '技能集·' + ns;
}

// Pick the best namespace token for one skill, given the global doc-frequency
// map of active skills. Returns '' when the skill has no consolidatable concept.
function skillNamespace(skill, docFreq, totalActive, umbrellaMin) {
  const corpus = [skill.goal, skill.summary, skill.name].filter(Boolean).join(' ');
  const toks = new Set(tokenize(corpus));
  let best = '';
  let bestDf = 0;
  for (const t of toks) {
    if (SKILL_STOPWORDS.has(t) || t.length < 2) continue;
    const df = docFreq.get(t) || 0;
    if (df < umbrellaMin) continue; // concept must be shared by enough skills
    // A token appearing in EVERY active skill is "universal" only when the
    // library is larger than a single cluster — otherwise the whole library IS
    // the cluster and the shared token legitimately IS its concept.
    if (df >= totalActive && totalActive > umbrellaMin) continue;
    if (df > bestDf || (df === bestDf && t < best)) {
      best = t;
      bestDf = df;
    }
  }
  return best;
}

// Build the document-frequency map of tokens over the active skill set.
function buildDocFreq(activeSkills) {
  const docFreq = new Map();
  for (const s of activeSkills) {
    const toks = new Set(tokenize([s.goal, s.summary, s.name].filter(Boolean).join(' ')));
    for (const t of toks) {
      if (SKILL_STOPWORDS.has(t) || t.length < 2) continue;
      docFreq.set(t, (docFreq.get(t) || 0) + 1);
    }
  }
  return docFreq;
}

// Mutates `idx.skills` in place: appends umbrella entries and archives the
// merged siblings. Writes index.json once if anything changed. Returns the
// list of consolidation reports (one per umbrella created).
function runConsolidate({ dir, idx, config = {}, deps } = {}) {
  if (resolveSkillUmbrellaMode(config) === 'off') return [];
  const f = (deps && deps.fs) || fs;
  const p = (deps && deps.path) || path;
  const c = (deps && deps.crypto) || crypto;
  const umbrellaMin = Math.max(2, Math.round(Number(config.umbrellaMin) || 3));
  const skills = (idx.skills || []).map(withSkillMeta);
  const active = skills.filter((s) => s.status !== 'archived');
  if (active.length < umbrellaMin) return [];
  const today = new Date().toISOString().slice(0, 10);
  const docFreq = buildDocFreq(active);
  const groups = new Map();
  for (const s of active) {
    const ns = skillNamespace(s, docFreq, active.length, umbrellaMin);
    if (!ns) continue;
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns).push(s);
  }
  const reports = [];
  for (const [ns, group] of groups) {
    if (group.length < umbrellaMin) continue;
    const names = new Set(group.map((g) => g.name));
    if (names.size < group.length) continue; // dedup owns duplicates; don't merge them
    const sections = [];
    for (const g of group) {
      const bodyObj = loadSkillBody({ dir, id: g.id, deps });
      const bodyText = bodyObj ? bodyObj.body : '';
      sections.push(`## ${g.name}\n${bodyText}`.trim());
    }
    const umbrellaId = genId(c);
    const umbrellaName = umbrellaNameFor(ns);
    const mergedIds = group.map((g) => g.id);
    const umbrellaSummary = `合并 ${group.length} 个「${ns}」相关技能：${group.map((g) => g.name).join('、')}`;
    const umbrellaBody = [
      `# ${umbrellaName}`,
      '',
      '> 由技能策展自动合并（v0.64 雨伞式合并）。以下子技能已被归档，知识不会丢失，可随时恢复。',
      '',
      sections.join('\n\n')
    ].join('\n');
    try {
      f.writeFileSync(p.join(dir, `${umbrellaId}.md`), umbrellaBody, 'utf8');
    } catch {
      continue; // never break curation on a write failure
    }
    idx.skills.push({
      id: umbrellaId,
      name: umbrellaName,
      tags: [ns].slice(0, 12),
      summary: umbrellaSummary.slice(0, 240),
      file: `${umbrellaId}.md`,
      used: 0,
      confidence: 0.9,
      lastUsed: '',
      created: today,
      goal: '',
      status: 'active',
      umbrella: true,
      mergedIds,
      consolidatedInto: ''
    });
    for (const g of group) {
      const e = idx.skills.find((x) => x.id === g.id);
      if (e) {
        e.status = 'archived';
        e.consolidatedInto = umbrellaId;
      }
    }
    reports.push({ namespace: ns, umbrellaId, umbrellaName, merged: mergedIds });
  }
  if (reports.length) {
    try {
      f.writeFileSync(p.join(dir, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');
    } catch {
      /* write failure must never throw out of consolidation */
    }
  }
  return reports;
}

// Standalone entry point (also used by tests). Returns
// { skipped, consolidated:[{namespace,umbrellaId,umbrellaName,merged}], active, total }.
export function consolidateSkills({ dir, config = {}, deps } = {}) {
  if (resolveSkillUmbrellaMode(config) === 'off') {
    return { skipped: true, consolidated: [], active: 0, total: 0 };
  }
  if (!dir) return { skipped: false, consolidated: [], active: 0, total: 0 };
  const idx = loadIndex({ dir, deps });
  const consolidated = runConsolidate({ dir, idx, config, deps });
  const finalActive = idx.skills.filter((s) => s.status !== 'archived').length;
  return { skipped: false, consolidated, active: finalActive, total: idx.skills.length };
}
