// Remote MCP: importing other clients' config, naming rules, read-only
// detection, and the HTTP transport driven by a fake fetch. These are the
// paths that let Agenite talk to hosted tool servers instead of only local
// npx processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMcpConfigJson, sanitizeServerId, fullToolName, looksReadOnly,
  createSseParser, createTransport, McpManager
} from '../src/core/mcp.js';

// ---------- config import ----------

test('parses the Claude Desktop / Cursor mcpServers shape', () => {
  const list = parseMcpConfigJson(JSON.stringify({
    mcpServers: {
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      github: { command: 'npx', args: ['-y', 'server-github'], env: { TOKEN: 'x' } }
    }
  }));
  assert.equal(list.length, 2);
  const pw = list.find((s) => s.id === 'playwright');
  assert.equal(pw.command, 'npx');
  assert.deepEqual(pw.args, ['-y', '@playwright/mcp@latest']);
  assert.equal(pw.transport, 'stdio');
  assert.equal(pw.enabled, true);
  assert.equal(list.find((s) => s.id === 'github').env.TOKEN, 'x');
});

test('parses a bare server map without the mcpServers wrapper', () => {
  const list = parseMcpConfigJson(JSON.stringify({
    myserver: { command: 'node', args: ['server.js'] }
  }));
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'myserver');
});

test('remote entries keep their url and become an http transport', () => {
  const list = parseMcpConfigJson(JSON.stringify({
    mcpServers: { remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } } }
  }));
  assert.equal(list[0].transport, 'http');
  assert.equal(list[0].url, 'https://example.com/mcp');
  assert.equal(list[0].headers.Authorization, 'Bearer t');
});

test('an explicit sse type is preserved', () => {
  const list = parseMcpConfigJson(JSON.stringify({
    mcpServers: { legacy: { type: 'sse', url: 'https://example.com/sse' } }
  }));
  assert.equal(list[0].transport, 'sse');
});

test('a disabled entry is imported but left switched off', () => {
  const list = parseMcpConfigJson(JSON.stringify({
    mcpServers: { off: { command: 'npx', args: [], disabled: true } }
  }));
  assert.equal(list[0].enabled, false);
});

test('junk input is rejected with a readable message, not a crash', () => {
  assert.throws(() => parseMcpConfigJson('not json at all'));
  assert.throws(() => parseMcpConfigJson(''));
  // An empty but valid object is a user mistake worth naming explicitly
  // rather than silently importing zero servers.
  assert.throws(() => parseMcpConfigJson('{}'), /没有找到任何 MCP 服务器/);
});

test('an object (already-parsed JSON) is accepted as well as a string', () => {
  const list = parseMcpConfigJson({ mcpServers: { a: { command: 'x', args: [] } } });
  assert.equal(list.length, 1);
});

// ---------- naming ----------

test('sanitizeServerId keeps names usable as tool-name segments', () => {
  assert.equal(sanitizeServerId('playwright'), 'playwright');
  assert.equal(sanitizeServerId('my server!'), 'my_server');
  assert.ok(sanitizeServerId('x'.repeat(200)).length <= 40);
});

test('fullToolName stays within the 64-char limit providers enforce', () => {
  const short = fullToolName('pw', 'click');
  assert.equal(short, 'mcp__pw__click');
  const long = fullToolName('a'.repeat(40), 'b'.repeat(60));
  assert.ok(long.length <= 64, `got ${long.length} chars`);
  assert.ok(long.startsWith('mcp__'));
  // Two different long names must not collide after shortening.
  const other = fullToolName('a'.repeat(40), 'c'.repeat(60));
  assert.notEqual(long, other);
});

test('looksReadOnly recognises harmless verbs and refuses destructive ones', () => {
  for (const n of ['browser_snapshot', 'get_page', 'read_file', 'list_tables', 'search_docs', 'screenshot', 'query_db']) {
    assert.equal(looksReadOnly(n), true, `${n} should be read-only`);
  }
  for (const n of ['write_file', 'delete_row', 'create_issue', 'run_command', 'browser_click', 'update_record', 'execute_sql']) {
    assert.equal(looksReadOnly(n), false, `${n} must NOT be auto-approved`);
  }
  // Ambiguous names default to "needs approval" — the safe direction.
  assert.equal(looksReadOnly('do_the_thing'), false);
});

// ---------- SSE framing ----------

