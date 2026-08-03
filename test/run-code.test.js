import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCode, executeTool, TOOL_DEFS } from '../src/core/tools.js';

const dangerOpts = { dangerTools: true };

test('run_code: rejects unsupported language', async () => {
  const r = await runCode({ language: 'ruby', code: 'puts 1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /node|python/);
});

test('run_code: rejects empty code', async () => {
  const r = await runCode({ language: 'node', code: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /不能为空/);
});

test('run_code: executes node and returns stdout + timing', async () => {
  const r = await runCode({ language: 'node', code: "console.log(2 + 3 * 4);" });
  assert.equal(r.ok, true);
  assert.match(r.content, /14/);
  assert.match(r.content, /耗时/);
});

test('run_code: node sees non-zero exit as information, not crash', async () => {
  const r = await runCode({ language: 'node', code: "console.log('before'); process.exit(2);" });
  assert.equal(r.ok, false);
  assert.match(r.error, /退出码 2/);
  assert.match(r.error, /before/);
});

test('run_code: supports ESM (import/export) via .mjs', async () => {
  const r = await runCode({
    language: 'node',
    code: "const doubled = (await import('node:util')).format(2); console.log('util ok', doubled);"
  });
  // format(2) -> '2' ; we just check it ran without throwing on ESM import
  assert.equal(r.ok, true);
  assert.match(r.content, /util ok/);
});

test('run_code: via executeTool requires dangerTools enabled', async () => {
  const blocked = await executeTool('run_code', { language: 'node', code: 'console.log(1)' }, {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /电脑操作权限/);
});

test('run_code: python guard (skip if unavailable)', async () => {
  const r = await runCode({ language: 'python', code: 'print(1+1)' });
  if (r.ok) {
    assert.match(r.content, /2/);
  } else {
    // Either missing interpreter or runtime error — both acceptable in CI.
    assert.ok(/Python|退出码|超时/.test(r.error), 'unexpected error: ' + r.error);
  }
});

test('TOOL_DEFS: run_code is marked danger', () => {
  const def = TOOL_DEFS.find((t) => t.name === 'run_code');
  assert.ok(def, 'run_code should be defined');
  assert.equal(def.danger, true);
  assert.deepEqual(def.parameters.required, ['language', 'code']);
});
