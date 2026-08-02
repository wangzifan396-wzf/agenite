// MCP (Model Context Protocol) client — this is what turns Agenite from a
// plain chat box into a real agent. It talks JSON-RPC to external MCP servers
// and exposes their tools to the model as `mcp__<serverId>__<toolName>`.
//
// Three transports are supported, which together cover the whole ecosystem:
//   stdio  — spawn a local process (`npx some-mcp-server`). Browser/desktop
//            control, file systems, git, databases…
//   http   — Streamable HTTP (current spec): every message is a POST, replies
//            come back as JSON or as an SSE stream. This is how hosted/cloud
//            MCP servers are reached.
//   sse    — legacy HTTP+SSE: a long-lived GET stream announces a POST
//            endpoint. Still what a large share of deployed servers speak.
//
// Pure-ish: `spawn` and `fetch` are injectable, so everything here is testable
// under node:test against mock servers.
import { spawn, execFileSync } from 'node:child_process';

// Killing an MCP server is not as simple as kill(pid). The usual launch form is
// `npx some-mcp-server`, where npx is merely a launcher that spawns the real
// server as a grandchild. Killing npx alone orphans the actual server, which
// then survives forever holding memory/ports. So we kill the whole tree.
function killTree(pid, force) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true
      });
      return;
    } catch { /* process already gone, or taskkill unavailable — fall through */ }
  }
  try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
}

// MCP servers are third-party and can return enormous payloads (a browser
// automation tool happily hands back a whole rendered page). Anything that
// goes into `messages` must be bounded or the next model call blows the
// context window and the whole run dies with a 400.
export const MCP_MAX_OUTPUT = 12000;

