#!/usr/bin/env node
// Agenite local server: serves the UI and proxies chat completions to the
// configured model provider, running the agent tool-calling loop server-side.
// Because it is a real local Node process (not the browser), the agent can
// actually read/write files and run commands on THIS machine — gated by a
// workspace sandbox and a human approval step. Zero dependencies.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { normalizeConfig, validateConfig, PROVIDER_PRESETS, APPROVAL_MODES } from './src/core/config.js';
import { runAgent } from './src/core/agent.js';
import { callModelStream } from './src/core/client.js';
import { activeTools, executeTool, scanWorkspaceFiles, applyUndo, setUndoStore } from './src/core/tools.js';
import { McpManager } from './src/core/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
// The machine root the agent is allowed to touch. Defaults to where you ran it.
const WORKSPACE = resolve(process.env.AGENITE_WORKSPACE || process.cwd());

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
  if (req.method === 'GET' && url === '/api/presets') return sendJson(res, 200, PROVIDER_PRESETS);
  if (req.method === 'GET' && url === '/api/health') {
    return sendJson(res, 200, { ok: true, workspace: WORKSPACE, approvalModes: APPROVAL_MODES });
  }
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

function buildSystemPrompt(config, workspace, planning = false, mcpCount = 0) {
  const extra = (config.systemPrompt || '').trim();
  const base = [
    'You are Agenite, a capable local AI agent running on the user\'s own computer.',
    `The current date is ${new Date().toISOString().slice(0, 10)}.`,
    `Your workspace (the folder you may read, write and run commands in) is: ${workspace}`,
    'When the user asks you to do something on their machine, use the tools instead of only describing steps.',
    'Prefer relative paths inside the workspace. Take small, verifiable steps and report what you did concisely.',
    'When you write code or files, keep changes minimal and explain them briefly afterwards.'
  ];
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
  const text = base.join(' ');
  return extra ? text + '\n\n' + extra : text;
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

  const agentEnabled = body.agentEnabled !== false && config.agentEnabled;

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

  sse('start', { model: config.model, provider: config.provider, agent: agentEnabled, toolCount: tools.length, mcp: mcpTools.length, workspace: WORKSPACE });

  // Prepend a system prompt so the model knows it can act on this machine.
  const incoming = Array.isArray(body.messages) ? body.messages.slice() : [];
  const hasSystem = incoming.some((m) => m.role === 'system');
  const planning = !!body.planning && agentEnabled;
  const messages = hasSystem ? incoming : [{ role: 'system', content: buildSystemPrompt(config, WORKSPACE, planning, mcpTools.length) }, ...incoming];

  const callModel = (msgs, { onDelta }) =>
    callModelStream({ config, messages: msgs, tools, onDelta, signal: ac.signal });

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

  const onEvent = (type, payload) => {
    if (type === 'delta') sse('delta', { content: payload });
    else if (type === 'tool_start') sse('tool_start', payload);
    else if (type === 'tool') sse('tool', payload);
    else if (type === 'done') sse('done', payload);
  };

  // Route MCP tool calls (names start with mcp__) to the MCP manager, which
  // applies the same approval gate. Everything else goes to the built-ins.
  const executeToolWithMcp = (name, args, o) => {
    if (name.startsWith('mcp__')) {
      return mcp.callToolByName(name, args, { ...o, approvalMode: config.approvalMode, requestApproval });
    }
    return executeTool(name, args, o);
  };

  try {
    await runAgent({
      messages,
      callModel,
      executeTool: executeToolWithMcp,
      onEvent,
      config,
      toolContext: { requestApproval, platform: process.platform },
      maxTurns: 12
    });
    sse('end', {});
    res.end();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    sse('error', { message: msg });
    res.end();
  } finally {
    cleanup();
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

export { server };
