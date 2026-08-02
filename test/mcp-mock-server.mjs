#!/usr/bin/env node
// A tiny fake MCP server for tests. Speaks line-delimited JSON-RPC over stdio
// and implements just enough to exercise Agenite's McpManager:
//   initialize / notifications/initialized / tools/list / tools/call
import { stdin, stdout } from 'node:process';

const TOOLS = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'boom', description: 'Always returns an error', inputSchema: { type: 'object', properties: {} } },
  { name: 'flood', description: 'Returns a huge blob (context-window hazard)', inputSchema: { type: 'object', properties: { size: { type: 'number' } } } },
  { name: 'mixed', description: 'Returns text + image + resource parts', inputSchema: { type: 'object', properties: {} } }
];

function send(obj) { stdout.write(JSON.stringify(obj) + '\n'); }

stdin.setEncoding('utf8');
// Per the MCP stdio transport spec, the server exits when stdin closes. This
// is what makes children die on their own if the client vanishes, so the
// behaviour must be modelled here or the orphan tests are meaningless.
stdin.on('end', () => process.exit(0));
stdin.on('close', () => process.exit(0));
let buf = '';
stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id == null) continue; // notifications (no id) are ignored
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1.0' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params || {};
      if (name === 'echo') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(args && args.text) }] } });
      } else if (name === 'add') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] } });
      } else if (name === 'boom') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'failed on purpose' }], isError: true } });
      } else if (name === 'flood') {
        const size = Number(args && args.size) || 50000;
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'x'.repeat(size) }] } });
      } else if (name === 'mixed') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [
              { type: 'text', text: 'first' },
              { type: 'image', mimeType: 'image/png', data: 'AAAA' },
              { type: 'resource', resource: { uri: 'file:///x.txt', text: 'from resource' } }
            ]
          }
        });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool ' + name } });
      }
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
    }
  }
});
