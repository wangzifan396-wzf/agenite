#!/usr/bin/env node
// Agenite local server: serves the UI and proxies chat completions to the
// configured model provider, running the agent tool-calling loop server-side.
// Because it is a real local Node process (not the browser), the agent can
// actually read/write files and run commands on THIS machine — gated by a
// workspace sandbox and a human approval step. Zero dependencies.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { normalizeConfig, validateConfig, PROVIDER_PRESETS, APPROVAL_MODES } from './src/core/config.js';
import { runAgent } from './src/core/agent.js';
import { callModelStream, verifyKey } from './src/core/client.js';
import { activeTools, executeTool, scanWorkspaceFiles, applyUndo, setUndoStore } from './src/core/tools.js';
import { BROWSER } from './src/core/browser.js';
import { McpManager, parseMcpConfigJson } from './src/core/mcp.js';
import { contextWindowFor, historyBudget, toolsTokens, totalTokens } from './src/core/context.js';
import { priceFor } from './src/core/pricing.js';
import { listSessions, readSession, writeSession, deleteSession, SESSIONS_DIR, searchSessionsForLabel } from './src/core/sessions.js';
import { defaultMemoryDir, injectMemory, injectSkills, listSkills, savePersona, listPersonas, readPersona, deletePersona } from './src/core/memory.js';
import { BUILTIN_SKILLS, resolveBuiltinSkills, listBuiltinSkills } from './src/core/skills.js';
import { createSubAgentRunner, createFanoutRunner } from './src/core/subagent.js';
import { autoSaveSkill } from './src/core/autoskill.js';
import { createGoal, listGoals, getGoal, stopGoal, deleteGoal, initGoals } from './src/core/goals.js';
import {
  loadAtlas, saveAtlas, addNode, linkNodes, removeNode, removeEdge, atlasStats, parseAtlasExtraction, applyExtraction, graphToContext,
  exportAtlasMarkdown, importAtlasMarkdown, mergeGraph
} from './src/core/atlas.js';
import {
  newTrace, addStep, classifyTool, saveTrace, listTraces, loadTrace, deleteTrace, pruneTraces, traceSummary, diagnoseTrace, TRACES_DIR
} from './src/core/trace.js';
import {
  traceToCase, runEval, listEvals, loadEval, deleteEval, pruneEvals, EVALS_DIR
} from './src/core/eval.js';
import { createKnowledge } from './src/core/knowledge.js';
import { emptyTodoState } from './src/core/todo.js';
import { isGitRepo, isClean, gitCommit } from './src/core/git.js';
import { verifyWorkspace } from './src/core/verify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
// The machine root the agent is allowed to touch. Defaults to where you ran it.
const WORKSPACE = resolve(process.env.AGENITE_WORKSPACE || process.cwd());
// Long-term memory lives in its own directory so the agent can never touch the
// user's files by "remembering" something — it only writes to its own kitchen.
const MEMORY_DIR = defaultMemoryDir();

// Local knowledge base (RAG), stored next to the agent's long-term memory.
// Opened lazily so importing server.js in tests doesn't create a file.
const KB_PATH = join(MEMORY_DIR, 'kb.sqlite');
let _kb;
function kb() {
  if (!_kb) _kb = createKnowledge(KB_PATH);
  return _kb;
}

// ---- live task checklists (todo_write), one per conversation ----
// In-memory on purpose: a checklist describes work in flight, not history. If
// the server restarts the run is gone anyway, so there is nothing to restore.
// Capped with a plain LRU so a long-lived server can't accumulate state for
// thousands of conversations.
const TODO_STATES = new Map();
const TODO_STATES_MAX = 200;

function todoStateFor(convId) {
  const key = typeof convId === 'string' && convId.trim() ? convId.trim() : '__default__';
  let st = TODO_STATES.get(key);
  if (st) {
    // Refresh recency (Map preserves insertion order → re-insert = most recent).
    TODO_STATES.delete(key);
    TODO_STATES.set(key, st);
    return st;
  }
  st = emptyTodoState();
  TODO_STATES.set(key, st);
  while (TODO_STATES.size > TODO_STATES_MAX) {
    TODO_STATES.delete(TODO_STATES.keys().next().value);
  }
  return st;
}

export function clearTodoState(convId) {
  if (convId == null) { TODO_STATES.clear(); return; }
  TODO_STATES.delete(String(convId));
}

// ---- git auto-checkpoint (Aider-style safety net) ----
// After every turn that actually changed files, snapshot the workspace so the
// user can `git undo` a bad edit. Only fires when WORKSPACE is already a git
// repo — we never silently `git init` the user's directory (that surprise is
// exactly what Aider's auto-commits are *not* supposed to do). The model can
// still call `git commit` to bootstrap a repo explicitly.
let gitUserSnapshotted = false;

async function autoGitCheckpoint(turnTools = []) {
  if (!isGitRepo(WORKSPACE)) return;
  // Dirty-commit-first: snapshot any pre-existing user changes ONCE, attributed
  // to "User", so agent commits stay cleanly attributable to "(agenite)".
  if (!gitUserSnapshotted) {
    gitUserSnapshotted = true;
    if (!(await isClean(WORKSPACE))) {
      await gitCommit(WORKSPACE, 'user: snapshot pre-existing working changes before agent edits', {
        addAll: true,
        author: 'User <user@local>'
      });
    }
  }
  if (await isClean(WORKSPACE)) return;
  const names = [...new Set(turnTools)].join(', ');
  await gitCommit(WORKSPACE, `agent: auto-checkpoint — ${names || 'workspace changes'}`, { addAll: true });
}

// Reset the per-process "did we snapshot user changes" latch (used by tests).
export function _resetGitSnapshot() { gitUserSnapshotted = false; }

