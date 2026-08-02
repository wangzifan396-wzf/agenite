// MCP (Model Context Protocol) client — this is what turns Agenite from a
// plain chat box into a real agent. It spawns external MCP servers (usually
// `npx some-package`) over stdio, speaks JSON-RPC with them, and exposes their
// tools to the model as callable functions named `mcp__<serverId>__<toolName>`.
//
// Why this matters: the entire MCP ecosystem (browser automation, desktop /
// computer control, databases, GitHub, file systems…) becomes usable by simply
// connecting a server — no code changes needed. That is exactly how clients
// like Cherry Studio reach "agent" status.
//
// Pure-ish: `spawn` is injectable so the whole thing is testable under
// node:test with a mock server script.
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

// A connected MCP server. `pending` holds in-flight JSON-RPC requests keyed by
// their numeric id so responses can be matched back.
function makeServer(id) {
  return {
    id,
    proc: null,
    status: 'connecting', // connecting | connected | error | disconnected
    statusMsg: '',
    exitCode: null,
    sig: null,
    tools: [], // [{ name, description, inputSchema }]
    buffer: '',
    nextId: 1,
    pending: new Map()
  };
}

export class McpManager {
  constructor({ spawnFn = spawn, maxOutput = MCP_MAX_OUTPUT } = {}) {
    this.spawnFn = spawnFn;
    this.maxOutput = maxOutput;
    this.servers = new Map();
    // fullName -> { serverId, toolName }  (serverId may itself contain "_")
    this.toolIndex = new Map();
    // reconcile() spawns/kills processes; running two at once races and can
    // leave duplicate children behind. Serialise them through this chain.
    this._reconcileChain = Promise.resolve();
  }

