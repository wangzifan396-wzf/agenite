// Long-term, file-based memory for the agent. Zero dependencies — just the
// filesystem. The agent keeps a curated MEMORY.md (projects, preferences,
// decisions, people) plus a daily log (YYYY-MM-DD.md). It can search its own
// memory with `memory_recall`, persist facts with `memory_save`, and jot notes
// with `memory_log`. At the start of every request the server injects MEMORY.md
// into the system prompt so the agent "remembers you" across sessions.
//
// Everything lives under one base directory (default ~/.agenite/memory) so it
// can never touch the user's files — the agent only writes to its own kitchen.
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MEMORY_FILE = 'MEMORY.md';
const DAILY_KEEP = 7; // how many daily logs recall() scans

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
export async function recall(base, query, { limit = 12 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { ok: true, content: '请输入要回忆的关键词。' };
  const tokens = q.split(/\s+/).filter(Boolean);
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

  const hits = [];
  for (const f of files) {
    const text = await readMemoryFile(base, f.name);
    if (!text) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase();
      if (tokens.every((t) => low.includes(t))) {
        hits.push(`${f.name}:${i + 1}: ${lines[i].trim()}`);
        if (hits.length >= limit) break;
      }
    }
    if (hits.length >= limit) break;
  }
  if (!hits.length) {
    return { ok: true, content: `记忆中没有与「${query}」相关的条目。` };
  }
  return { ok: true, content: `回忆到 ${hits.length} 条（关键词「${query}」）：\n` + hits.join('\n') };
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