// ---- auto verification (the "Verify" in Plan → Execute → Verify → Rollback) ----
// Runs right after the git checkpoint on every turn that changed files. The
// default level ('syntax') only parse-checks the files that actually moved, so
// it costs tens of milliseconds and can stay on for everyone; 'full' runs the
// project's real test command. Whatever comes back, agent.js decides whether to
// hand a failure to the model as a fix request.
export function makeAutoVerify(config) {
  if (!config || !config.autoVerify || config.autoVerify === 'off') return undefined;
  return async ({ files = [] } = {}) => verifyWorkspace(WORKSPACE, {
    level: config.autoVerify,
    cmd: config.verifyCmd || '',
    changedFiles: files,
    timeoutMs: Number(config.verifyTimeoutMs) || 120000
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2'
};

// Pending approvals: requestId -> { resolve } waiting for a POST /api/approve.
const pendingApprovals = new Map();

// Undo snapshots: token -> { path, before }. Lets the UI revert a write/edit.
const undoStore = new Map();
setUndoStore(undoStore);

// Compaction summaries, keyed by the digest content. The browser re-sends the
// whole history on every turn, so without this the same old prefix would be
// summarized (and paid for) again and again. Bounded so it cannot grow forever.
const summaryCache = new Map();
const SUMMARY_CACHE_MAX = 60;
function cacheKey(text) {
  const s = String(text);
  // Length + head + tail is enough to identify a prefix without hashing cost.
  return `${s.length}:${s.slice(0, 96)}:${s.slice(-96)}`;
}

// MCP client: connects to external tool servers (browser/desktop control,
// databases, GitHub, file systems…) so the model can actually act on the
// machine and the wider world. This is what makes Agenite a real agent.
const mcp = new McpManager();

// MCP servers are child processes we spawned. If we exit without killing them
// they linger as orphans (very visible on Windows: node.exe piling up in Task
// Manager after every Ctrl+C). Tear them down on every exit path.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  正在关闭（${signal}）… 断开 MCP 服务器`);
  const done = mcp.disconnectAll();
  const guard = new Promise((r) => setTimeout(r, 3000));
  await Promise.race([done, guard]);
  mcp.killAllSync();
  try { server.close(); } catch { /* ignore */ }
  process.exit(0);
}
// On Windows only some of these are real: Ctrl+C -> SIGINT, closing the console
// window -> SIGHUP, Ctrl+Break -> SIGBREAK. A hard TerminateProcess (Task
// Manager) runs nothing at all — that case is covered by MCP servers exiting on
// stdin EOF, which the stdio transport spec requires.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => shutdown(sig)); } catch { /* unsupported on this OS */ }
}
process.on('exit', () => mcp.killAllSync());
process.on('uncaughtException', (e) => {
  console.error('  未捕获异常:', e && e.message ? e.message : e);
  mcp.killAllSync();
  process.exit(1);
});

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'POST' && url === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && url === '/api/approve') return handleApprove(req, res);
  if (req.method === 'POST' && url === '/api/undo') return handleUndo(req, res);
  if (req.method === 'GET' && url === '/api/mcp/status') return sendJson(res, 200, { ok: true, servers: mcp.status() });
  if (req.method === 'POST' && url === '/api/mcp/servers') return handleMcpServers(req, res);
  if (req.method === 'POST' && url === '/api/mcp/disconnect') return handleMcpDisconnect(req, res);
  // Local knowledge base (RAG) endpoints.
  if (req.method === 'GET' && url === '/api/kb/list') return handleKbList(res);
  if (req.method === 'POST' && url === '/api/kb/ingest') return handleKbIngest(req, res);
  if (req.method === 'POST' && url === '/api/kb/retrieve') return handleKbRetrieve(req, res);
  if (req.method === 'POST' && url === '/api/kb/remove') return handleKbRemove(req, res);
  if (req.method === 'POST' && url === '/api/kb/clear') return handleKbClear(res);
  // Agent gallery: curated built-in personas.
  if (req.method === 'GET' && url === '/api/agents') return handleAgents(res);
  if (req.method === 'POST' && url === '/api/mcp/import') return handleMcpImport(req, res);
  if (url === '/api/sessions' || url.startsWith('/api/sessions/')) return handleSessions(req, res, url);
  if (req.method === 'GET' && url === '/api/presets') return sendJson(res, 200, PROVIDER_PRESETS);
  if (req.method === 'GET' && url === '/api/ollama/models') return handleOllamaModels(req, res);
  if (req.method === 'GET' && url === '/api/skills') return handleSkillsList(req, res);
  if (req.method === 'GET' && url === '/api/personas') return handlePersonasList(req, res);
  if (req.method === 'POST' && url === '/api/personas') return handlePersonaSave(req, res);
  if (req.method === 'DELETE' && url.startsWith('/api/personas/')) return handlePersonaDelete(req, res, url);
  // Autonomous goal delegation ("fire and forget" + self-verify), see goals.js.
  if (req.method === 'POST' && url === '/api/goals') return handleGoalCreate(req, res);
  if (req.method === 'GET' && url === '/api/goals') return handleGoalsList(req, res);
  if (req.method === 'POST' && url.startsWith('/api/goals/') && url.endsWith('/stop')) return handleGoalStop(req, res, url);
  if (req.method === 'DELETE' && url.startsWith('/api/goals/')) return handleGoalDelete(req, res, url);
  if (req.method === 'GET' && url.startsWith('/api/goals/')) return handleGoalGet(req, res, url);

  // ---- Agenite Atlas: local-first memory graph ----
  if (req.method === 'GET' && url === '/api/atlas') return handleAtlasGet(req, res);
  if (req.method === 'POST' && url === '/api/atlas') return handleAtlasPost(req, res);
  if (req.method === 'POST' && url === '/api/atlas/extract') return handleAtlasExtract(req, res);
  if (req.method === 'DELETE' && url === '/api/atlas') return handleAtlasReset(req, res);
  if (req.method === 'GET' && url === '/api/atlas/markdown') return handleAtlasMarkdownGet(req, res);
  if (req.method === 'POST' && url === '/api/atlas/markdown') return handleAtlasMarkdownPost(req, res);
  if (req.method === 'GET' && url.startsWith('/api/atlas/recall')) return handleAtlasRecall(req, res, req.url);
  if (req.method === 'GET' && url === '/api/traces') return handleTracesList(req, res);
  if (req.method === 'GET' && url.startsWith('/api/traces/')) return handleTraceGet(req, res, req.url);
  if (req.method === 'DELETE' && url.startsWith('/api/traces/')) return handleTraceDelete(req, res, req.url);

  // ---- Agenite Eval: local-first, trace-driven regression suite ----
  if (req.method === 'POST' && url === '/api/eval') return handleEvalCreate(req, res);
  if (req.method === 'GET' && url === '/api/evals') return handleEvalsList(req, res);
  if (req.method === 'GET' && url.startsWith('/api/evals/')) return handleEvalGet(req, res, req.url);
  if (req.method === 'DELETE' && url.startsWith('/api/evals/')) return handleEvalDelete(req, res, req.url);

  // ---- Agenite Browser: built-in live web browsing (local Chrome) ----
  if (req.method === 'GET' && url === '/api/browser') return handleBrowserGet(req, res);
  if (req.method === 'POST' && url === '/api/browser/close') return handleBrowserClose(req, res);
  if (req.method === 'GET' && url === '/api/health') {
    return sendJson(res, 200, {
      ok: true, workspace: WORKSPACE, approvalModes: APPROVAL_MODES, sessionsDir: SESSIONS_DIR
    });
  }
  // Real key validation: pings the provider with a 1-token completion so the
  // user learns "密钥无效" before they ever send a real message.
  if (req.method === 'POST' && url === '/api/verifykey') return handleVerifyKey(req, res);
  // Cheap, best-effort "suggested next steps" — the model proposes 3 short
  // follow-up prompts after each assistant reply. Never blocks the UI; the
  // client treats an empty/error response as "no suggestions".
  if (req.method === 'POST' && url === '/api/suggest') return handleSuggest(req, res);
  if (req.method === 'GET' && url === '/api/files') return handleFiles(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url, req, res);
  res.writeHead(405, { 'Content-Type': 'text/plain' }).end('Method Not Allowed');
});

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function serveStatic(url, req, res) {
  let rel = url === '/' ? '/index.html' : url;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(__dirname, safe);
  if (!filePath.startsWith(__dirname + sep) && filePath !== __dirname) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) throw new Error('dir');
    const data = await readFile(filePath);
    const type = MIME[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  } catch {
    if (!extname(filePath)) {
      try {
        const data = await readFile(join(__dirname, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        return res.end(data);
      } catch { /* fall through */ }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
  }
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Revert a previous write/edit by its undo token.
async function handleUndo(req, res) {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const result = applyUndo(body.token, undoStore);
    return sendJson(res, result.ok ? 200 : 409, result);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message });
  }
}

// The settings UI pushes the desired MCP server list here; we connect/disconnect
// to make reality match it, then return the live status + tool inventory.
async function handleMcpServers(req, res) {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const servers = Array.isArray(body.servers) ? body.servers : [];
    const status = await mcp.reconcile(servers);
    return sendJson(res, 200, { ok: true, servers: status });
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message });
  }
}

async function handleMcpDisconnect(req, res) {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    await mcp.disconnect(body.id);
    return sendJson(res, 200, { ok: true, servers: mcp.status() });
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message });
  }
}

// Paste a Claude Desktop / Cherry Studio mcp.json and get our server list back.
// Parsing lives server-side because the parser sits next to the MCP client.
async function handleMcpImport(req, res) {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const servers = parseMcpConfigJson(body.text != null ? body.text : body.json);
    return sendJson(res, 200, { ok: true, servers });
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message });
  }
}

// Conversations mirrored to ~/.agenite/sessions so they survive the browser.
//   GET  /api/sessions           -> index
//   GET  /api/sessions/<id>      -> one conversation
//   POST /api/sessions           -> upsert  { conv }
//   POST /api/sessions/delete    -> remove  { id }
async function handleSessions(req, res, url) {
  try {
    if (req.method === 'GET' && url === '/api/sessions') {
      return sendJson(res, 200, { ok: true, dir: SESSIONS_DIR, sessions: await listSessions() });
    }
    if (req.method === 'GET') {
      const id = decodeURIComponent(url.slice('/api/sessions/'.length));
      const conv = await readSession(id);
      return conv ? sendJson(res, 200, { ok: true, conv }) : sendJson(res, 404, { ok: false, error: '未找到' });
    }
    if (req.method === 'POST' && url === '/api/sessions/delete') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return sendJson(res, 200, { ok: await deleteSession(body.id) });
    }
    if (req.method === 'POST' && url === '/api/sessions') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const convs = Array.isArray(body.convs) ? body.convs : body.conv ? [body.conv] : [];
      const saved = [];
      for (const c of convs.slice(0, 50)) {
        try { saved.push(await writeSession(c)); } catch (e) { saved.push({ error: e.message }); }
      }
      return sendJson(res, 200, { ok: true, saved });
    }
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message });
  }
}

