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
import { activeTools, executeTool, scanWorkspaceFiles } from './src/core/tools.js';

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

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'POST' && url === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && url === '/api/approve') return handleApprove(req, res);
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

function buildSystemPrompt(config, workspace) {
  const extra = (config.systemPrompt || '').trim();
  const base = [
    'You are Agenite, a capable local AI agent running on the user\'s own computer.',
    `The current date is ${new Date().toISOString().slice(0, 10)}.`,
    `Your workspace (the folder you may read, write and run commands in) is: ${workspace}`,
    'When the user asks you to do something on their machine, use the tools instead of only describing steps.',
    'Prefer relative paths inside the workspace. Take small, verifiable steps and report what you did concisely.',
    'When you write code or files, keep changes minimal and explain them briefly afterwards.'
  ].join(' ');
  return extra ? base + '\n\n' + extra : base;
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
  const tools = agentEnabled ? activeTools(config) : [];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const sse = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const ac = new AbortController();
  let closed = false;
  req.on('close', () => { closed = true; ac.abort(); for (const e of pendingApprovals.values()) e.resolve({ approved: false, reason: '连接已关闭' }); });

  sse('start', { model: config.model, provider: config.provider, agent: agentEnabled, toolCount: tools.length, workspace: WORKSPACE });

  // Prepend a system prompt so the model knows it can act on this machine.
  const incoming = Array.isArray(body.messages) ? body.messages.slice() : [];
  const hasSystem = incoming.some((m) => m.role === 'system');
  const messages = hasSystem ? incoming : [{ role: 'system', content: buildSystemPrompt(config, WORKSPACE) }, ...incoming];

  const callModel = (msgs, { onDelta }) =>
    callModelStream({ config, messages: msgs, tools, onDelta, signal: ac.signal });

  // Ask the browser for permission and wait (with a timeout) for the click.
  const requestApproval = ({ name, args, description }) => new Promise((resolveVote) => {
    if (closed) return resolveVote({ approved: false, reason: '连接已关闭' });
    const id = 'apv_' + Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => {
      if (pendingApprovals.has(id)) { pendingApprovals.delete(id); resolveVote({ approved: false, reason: '审批超时（120s）' }); }
    }, 120000);
    pendingApprovals.set(id, { resolve: (v) => { clearTimeout(timer); resolveVote(v); } });
    sse('approval', { id, name, args, description });
  });

  const onEvent = (type, payload) => {
    if (type === 'delta') sse('delta', { content: payload });
    else if (type === 'tool_start') sse('tool_start', payload);
    else if (type === 'tool') sse('tool', payload);
    else if (type === 'done') sse('done', payload);
  };

  try {
    await runAgent({
      messages,
      callModel,
      executeTool,
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

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  const url = `http://${shown}:${PORT}`;
  console.log(`\n  \x1b[1mAgenite\x1b[0m 已启动  →  \x1b[36m${url}\x1b[0m`);
  console.log(`  工作区（可操作范围）: ${WORKSPACE}`);
  console.log('  在设置里填入你的模型 API Key（OpenAI / DeepSeek / 通义 / Kimi / 智谱 / Groq / Ollama 等）。');
  console.log('  按 Ctrl+C 退出。\n');
  if (process.argv.includes('--open') || process.env.AGENITE_OPEN === '1') openBrowser(url);
});

export { server };
