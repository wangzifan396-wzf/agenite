// Long-term, file-based memory for the agent. Zero dependencies — just the
// filesystem. The agent keeps a curated MEMORY.md (projects, preferences,
// decisions, people) plus a daily log (YYYY-MM-DD.md). It can search its own
// memory with `memory_recall`, persist facts with `memory_save`, and jot notes
// with `memory_log`. At the start of every request the server injects MEMORY.md
// into the system prompt so the agent "remembers you" across sessions.
//
// Everything lives under one base directory (default ~/.agenite/memory) so it
// can never touch the user's files — the agent only writes to its own kitchen.
import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MEMORY_FILE = 'MEMORY.md';
const DAILY_KEEP = 7; // how many daily logs recall() scans
const SKILLS_DIR = 'skills';

export function defaultMemoryDir() {
  return join(homedir(), '.agenite', 'memory');
}

async function ensureDir(base) {
  await mkdir(base, { recursive: true });
}

export async function readMemoryFile(base, name = MEMORY_FILE) {
  try {
    return await readFile(join(base, name), 'utf8');
  } catch {
    return '';
  }
}

// Persist a fact under a category section in MEMORY.md.
//   memory_save({ category: 'Preferences', key: 'language', value: '中文' })
// Updates the bullet if the key already exists, otherwise appends one.
export async function saveMemory(base, category, key, value) {
  if (!category || !key) return { ok: false, error: 'category 与 key 不能为空' };
  await ensureDir(base);
  const cat = String(category).trim();
  const k = String(key).trim();
  const v = String(value == null ? '' : value).trim();
  const path = join(base, MEMORY_FILE);
  let content = await readMemoryFile(base, MEMORY_FILE);
  const header = `## ${cat}`;

  const lines = content.length ? content.split('\n') : ['# 长期记忆', ''];
  let idx = lines.findIndex((l) => l.trim() === header);
  if (idx === -1) {
    // append a new section at the end
    if (lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(header, '');
    idx = lines.length - 1;
  }
  // find the bullet for this key inside the section
  const bulletRe = /^- \*\*(.+?)\*\*:?\s*(.*)$/;
  let inserted = false;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = bulletRe.exec(lines[i]);
    if (m && m[1].trim() === k) {
      lines[i] = `- **${k}**: ${v}`;
      inserted = true;
      break;
    }
    // stop at the next section or end of known region
    if (lines[i].startsWith('## ') && i > idx) {
      lines.splice(i, 0, `- **${k}**: ${v}`);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    // append right after the header
    lines.splice(idx + 1, 0, `- **${k}**: ${v}`);
  }
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  await writeFile(path, out, 'utf8');
  return { ok: true, content: `已记忆 [${cat}] ${k}: ${v}` };
}

// Append a dated note to today's daily log.
export async function logDaily(base, section, content) {
  if (!section || !content) return { ok: false, error: 'section 与 content 不能为空' };
  await ensureDir(base);
  const today = new Date().toISOString().slice(0, 10);
  const file = join(base, `${today}.md`);
  let body = '';
  try { body = await readFile(file, 'utf8'); } catch { body = `# ${today}\n`; }
  const block = `\n## ${String(section).trim()}\n${String(content).trim()}\n`;
  await writeFile(file, body.replace(/\s*$/, '') + block, 'utf8');
  return { ok: true, content: `已记入今日(${today})日志` };
}

// Keyword search across MEMORY.md and the most recent daily logs.
// Returns up to `limit` matching lines as "file:line: text".
//
// If `embed` (an async (text)=>number[] function, e.g. Ollama nomic-embed-text)
// is supplied, recall first tries semantic ranking by cosine similarity and
// only falls back to keyword search when embedding fails or returns nothing.
export async function recall(base, query, { limit = 12, embed = null } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, content: '请输入要回忆的关键词。' };

  const files = [{ name: MEMORY_FILE }];
  try {
    const entries = await readdir(base);
    const dailies = entries
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .sort()
      .reverse()
      .slice(0, DAILY_KEEP);
    for (const n of dailies) files.push({ name: n });
  } catch { /* no memory dir yet */ }

  // Build one searchable chunk per non-empty line.
  const chunks = [];
  for (const f of files) {
    const text = await readMemoryFile(base, f.name);
    if (!text) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line) chunks.push({ ref: `${f.name}:${i + 1}`, text: line });
    }
  }
  if (!chunks.length) {
    return { ok: true, content: `记忆中没有与「${query}」相关的条目。` };
  }

  if (embed) {
    try {
      const qv = await embed(q);
      if (qv && qv.length) {
        const scored = [];
        for (const ch of chunks) {
          const cv = await embed(ch.text);
          if (!cv || !cv.length) continue;
          scored.push({ ...ch, sim: cosine(qv, cv) });
        }
        scored.sort((a, b) => b.sim - a.sim);
        const top = scored.slice(0, limit);
        if (top.length) {
          const body = top
            .map((c) => `${c.ref}  (相似度 ${(c.sim * 100).toFixed(0)}%)\n${c.text}`)
            .join('\n\n');
          return { ok: true, content: `语义回忆到 ${top.length} 条（查询「${q}」）：\n\n${body}`, semantic: true };
        }
      }
    } catch {
      // Embedding unavailable — fall through to keyword search.
    }
  }

  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const ch of chunks) {
    const low = ch.text.toLowerCase();
    if (tokens.every((t) => low.includes(t))) hits.push(`${ch.ref}: ${ch.text}`);
    if (hits.length >= limit) break;
  }
  if (!hits.length) {
    return { ok: true, content: `记忆中没有与「${query}」相关的条目。` };
  }
  return { ok: true, content: `回忆到 ${hits.length} 条（关键词「${query}」）：\n` + hits.join('\n') };
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Produce the block the server embeds into the system prompt. Empty string when
// there is nothing to remember yet.
export async function injectMemory(base, { maxChars = 2200 } = {}) {
  const text = (await readMemoryFile(base, MEMORY_FILE)).trim();
  if (!text) return '';
  const trimmed = text.length > maxChars ? text.slice(0, maxChars) + '\n…(记忆已截断)' : text;
  return (
    '## 你的长期记忆（来自本机 ~/.agenite/memory/MEMORY.md，跨会话保留）\n' +
    '以下是你之前了解到的关于用户与项目的事实，做决策时优先参考：\n' +
    trimmed +
    '\n\n如果记忆缺失或过期，可用 memory_recall 检索、memory_save 补充、memory_log 记录今日进展。'
  );
}