// Client answers an approval request here.
async function handleApprove(req, res) {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const entry = pendingApprovals.get(body.id);
    if (!entry) return sendJson(res, 404, { ok: false, error: '审批已过期或不存在' });
    pendingApprovals.delete(body.id);
    entry.resolve({ approved: !!body.approved, reason: body.reason });
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message });
  }
}

// Flat workspace file index for the UI's "@" mention picker.
// Cached briefly so typing "@" repeatedly does not re-walk the tree every time.
let filesCache = { at: 0, list: null };
async function handleFiles(req, res) {
  try {
    const fresh = Date.now() - filesCache.at < 5000 && filesCache.list;
    if (!fresh) {
      filesCache = { at: Date.now(), list: await scanWorkspaceFiles({ root: WORKSPACE, limit: 2000 }) };
    }
    return sendJson(res, 200, { ok: true, workspace: WORKSPACE, files: filesCache.list });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message, files: [] });
  }
}

// List models Ollama has already pulled locally (so the user can pick from a
// dropdown instead of guessing names). Fails gracefully when Ollama isn't up.
async function fetchOllamaModels() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: ctrl.signal });
    if (!res.ok) return { running: false, models: [] };
    const data = await res.json().catch(() => ({ models: [] }));
    const models = Array.isArray(data.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function handleOllamaModels(req, res) {
  return sendJson(res, 200, await fetchOllamaModels());
}

async function handleSkillsList(req, res) {
  try {
    return sendJson(res, 200, { builtin: listBuiltinSkills(), custom: await listSkills(MEMORY_DIR) });
  } catch {
    return sendJson(res, 200, { builtin: listBuiltinSkills(), custom: [] });
  }
}

async function handlePersonasList(req, res) {
  try {
    return sendJson(res, 200, { builtin: BUILTIN_PERSONAS, custom: await listPersonas(MEMORY_DIR) });
  } catch {
    return sendJson(res, 200, { builtin: BUILTIN_PERSONAS, custom: [] });
  }
}

async function handlePersonaSave(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { error: '请求体解析失败' });
  }
  if (!body || !body.name || !String(body.system_prompt || '').trim()) {
    return sendJson(res, 400, { error: 'name 与 system_prompt 不能为空' });
  }
  const r = await savePersona(MEMORY_DIR, {
    name: body.name,
    description: body.description || '',
    system_prompt: body.system_prompt
  });
  if (!r.ok) return sendJson(res, 400, { error: r.error });
  return sendJson(res, 200, r);
}

async function handlePersonaDelete(req, res, url) {
  const slug = decodeURIComponent(url.slice('/api/personas/'.length));
  const r = await deletePersona(MEMORY_DIR, slug);
  if (!r.ok) return sendJson(res, 404, { error: r.error });
  return sendJson(res, 200, r);
}

// ── Autonomous goals ────────────────────────────────────────────────────────
// These run as independent, long-lived sessions (not tied to an HTTP request),
// persisting state to ~/.agenite/memory/goals so they survive refreshes/restarts.
async function handleGoalCreate(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { error: '请求体解析失败' });
  }
  const r = await createGoal({ goal: body.goal, title: body.title, config: body.config });
  if (!r.ok) return sendJson(res, 400, { error: r.error });
  return sendJson(res, 200, r);
}

async function handleGoalsList(req, res) {
  try {
    return sendJson(res, 200, { goals: await listGoals() });
  } catch {
    return sendJson(res, 200, { goals: [] });
  }
}

async function handleGoalGet(req, res, url) {
  const id = decodeURIComponent(url.slice('/api/goals/'.length));
  const g = await getGoal(id);
  if (!g) return sendJson(res, 404, { error: '未找到该目标' });
  return sendJson(res, 200, g);
}

async function handleGoalStop(req, res, url) {
  const id = decodeURIComponent(url.slice('/api/goals/'.length).replace(/\/stop$/, ''));
  stopGoal(id);
  return sendJson(res, 200, { ok: true });
}

async function handleGoalDelete(req, res, url) {
  const id = decodeURIComponent(url.slice('/api/goals/'.length));
  const r = await deleteGoal(id);
  if (!r.ok) return sendJson(res, 404, { error: r.error });
  return sendJson(res, 200, r);
}

// ---------- Agenite Atlas handlers ----------

// Shared system prompt for knowledge extraction — used by both the manual
// "build from conversation" endpoint and the fire-and-forget auto-build.
const ATLAS_EXTRACT_SYSTEM =
  '你是一个知识抽取器。阅读用户提供的对话/资料，抽取其中的实体与关系，只输出一个 JSON 对象（不要任何解释、不要 markdown 代码块），形如：\n' +
  '{"nodes":[{"type":"person|project|concept|file|tool|preference|fact|event","label":"名称","description":"一句话说明"}],' +
  '"edges":[{"from":"源实体名称","to":"目标实体名称","type":"关系类型(英文，如 competes_with/part_of/uses/maintained_by/located_in/related_to)","label":"中文说明"}]}\n' +
  '只抽取确凿出现的信息；node 的 label 要简洁唯一；edge 的 from/to 必须是前面 nodes 里出现过的 label。';

// Extract entities/relations from a text blob into the persistent graph.
// Reused by handleAtlasExtract (manual) and the auto-build path. Never throws —
// extraction is best-effort everywhere it is used.
async function buildAtlasFromText(text, config) {
  const out = await callModelStream({
    config,
    messages: [
      { role: 'system', content: ATLAS_EXTRACT_SYSTEM },
      { role: 'user', content: text }
    ],
    onDelta: () => {}
  });
  const ext = parseAtlasExtraction(out.content || '');
  const g = await loadAtlas(MEMORY_DIR);
  const applied = applyExtraction(g, ext);
  await saveAtlas(g, MEMORY_DIR);
  return { ext, applied, stats: atlasStats(g) };
}

async function handleAtlasGet(req, res) {
  const g = await loadAtlas(MEMORY_DIR);
  return sendJson(res, 200, { ok: true, graph: g, stats: atlasStats(g) });
}

async function handleAtlasPost(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { ok: false, error: '无效的 JSON' }); }
  const g = await loadAtlas(MEMORY_DIR);
  const a = body.action;
  let r;
  if (a === 'add') r = addNode(g, { type: body.type, label: body.label, description: body.description, provenance: body.provenance });
  else if (a === 'link') r = linkNodes(g, { from: body.from, to: body.to, type: body.edge_type, label: body.edge_label });
  else if (a === 'note') {
    if (!body.text) return sendJson(res, 400, { ok: false, error: 'note 需要提供 text' });
    const n = addNode(g, { type: body.type || 'fact', label: String(body.text).slice(0, 60), description: body.text });
    if (body.from) linkNodes(g, { from: body.from, to: n.node.id, type: body.edge_type || 'related_to' });
    r = { ok: true, node: n.node };
  } else if (a === 'remove_node') r = removeNode(g, body.id || body.label);
  else if (a === 'remove_edge') r = removeEdge(g, body.id);
  else return sendJson(res, 400, { ok: false, error: '未知 action' });
  if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error });
  await saveAtlas(g, MEMORY_DIR);
  return sendJson(res, 200, { ok: true, stats: atlasStats(g), node: r.node, edge: r.edge });
}

async function handleAtlasExtract(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { ok: false, error: '无效的 JSON' }); }
  const text = String(body.text || '').trim();
  if (!text) return sendJson(res, 400, { ok: false, error: '请提供要抽取的文本' });
  const config = normalizeConfig({ ...body.config, workspace: WORKSPACE });
  const validation = validateConfig(config);
  if (!validation.ok || !config.apiKey || !config.model) {
    return sendJson(res, 400, { ok: false, error: '未配置模型或 API Key，无法自动抽取（可手动添加节点）。' });
  }
  try {
    const r = await buildAtlasFromText(text, config);
    return sendJson(res, 200, { ok: true, extracted: r.ext, applied: r.applied, stats: r.stats });
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: '模型调用失败：' + (e.message || e) });
  }
}

async function handleAtlasReset(req, res) {
  const g = await loadAtlas(MEMORY_DIR);
  // keep meta timestamps; wipe content
  g.nodes = {};
  g.edges = [];
  await saveAtlas(g, MEMORY_DIR);
  return sendJson(res, 200, { ok: true, stats: atlasStats(g) });
}

// Export the graph as a hand-editable Markdown file.
async function handleAtlasMarkdownGet(req, res) {
  const g = await loadAtlas(MEMORY_DIR);
  return sendJson(res, 200, { ok: true, markdown: exportAtlasMarkdown(g) });
}