export function truncateMcpOutput(text, max = MCP_MAX_OUTPUT) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(MCP 输出共 ${s.length} 字符，已截断到 ${max})`;
}

// --- naming -----------------------------------------------------------------

// Providers require tool names to match ^[a-zA-Z0-9_-]{1,64}$. Server ids come
// from user-written JSON and tool names from third parties, so both are
// normalized before they ever reach the model.
// Server ids may come from untrusted mcp.json files and are embedded into
// tool names as `mcp__<serverId>__<tool>` (capped at 64 chars downstream).
// Keep the segment short so the resulting tool name stays usable, and clamp
// any absurdly long id before it can blow past that budget.
const SERVER_ID_MAX = 40;
export function sanitizeServerId(id) {
  const s = String(id || '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const trimmed = s.length > SERVER_ID_MAX ? s.slice(0, SERVER_ID_MAX) : s;
  return trimmed || 'server';
}

function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 4).padStart(4, '0');
}

export function fullToolName(serverId, toolName) {
  const raw = `mcp__${serverId}__${toolName}`;
  const safe = raw.replace(/[^a-zA-Z0-9_-]+/g, '_');
  if (safe.length <= 64) return safe;
  return safe.slice(0, 59) + '_' + shortHash(raw);
}

// --- read-only detection ----------------------------------------------------

// Splits `get_pageContent-v2` into ['get','page','content','v2'].
function words(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const READ_VERBS = new Set([
  'get', 'read', 'list', 'search', 'find', 'query', 'fetch', 'describe', 'inspect',
  'show', 'view', 'resolve', 'lookup', 'count', 'stat', 'snapshot', 'screenshot',
  'capture', 'analyze', 'analyse', 'summarize', 'summarise', 'diff', 'check',
  'explain', 'history', 'tail', 'head', 'grep', 'glob', 'dir', 'ls', 'cat',
  'info', 'status', 'peek', 'preview'
]);

const WRITE_VERBS = new Set([
  'write', 'create', 'delete', 'remove', 'update', 'insert', 'drop', 'rename',
  'move', 'copy', 'upload', 'execute', 'exec', 'run', 'shell', 'command', 'kill',
  'install', 'launch', 'open', 'click', 'type', 'press', 'scroll', 'navigate',
  'goto', 'submit', 'fill', 'drag', 'send', 'post', 'put', 'patch', 'commit',
  'push', 'merge', 'deploy', 'restart', 'reboot', 'shutdown', 'set', 'modify',
  'edit', 'apply', 'approve', 'pay', 'purchase', 'transfer', 'close', 'clear',
  'reset', 'stop', 'start', 'add', 'append', 'save', 'store', 'publish',
  'invoke', 'call', 'eval', 'sudo', 'chmod', 'mkdir', 'rm'
]);

/**
 * Heuristic: is this tool obviously incapable of changing anything?
 * Used to skip the approval prompt for things like `list_files` / `get_weather`
 * while anything that could act on the machine still asks. Deliberately
 * conservative — a false "no" only costs one extra click.
 */
export function looksReadOnly(toolName) {
  const w = words(toolName);
  if (!w.length) return false;
  if (w.some((x) => WRITE_VERBS.has(x))) return false;
  return w.some((x) => READ_VERBS.has(x));
}

// --- mcp.json import --------------------------------------------------------

/**
 * Parse a Claude Desktop / Cherry Studio / Cline style config into our server
 * list. Accepts `{ mcpServers: { name: {...} } }`, a bare map, or an array.
 * Understands both stdio (`command`/`args`/`env`) and remote (`url`/`type`).
 */
export function parseMcpConfigJson(text) {
  let j;
  try {
    j = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (e) {
    throw new Error('JSON 解析失败: ' + e.message);
  }
  if (!j || typeof j !== 'object') throw new Error('配置内容不是对象');
  const src = j.mcpServers || j.servers || j;
  const entries = Array.isArray(src)
    ? src.map((v) => [v && (v.id || v.name), v])
    : Object.entries(src);

  const out = [];
  for (const [rawId, v] of entries) {
    if (!v || typeof v !== 'object') continue;
    const id = sanitizeServerId(rawId || v.name || v.id);
    const enabled = v.disabled === true ? false : v.enabled !== false;
    const url = v.url || v.baseUrl || v.endpoint;
    if (url) {
      const t = String(v.type || v.transport || '').toLowerCase();
      const transport = t === 'sse' ? 'sse' : t === 'stdio' ? 'http' : 'http';
      out.push({
        id, label: String(rawId || id), enabled, transport,
        url: String(url), headers: isObj(v.headers) ? v.headers : {}
      });
    } else if (v.command) {
      out.push({
        id, label: String(rawId || id), enabled, transport: 'stdio',
        command: String(v.command),
        args: Array.isArray(v.args) ? v.args.map(String) : [],
        env: isObj(v.env) ? v.env : {}
      });
    }
  }
  if (!out.length) throw new Error('没有找到任何 MCP 服务器（需要 command 或 url 字段）');
  return out;
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// --- SSE frame parser -------------------------------------------------------

// Minimal `text/event-stream` parser: feed it chunks, get {event, data} frames.
export function createSseParser(onFrame) {
  let buf = '';
  return function feed(chunk) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const data = [];
      for (const line of raw.split('\n')) {
        const l = line.replace(/\r$/, '');
        if (!l || l.startsWith(':')) continue;
        const c = l.indexOf(':');
        const field = c < 0 ? l : l.slice(0, c);
        const value = c < 0 ? '' : l.slice(c + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) onFrame({ event, data: data.join('\n') });
    }
  };
}

// --- transports -------------------------------------------------------------

class StdioTransport {
  constructor({ command, args = [], env = {}, spawnFn = spawn }) {
    this.kind = 'stdio';
    this.command = command;
    this.args = args.map(String);
    this.env = env;
    this.spawnFn = spawnFn;
    this.proc = null;
  }

  get pid() { return this.proc ? this.proc.pid : null; }

  describe() { return `stdio · ${this.command} ${this.args.join(' ')}`.trim(); }

  async start(handlers) {
    if (!this.command) throw new Error('缺少 command');
    const proc = this.spawnFn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc = proc;
    proc.on('error', (e) => handlers.onError(e));
    proc.on('exit', (code) => handlers.onClose('进程已退出 (code ' + code + ')'));
    proc.stdout.setEncoding('utf8');
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        handlers.onMessage(msg);
      }
    });
    if (proc.stderr) {
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => handlers.onStderr(String(d)));
    }
  }

  send(obj) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) throw new Error('MCP 进程未启动');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  // Wait (briefly) for the child to actually exit and escalate to a forced
  // tree kill, otherwise stubborn `npx`-launched servers survive as orphans.
  async close({ graceMs = 1500 } = {}) {
    const proc = this.proc;
    if (!proc || proc.exitCode != null || proc.signalCode != null) return;
    await new Promise((done) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); done(); } };
      const timer = setTimeout(() => { killTree(proc.pid, true); finish(); }, graceMs);
      proc.once('exit', finish);
      // Closing stdin is the polite MCP shutdown signal; spec-compliant servers
      // exit on EOF. The tree kill is the guarantee.
      try { proc.stdin && proc.stdin.end(); } catch { /* ignore */ }
      try { killTree(proc.pid, false); } catch { finish(); }
    });
  }

  killSync() { if (this.proc) killTree(this.proc.pid, true); }
}

// Streamable HTTP (MCP spec 2025-03-26). Each client message is a POST; the
// server answers either with a single JSON object or with an SSE stream.
class HttpTransport {
  constructor({ url, headers = {}, fetchImpl }) {
    this.kind = 'http';
    this.url = url;
    this.headers = headers;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.sessionId = null;
    this.ac = new AbortController();
    this.closed = false;
  }

  get pid() { return null; }

  describe() { return `http · ${this.url}`; }

  async start(handlers) {
    if (!this.url) throw new Error('缺少 url');
    if (typeof this.fetchImpl !== 'function') throw new Error('当前环境没有 fetch');
    this.handlers = handlers;
  }

  _headers(extra) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.headers,
      ...extra
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async send(obj) {
    if (this.closed) throw new Error('传输已关闭');
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(obj),
      signal: this.ac.signal
    });
    const sid = res.headers && res.headers.get && res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return; // notification accepted
    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
    if (ct.includes('text/event-stream')) {
      // Read in the background: replies are delivered through onMessage, which
      // is what resolves the pending JSON-RPC promise.
      this._pump(res).catch((e) => {
        if (!this.closed) this.handlers.onError(e);
      });
      return;
    }
    const txt = await safeText(res);
    if (!txt) return;
    try { this._deliver(JSON.parse(txt)); } catch { /* non-JSON body: ignore */ }
  }

  async _pump(res) {
    const feed = createSseParser((frame) => {
      if (!frame.data || frame.data === '[DONE]') return;
      try { this._deliver(JSON.parse(frame.data)); } catch { /* ignore junk */ }
    });
    await readStream(res.body, feed, this.ac.signal);
  }

  _deliver(payload) {
    const list = Array.isArray(payload) ? payload : [payload];
    for (const m of list) if (m && typeof m === 'object') this.handlers.onMessage(m);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ac.abort(); } catch { /* ignore */ }
    // Politely release the session so the server can free resources.
    if (this.sessionId) {
      try {
        await this.fetchImpl(this.url, { method: 'DELETE', headers: this._headers() });
      } catch { /* best effort */ }
    }
  }

  killSync() { try { this.ac.abort(); } catch { /* ignore */ } this.closed = true; }
}

// Legacy HTTP+SSE transport (MCP spec 2024-11-05): open a GET stream, receive
// an `endpoint` event telling us where to POST, then all replies arrive on the
// original stream.
class SseTransport {
  constructor({ url, headers = {}, fetchImpl }) {
    this.kind = 'sse';
    this.url = url;
    this.headers = headers;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.postUrl = null;
    this.ac = new AbortController();
    this.closed = false;
  }

  get pid() { return null; }

  describe() { return `sse · ${this.url}`; }

  async start(handlers, { timeoutMs = 20000 } = {}) {
    if (!this.url) throw new Error('缺少 url');
    if (typeof this.fetchImpl !== 'function') throw new Error('当前环境没有 fetch');
    this.handlers = handlers;
    const res = await this.fetchImpl(this.url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...this.headers },
      signal: this.ac.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await safeText(res)).slice(0, 200)}`);

    let ready;
    const gotEndpoint = new Promise((resolve, reject) => {
      ready = resolve;
      setTimeout(() => reject(new Error('等待 endpoint 事件超时')), timeoutMs).unref?.();
    });

    const feed = createSseParser((frame) => {
      if (frame.event === 'endpoint') {
        try { this.postUrl = new URL(frame.data, this.url).toString(); } catch { this.postUrl = frame.data; }
        ready(true);
        return;
      }
      if (!frame.data) return;
      try {
        const payload = JSON.parse(frame.data);
        const list = Array.isArray(payload) ? payload : [payload];
        for (const m of list) if (m && typeof m === 'object') handlers.onMessage(m);
      } catch { /* ignore junk */ }
    });

    readStream(res.body, feed, this.ac.signal)
      .then(() => { if (!this.closed) handlers.onClose('SSE 流已结束'); })
      .catch((e) => { if (!this.closed) handlers.onError(e); });

    await gotEndpoint;
  }

  async send(obj) {
    if (this.closed) throw new Error('传输已关闭');
    if (!this.postUrl) throw new Error('尚未收到 endpoint');
    const res = await this.fetchImpl(this.postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(obj),
      signal: this.ac.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await safeText(res)).slice(0, 200)}`);
    // Most servers reply 202 and push the answer down the GET stream, but some
    // inline it in the POST response.
    const ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
    if (ct.includes('application/json')) {
      const txt = await safeText(res);
      if (!txt) return;
      try {
        const payload = JSON.parse(txt);
        const list = Array.isArray(payload) ? payload : [payload];
        for (const m of list) if (m && typeof m === 'object') this.handlers.onMessage(m);
      } catch { /* ignore */ }
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ac.abort(); } catch { /* ignore */ }
  }

  killSync() { try { this.ac.abort(); } catch { /* ignore */ } this.closed = true; }
}

async function readStream(body, feed, signal) {
  if (!body) return;
  // Node's fetch gives a web ReadableStream; be tolerant of async iterables too.
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      if (signal && signal.aborted) { try { await reader.cancel(); } catch { /* ignore */ } return; }
      const { done, value } = await reader.read();
      if (done) return;
      feed(decoder.decode(value, { stream: true }));
    }
  }
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    if (signal && signal.aborted) return;
    feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
  }
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

export function createTransport(opts = {}, deps = {}) {
  const kind = String(opts.transport || (opts.url ? 'http' : 'stdio')).toLowerCase();
  if (kind === 'http' || kind === 'streamablehttp' || kind === 'streamable-http') {
    return new HttpTransport({ url: opts.url, headers: opts.headers, fetchImpl: deps.fetchImpl });
  }
  if (kind === 'sse') {
    return new SseTransport({ url: opts.url, headers: opts.headers, fetchImpl: deps.fetchImpl });
  }
  return new StdioTransport({
    command: opts.command, args: opts.args, env: opts.env, spawnFn: deps.spawnFn
  });
}

// --- server record ----------------------------------------------------------

function makeServer(id) {
  const server = {
    id,
    transport: null,
    status: 'connecting', // connecting | connected | error | disconnected
    statusMsg: '',
    tools: [], // [{ name, description, inputSchema, fullName }]
    nextId: 1,
    pending: new Map()
  };
  // Convenience for stdio servers: the child process, or null for remote
  // transports that have none. Keeps callers from reaching into `transport`.
  Object.defineProperty(server, 'proc', {
    enumerable: false,
    get() { return server.transport && server.transport.proc ? server.transport.proc : null; }
  });
  return server;
}

export class McpManager {
  constructor({ spawnFn = spawn, fetchImpl, maxOutput = MCP_MAX_OUTPUT } = {}) {
    this.deps = { spawnFn, fetchImpl: fetchImpl || globalThis.fetch };
    this.maxOutput = maxOutput;
    this.servers = new Map();
    // fullName -> { serverId, toolName, readOnly }
    this.toolIndex = new Map();
    // reconcile() spawns/kills processes; running two at once races and can
    // leave duplicate children behind. Serialise them through this chain.
    this._reconcileChain = Promise.resolve();
  }

  // Connect (or reconnect) a single server.
  // opts = { transport, command, args, env } | { transport:'http'|'sse', url, headers }
  async connect(id, opts = {}) {
    if (this.servers.has(id)) await this.disconnect(id);
    const server = makeServer(id);
    this.servers.set(id, server);
    server.sig = signatureOf(opts);

    let transport;
    try {
      transport = createTransport(opts, this.deps);
      server.transport = transport;
      await transport.start({
        onMessage: (msg) => this._onMessage(server, msg),
        onError: (e) => {
          server.status = 'error';
          server.statusMsg = (server.statusMsg + '\n' + errText(e)).slice(-1000);
          this._failPending(server, 'MCP 传输错误: ' + errText(e));
        },
        onClose: (why) => {
          if (!this.servers.has(id)) return;
          server.status = 'disconnected';
          server.tools = [];
          this._rebuildIndex();
          this._failPending(server, 'MCP ' + why);
        },
        onStderr: (d) => { server.statusMsg = (server.statusMsg + d).slice(-1200); }
      });
    } catch (e) {
      server.status = 'error';
      server.statusMsg = errText(e);
      throw e;
    }

    // 1) handshake
    await this._request(server, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agenite', version: '0.6.0' }
    }, 30000);
    // 2) tell the server we are ready
    try { await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' }); }
    catch { /* server may not care; the next step reports real problems */ }
    // 3) enumerate tools
    const listRes = await this._request(server, 'tools/list', {}, 30000);
    server.tools = (listRes && listRes.tools ? listRes.tools : []).map((t) => ({
      name: t.name,
      fullName: fullToolName(id, t.name),
      description: t.description || '',
      readOnly: readOnlyHint(t),
      inputSchema: t.inputSchema || { type: 'object', properties: {} }
    }));
    server.status = 'connected';
    server.statusMsg = '';
    this._rebuildIndex();
    return server;
  }

  _rebuildIndex() {
    this.toolIndex.clear();
    for (const [id, s] of this.servers) {
      if (s.status !== 'connected') continue;
      for (const t of s.tools) {
        this.toolIndex.set(t.fullName, { serverId: id, toolName: t.name, readOnly: t.readOnly });
      }
    }
  }

  _request(server, method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!server.transport) { reject(new Error('MCP 传输未启动')); return; }
      const id = server.nextId++;
      const timer = setTimeout(() => {
        server.pending.delete(id);
        reject(new Error('MCP 请求超时: ' + method));
      }, timeoutMs);
      server.pending.set(id, { resolve, reject, timer });
      Promise.resolve()
        .then(() => server.transport.send({ jsonrpc: '2.0', id, method, params }))
        .catch((e) => {
          const p = server.pending.get(id);
          if (!p) return;
          clearTimeout(p.timer);
          server.pending.delete(id);
          reject(e instanceof Error ? e : new Error(errText(e)));
        });
    });
  }

  _onMessage(server, msg) {
    if (!msg || msg.id == null) return; // notification from server: ignored
    const p = server.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    server.pending.delete(msg.id);
    if (msg.error) p.reject(new Error('MCP 错误: ' + (msg.error.message || JSON.stringify(msg.error))));
    else p.resolve(msg.result || {});
  }

  _failPending(server, message) {
    for (const p of server.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    server.pending.clear();
  }

  // Tool definitions ready to hand to the model (OpenAI-style function specs).
  listToolDefs() {
    const out = [];
    for (const [id, s] of this.servers) {
      if (s.status !== 'connected') continue;
      for (const t of s.tools) {
        const inputSchema = t.inputSchema && t.inputSchema.type ? t.inputSchema : { type: 'object', properties: {} };
        out.push({
          name: t.fullName,
          description: `[MCP · ${id}] ${t.description}`,
          parameters: inputSchema,
          // Mirrored at the top level so callers can filter on it without
          // knowing the tool came from MCP.
          readOnly: !!t.readOnly,
          mcp: { serverId: id, toolName: t.name, readOnly: !!t.readOnly }
        });
      }
    }
    return out;
  }

  /**
   * Should calling this tool interrupt the user for a click?
   * 'deny' blocks everything; an explicit allowlist entry or a read-only tool
   * (when that option is on) goes straight through.
   */
  approvalDecision(fullName, opts = {}) {
    const mode = opts.approvalMode || 'ask';
    if (mode === 'deny') return 'deny';
    if (mode === 'auto') return 'allow';
    const allowlist = opts.toolAllowlist;
    if (Array.isArray(allowlist) && allowlist.includes(fullName)) return 'allow';
    if (opts.autoApproveReadonly !== false) {
      const ref = this.toolIndex.get(fullName);
      if (ref && ref.readOnly) return 'allow';
    }
    return 'ask';
  }

  // Call an MCP tool by its full name, through the same approval gate as the
  // built-in danger tools so the user stays in control of the machine.
  async callToolByName(fullName, args = {}, opts = {}) {
    const ref = this.toolIndex.get(fullName);
    if (!ref) return { ok: false, error: '未知 MCP 工具: ' + fullName };
    const server = this.servers.get(ref.serverId);
    if (!server || server.status !== 'connected') {
      return { ok: false, error: 'MCP 服务器未连接: ' + ref.serverId };
    }
    const decision = this.approvalDecision(fullName, opts);
    if (decision === 'deny') {
      return { ok: false, error: `当前为「只读模式」，已拒绝执行 MCP 工具 ${fullName}。` };
    }
    if (decision === 'ask' && typeof opts.requestApproval === 'function') {
      const verdict = await opts.requestApproval({
        name: fullName,
        args,
        readOnly: !!ref.readOnly,
        description: `MCP 工具 (${ref.serverId}): ${ref.toolName}`
      });
      if (!verdict || !verdict.approved) {
        return { ok: false, error: (verdict && verdict.reason) || '用户拒绝了 MCP 工具调用。' };
      }
    }
    let result;
    try {
      result = await this._request(server, 'tools/call', { name: ref.toolName, arguments: args || {} }, 120000);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const content = (result && result.content) || [];
    const parts = [];
    for (const c of content) {
      if (!c) continue;
      if (c.type === 'text') parts.push(String(c.text ?? ''));
      // Images/audio can't go into a text-only message; describe them instead
      // of dropping them silently, so the model knows something came back.
      else if (c.type === 'image') parts.push(`[图片 ${c.mimeType || 'image'}，${(c.data || '').length} 字节 base64，已省略]`);
      else if (c.type === 'resource' && c.resource) {
        parts.push(String(c.resource.text ?? `[资源 ${c.resource.uri || ''}]`));
      }
    }
    const text = parts.join('\n');
    const isError = !!(result && result.isError);
    return {
      ok: !isError,
      content: truncateMcpOutput(text, this.maxOutput) ||
        (isError ? '工具返回错误（无文本）' : '（无文本输出）'),
      isError
    };
  }

  // Make the desired set of servers match reality: connect new/enabled ones,
  // disconnect removed/disabled ones, keep already-connected ones alive.
  // Queued so overlapping chat requests can't race into duplicate children.
  reconcile(desired = []) {
    const run = () => this._reconcile(desired);
    const next = this._reconcileChain.then(run, run);
    this._reconcileChain = next.then(() => {}, () => {});
    return next;
  }

  async _reconcile(desired = []) {
    const wanted = new Map();
    for (const d of desired) {
      if (d && d.enabled && d.id) wanted.set(sanitizeServerId(d.id), { ...d, id: sanitizeServerId(d.id) });
    }
    for (const id of [...this.servers.keys()]) {
      if (!wanted.has(id)) await this.disconnect(id);
    }
    for (const [id, d] of wanted) {
      const existing = this.servers.get(id);
      if (existing && existing.status === 'connected' && existing.sig === signatureOf(d)) continue;
      if (existing) await this.disconnect(id);
      try {
        await this.connect(id, d);
      } catch (e) {
        const s = this.servers.get(id);
        if (s) { s.status = 'error'; s.statusMsg = errText(e); }
      }
    }
    return this.status();
  }

  async disconnect(id, { graceMs = 1500 } = {}) {
    const s = this.servers.get(id);
    if (!s) return;
    this.servers.delete(id);
    this._rebuildIndex();
    this._failPending(s, 'MCP 服务器已断开');
    if (s.transport) {
      try { await s.transport.close({ graceMs }); } catch { /* best effort */ }
    }
  }

  async disconnectAll() {
    await Promise.all([...this.servers.keys()].map((id) => this.disconnect(id)));
  }

  // Best-effort synchronous teardown for process exit handlers, where there is
  // no time left to await anything.
  killAllSync() {
    for (const s of this.servers.values()) {
      try { if (s.transport) s.transport.killSync(); } catch { /* ignore */ }
    }
    this.servers.clear();
    this.toolIndex.clear();
  }

  // PIDs of every live child — used by the shutdown watchdog.
  childPids() {
    return [...this.servers.values()]
      .map((s) => s.transport && s.transport.pid)
      .filter((p) => typeof p === 'number');
  }

  // Snapshot for the UI.
  status() {
    return [...this.servers.values()].map((s) => ({
      id: s.id,
      status: s.status,
      transport: s.transport ? s.transport.kind : 'stdio',
      target: s.transport ? s.transport.describe() : '',
      toolCount: s.tools.length,
      tools: s.tools.map((t) => ({ name: t.fullName, description: t.description, readOnly: t.readOnly })),
      error: s.statusMsg || null
    }));
  }
}

// The spec lets a server declare `annotations.readOnlyHint`; trust it when
// present, fall back to the name heuristic otherwise.
function readOnlyHint(t) {
  const a = t && (t.annotations || t.annotation);
  if (a && typeof a.readOnlyHint === 'boolean') return a.readOnlyHint;
  if (a && typeof a.destructiveHint === 'boolean' && a.destructiveHint === false && a.readOnlyHint !== false) {
    return looksReadOnly(t.name);
  }
  return looksReadOnly(t && t.name);
}

function signatureOf(d) {
  return JSON.stringify({
    transport: d.transport || (d.url ? 'http' : 'stdio'),
    command: d.command || '',
    args: d.args || [],
    env: d.env || {},
    url: d.url || '',
    headers: d.headers || {}
  });
}

function errText(e) {
  return String(e && e.message ? e.message : e);
}

export function isMcpToolName(name) {
  return typeof name === 'string' && name.startsWith('mcp__');
}
