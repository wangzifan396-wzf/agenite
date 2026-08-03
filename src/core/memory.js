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

export async function saveSkill(base, { name, description, whenToUse, when_to_use, body }) {
  if (!name || !description) return { ok: false, error: 'name 与 description 不能为空' };
  await ensureDir(base);
  await mkdir(join(base, SKILLS_DIR), { recursive: true });
  const slug = slugify(name);
  const when = whenToUse || when_to_use || '';
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `when_to_use: ${when}`,
    '---',
    '',
    String(body || '').trim(),
    ''
  ].join('\n');
  await writeFile(join(base, SKILLS_DIR, `${slug}.md`), fm, 'utf8');
  return { ok: true, content: `已沉淀技能「${name}」(skills/${slug}.md)，下次会话会自动进入技能库。`, slug };
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
    out.push({ slug: n.replace(/\.md$/, ''), name: meta.name || n, description: meta.description || '', whenToUse: meta.when_to_use || '' });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readSkill(base, ref) {
  if (!ref) return { ok: false, error: '请指定技能名称或 slug' };
  const list = await listSkills(base);
  const target = list.find((s) => s.slug === ref || s.name === ref || s.slug === slugify(ref));
  if (!target) return { ok: false, error: `未找到技能：${ref}` };
  const text = await readFile(join(base, SKILLS_DIR, `${target.slug}.md`), 'utf8');
  return { ok: true, slug: target.slug, name: target.name, content: text };
}

export async function deleteSkill(base, ref) {
  const list = await listSkills(base);
  const target = list.find((s) => s.slug === ref || s.name === ref || s.slug === slugify(ref));
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
export async function injectSkills(base, { maxChars = 1500 } = {}) {
  const list = await listSkills(base);
  if (!list.length) return '';
  const lines = list.map(
    (s) => `- **${s.name}**: ${s.description}${s.whenToUse ? `（适用：${s.whenToUse}）` : ''}`
  );
  let body = lines.join('\n');
  if (body.length > maxChars) body = body.slice(0, maxChars) + '\n…(技能库已截断)';
  return (
    '## 你的技能库（agent 自己沉淀的可复用工作流，本机 ~/.agenite/memory/skills/，跨会话保留）\n' +
    '遇到匹配场景时，先调用 skill_recall 读取该技能的完整步骤再照做：\n' +
    body
  );
}