// Import a (possibly hand-edited) Markdown file back into the graph, merging
// by type+label. Never throws — a bad file just yields zero parsed entities.
async function handleAtlasMarkdownPost(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { ok: false, error: '无效的 JSON' }); }
  const md = String(body.markdown || '').trim();
  if (!md) return sendJson(res, 400, { ok: false, error: '请提供 markdown' });
  const ext = importAtlasMarkdown(md);
  if (!ext.nodes.length && !ext.edges.length) {
    return sendJson(res, 400, { ok: false, error: '未从 Markdown 解析到任何节点 / 关系' });
  }
  const g = await loadAtlas(MEMORY_DIR);
  const applied = mergeGraph(g, ext);
  await saveAtlas(g, MEMORY_DIR);
  return sendJson(res, 200, { ok: true, parsed: ext, applied, stats: atlasStats(g) });
}

// Recall the entity's appearances across past conversations (best-effort).
async function handleAtlasRecall(req, res, reqUrl) {
  const u = new URL(reqUrl || '/', 'http://localhost');
  const label = u.searchParams.get('label') || '';
  if (!label.trim()) return sendJson(res, 400, { ok: false, error: '需要 label 参数' });
  try {
    const list = await listSessions();
    const sessions = [];
    for (const meta of list.slice(0, 200)) {
      const s = await readSession(meta.id);
      if (s) sessions.push(s);
    }
    const matches = searchSessionsForLabel(sessions, label, { limit: 12 });
    return sendJson(res, 200, { ok: true, label, matches });
  } catch {
    return sendJson(res, 200, { ok: true, label, matches: [] });
  }
}

// ---------- Agenite Run Trace handlers ----------

async function handleTracesList(req, res) {
  const traces = await listTraces(TRACES_DIR);
  return sendJson(res, 200, { ok: true, traces });
}

async function handleTraceGet(req, res, reqUrl) {
  const u = new URL(reqUrl || '/', 'http://localhost');
  const id = decodeURIComponent(u.pathname.replace(/^\/api\/traces\/?/, '').trim());
  if (!id) return sendJson(res, 400, { ok: false, error: '缺少 runId' });
  try {
    const t = await loadTrace(TRACES_DIR, id);
    return sendJson(res, 200, { ok: true, trace: t, summary: traceSummary(t), diagnosis: diagnoseTrace(t, { maxCostUSD: 0 }) });
  } catch {
    return sendJson(res, 404, { ok: false, error: '未找到该轨迹（可能已被清理）' });
  }
}

async function handleTraceDelete(req, res, reqUrl) {
  const u = new URL(reqUrl || '/', 'http://localhost');
  const id = decodeURIComponent(u.pathname.replace(/^\/api\/traces\/?/, '').trim());
  if (!id) return sendJson(res, 400, { ok: false, error: '缺少 runId' });
  const ok = await deleteTrace(TRACES_DIR, id);
  return sendJson(res, ok ? 200 : 404, { ok, deleted: id });
}

// ---------- Agenite Eval handlers ----------
// Eval replays real past runs (frozen tools) against the model, so it is a
// long-running, multi-call operation. We accept the request, kick off the run
// in the background (like goals), and let the client poll GET /api/evals/:id.
const evalJobs = new Map(); // evalId -> { status, error }

async function handleEvalCreate(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { ok: false, error: '无效的 JSON' });
  }
  const config = normalizeConfig({ ...body.config, workspace: WORKSPACE });
  const validation = validateConfig(config);
  if (!validation.ok || !config.apiKey || !config.model) {
    return sendJson(res, 400, { ok: false, error: '未配置模型或 API Key，无法运行评估（评估会真实调用模型）。' });
  }
  // Keep eval deterministic: no MCP tools (they would break frozen replay).
  const agentEnabled = body.agentEnabled !== false && config.agentEnabled;
  const tools = agentEnabled ? activeTools(config) : [];
  // Same default budget guardrail as chat, so a runaway eval can't burn money.
  if (!config.budget || !(Number(config.budget.maxCostUSD) > 0)) {
    config.budget = { ...(config.budget || {}), maxCostUSD: 3 };
  }

  const traceIds = Array.isArray(body.traceIds) ? body.traceIds : [];
  if (!traceIds.length) {
    return sendJson(res, 400, { ok: false, error: '请至少选择一个轨迹作为评估用例。' });
  }
  const cases = [];
  for (const id of traceIds) {
    try {
      const t = await loadTrace(TRACES_DIR, id);
      cases.push(traceToCase(t));
    } catch { /* skip unreadable / corrupt */ }
  }
  if (!cases.length) {
    return sendJson(res, 400, { ok: false, error: '没有可用的轨迹（可能已被清理）。' });
  }

  const trials = Math.min(5, Math.max(1, Number(body.trials) || 1));
  const ac = new AbortController();
  const callModel = buildCallModel(config, tools, ac.signal);

  // Start the background run and remember the job so GET /api/evals/:id can
  // report "running" until the report is persisted.
  const placeholder = { status: 'running' };
  // runEval generates its own evalId; capture it via the returned report. We
  // can't know the id before running, so stash by a temp key and re-key after.
  const tempKey = 'tmp_' + Date.now().toString(36);
  evalJobs.set(tempKey, placeholder);
  void runEval({ cases, callModel, config, tools, trials, dir: EVALS_DIR })
    .then((report) => {
      evalJobs.delete(tempKey);
      evalJobs.set(report.evalId, { status: 'done' });
      return pruneEvals(EVALS_DIR);
    })
    .catch((e) => {
      evalJobs.delete(tempKey);
      evalJobs.set(tempKey, { status: 'error', error: e && e.message ? e.message : String(e) });
    });

  return sendJson(res, 202, {
    ok: true, status: 'running', tempKey, cases: cases.length, trials,
    note: '评估在后台运行（会真实调用模型并消耗额度），完成后可在「历史评估」中查看报告。'
  });
}

async function handleEvalsList(req, res) {
  const evals = await listEvals(EVALS_DIR);
  return sendJson(res, 200, { ok: true, evals });
}

async function handleEvalGet(req, res, reqUrl) {
  const u = new URL(reqUrl || '/', 'http://localhost');
  const id = decodeURIComponent(u.pathname.replace(/^\/api\/evals\/?/, '').trim());
  if (!id) return sendJson(res, 400, { ok: false, error: '缺少 evalId' });
  // A temp job still running?
  const job = evalJobs.get(id);
  if (job && job.status === 'running') return sendJson(res, 200, { ok: true, status: 'running' });
  if (job && job.status === 'error') return sendJson(res, 200, { ok: true, status: 'error', error: job.error });
  try {
    const r = await loadEval(EVALS_DIR, id);
    return sendJson(res, 200, { ok: true, status: 'done', report: r });
  } catch {
    return sendJson(res, 404, { ok: false, error: '未找到该评估（可能仍在运行或已被清理）。' });
  }
}

async function handleEvalDelete(req, res, reqUrl) {
  const u = new URL(reqUrl || '/', 'http://localhost');
  const id = decodeURIComponent(u.pathname.replace(/^\/api\/evals\/?/, '').trim());
  if (!id) return sendJson(res, 400, { ok: false, error: '缺少 evalId' });
  const ok = await deleteEval(EVALS_DIR, id);
  return sendJson(res, ok ? 200 : 404, { ok, deleted: id });
}

// ---------- Agenite Browser handlers ----------
// Returns the live state of the built-in browser so the UI can show exactly
// what the agent is looking at (URL, title, fresh screenshot). Never throws —
// when Chrome/puppeteer-core are missing it reports available:false.
async function handleBrowserGet(req, res) {
  try {
    const st = await BROWSER.status();
    return sendJson(res, 200, st);
  } catch (e) {
    return sendJson(res, 200, { ok: false, available: false, open: false, error: e && e.message ? e.message : String(e) });
  }
}

async function handleBrowserClose(req, res) {
  try {
    const r = await BROWSER.close();
    return sendJson(res, 200, r);
  } catch (e) {
    return sendJson(res, 200, { ok: false, error: e && e.message ? e.message : String(e) });
  }
}

// Validate the user's provider key/model by issuing a minimal completion.
// Returns the structured { ok, errorClass, message } from client.js.
async function handleVerifyKey(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch {
    return sendJson(res, 400, { ok: false, error: '请求体解析失败' });
  }
  const config = normalizeConfig({ ...body, workspace: WORKSPACE });
  const r = await verifyKey(config);
  return sendJson(res, 200, r);
}

