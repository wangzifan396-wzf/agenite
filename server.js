#!/usr/bin/env node
// Agenite local server: serves the UI and proxies chat completions to the
// configured model provider, running the agent tool-calling loop server-side.
// Zero dependencies — just `node server.js` and open the printed URL.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig, validateConfig, PROVIDER_PRESETS } from './src/core/config.js';
import { runAgent } from './src/core/agent.js';
import { callModelStream } from './src/core/client.js';
import { activeTools, executeTool } from './src/core/tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';

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
  '.map': 'application/json',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'POST' && url === '/api/chat') return handleChat(req, res);
  if (req.method === 'GET' && url === '/api/presets') return sendJson(res, 200, PROVIDER_PRESETS);
  if (req.method === 'GET' && url === '/api/health') return sendJson(res, 200, { ok: true });
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
  // prevent path traversal
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
    // SPA-ish fallback to index.html for unknown non-asset routes
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

async function handleChat(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: '请求体解析失败: ' + e.message });
  }

  const config = normalizeConfig(body.config || {});
  const validation = validateConfig(config);
  if (!validation.ok) {
    return sendJson(res, 400, { error: validation.errors.join('；') });
  }

  const agentEnabled = body.agentEnabled !== false && config.agentEnabled;
  const tools = agentEnabled ? activeTools(config) : [];

  // SSE response
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
  req.on('close', () => ac.abort());

  sse('start', { model: config.model, provider: config.provider, agent: agentEnabled, toolCount: tools.length });

  const messages = Array.isArray(body.messages) ? body.messages.slice() : [];

  const callModel = (msgs, { onDelta }) =>
    callModelStream({ config, messages: msgs, tools, onDelta, signal: ac.signal });

  const onEvent = (type, payload) => {
    if (type === 'delta') sse('delta', { content: payload });
    else if (type === 'tool') sse('tool', payload);
    else if (type === 'done') sse('done', payload);
  };

  try {
    await runAgent({ messages, callModel, executeTool, onEvent, config, maxTurns: 10 });
    sse('end', {});
    res.end();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    sse('error', { message: msg });
    res.end();
  }
}

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  Agenite 已启动 →  http://${shown}:${PORT}\n`);
  console.log('  在设置里填入你的模型 API Key（OpenAI / DeepSeek / 通义 / Kimi / 智谱 / Groq / Ollama 等）。');
  console.log('  按 Ctrl+C 退出。\n');
});

export { server };