  // Connect (or reconnect) a single server. `opts` = { command, args, env, enabled }.
  async connect(id, opts = {}) {
    if (this.servers.has(id)) await this.disconnect(id);
    const server = makeServer(id);
    this.servers.set(id, server);

    const command = opts.command;
    if (!command) {
      server.status = 'error';
      server.statusMsg = '缺少 command';
      throw new Error('MCP 服务器缺少 command: ' + id);
    }
    const args = Array.isArray(opts.args) ? opts.args.map(String) : [];
    const env = { ...process.env, ...(opts.env || {}) };
    server.sig = JSON.stringify({ command, args, env: opts.env || {} });

    let proc;
    try {
      proc = this.spawnFn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      server.status = 'error';
      server.statusMsg = String(e && e.message ? e.message : e);
      throw e;
    }
    server.proc = proc;

    proc.on('error', (e) => {
      server.status = 'error';
      server.statusMsg = (server.statusMsg + '\n' + (e && e.message ? e.message : e)).slice(-1000);
      this._failPending(server, 'MCP 进程错误: ' + (e && e.message ? e.message : e));
    });
    proc.on('exit', (code) => {
      server.status = 'disconnected';
      server.exitCode = code;
      server.tools = [];
      this._rebuildIndex();
      this._failPending(server, 'MCP 进程已退出 (code ' + code + ')');
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this._onData(server, chunk));
    if (proc.stderr) {
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => { server.statusMsg = (server.statusMsg + String(d)).slice(-1200); });
    }

    // 1) handshake
    await this._request(server, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agenite', version: '0.5.1' }
    }, 30000);
    // 2) tell the server we are ready
    try {
      server.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    } catch { /* proc may be dying; next step will report it */ }
    // 3) enumerate tools
    const listRes = await this._request(server, 'tools/list', {}, 30000);
    server.tools = (listRes && listRes.tools ? listRes.tools : []).map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} }
    }));
    server.status = 'connected';
    server.statusMsg = '';
    this._rebuildIndex();
    return server;
  }

  // Rebuild the fullName -> ref index from connected servers.
  _rebuildIndex() {
    this.toolIndex.clear();
    for (const [id, s] of this.servers) {
      if (s.status !== 'connected') continue;
      for (const t of s.tools) this.toolIndex.set(`mcp__${id}__${t.name}`, { serverId: id, toolName: t.name });
    }
  }

  _request(server, method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!server.proc || !server.proc.stdin) {
        reject(new Error('MCP 进程未启动'));
        return;
      }
      const id = server.nextId++;
      const timer = setTimeout(() => {
        server.pending.delete(id);
        reject(new Error('MCP 请求超时: ' + method));
      }, timeoutMs);
      server.pending.set(id, { resolve, reject, timer });
      try {
        server.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        server.pending.delete(id);
        reject(e);
      }
    });
  }

  _onData(server, chunk) {
    server.buffer += chunk;
    let idx;
    while ((idx = server.buffer.indexOf('\n')) >= 0) {
      const line = server.buffer.slice(0, idx).trim();
      server.buffer = server.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      // Only responses carry an id; notifications (server->client) are ignored.
      if (msg.id != null && server.pending.has(msg.id)) {
        const p = server.pending.get(msg.id);
        clearTimeout(p.timer);
        server.pending.delete(msg.id);
        if (msg.error) p.reject(new Error('MCP 错误: ' + (msg.error.message || JSON.stringify(msg.error))));
        else p.resolve(msg.result || {});
      }
    }
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
          name: `mcp__${id}__${t.name}`,
          description: `[MCP · ${id}] ${t.description}`,
          parameters: inputSchema,
          mcp: { serverId: id, toolName: t.name }
        });
      }
    }
    return out;
  }

  // Call an MCP tool by its full name. Routes through the same approval gate
  // as built-in danger tools so the user stays in control of the machine.
  async callToolByName(fullName, args = {}, opts = {}) {
    const ref = this.toolIndex.get(fullName);
    if (!ref) return { ok: false, error: '未知 MCP 工具: ' + fullName };
    const server = this.servers.get(ref.serverId);
    if (!server || server.status !== 'connected') {
      return { ok: false, error: 'MCP 服务器未连接: ' + ref.serverId };
    }
    const mode = opts.approvalMode || 'ask';
    if (mode === 'deny') {
      return { ok: false, error: `当前为「只读模式」，已拒绝执行 MCP 工具 ${fullName}。` };
    }
    if (mode === 'ask' && typeof opts.requestApproval === 'function') {
      const verdict = await opts.requestApproval({
        name: fullName,
        args,
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
  // Public entry point: queued so overlapping chat requests can't race each
  // other into spawning duplicate child processes.
  reconcile(desired = []) {
    const run = () => this._reconcile(desired);
    const next = this._reconcileChain.then(run, run);
    // Keep the chain alive even if this reconcile rejects.
    this._reconcileChain = next.then(() => {}, () => {});
    return next;
  }

  async _reconcile(desired = []) {
    const wanted = new Map();
    for (const d of desired) {
      if (d && d.enabled && d.id) wanted.set(d.id, d);
    }
    for (const id of [...this.servers.keys()]) {
      if (!wanted.has(id)) await this.disconnect(id);
    }
    for (const [id, d] of wanted) {
      const existing = this.servers.get(id);
      const sig = JSON.stringify({ command: d.command, args: d.args, env: d.env || {} });
      if (existing && existing.status === 'connected' && existing.sig === sig) continue;
      if (existing) await this.disconnect(id);
      try {
        await this.connect(id, d);
      } catch (e) {
        const s = this.servers.get(id);
        if (s) { s.status = 'error'; s.statusMsg = String(e && e.message ? e.message : e); }
      }
    }
    return this.status();
  }

  // Terminate a server. We wait (briefly) for the child to actually exit and
  // escalate to SIGKILL, otherwise stubborn `npx`-launched servers survive as
  // orphans and keep holding ports/memory after Agenite quits.
  async disconnect(id, { graceMs = 1500 } = {}) {
    const s = this.servers.get(id);
    if (!s) return;
    this.servers.delete(id);
    this._rebuildIndex();
    this._failPending(s, 'MCP 服务器已断开');
    const proc = s.proc;
    if (!proc || proc.exitCode != null || proc.signalCode != null) return;
    await new Promise((done) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); done(); } };
      const timer = setTimeout(() => {
        killTree(proc.pid, true);
        finish();
      }, graceMs);
      proc.once('exit', finish);
      // Closing stdin is the polite MCP shutdown signal; spec-compliant servers
      // exit on EOF. The tree kill below is the guarantee.
      try { proc.stdin && proc.stdin.end(); } catch { /* ignore */ }
      try { killTree(proc.pid, false); } catch { finish(); }
    });
  }

  async disconnectAll() {
    await Promise.all([...this.servers.keys()].map((id) => this.disconnect(id)));
  }

  // Best-effort synchronous teardown for process exit handlers, where there is
  // no time left to await anything.
  killAllSync() {
    for (const s of this.servers.values()) {
      if (s.proc) killTree(s.proc.pid, true);
    }
    this.servers.clear();
    this.toolIndex.clear();
  }

  // PIDs of every live child — used by the shutdown watchdog.
  childPids() {
    return [...this.servers.values()]
      .map((s) => s.proc && s.proc.pid)
      .filter((p) => typeof p === 'number');
  }

  // Snapshot for the UI.
  status() {
    return [...this.servers.values()].map((s) => ({
      id: s.id,
      status: s.status,
      toolCount: s.tools.length,
      tools: s.tools.map((t) => ({ name: `mcp__${s.id}__${t.name}`, description: t.description })),
      error: s.statusMsg || null
    }));
  }
}

export function isMcpToolName(name) {
  return typeof name === 'string' && name.startsWith('mcp__');
}
