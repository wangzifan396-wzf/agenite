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
  const rec = {
    id,
    name: skill.name,
    tags: Array.isArray(skill.tags) ? skill.tags.filter((x) => typeof x === 'string').slice(0, 12) : [],
    summary: String(skill.summary || '').slice(0, 240),
    file
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

function genId(c) {
  try {
    return 'skl_' + c.randomBytes(8).toString('hex');
  } catch {
    return 'skl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}