// ---- skills: the agent's self-evolving playbook library ----
// Inspired by Hermes / GenericAgent: after nailing a tricky workflow the agent
// can crystallize it into a reusable SKILL.md. Future sessions auto-load the
// catalog into the system prompt (name + description only; body fetched on
// demand via skill_recall). This is the "技能复利" — the agent gets smarter
// the more it is used, and every skill is a plain local file you can read/edit.

export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'skill';
}

// ---- skill metadata (v0.46) ----
// A skill is still a plain .md file you can read and edit by hand, but the
// frontmatter now carries the evidence that makes the library *trustworthy*:
//   version / status / verified / anti_patterns / usage & success counts.
// Research lesson (MindMemOS, SpreadsheetBench): an un-curated skill library is
// worse than no library at all — stale, redundant entries are pure noise. So we
// score every skill, retire the losers, and keep superseded versions around for
// rollback instead of silently overwriting them.

export const SKILL_STATUS = { ACTIVE: 'active', SUPERSEDED: 'superseded', ARCHIVED: 'archived' };

// Laplace-smoothed success rate: an unused skill starts neutral at 0.5, and a
// skill needs real wins (not just one lucky run) to climb.
export function computeSkillScore(usageCount = 0, successCount = 0) {
  const u = Math.max(0, Number(usageCount) || 0);
  const s = Math.min(u, Math.max(0, Number(successCount) || 0));
  return Math.round(((s + 1) / (u + 2)) * 1000) / 1000;
}