test('createSseParser reassembles frames split across chunks', () => {
  const frames = [];
  const feed = createSseParser((f) => frames.push(f));
  feed('event: message\ndata: {"a"');
  feed(':1}\n\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'message');
  assert.equal(frames[0].data, '{"a":1}');
});

test('createSseParser joins multi-line data and ignores comments', () => {
  const frames = [];
  const feed = createSseParser((f) => frames.push(f));
  feed(': keepalive\n\n');
  feed('data: line1\ndata: line2\n\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, 'line1\nline2');
});

// ---------- transport selection ----------

test('createTransport picks the transport from the options', () => {
  assert.equal(createTransport({ command: 'npx', args: [] }, { spawnFn: () => {} }).kind, 'stdio');
  assert.equal(createTransport({ url: 'https://x/mcp' }, { fetchImpl: async () => {} }).kind, 'http');
  assert.equal(createTransport({ transport: 'sse', url: 'https://x/sse' }, { fetchImpl: async () => {} }).kind, 'sse');
});

// ---------- HTTP transport against a fake server ----------

// Minimal in-memory MCP server: answers initialize / tools/list / tools/call
// over plain JSON responses, and records the session header handling.
function fakeHttpServer({ tools = [], sessionId = 'sess-123' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, headers: init.headers || {}, body });

    if (init.method === 'DELETE') return jsonRes({}, {});
    if (!body || body.id == null) return { ok: true, status: 202, headers: hdrs({}), text: async () => '' };

    let result;
    if (body.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake' } };
    else if (body.method === 'tools/list') result = { tools };
    else if (body.method === 'tools/call') result = { content: [{ type: 'text', text: 'called ' + body.params.name }] };
    else result = {};

    return jsonRes({ jsonrpc: '2.0', id: body.id, result }, { 'mcp-session-id': sessionId });
  };
  return { fetchImpl, calls };

  function hdrs(map) {
    const m = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
    return { get: (k) => m.get(String(k).toLowerCase()) || null };
  }
  function jsonRes(obj, extra) {
    return {
      ok: true,
      status: 200,
      headers: hdrs({ 'content-type': 'application/json', ...extra }),
      text: async () => JSON.stringify(obj)
    };
  }
}

test('connects to a remote HTTP MCP server and lists its tools', async () => {
  const { fetchImpl, calls } = fakeHttpServer({
    tools: [
      { name: 'get_weather', description: '查天气', inputSchema: { type: 'object', properties: {} } },
      { name: 'send_email', description: '发邮件', inputSchema: { type: 'object', properties: {} } }
    ]
  });
  const m = new McpManager({ fetchImpl });
  const srv = await m.connect('remote', { transport: 'http', url: 'https://example.com/mcp' });

  assert.equal(srv.status, 'connected');
  assert.equal(srv.tools.length, 2);
  const defs = m.listToolDefs();
  assert.deepEqual(defs.map((d) => d.name).sort(), ['mcp__remote__get_weather', 'mcp__remote__send_email']);

  // The read-only heuristic rides along so the UI and the approval gate agree.
  assert.equal(defs.find((d) => d.name.endsWith('get_weather')).readOnly, true);
  assert.equal(defs.find((d) => d.name.endsWith('send_email')).readOnly, false);

  // Session id from the first response must be echoed on later requests.
  const later = calls[calls.length - 1];
  assert.equal(later.headers['Mcp-Session-Id'], 'sess-123');

  await m.disconnectAll();
});

test('a remote tool call goes through and returns text content', async () => {
  const { fetchImpl } = fakeHttpServer({
    tools: [{ name: 'get_weather', description: '', inputSchema: { type: 'object', properties: {} } }]
  });
  const m = new McpManager({ fetchImpl });
  await m.connect('remote', { transport: 'http', url: 'https://example.com/mcp' });
  const res = await m.callToolByName('mcp__remote__get_weather', { city: 'SZ' }, { approvalMode: 'auto' });
  assert.equal(res.ok, true);
  assert.match(res.content, /called get_weather/);
  await m.disconnectAll();
});

test('status() reports the transport and target for a remote server', async () => {
  const { fetchImpl } = fakeHttpServer({ tools: [] });
  const m = new McpManager({ fetchImpl });
  await m.connect('remote', { transport: 'http', url: 'https://example.com/mcp' });
  const st = m.status();
  assert.equal(st[0].transport, 'http');
  assert.match(st[0].target, /example\.com/);
  await m.disconnectAll();
});

test('a failing remote server surfaces the HTTP error instead of hanging', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 502,
    headers: { get: () => null },
    text: async () => 'bad gateway'
  });
  const m = new McpManager({ fetchImpl });
  await assert.rejects(
    () => m.connect('broken', { transport: 'http', url: 'https://example.com/mcp' }),
    /502/
  );
  await m.disconnectAll();
});

// ---------- approval policy ----------

test('read-only MCP tools skip approval only when the option is on', async () => {
  const { fetchImpl } = fakeHttpServer({
    tools: [
      { name: 'read_page', description: '', inputSchema: {} },
      { name: 'delete_page', description: '', inputSchema: {} }
    ]
  });
  const m = new McpManager({ fetchImpl });
  await m.connect('r', { transport: 'http', url: 'https://example.com/mcp' });

  assert.equal(m.approvalDecision('mcp__r__read_page', { approvalMode: 'ask', autoApproveReadonly: true }), 'allow');
  assert.equal(m.approvalDecision('mcp__r__read_page', { approvalMode: 'ask', autoApproveReadonly: false }), 'ask');
  assert.equal(m.approvalDecision('mcp__r__delete_page', { approvalMode: 'ask', autoApproveReadonly: true }), 'ask');

  // An explicit allowlist entry beats the heuristic.
  assert.equal(
    m.approvalDecision('mcp__r__delete_page', { approvalMode: 'ask', toolAllowlist: ['mcp__r__delete_page'] }),
    'allow'
  );
  // Read-only mode still blocks everything, allowlist or not.
  assert.equal(
    m.approvalDecision('mcp__r__read_page', { approvalMode: 'deny', toolAllowlist: ['mcp__r__read_page'] }),
    'deny'
  );
  await m.disconnectAll();
});
