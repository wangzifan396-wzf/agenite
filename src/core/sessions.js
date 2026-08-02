// Conversation persistence on the machine, not just in the browser.
//
// Everything used to live in localStorage, which means: switch browsers, use a
// private window, or clear site data — and your entire history is gone. The
// browser stays the source of truth for speed, but every conversation is
// mirrored into ~/.agenite/sessions so it can always be recovered.
import { mkdir, readdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SESSIONS_DIR = join(homedir(), '.agenite', 'sessions');
const MAX_SESSIONS = 500;
const MAX_BYTES = 4 * 1024 * 1024;

// Ids come from the browser, so they must never be able to escape the folder.
export function safeSessionId(id) {
  const s = String(id || '').replace(/[^a-zA-Z0-9_-]+/g, '');
  return s.slice(0, 64);
}

async function ensureDir(dir = SESSIONS_DIR) {
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function listSessions(dir = SESSIONS_DIR) {
  try {
    await ensureDir(dir);
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    const out = [];
    for (const n of names.slice(0, MAX_SESSIONS)) {
      try {
        const raw = await readFile(join(dir, n), 'utf8');
        const j = JSON.parse(raw);
        out.push({
          id: j.id || n.replace(/\.json$/, ''),
          title: j.title || '未命名',
          updatedAt: j.updatedAt || 0,
          count: Array.isArray(j.messages) ? j.messages.length : 0
        });
      } catch { /* skip a corrupt file rather than fail the whole list */ }
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  } catch {
    return [];
  }
}

export async function readSession(id, dir = SESSIONS_DIR) {
  const sid = safeSessionId(id);
  if (!sid) return null;
  try {
    const raw = await readFile(join(dir, sid + '.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeSession(conv, dir = SESSIONS_DIR) {
  const sid = safeSessionId(conv && conv.id);
  if (!sid) throw new Error('会话 id 无效');
  await ensureDir(dir);
  const payload = {
    id: sid,
    title: String((conv && conv.title) || '未命名').slice(0, 200),
    createdAt: Number(conv && conv.createdAt) || Date.now(),
    updatedAt: Number(conv && conv.updatedAt) || Date.now(),
    messages: Array.isArray(conv && conv.messages) ? conv.messages : []
  };
  let body = JSON.stringify(payload);
  if (body.length > MAX_BYTES) {
    // Keep the tail: the recent turns are the ones worth recovering.
    payload.messages = payload.messages.slice(-120);
    payload.truncated = true;
    body = JSON.stringify(payload);
    if (body.length > MAX_BYTES) throw new Error('会话过大，无法保存');
  }
  await writeFile(join(dir, sid + '.json'), body, 'utf8');
  await pruneOldest(dir);
  return { id: sid, bytes: body.length };
}

export async function deleteSession(id, dir = SESSIONS_DIR) {
  const sid = safeSessionId(id);
  if (!sid) return false;
  try {
    await unlink(join(dir, sid + '.json'));
    return true;
  } catch {
    return false;
  }
}

// Cap the folder so a runaway client cannot fill the disk.
async function pruneOldest(dir) {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    if (names.length <= MAX_SESSIONS) return;
    const withTime = [];
    for (const n of names) {
      try { withTime.push({ n, t: (await stat(join(dir, n))).mtimeMs }); } catch { /* ignore */ }
    }
    withTime.sort((a, b) => a.t - b.t);
    for (const { n } of withTime.slice(0, withTime.length - MAX_SESSIONS)) {
      try { await unlink(join(dir, n)); } catch { /* ignore */ }
    }
  } catch { /* pruning is best effort */ }
}