// Suggested follow-up prompts. A single tiny, tool-free completion that asks
// the model for 3 short next-question chips. Strictly best-effort: any failure
// returns an empty list so the client simply shows nothing.
async function handleSuggest(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch {
    return sendJson(res, 200, { suggestions: [] });
  }
  const config = normalizeConfig({ ...(body.config || {}), workspace: WORKSPACE });
  const noKey = !config.apiKey || !config.apiKey.trim();
  if (noKey && config.provider !== 'ollama') return sendJson(res, 200, { suggestions: [] });

  const lastUser = String(body.lastUser || '').slice(0, 1200);
  const lastAssistant = String(body.lastAssistant || '').slice(0, 2400);
  if (!lastAssistant.trim()) return sendJson(res, 200, { suggestions: [] });

  const sys =
    '你是一个对话助手。根据用户刚收到的回复，提出 3 个简短、具体、可点击的"下一步"追问，' +
    '帮助用户深入或行动。要求：每条不超过 22 个汉字；不要解释、不要编号外的标点；' +
    '只输出一个 JSON 数组，例如 ["解释刚才的方案","给个可运行示例","可能有什么风险"]。' +
    '不要输出任何额外文字或 markdown 代码块。';
  const userText = `用户刚才问：\n${lastUser}\n\n助手刚才回答：\n${lastAssistant}\n\n请给出 3 个下一步追问（JSON 数组）：`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let buf = '';
  try {
    await callModelStream({
      config: { ...config, maxTokens: 140, temperature: 0.4 },
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userText }
      ],
      onDelta: (d) => { buf += (d.content || ''); }
    }, ctrl.signal);
    const suggestions = parseSuggestions(buf);
    return sendJson(res, 200, { suggestions });
  } catch {
    return sendJson(res, 200, { suggestions: [] });
  } finally {
    clearTimeout(timer);
  }
}

// Tolerant extraction of a JSON string array from loosely-formatted model
// output (may include markdown fences or stray prose). Returns <=3 strings.
function parseSuggestions(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  let arr;
  try { arr = JSON.parse(raw); }
  catch {
    const s = raw.indexOf('[');
    const e = raw.lastIndexOf(']');
    if (s === -1 || e === -1 || e <= s) return [];
    try { arr = JSON.parse(raw.slice(s, e + 1)); }
    catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out = arr
    .map((x) => String(x || '').replace(/^[0-9]+[.、)]\s*/, '').trim())
    .filter((x) => x.length >= 2 && x.length <= 40)
    .slice(0, 3);
  return out;
}

// Embedding via a local Ollama model — powers fully-on-device semantic memory.
// Returns a number[] or null on any failure (recall then falls back to keyword).
const OLLAMA_EMBED_MODEL = process.env.AGENITE_EMBED_MODEL || 'nomic-embed-text';
async function ollamaEmbed(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: String(text) })
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const e = Array.isArray(data.embedding) ? data.embedding : null;
    return e && e.length ? e : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Built-in personas the user can adopt from the Agent Gallery or Settings.
// Custom ones live as files under ~/.agenite/memory/personas and are merged
// in via /api/personas. `icon`/`tagline` drive the gallery cards.
const BUILTIN_PERSONAS = [
  { name: 'default', icon: '⚖️', tagline: '均衡的通用智能体', description: '均衡的通用智能体（默认）', system_prompt: '' },
  {
    name: 'fullstack',
    icon: '🧩',
    tagline: '全栈工程师 · 能写能跑能测',
    description: '全栈工程师：从需求到可运行代码，重视可测试与最小改动',
    system_prompt: '你是一位经验丰富的全栈工程师。面对需求时先拆解成小步骤，优先给出可运行、可测试的代码片段，而不是伪代码。写文件后主动跑测试/构建验证。保持改动最小、职责清晰，遇到歧义先确认关键约束再动手。'
  },
  {
    name: 'strict-reviewer',
    icon: '🔍',
    tagline: '严厉的代码审查员',
    description: '严厉的资深代码审查员：聚焦正确性、边界、错误、安全与性能',
    system_prompt: '你是一位严厉的资深代码审查员。审查代码时聚焦：正确性、边界条件、错误处理、安全漏洞、性能与可维护性。先给总体判断（LGTM / 需修改），再逐条列出具体问题，每条给出文件位置与修复建议。不要客套，直接指出问题。'
  },
  {
    name: 'warm-writer',
    icon: '✍️',
    tagline: '温柔的专业写手',
    description: '温柔的专业写作助手：把想法写成清晰、有温度的文字',
    system_prompt: '你是一位温柔而专业的写作助手。帮助用户把想法组织成清晰、有温度、结构分明的文字。多用具体例子，少用 jargon。先理解意图再动笔，必要时反问澄清，而不是替用户做过多假设。'
  },
  {
    name: 'researcher',
    icon: '📚',
    tagline: '严谨的研究员',
    description: '严谨的研究员：论证要有依据、标注来源、区分事实与推测',
    system_prompt: '你是一位严谨的研究员。回答要有依据，明确区分「事实 / 推测 / 待验证」。涉及外部信息时优先用 web_search / web_fetch 核实并标注来源。给出结论前先呈现关键证据与可能的反例。'
  },
  {
    name: 'data-analyst',
    icon: '📊',
    tagline: '数据分析师 · 用数据说话',
    description: '数据分析师：清洗、统计、可视化，结论可复现',
    system_prompt: '你是一位数据分析师。面对数据类任务，先理解字段与口径，再做清洗与统计；能用代码（Python/SQL/JS）复现的分析优先写代码并给出结果。结论要区分相关与因果，给出不确定性，并指出数据局限。'
  },
  {
    name: 'translator',
    icon: '🌐',
    tagline: '多语翻译官',
    description: '翻译官：保意保调，标注文化与术语差异',
    system_prompt: '你是一位专业的多语言翻译。翻译时优先保真「意思 + 语气 + 读者预期」，而不是逐字直译；遇到文化梗、双关或术语差异时给出简短译注。除非用户指定，否则只输出译文与相关说明，不要画蛇添足。'
  },
  {
    name: 'security-auditor',
    icon: '🛡️',
    tagline: '安全审计员',
    description: '安全审计员：找漏洞、给风险等级与加固建议',
    system_prompt: '你是一位安全审计员。审查代码/配置时系统排查注入、XSS、越权、密钥泄露、路径遍历、SSRF、依赖风险等，并给出风险等级（高/中/低）与可落地的加固建议。默认最小权限原则；发现高危项要明确告警。'
  },
  {
    name: 'devops',
    icon: '⚙️',
    tagline: 'DevOps / SRE',
    description: 'DevOps 工程师：部署、CI、可观测、故障定位',
    system_prompt: '你是一位 DevOps / SRE。关注部署流程、CI/CD、可观测性、回滚与故障定位。给出的命令要幂等、可回滚，并提示风险。涉及线上操作务必先说明影响面与兜底方案，再建议执行。'
  },
  {
    name: 'product-manager',
    icon: '🧭',
    tagline: '产品经理',
    description: '产品经理：把目标拆成需求、优先级与验收标准',
    system_prompt: '你是一位产品经理。面对想法先澄清目标用户与核心问题，再拆成带优先级的需求与可衡量的验收标准。用用户故事与场景说话，主动暴露假设与取舍，避免一上来就谈实现细节。'
  },
  {
    name: 'interviewer',
    icon: '🎙️',
    tagline: '面试教练',
    description: '面试教练：结构化追问 + 反馈',
    system_prompt: '你是一位面试教练。针对岗位要求出结构化题目，循序渐进追问，考察深度而非背诵；每轮给出简要反馈与下一步建议。保持专业、尊重，重点帮助对方暴露思路而非难倒对方。'
  },
  {
    name: 'meeting-notes',
    icon: '🗒️',
    tagline: '会议纪要官',
    description: '会议纪要：提炼决策、待办与负责人',
    system_prompt: '你是一位会议纪要助手。把冗长讨论提炼成：决策、行动项（带负责人与时限）、遗留问题、下次会议议题。用要点呈现，去掉口水话，确保「谁、做什么、何时」一目了然。'
  },
  {
    name: 'resume-coach',
    icon: '📄',
    tagline: '简历优化师',
    description: '简历优化：用成果量化、对齐岗位',
    system_prompt: '你是一位简历优化师。帮助把经历改写成「动作 + 量化成果 + 影响力」的写法，对齐目标岗位的关键词。指出空话与重复，给出可直接替换的句子，必要时反问以补全关键信息。'
  },
  {
    name: 'brainstorm',
    icon: '💡',
    tagline: '头脑风暴伙伴',
    description: '头脑风暴：发散 + 收敛，给可落地下一步',
    system_prompt: '你是一位头脑风暴伙伴。先大量发散（不急于评判），再帮你收敛成 2-3 个最有潜力的方向，每个给一句话价值主张与最小验证步骤。鼓励非常规想法，但最后一定落到可执行的下一步。'
  }
];

