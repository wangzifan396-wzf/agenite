import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool, TOOL_DEFS, activeTools } from '../src/core/tools.js';

test('calculator evaluates arithmetic', async () => {
  const r = await executeTool('calculator', { expression: '3 * (4 + 5) ^ 2' });
  assert.equal(r.ok, true);
  assert.equal(r.content, '243');
});

test('calculator evaluates functions', async () => {
  const r = await executeTool('calculator', { expression: 'sqrt(16) + max(1, 9)' });
  assert.equal(r.content, '13');
});

test('calculator rejects code injection', async () => {
  const r = await executeTool('calculator', { expression: 'process.exit(1)' });
  assert.equal(r.ok, false);
});

test('current_datetime returns a string', async () => {
  const r = await executeTool('current_datetime', {});
  assert.equal(r.ok, true);
  assert.ok(r.content.includes('UTC:'));
});

test('web_fetch uses injected fetch', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, text: async () => '<html>Hello World</html>' });
  const r = await executeTool('web_fetch', { url: 'https://example.com' }, { fetchImpl: fakeFetch });
  assert.equal(r.ok, true);
  assert.ok(r.content.includes('Hello World'));
});

test('web_fetch rejects non-http', async () => {
  const r = await executeTool('web_fetch', { url: 'javascript:alert(1)' });
  assert.equal(r.ok, false);
});

test('read_file and write_file round-trip (write needs danger)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agenite-'));
  const file = join(dir, 'note.txt');
  const w = await executeTool('write_file', { path: file, content: 'hi there' }, { dangerTools: true });
  assert.equal(w.ok, true);
  const r = await executeTool('read_file', { path: file });
  assert.equal(r.ok, true);
  assert.equal(r.content, 'hi there');
});

test('write_file blocked without danger mode', async () => {
  const r = await executeTool('write_file', { path: '/tmp/x', content: 'y' }, { dangerTools: false });
  assert.equal(r.ok, false);
});

test('run_command blocked without danger mode', async () => {
  const r = await executeTool('run_command', { command: 'node', args: ['-e', '1'] }, { dangerTools: false });
  assert.equal(r.ok, false);
});

test('run_command runs with danger mode', async () => {
  const r = await executeTool('run_command', { command: 'node', args: ['-e', 'console.log("hi")'] }, { dangerTools: true });
  assert.equal(r.ok, true);
  assert.ok(r.content.includes('hi'));
});

test('activeTools hides danger tools unless enabled', () => {
  const safe = activeTools({ dangerTools: false }).map((t) => t.name);
  const all = activeTools({ dangerTools: true }).map((t) => t.name);
  assert.ok(!safe.includes('write_file'));
  assert.ok(all.includes('write_file') && all.includes('run_command'));
});

test('all tool defs have name/description/parameters', () => {
  for (const t of TOOL_DEFS) {
    assert.ok(t.name && t.description && t.parameters);
    assert.ok(t.parameters.properties || Object.keys(t.parameters).length >= 0);
  }
});