function splitList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v == null ? '' : v)
    .split(/\s*\|\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function oneLine(v) {
  return String(v == null ? '' : v).replace(/\s*\n+\s*/g, ' ').trim();
}

// Turn raw frontmatter strings into a typed record with sane defaults so a
// hand-written skill from v0.45 keeps working untouched.
export function normalizeSkillMeta(meta = {}, slug = '') {
  const usageCount = Math.max(0, parseInt(meta.usage_count, 10) || 0);
  const successCount = Math.min(usageCount, Math.max(0, parseInt(meta.success_count, 10) || 0));
  const status = [SKILL_STATUS.ACTIVE, SKILL_STATUS.SUPERSEDED, SKILL_STATUS.ARCHIVED].includes(meta.status)
    ? meta.status
    : SKILL_STATUS.ACTIVE;
  return {
    slug,
    name: meta.name || slug,
    description: meta.description || '',
    whenToUse: meta.when_to_use || '',
    version: Math.max(1, parseInt(meta.version, 10) || 1),
    status,
    verified: String(meta.verified) === 'true',
    source: meta.source || 'manual',
    antiPatterns: splitList(meta.anti_patterns),
    supersedes: meta.supersedes || '',
    supersededBy: meta.superseded_by || '',
    usageCount,
    successCount,
    score: meta.score != null && meta.score !== '' ? Number(meta.score) : computeSkillScore(usageCount, successCount),
    createdAt: meta.created_at || '',
    updatedAt: meta.updated_at || ''
  };
}

export function serializeSkillMeta(m) {
  const lines = [
    '---',
    `name: ${oneLine(m.name)}`,
    `description: ${oneLine(m.description)}`,
    `when_to_use: ${oneLine(m.whenToUse)}`,
    `version: ${m.version}`,
    `status: ${m.status}`,
    `verified: ${m.verified ? 'true' : 'false'}`,
    `source: ${m.source || 'manual'}`,
    `anti_patterns: ${(m.antiPatterns || []).map(oneLine).filter(Boolean).join(' | ')}`,
    `supersedes: ${m.supersedes || ''}`,
    `superseded_by: ${m.supersededBy || ''}`,
    `usage_count: ${m.usageCount || 0}`,
    `success_count: ${m.successCount || 0}`,
    `score: ${m.score}`,
    `created_at: ${m.createdAt || ''}`,
    `updated_at: ${m.updatedAt || ''}`,
    '---'
  ];
  return lines.join('\n');
}

function renderSkillFile(meta, body) {
  const anti = (meta.antiPatterns || []).filter(Boolean);
  const parts = [serializeSkillMeta(meta), '', String(body || '').trim()];
  if (anti.length) {
    parts.push('', '## 反模式（上次踩过的坑，务必避开）', ...anti.map((a) => `- ${a}`));
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// Strip the auto-generated anti-pattern section so re-saving never duplicates it.
function stripAntiSection(body) {
  return String(body || '').replace(/\n*## 反模式（上次踩过的坑，务必避开）[\s\S]*$/, '').trim();
}

async function readSkillFile(base, slug) {
  try {
    const text = await readFile(join(base, SKILLS_DIR, `${slug}.md`), 'utf8');
    const { meta, body } = parseFrontmatter(text);
    return { meta: normalizeSkillMeta(meta, slug), body: stripAntiSection(body), raw: text };
  } catch {
    return null;
  }
}

async function writeSkillFile(base, slug, meta, body) {
  await mkdir(join(base, SKILLS_DIR), { recursive: true });
  await writeFile(join(base, SKILLS_DIR, `${slug}.md`), renderSkillFile(meta, body), 'utf8');
}

export async function saveSkill(base, {
  name,
  description,
  whenToUse,
  when_to_use,
  body,
  antiPatterns,
  anti_patterns,
  verified = false,
  source = 'manual',
  supersede = true
} = {}) {
  if (!name || !description) return { ok: false, error: 'name 与 description 不能为空' };
  await ensureDir(base);
  await mkdir(join(base, SKILLS_DIR), { recursive: true });
  const slug = slugify(name);
  const now = new Date().toISOString();
  const anti = splitList(antiPatterns != null ? antiPatterns : anti_patterns);

  // Supersede instead of overwrite: the previous revision is parked at
  // `<slug>.v<N>.md` with status=superseded so you can always roll back, and the
  // canonical `<slug>.md` always holds the newest revision.
  const prev = await readSkillFile(base, slug);
  let version = 1;
  let supersedes = '';
  let createdAt = now;
  if (prev) {
    createdAt = prev.meta.createdAt || now;
    if (supersede) {
      version = prev.meta.version + 1;
      supersedes = `${slug}.v${prev.meta.version}`;
      await writeSkillFile(
        base,
        supersedes,
        { ...prev.meta, slug: supersedes, status: SKILL_STATUS.SUPERSEDED, supersededBy: slug, updatedAt: now },
        prev.body
      );
    } else {
      version = prev.meta.version;
      supersedes = prev.meta.supersedes;
    }
  }

  const meta = normalizeSkillMeta({}, slug);
  meta.name = name;
  meta.description = description;
  meta.whenToUse = whenToUse || when_to_use || '';
  meta.version = version;
  meta.status = SKILL_STATUS.ACTIVE;
  meta.verified = !!verified;
  meta.source = source;
  meta.antiPatterns = anti;
  meta.supersedes = supersedes;
  meta.supersededBy = '';
  meta.usageCount = 0;
  meta.successCount = 0;
  meta.score = computeSkillScore(0, 0);
  meta.createdAt = createdAt;
  meta.updatedAt = now;

  await writeSkillFile(base, slug, meta, body);
  const badge = version > 1 ? `v${version}（旧版已存为 ${supersedes}）` : 'v1';
  return {
    ok: true,
    content: `已沉淀技能「${name}」${badge}${verified ? ' ✓已验证' : ''}(skills/${slug}.md)，下次会话会自动进入技能库。`,
    slug,
    version,
    supersedes,
    verified: !!verified,
    antiPatterns: anti
  };
}

// Merge a partial metadata patch into an existing skill file.
export async function patchSkillFile(base, ref, patch = {}) {
  const target = await resolveSkill(base, ref);
  if (!target) return { ok: false, error: `未找到技能：${ref}` };
  const cur = await readSkillFile(base, target.slug);
  if (!cur) return { ok: false, error: `未找到技能：${ref}` };
  const meta = { ...cur.meta, ...patch, slug: target.slug, updatedAt: new Date().toISOString() };
  meta.usageCount = Math.max(0, Number(meta.usageCount) || 0);
  meta.successCount = Math.min(meta.usageCount, Math.max(0, Number(meta.successCount) || 0));
  meta.score = computeSkillScore(meta.usageCount, meta.successCount);
  await writeSkillFile(base, target.slug, meta, patch.body != null ? patch.body : cur.body);
  return { ok: true, slug: target.slug, meta };
}

// Called every time the agent actually pulls a skill (skill_recall). Usage data
// is what lets the library prune itself later.
export async function recordSkillUse(base, ref, { success = null } = {}) {
  const target = await resolveSkill(base, ref);
  if (!target) return { ok: false, error: `未找到技能：${ref}` };
  const cur = await readSkillFile(base, target.slug);
  if (!cur) return { ok: false, error: `未找到技能：${ref}` };
  const usageCount = cur.meta.usageCount + 1;
  const successCount = cur.meta.successCount + (success === true ? 1 : 0);
  return patchSkillFile(base, target.slug, { usageCount, successCount });
}

export async function markSuperseded(base, ref, bySlug = '') {
  return patchSkillFile(base, ref, { status: SKILL_STATUS.SUPERSEDED, supersededBy: bySlug });
}

// Retire skills that have been tried enough times and keep losing. They are
// archived (status flip), never deleted — the file stays on disk for review.
export async function pruneSkills(base, { minUses = 3, minScore = 0.4 } = {}) {
  const list = await listSkills(base);
  const pruned = [];
  for (const s of list) {
    if (s.status !== SKILL_STATUS.ACTIVE) continue;
    if (s.usageCount < minUses) continue;
    if (s.score >= minScore) continue;
    await patchSkillFile(base, s.slug, { status: SKILL_STATUS.ARCHIVED });
    pruned.push({ slug: s.slug, name: s.name, score: s.score, usageCount: s.usageCount });
  }
  return { ok: true, pruned, kept: list.length - pruned.length };
}

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > -1) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

export async function listSkills(base) {
  const dir = join(base, SKILLS_DIR);
  let entries;
  try { entries = await readdir(dir); } catch { return []; }
  const out = [];
  for (const n of entries) {
    if (!n.endsWith('.md')) continue;
    const text = await readFile(join(dir, n), 'utf8');
    const { meta } = parseFrontmatter(text);
    out.push(normalizeSkillMeta(meta, n.replace(/\.md$/, '')));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function resolveSkill(base, ref) {
  if (!ref) return null;
  const list = await listSkills(base);
  return list.find((s) => s.slug === ref || s.name === ref || s.slug === slugify(ref)) || null;
}

export async function readSkill(base, ref) {
  if (!ref) return { ok: false, error: '请指定技能名称或 slug' };
  const target = await resolveSkill(base, ref);
  if (!target) return { ok: false, error: `未找到技能：${ref}` };
  const text = await readFile(join(base, SKILLS_DIR, `${target.slug}.md`), 'utf8');
  return { ok: true, slug: target.slug, name: target.name, content: text };
}

export async function deleteSkill(base, ref) {
  const target = await resolveSkill(base, ref);
  if (!target) return { ok: false, error: `未找到技能：${ref}` };
  // Some environments intercept unlink and route it through a trash can that
  // can occasionally error; tolerate it so a delete never crashes the server.
  try { await unlink(join(base, SKILLS_DIR, `${target.slug}.md`)); } catch { /* best-effort */ }
  return { ok: true, content: `已删除技能「${target.name}」` };
}

// ---- personas: reusable role/system-prompt presets ----
const PERSONAS_DIR = 'personas';

export async function savePersona(base, { name, description, system_prompt, instructions }) {
  const prompt = String(system_prompt || instructions || '').trim();
  if (!name || !prompt) {
    return { ok: false, error: 'name 与 system_prompt（角色指令）不能为空' };
  }
  await ensureDir(base);
  await mkdir(join(base, PERSONAS_DIR), { recursive: true });
  const slug = slugify(name);
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${description || ''}`,
    '---',
    '',
    prompt,
    ''
  ].join('\n');
  await writeFile(join(base, PERSONAS_DIR, `${slug}.md`), fm, 'utf8');
  return { ok: true, content: `已保存角色「${name}」(personas/${slug}.md)。`, slug };
}

export async function listPersonas(base) {
  const dir = join(base, PERSONAS_DIR);
  let entries;
  try { entries = await readdir(dir); } catch { return []; }
  const out = [];
  for (const n of entries) {
    if (!n.endsWith('.md')) continue;
    const text = await readFile(join(dir, n), 'utf8');
    const { meta, body } = parseFrontmatter(text);
    out.push({ slug: n.replace(/\.md$/, ''), name: meta.name || n, description: meta.description || '', system_prompt: body.trim() });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readPersona(base, ref) {
  if (!ref) return { ok: false, error: '请指定角色名称或 slug' };
  const list = await listPersonas(base);
  const target = list.find((s) => s.slug === ref || s.name === ref || s.slug === slugify(ref));
  if (!target) return { ok: false, error: `未找到角色：${ref}` };
  return { ok: true, slug: target.slug, name: target.name, description: target.description, content: target.system_prompt };
}

export async function deletePersona(base, ref) {
  const list = await listPersonas(base);
  const target = list.find((s) => s.slug === ref || s.name === ref || s.slug === slugify(ref));
  if (!target) return { ok: false, error: `未找到角色：${ref}` };
  // Some environments intercept unlink and route it through a trash can that
  // can occasionally error; tolerate it so a delete never crashes the server.
  try { await unlink(join(base, PERSONAS_DIR, `${target.slug}.md`)); } catch { /* best-effort */ }
  return { ok: true, content: `已删除角色「${target.name}」` };
}

// The catalog block injected into the system prompt at session start.
// Progressive disclosure: only name + description + evidence badges go into the
// prompt; the full playbook is fetched on demand via skill_recall. Superseded
// and archived revisions are filtered out so the index never turns into noise,
// and the highest-scoring skills are listed first.
export async function injectSkills(base, { maxChars = 1500 } = {}) {
  const all = await listSkills(base);
  const list = all
    .filter((s) => s.status === SKILL_STATUS.ACTIVE)
    .sort((a, b) => b.score - a.score || (b.verified === a.verified ? 0 : b.verified ? 1 : -1) || a.name.localeCompare(b.name));
  if (!list.length) return '';
  const lines = list.map((s) => {
    const badges = [];
    if (s.version > 1) badges.push(`v${s.version}`);
    if (s.verified) badges.push('✓已验证');
    if (s.usageCount > 0) badges.push(`用过${s.usageCount}次·评分${s.score}`);
    if (s.antiPatterns.length) badges.push(`${s.antiPatterns.length}条反模式`);
    const tag = badges.length ? ` [${badges.join(' · ')}]` : '';
    return `- **${s.name}**${tag}: ${s.description}${s.whenToUse ? `（适用：${s.whenToUse}）` : ''}`;
  });
  let body = lines.join('\n');
  if (body.length > maxChars) body = body.slice(0, maxChars) + '\n…(技能库已截断)';
  return (
    '## 你的技能库（agent 自己沉淀的可复用工作流，本机 ~/.agenite/memory/skills/，跨会话保留）\n' +
    '遇到匹配场景时，先调用 skill_recall 读取该技能的完整步骤再照做；带 ✓已验证 的技能曾通过真实验证，优先采信；技能正文里的「反模式」是上次踩过的坑，务必避开：\n' +
    body
  );
}