function buildSystemPrompt(config, workspace, planning = false, mcpCount = 0, memory = '', skills = '', persona = '', atlas = '', kb = '') {
  const extra = (config.systemPrompt || '').trim();
  const base = [
    'You are Agenite, a capable local AI agent running on the user\'s own computer.',
    `The current date is ${new Date().toISOString().slice(0, 10)}.`,
    `Your workspace (the folder you may read, write and run commands in) is: ${workspace}`,
    'When the user asks you to do something on their machine, use the tools instead of only describing steps.',
    'Prefer relative paths inside the workspace. Take small, verifiable steps and report what you did concisely.',
    'When you write code or files, keep changes minimal and explain them briefly afterwards.',
    'When a request decomposes into several INDEPENDENT sub-tasks (no shared intermediate state), prefer the `fanout` tool to run them in parallel at once — it is much faster than calling `delegate` repeatedly. Use `delegate` for a single focused side task, or when sub-tasks depend on each other.',
    'TASK TRACKING: for anything that takes 3+ steps, or when the user hands you several things at once, call `todo_write` FIRST to lay out the whole checklist (always include a final verification step), then keep it truthful as you go — exactly one item in_progress, mark each one completed the moment it is really done, and resend the complete list every time. This is how you avoid finishing step 12 having forgotten what step 1 was for. Skip it only for genuinely single-step requests.',
    '你可以在设置里切换「角色人格」(persona) 来改变说话与思维方式（如 strict-reviewer / warm-writer / researcher，或自定义）。若当前任务明显更适合某个角色，主动建议用户切换。',
    'GIT 安全网：每次你改动文件后，系统会自动把工作区 git 提交（署名 Agenite Agent (agenite)），因此任何一步改坏都能随时 `git undo` 一键回退——你可以放心大胆地改。想查看改动用 `git diff`，想回退用 `git undo`，想看历史用 `git log`。不要在 git 操作上犹豫或反复确认，安全网已经兜底。'
  ];
  if (config.gitCheckpoint === false) {
    base.push('（本次已关闭自动 git 提交安全网：你的改动不会自动提交，需要手动用 `git commit` 或 `git` 工具保存。）');
  }
  if (config.autoVerify && config.autoVerify !== 'off') {
    base.push(
      config.autoVerify === 'full'
        ? '自动验证：每次你改完文件后，系统会自动运行本项目的校验命令（自动探测 npm test / cargo test / go test / pytest / make test，或用户配置的命令）。失败时你会收到压缩后的结构化失败摘要——那是真实结果，请据此修复，不要靠猜，也不要为了让检查变绿而删改测试本身。'
        : '自动验证：每次你改完文件后，系统会对改动过的文件做语法快检；出错会立刻反馈给你。若要更强的保证（跑真实测试），可主动调用 `verify` 工具并传 level="full"。'
    );
    base.push('不要口头声称"已完成/应该没问题"——在收尾前用 `verify` 自证一次，把证据摆出来。');
  }
  if (planning) {
    base.push(
      'PLAN MODE: First, think through the task and respond with a clear, step-by-step PLAN only. ' +
      'Do NOT call any tools yet. Use a numbered list and mention which tools/files you expect to touch. ' +
      'After the user approves the plan, you will be asked to execute it.'
    );
  }
  if (mcpCount > 0) {
    base.push(
      `已连接 ${mcpCount} 个 MCP 工具服务器（工具名以 mcp__ 开头，例如 mcp__server__tool）。` +
      '这些工具来自外部服务，可让你控制浏览器、桌面、数据库等——需要动机器时优先调用它们。'
    );
  }
  if (memory) base.push(memory);
  if (skills) base.push(skills);
  if (persona) base.push('ROLE / 角色设定：\n' + persona);
  if (atlas) base.push(atlas);
  if (kb) base.push(kb);
  const text = base.join(' ');
  return extra ? text + '\n\n' + extra : text;
}

// Resolve a persona name (built-in or a saved custom file) into its system
// prompt text so it can be injected into the system message. Unknown names
// silently fall back to '' (default behaviour) — never breaks a chat.
async function resolvePersonaText(config, memoryBase) {
  const name = (config.persona || '').trim();
  if (!name || name === 'default') return '';
  const builtin = BUILTIN_PERSONAS.find((p) => p.name === name);
  if (builtin) return builtin.system_prompt || '';
  try {
    const r = await readPersona(memoryBase, name);
    return r.ok ? r.content : '';
  } catch {
    return '';
  }
}

// Build the per-request model caller. Shared by the chat loop and the eval
// replay loop so they always speak to the provider identically.
function buildCallModel(config, tools, signal) {
  return (msgs, { onDelta, onReasoning } = {}) =>
    callModelStream({ config, messages: msgs, tools, onDelta, onReasoning, signal });
}

// ── Local knowledge base (RAG) API ─────────────────────────────────────────
async function handleKbIngest(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
    return sendJson(res, 400, { error: '请求体解析失败: ' + e.message });
  }
  try {
    let doc = null;
    if (body.path) {
      const abs = isAbsolute(body.path) ? body.path : join(WORKSPACE, body.path);
      doc = await kb().ingestFile(abs, { title: body.title });
    } else if (body.url && body.text) {
      doc = kb().ingestUrl({ url: body.url, text: body.text, title: body.title });
    } else if (body.text) {
      doc = kb().ingestText({ title: body.title || '粘贴内容', text: body.text, source: body.source || 'pasted', kind: 'text' });
    } else {
      return sendJson(res, 400, { error: '需要 text / path / (url+text) 之一' });
    }
    sendJson(res, 200, { ok: true, doc, stats: kb().stats() });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}
