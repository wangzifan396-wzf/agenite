// Tests for the MCP client (src/core/mcp.js) using a mock MCP server spawned
// over stdio. Fully offline — no network, no real MCP packages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpManager, isMcpToolName } from '../src/core/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = join(__dirname, 'mcp-mock-server.mjs');
const NODE = process.execPath;

function mockServerOpts() {
  return { command: NODE, args: [MOCK], env: {} };
}

test('isMcpToolName detects mcp__ prefixed names', () => {
  assert.equal(isMcpToolName('mcp__x__y'), true);
  assert.equal(isMcpToolName('write_file'), false);
  assert.equal(isMcpToolName('mcp__weird_server__deep__tool'), true);
});

test('connect enumerates tools and exposes them with mcp__ names', async () => {
  const m = new McpManager();
  const srv = await m.connect('mock', mockServerOpts());
  assert.equal(srv.status, 'connected');
  assert.equal(srv.tools.length, 3);
  const defs = m.listToolDefs();
  assert.equal(defs.length, 3);
  assert.ok(defs.every((d) => d.name.startsWith('mcp__mock__')));
  const echo = defs.find((d) => d.name === 'mcp__mock__echo');
  assert.equal(echo.parameters.properties.text.type, 'string');
  assert.equal(echo.mcp.serverId, 'mock');
  assert.equal(echo.mcp.toolName, 'echo');
  await m.disconnectAll();
});

test('callToolByName runs a tool and returns its text', async () => {
  const m = new McpManager();
  await m.connect('mock', mockServerOpts());
  const echo = await m.callToolByName('mcp__mock__echo', { text: 'hello mcp' });
  assert.equal(echo.ok, true);
  assert.equal(echo.content, 'hello mcp');
  const add = await m.callToolByName('mcp__mock__add', { a: 2, b: 5 });
  assert.equal(add.ok, true);
  assert.equal(add.content, '7');
  await m.disconnectAll();
});

test('callToolByName reports isError results', async () => {
  const m = new McpManager();
  await m.connect('mock', mockServerOpts());
  const boom = await m.callToolByName('mcp__mock__boom', {});
  assert.equal(boom.ok, false);
  assert.equal(boom.isError, true);
  assert.match(boom.content, /failed on purpose/);
  await m.disconnectAll();
});

test('callToolByName requests approval in ask mode', async () => {
  const m = new McpManager();
  await m.connect('mock', mockServerOpts());
  // denied — the user-supplied reason is echoed back
  const denied = await m.callToolByName('mcp__mock__echo', { text: 'x' }, {
    approvalMode: 'ask',
    requestApproval: async () => ({ approved: false, reason: 'nope' })
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /nope/);
  // allowed
  const allowed = await m.callToolByName('mcp__mock__echo', { text: 'go' }, {
    approvalMode: 'ask',
    requestApproval: async () => ({ approved: true })
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.content, 'go');
  await m.disconnectAll();
});

test('callToolByName refuses in deny mode and skips approval in auto mode', async () => {
  const m = new McpManager();
  await m.connect('mock', mockServerOpts());
  let asked = false;
  const deny = await m.callToolByName('mcp__mock__echo', { text: 'x' }, {
    approvalMode: 'deny',
    requestApproval: async () => { asked = true; return { approved: true }; }
  });
  assert.equal(deny.ok, false);
  assert.equal(asked, false);
  const auto = await m.callToolByName('mcp__mock__echo', { text: 'y' }, {
    approvalMode: 'auto',
    requestApproval: async () => { asked = true; return { approved: true }; }
  });
  assert.equal(auto.ok, true);
  assert.equal(asked, false);
  await m.disconnectAll();
});

test('unknown tool name errors', async () => {
  const m = new McpManager();
  await m.connect('mock', mockServerOpts());
  const r = await m.callToolByName('mcp__mock__nope', {});
  assert.equal(r.ok, false);
  await m.disconnectAll();
});

test('reconcile connects wanted servers and disconnects the rest', async () => {
  const m = new McpManager();
  await m.reconcile([{ id: 'mock', enabled: true, ...mockServerOpts() }]);
  let st = m.status();
  assert.equal(st.length, 1);
  assert.equal(st[0].status, 'connected');
  assert.equal(st[0].toolCount, 3);
  // drop it
  await m.reconcile([]);
  st = m.status();
  assert.equal(st.length, 0);
});

test('reconcile keeps an already-connected server alive (no reconnect)', async () => {
  const m = new McpManager();
  await m.reconcile([{ id: 'mock', enabled: true, ...mockServerOpts() }]);
  const first = m.servers.get('mock');
  await m.reconcile([{ id: 'mock', enabled: true, ...mockServerOpts() }]);
  const second = m.servers.get('mock');
  assert.equal(first, second, 'same server instance should be reused');
  await m.disconnectAll();
});