function handleKbList(res) {
  sendJson(res, 200, { ok: true, docs: kb().listDocs(), stats: kb().stats() });
}
async function handleKbRetrieve(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
    return sendJson(res, 400, { error: '请求体解析失败: ' + e.message });
  }
  const hits = kb().retrieve(body.query || '', body.k || 5);
  sendJson(res, 200, { ok: true, hits });
}
async function handleKbRemove(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
    return sendJson(res, 400, { error: '请求体解析失败: ' + e.message });
  }
  kb().removeDoc(Number(body.id));
  sendJson(res, 200, { ok: true, stats: kb().stats() });
}
function handleKbClear(res) {
  kb().clear();
  sendJson(res, 200, { ok: true, stats: kb().stats() });
}
async function handleAgents(res) {
  let custom = [];
  try { custom = await listPersonas(MEMORY_DIR); } catch { custom = []; }
  const customAgents = custom.map((p) => ({
    name: p.name,
    icon: '🧠',
    tagline: p.description || '自定义智能体',
    description: p.description || '用户自定义智能体',
    system_prompt: p.system_prompt,
    custom: true,
    slug: p.slug
  }));
  sendJson(res, 200, {
    ok: true,
    agents: [
      ...BUILTIN_PERSONAS.map((p) => ({
        name: p.name, icon: p.icon, tagline: p.tagline, description: p.description, system_prompt: p.system_prompt
      })),
      ...customAgents
    ]
  });
}

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: '请求体解析失败: ' + e.message });
  }

  const config = normalizeConfig({ ...body.config, workspace: WORKSPACE });
  const validation = validateConfig(config);
  if (!validation.ok) {
    return sendJson(res, 400, { error: validation.errors.join('；') });
  }

  // Interactive chat gets a default cost guardrail even when the client didn't
  // set one (autonomous goals carry their own rails in goals.js). This keeps an
  // accidental loop from silently burning money — the 2026 "agents need
  // guardrails, not just observability" baseline. The client can raise/lower it
  // from Settings (budget.maxCostUSD); 0 means "use this default".
  if (!config.budget || !(Number(config.budget.maxCostUSD) > 0)) {
    config.budget = { ...(config.budget || {}), maxCostUSD: 3 };
  }

  const agentEnabled = body.agentEnabled !== false && config.agentEnabled;

  // Live task checklist, keyed by conversation. The HTTP layer is stateless
  // (the client resends the whole transcript every turn), but the checklist
  // must survive across turns — otherwise the model would rebuild it from
  // scratch on every message and the "one in_progress" invariant would mean
  // nothing. Clients without a convId share a single scratch state.
  const todoState = todoStateFor(body.convId);

  // Connect / disconnect MCP servers the client asked for, then merge their
  // tools into what the model can call. Reconcile is idempotent, so already
  // connected servers are reused instead of re-spawning on every message.
  const mcpServers = Array.isArray(body.mcpServers) ? body.mcpServers : [];
  let mcpTools = [];
  try {
    await mcp.reconcile(mcpServers);
    mcpTools = mcp.listToolDefs();
  } catch (e) {
    console.warn('[mcp] reconcile failed:', e.message);
  }
  const tools = agentEnabled ? [...activeTools(config), ...mcpTools] : [];
  // Memory tools only make sense when long-term memory is enabled.
  if (config.memoryEnabled === false) {
    for (let i = tools.length - 1; i >= 0; i--) {
      if (tools[i].name && tools[i].name.startsWith('memory_')) tools.splice(i, 1);
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const sse = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const ac = new AbortController();
  let closed = false;
  // Approvals belonging to THIS request only. Cancelling every pending
  // approval on disconnect would kill approvals of other open tabs.
  const myApprovals = new Set();
  // A long tool call (MCP allows 120s) or a slow human approval leaves the
  // stream silent long enough for proxies/browsers to consider it dead.
  // An SSE comment line keeps it warm without disturbing the client parser.
  const heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
  }, 15000);
  const cleanup = () => {
    clearInterval(heartbeat);
    for (const id of myApprovals) {
      const e = pendingApprovals.get(id);
      if (e) { pendingApprovals.delete(id); e.resolve({ approved: false, reason: '连接已关闭' }); }
    }
    myApprovals.clear();
  };
  req.on('close', () => { closed = true; ac.abort(); cleanup(); });

  const contextWindow = config.contextWindow || contextWindowFor(config.model);
  const budget = historyBudget({
    contextWindow, maxTokens: config.maxTokens, toolTokens: toolsTokens(tools)
  });
  sse('start', {
    model: config.model,
    provider: config.provider,
    agent: agentEnabled,
    toolCount: tools.length,
    mcp: mcpTools.length,
    workspace: WORKSPACE,
    contextWindow,
    budget,
    maxTurns: config.maxTurns,
    price: priceFor(config.model, config)
  });

  // Prepend a system prompt so the model knows it can act on this machine.
  const incoming = Array.isArray(body.messages) ? body.messages.slice() : [];
  const hasSystem = incoming.some((m) => m.role === 'system');
  const planning = !!(config.planMode || body.planning) && agentEnabled;
  const memoryBlock = config.memoryEnabled !== false ? await injectMemory(MEMORY_DIR) : '';
  // Curated skill packs the user toggled on from the 🧩 技能 gallery, plus the
  // agent's own auto-precipitated skills — combined into one system block.
  const builtinSkillsBlock = resolveBuiltinSkills(config.skills);
  const skillsBlock = [builtinSkillsBlock, config.memoryEnabled !== false ? await injectSkills(MEMORY_DIR) : '']
    .filter(Boolean)
    .join('\n\n');
  const personaText = await resolvePersonaText(config, MEMORY_DIR);
  // Local knowledge graph, compressed into the system prompt so the agent
  // "knows the map" and can reference known people/projects/relations instead
  // of asking again. Off when disabled or when the graph is still empty.
  const atlasBlock = config.atlasInject !== false ? graphToContext(await loadAtlas(MEMORY_DIR)) : '';
  // Local RAG: retrieve the top-k chunks for the user's first message and feed
  // them as grounded context. Fully offline — nothing leaves the machine.
  let kbBlock = '';
  if (config.kbEnabled) {
    const firstUser = incoming.find((m) => m.role === 'user' && m.content);
    const query = firstUser ? (typeof firstUser.content === 'string' ? firstUser.content : '') : '';
    if (query) {
      const hits = kb().retrieve(query, config.kbTopK || 5);
      if (hits.length) {
        const items = hits
          .map((h, i) => `[${i + 1}] 来源《${h.title}》${h.kind === 'url' ? '(' + h.source + ')' : ''}：\n${h.text}`)
          .join('\n\n');
        kbBlock =
          '## 本地知识库（检索到的参考片段）\n' +
          '以下是根据你的问题从本地知识库检索到的资料，仅作参考上下文；引用时请标注来源标题，' +
          '不要编造知识库之外的内容：\n\n' + items;
      }
    }
  }
  const convInstructions = (body.instructions || '').trim();
  let systemContent = buildSystemPrompt(config, WORKSPACE, planning, mcpTools.length, memoryBlock, skillsBlock, personaText, atlasBlock, kbBlock);
  if (convInstructions) {
    systemContent +=
      '\n\n## 本次对话的专属指令\n以下是用户针对【当前这次对话】单独设定的要求，优先级高于上面的通用设定，请在本对话中始终遵守：\n' +
      convInstructions;
  }
  const messages = hasSystem ? incoming : [{ role: 'system', content: systemContent }, ...incoming];

  const callModel = buildCallModel(config, tools, ac.signal);

  // Ask the browser for permission and wait (with a timeout) for the click.
  const requestApproval = ({ name, args, description }) => new Promise((resolveVote) => {
    if (closed) return resolveVote({ approved: false, reason: '连接已关闭' });
    const id = 'apv_' + Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => {
      if (pendingApprovals.has(id)) {
        pendingApprovals.delete(id);
        myApprovals.delete(id);
        resolveVote({ approved: false, reason: '审批超时（120s）' });
      }
    }, 120000);
    myApprovals.add(id);
    pendingApprovals.set(id, {
      resolve: (v) => { clearTimeout(timer); myApprovals.delete(id); resolveVote(v); }
    });
    sse('approval', { id, name, args, description });
  });

  // Semantic memory only when a local Ollama is the provider (zero-cost, on-device).
  const embedFn = config.provider === 'ollama' ? (q) => ollamaEmbed(q) : null;

  // --- Execution trace capture (agent observability) ---
  // Every run becomes a local, replayable evidence chain: model turns,
  // tool-call spans (with args/result/status), sub-agent handoffs, and
  // context compactions. A healthy 200 can still hide a wrong tool or a loop;
  // the trace surfaces it. Persisted in finally() so it survives disconnects.
  const cap = (s, n = 1500) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `…(${s.length - n}字已省略)` : s);
  const firstUser = (incoming.find((m) => m.role === 'user')?.content || '').toString();
  const trace = newTrace({
    title: firstUser.slice(0, 80),
    input: firstUser,
    model: config.model,
    provider: config.provider
  });
  let traceTurnId = null; // current model-turn step (parent for its tools)
  let traceSubId = null;  // current sub-agent step (parent for its tools)

  const onEvent = (type, payload) => {
    // forward to the client unchanged
    if (type === 'delta') sse('delta', { content: payload });
    else if (type === 'reasoning') sse('reasoning', { content: payload });
    else if (type === 'tool_start') sse('tool_start', payload);
    else if (type === 'tool') sse('tool', payload);
    else if (type === 'compact') sse('compact', payload);
    else if (type === 'usage') sse('usage', payload);
    else if (type === 'done') sse('done', payload);
    else if (type === 'subagent') sse('subagent', payload);
    else if (type === 'guardrail') sse('guardrail', payload);
    else if (type === 'todo') sse('todo', payload);

    // capture into the trace (best-effort: never break the chat)
    try {
      if (type === 'assistant') {
        if (!trace.startedAt) trace.startedAt = Date.now();
        const step = addStep(trace, {
          kind: 'turn',
          name: '推理 / 模型回复',
          parentId: traceSubId || null,
          data: {
            content: cap(typeof payload?.content === 'string' ? payload.content : '', 4000),
            toolCalls: (payload?.tool_calls || []).length
          }
        });
        traceTurnId = step.id;
      } else if (type === 'tool') {
        addStep(trace, {
          kind: 'tool',
          name: payload?.name || '',
          parentId: traceSubId || traceTurnId || null,
          ms: payload?.ms || 0,
          status: payload?.ok === false ? 'error' : 'ok',
          data: {
            args: cap(JSON.stringify(payload?.args || {}), 1500),
            result: cap(typeof payload?.result === 'string' ? payload.result : JSON.stringify(payload?.result ?? ''), 1500),
            ok: payload?.ok,
            kind: classifyTool(payload?.name || ''),
            diff: payload?.diff
          }
        });
      } else if (type === 'compact') {
        addStep(trace, { kind: 'compact', name: '上下文压缩', data: payload || {} });
      } else if (type === 'subagent') {
        const ev = payload?.event;
        if (ev === 'start') {
          const step = addStep(trace, {
            kind: 'subagent', name: payload?.name || '子智能体',
            parentId: traceTurnId || null, data: {}
          });
          traceSubId = step.id;
        } else if (ev === 'tool') {
          addStep(trace, {
            kind: 'tool', name: payload?.name || '', parentId: traceSubId || null,
            ms: payload?.ms || 0, status: payload?.ok === false ? 'error' : 'ok',
            data: {
              args: cap(JSON.stringify(payload?.args || {}), 1500),
              result: cap(typeof payload?.result === 'string' ? payload.result : JSON.stringify(payload?.result ?? ''), 1500),
              ok: payload?.ok, kind: classifyTool(payload?.name || ''), sub: true
            }
          });
        } else if (ev === 'done') {
          traceSubId = null;
        }
      } else if (type === 'usage') {
        if (payload?.cost != null) {
          // store the numeric amount (costOf returns { amount, currency, known })
          trace.cost = (payload.cost && typeof payload.cost.amount === 'number')
            ? payload.cost.amount : (Number(payload.cost) || 0);
        }
      } else if (type === 'guardrail') {
        addStep(trace, { kind: 'guardrail', name: '预算护栏触发', status: 'error', data: payload || {} });
      } else if (type === 'done') {
        trace.finishedAt = Date.now();
        trace.stopped = payload?.stopped || null;
        trace.turns = payload?.turns || 0;
      }
    } catch { /* trace capture is strictly best-effort */ }
  };

  // Used by the context compactor to turn dropped turns into a short recap.
  // A tiny, tool-free, non-streaming call — cheap compared to the 400 error it
  // prevents. Any failure falls back to the mechanical digest.
  //
  // The client re-sends the whole history every turn, so the same prefix would
  // be summarized again on every message. Cache by content so it happens once.
  const summarize = async (digestText) => {
    const key = cacheKey(digestText);
    if (summaryCache.has(key)) return summaryCache.get(key);
    const r = await callModelStream({
      config: { ...config, maxTokens: 700, temperature: 0.2 },
      messages: [
        {
          role: 'system',
          content:
            '你是对话压缩器。把下面的智能体执行记录压缩成简洁要点，必须保留：用户的目标、' +
            '已完成的关键步骤与结论、创建或修改过的文件路径、尚未完成的事项、出现过的重要错误。' +
            '不要臆造内容，不要客套话，用短句列点。'
        },
        { role: 'user', content: digestText }
      ],
      tools: [],
      signal: ac.signal
    });
    const text = r && r.content ? r.content : '';
    if (text) {
      summaryCache.set(key, text);
      if (summaryCache.size > SUMMARY_CACHE_MAX) summaryCache.delete(summaryCache.keys().next().value);
    }
    return text;
  };

  // Route MCP tool calls (names start with mcp__) to the MCP manager, which
  // applies the same approval gate. Everything else goes to the built-ins.
  const executeToolWithMcp = (name, args, o) => {
    if (name.startsWith('mcp__')) {
      return mcp.callToolByName(name, args, { ...o, approvalMode: config.approvalMode, requestApproval });
    }
    return executeTool(name, args, o);
  };

  // Sub-agent runner: the `delegate` tool calls this. It spins a child agent
  // loop in an isolated context and streams its steps back as `subagent` SSE.
  const runSubAgent = createSubAgentRunner({
    callModel,
    executeTool: executeToolWithMcp,
    baseConfig: config,
    tools,
    memoryBase: MEMORY_DIR,
    injectMemory,
    onSubEvent: (id, name, type, payload) => onEvent('subagent', { subId: id, name, event: type, ...payload }),
    summarize,
    requestApproval,
    platform: process.platform
  });

  // Fan-out scheduler: runs several independent sub-agents concurrently and
  // merges their summaries. Built on top of runSubAgent so every child still
  // streams its own `subagent` SSE (with a distinct subId) for the UI.
  const runFanout = createFanoutRunner(runSubAgent);

  // Auto-build the memory graph at the end of a completed chat. Set before the
  // try so finally can read it even on early throws.
  const doAtlasAutoBuild = config.atlasAutoBuild === true;
  let chatStopped = null;

  try {
    const result = await runAgent({
      messages,
      callModel,
      executeTool: executeToolWithMcp,
      onEvent,
      config,
      tools,
      summarize,
      toolContext: { requestApproval, platform: process.platform, memoryBase: MEMORY_DIR, runSubAgent, runFanout, embed: embedFn, browser: BROWSER, todoState, autoGit: config.gitCheckpoint ? autoGitCheckpoint : undefined, autoVerify: makeAutoVerify(config), verifyTimeoutMs: config.verifyTimeoutMs }
    });
    chatStopped = result.stopped;

    // Self-evolving skills, part 2: after a successful complex run, ask the
    // model once (tool-free) whether to crystallize the workflow into a SKILL.
    // Runs before 'end' so the client sees the skill_auto event in-stream.
    if (config.autoSkill && result.stopped === 'done') {
      const reflect = (msgs, o) =>
        callModelStream({
          config: { ...config, maxTokens: 800, temperature: 0.2 },
          messages: msgs,
          tools: [],
          onDelta: o && o.onDelta,
          signal: ac.signal
        });
      try {
        await autoSaveSkill({ messages, callModel: reflect, sse, memoryBase: MEMORY_DIR });
      } catch {
        // Never let skill extraction break a finished chat.
      }
    }

    // Run self-check on the completed trace and surface it as a graded report
    // (ok / warn / bad) — this is the "observability -> actionable" step: the
    // client shows the user WHAT to worry about, not just that the run happened.
    try {
      const maxCostUSD = (config.budget && Number(config.budget.maxCostUSD) > 0) ? config.budget.maxCostUSD : 0;
      sse('diagnosis', diagnoseTrace(trace, { maxCostUSD }));
    } catch { /* never break the chat */ }

    sse('end', { stopped: result.stopped, turns: result.turns, historyTokens: totalTokens(messages), budget });
    res.end();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    sse('error', { message: msg });
    res.end();
  } finally {
    cleanup();
    // Persist the run trace locally (cheap fs write, not a model call) so the
    // execution evidence chain survives disconnects and is replayable later.
    void saveTrace(trace, TRACES_DIR).then(() => pruneTraces(TRACES_DIR)).catch(() => {});
    // Fire-and-forget: don't block the SSE response or reuse ac.signal (which
    // aborts on disconnect). Runs its own model call + atomic save off the
    // event loop; any failure is swallowed so it never breaks the chat.
    if (doAtlasAutoBuild && chatStopped === 'done' && incoming.length) {
      const recent = incoming
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-40)
        .map((m) => (m.role === 'user' ? '用户: ' : '助手: ') + (typeof m.content === 'string' ? m.content : ''))
        .join('\n')
        .trim();
      if (recent) void buildAtlasFromText(recent, config).catch(() => {});
    }
  }
}

// Launch the default browser so `start.cmd` feels like opening an app.
function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch { /* not fatal — the URL is printed anyway */ }
}

// Start listening, but if the port is taken, walk upward to the next free
// one instead of crashing — a common cause of "double-click does nothing".
function listenOn(port) {
  const onErr = (err) => {
    if (err.code === 'EADDRINUSE' && port < 4193) {
      console.log(`  \x1b[33m⚠ 端口 ${port} 已被占用，改试 ${port + 1} ...\x1b[0m`);
      listenOn(port + 1);
    } else {
      console.error(`  \x1b[31m✗ 无法启动服务: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  };
  server.once('error', onErr);
  server.listen(port, HOST, () => {
    server.removeListener('error', onErr);
    const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
    const url = `http://${shown}:${port}`;
    console.log(`\n  \x1b[1mAgenite\x1b[0m 已启动  →  \x1b[36m${url}\x1b[0m`);
    console.log(`  工作区（可操作范围）: ${WORKSPACE}`);
    console.log('  在设置里填入你的模型 API Key（OpenAI / DeepSeek / 通义 / Kimi / 智谱 / Groq / Ollama 等）。');
    console.log('  按 Ctrl+C 退出。\n');
    if (process.argv.includes('--open') || process.env.AGENITE_OPEN === '1') openBrowser(url);
  });
}
listenOn(PORT);

// Mark any goal left "running"/"queued" by a previous process as interrupted —
// there is no cross-process resume yet.
initGoals().catch(() => {});

export { server };
