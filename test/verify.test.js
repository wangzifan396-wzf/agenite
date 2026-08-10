// Verification loop: the harness must actually check the agent's work and hand
// failures back as something the model can act on. These tests drive real temp
// projects (and a real `node --check`) rather than mocks, because the whole
// point of this feature is that it reflects reality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  detectVerify,
  parseVerifyCmd,
  quickSyntaxCheck,
  summarizeFailure,
  verifyWorkspace,
  syntaxCheckable,
  VERIFY_LEVELS
} from '../src/core/verify.js';
import { runAgent, changedPathsFrom } from '../src/core/agent.js';
import { executeTool } from '../src/core/tools.js';
import { normalizeConfig, defaultConfig } from '../src/core/config.js';

function tmp(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenite-verify-'));
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}
const clean = (d) => fs.rmSync(d, { recursive: true, force: true });

// ── detection ──────────────────────────────────────────────────────────────

test('detectVerify: picks up npm test from package.json', () => {
  const d = tmp({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  const s = detectVerify(d);
  assert.equal(s.cmd, 'npm');
  assert.equal(s.kind, 'test');
  assert.match(s.label, /npm run test/);
  clean(d);
});

test('detectVerify: ignores the npm placeholder test script, falls through to lint', () => {
  const d = tmp({
    'package.json': JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .' }
    })
  });
  const s = detectVerify(d);
  assert.equal(s.kind, 'lint');
  assert.match(s.label, /run lint/);
  clean(d);
});

test('detectVerify: respects the lockfile when choosing the package runner', () => {
  const d = tmp({
    'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n'
  });
  assert.equal(detectVerify(d).cmd, 'pnpm');
  clean(d);
});

test('detectVerify: recognises cargo / go / pytest / make projects', () => {
  const rust = tmp({ 'Cargo.toml': '[package]\nname="x"\n' });
  assert.equal(detectVerify(rust).cmd, 'cargo');
  clean(rust);

  const go = tmp({ 'go.mod': 'module x\n' });
  assert.equal(detectVerify(go).label, 'go test ./...');
  clean(go);

  const py = tmp({ 'tests/test_x.py': 'def test_x():\n    assert True\n' });
  assert.equal(detectVerify(py).cmd, 'pytest');
  clean(py);

  const mk = tmp({ Makefile: 'build:\n\tcc x.c\ntest:\n\t./a.out\n' });
  assert.equal(detectVerify(mk).label, 'make test');
  clean(mk);
});

test('detectVerify: returns null for a directory with no known checker', () => {
  const d = tmp({ 'notes.txt': 'hello' });
  assert.equal(detectVerify(d), null);
  clean(d);
});

test('parseVerifyCmd: splits a command string and keeps quoted args intact', () => {
  assert.deepEqual(parseVerifyCmd('npm test').args, ['test']);
  const q = parseVerifyCmd('node --test "test/*.test.js"');
  assert.deepEqual(q.args, ['--test', 'test/*.test.js']);
  assert.equal(parseVerifyCmd('   '), null);
});

// ── syntax level ───────────────────────────────────────────────────────────

test('syntaxCheckable: only claims file types we can actually parse', () => {
  assert.equal(syntaxCheckable('a.js'), true);
  assert.equal(syntaxCheckable('a.mjs'), true);
  assert.equal(syntaxCheckable('a.json'), true);
  assert.equal(syntaxCheckable('a.py'), true);
  assert.equal(syntaxCheckable('a.md'), false);
  assert.equal(syntaxCheckable('a.rs'), false);
});

test('quickSyntaxCheck: flags broken JS and JSON, passes valid ESM, skips the rest', async () => {
  const d = tmp({
    'good.js': 'import x from "node:path";\nexport const a = 1;\n',
    'bad.js': 'const a = (\n',
    'bad.json': '{"a":}',
    'good.json': '{"a":1}',
    'notes.md': '# hi'
  });
  const r = await quickSyntaxCheck(d, ['good.js', 'bad.js', 'bad.json', 'good.json', 'notes.md']);
  assert.equal(r.ok, false);
  assert.equal(r.checked, 4, 'notes.md is skipped, not checked');
  const files = r.failures.map((f) => f.file).sort();
  assert.deepEqual(files, ['bad.js', 'bad.json']);
  assert.match(r.failures.find((f) => f.file === 'bad.js').error, /SyntaxError/);
  clean(d);
});

test('quickSyntaxCheck: a missing file is ignored rather than reported as broken', async () => {
  const d = tmp({ 'a.js': 'export const a = 1;\n' });
  const r = await quickSyntaxCheck(d, ['a.js', 'ghost.js']);
  assert.equal(r.ok, true);
  clean(d);
});

// ── failure summarization ──────────────────────────────────────────────────

test('summarizeFailure: parses node:test TAP output', () => {
  const s = summarizeFailure([
    'TAP version 13',
    'ok 1 - passes',
    'not ok 2 - adds numbers',
    'not ok 3 - handles empty input',
    '# pass 1',
    '# fail 2'
  ].join('\n'));
  assert.equal(s.framework, 'node:test');
  assert.deepEqual(s.failures, ['adds numbers', 'handles empty input']);
  assert.equal(s.counts.fail, 2);
  assert.equal(s.counts.pass, 1);
  assert.match(s.text, /失败 2/);
});

test('summarizeFailure: parses jest/vitest, pytest, go and cargo output', () => {
  const jest = summarizeFailure(' ✕ renders the header (12 ms)\nTests:  1 failed, 3 passed');
  assert.equal(jest.framework, 'jest/vitest');
  assert.deepEqual(jest.failures, ['renders the header']);

  const py = summarizeFailure('FAILED tests/test_a.py::test_sum - AssertionError: 3 != 4\n=== 1 failed, 2 passed in 0.2s ===');
  assert.equal(py.framework, 'pytest');
  assert.match(py.failures[0], /test_sum — AssertionError/);

  const go = summarizeFailure('--- FAIL: TestSum (0.00s)\n    x_test.go:9: got 3\nFAIL\texample/x\t0.1s');
  assert.equal(go.framework, 'go test');
  assert.deepEqual(go.failures, ['TestSum']);

  const rs = summarizeFailure('failures:\n    tests::adds\ntest result: FAILED. 1 passed; 1 failed;');
  assert.equal(rs.framework, 'cargo test');
  assert.ok(rs.failures.includes('tests::adds'));
});

test('summarizeFailure: unknown tools fall back to the output tail, not the whole log', () => {
  const noisy = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const s = summarizeFailure(noisy, { tailLines: 5 });
  assert.equal(s.framework, null);
  assert.equal(s.text.split('\n').length, 5);
  assert.match(s.text, /line 499/);
  assert.ok(!s.text.includes('line 100'), 'the middle of a huge log must not reach the model');
});

test('summarizeFailure: caps how many failing tests it lists', () => {
  const many = Array.from({ length: 40 }, (_, i) => `not ok ${i + 1} - case ${i}`).join('\n') + '\n# fail 40\n';
  const s = summarizeFailure(many, { maxFailures: 5 });
  assert.equal(s.failures.length, 40);
  assert.match(s.text, /另有 35 项失败未列出/);
});

// ── verifyWorkspace ────────────────────────────────────────────────────────

test('verifyWorkspace: off never runs, syntax reports real breakage', async () => {
  const d = tmp({ 'bad.js': 'function f( {\n' });

  const off = await verifyWorkspace(d, { level: 'off', changedFiles: ['bad.js'] });
  assert.equal(off.ran, false);
  assert.equal(off.ok, true);

  const syn = await verifyWorkspace(d, { level: 'syntax', changedFiles: ['bad.js'] });
  assert.equal(syn.ran, true);
  assert.equal(syn.ok, false);
  assert.match(syn.summary, /bad\.js/);
  clean(d);
});

test('verifyWorkspace: nothing checkable this turn is a no-op, not a failure', async () => {
  const d = tmp({ 'a.md': '# hi' });
  const r = await verifyWorkspace(d, { level: 'syntax', changedFiles: ['a.md'] });
  assert.equal(r.ran, false);
  assert.equal(r.ok, true);
  clean(d);
});

test('verifyWorkspace: full degrades to a syntax check when no project command exists', async () => {
  const d = tmp({ 'bad.js': 'const a = (\n' });
  const r = await verifyWorkspace(d, { level: 'full', changedFiles: ['bad.js'] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /降级/);
  clean(d);
});

test('verifyWorkspace: full runs the real command and reports pass and fail', async () => {
  const pass = tmp({
    'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } })
  });
  const okRun = await verifyWorkspace(pass, { level: 'full', timeoutMs: 60000 });
  assert.equal(okRun.ran, true);
  assert.equal(okRun.ok, true, `expected pass, got: ${okRun.summary}`);
  clean(pass);

  const fail = tmp({
    'package.json': JSON.stringify({
      scripts: { test: 'node -e "console.log(\'not ok 1 - boom\');console.log(\'# fail 1\');process.exit(1)"' }
    })
  });
  const badRun = await verifyWorkspace(fail, { level: 'full', timeoutMs: 60000 });
  assert.equal(badRun.ok, false);
  assert.match(badRun.summary, /boom/);
  clean(fail);
});

test('verifyWorkspace: a missing custom command is skipped, never a hard failure', async () => {
  const d = tmp({ 'a.js': 'export const a = 1;\n' });
  const r = await verifyWorkspace(d, { level: 'full', cmd: 'definitely-not-a-real-binary-xyz', timeoutMs: 20000 });
  assert.equal(r.ok, true);
  assert.equal(r.ran, false);
  assert.match(r.reason, /未找到命令/);
  clean(d);
});

// ── config ─────────────────────────────────────────────────────────────────

test('config: verification defaults are safe and inputs are clamped', () => {
  const d = defaultConfig();
  assert.equal(d.autoVerify, 'syntax', 'default must be the near-free level, not off and not full');
  assert.equal(d.maxVerifyFixes, 2);
  assert.deepEqual(VERIFY_LEVELS, ['off', 'syntax', 'full']);

  assert.equal(normalizeConfig({ autoVerify: 'bogus' }).autoVerify, 'syntax');
  assert.equal(normalizeConfig({ autoVerify: 'off' }).autoVerify, 'off');
  assert.equal(normalizeConfig({ maxVerifyFixes: 99 }).maxVerifyFixes, 5);
  assert.equal(normalizeConfig({ verifyTimeoutMs: 1 }).verifyTimeoutMs, 5000);
  assert.equal(normalizeConfig({ verifyCmd: '  npm test  ' }).verifyCmd, 'npm test');
});

// ── changed-file extraction ────────────────────────────────────────────────

test('changedPathsFrom: collects write/edit paths and patch targets, skips failures', () => {
  const calls = [
    { name: 'write_file', args: { path: 'a.js' } },
    { name: 'edit_file', args: { path: 'b.js' } },
    { name: 'write_file', args: { path: 'failed.js' } },
    { name: 'make_dir', args: { path: 'dir' } },
    { name: 'apply_patch', args: { patch: '--- a/c.js\n+++ b/c.js\n@@ -1 +1 @@\n-x\n+y\n' } },
    { name: 'run_command', args: { command: 'ls' } }
  ];
  const results = [
    { res: { ok: true } }, { res: { ok: true } }, { res: { ok: false } },
    { res: { ok: true } }, { res: { ok: true } }, { res: { ok: true } }
  ];
  assert.deepEqual(changedPathsFrom(calls, results), ['a.js', 'b.js', 'c.js']);
});

test('changedPathsFrom: de-duplicates a file edited twice in one turn', () => {
  const calls = [{ name: 'edit_file', args: { path: 'x.js' } }, { name: 'edit_file', args: { path: 'x.js' } }];
  const results = [{ res: { ok: true } }, { res: { ok: true } }];
  assert.deepEqual(changedPathsFrom(calls, results), ['x.js']);
});

// ── the `verify` tool ──────────────────────────────────────────────────────

test('verify tool: reports syntax breakage with a VERIFY_FAILED class', async () => {
  const d = tmp({ 'bad.js': 'const a = (\n' });
  const r = await executeTool('verify', { level: 'syntax', files: ['bad.js'] }, { workspace: d, dangerTools: true });
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'VERIFY_FAILED', 'must not be retried like a transient error');
  assert.match(r.error, /bad\.js/);
  clean(d);
});

test('verify tool: passes cleanly and says so', async () => {
  const d = tmp({ 'ok.js': 'export const a = 1;\n' });
  const r = await executeTool('verify', { level: 'syntax', files: ['ok.js'] }, { workspace: d, dangerTools: true });
  assert.equal(r.ok, true);
  assert.match(r.content, /通过/);
  clean(d);
});

test('verify tool: without files and without git, explains instead of failing', async () => {
  const d = tmp({ 'a.md': '# hi' });
  const r = await executeTool('verify', {}, { workspace: d, dangerTools: true });
  assert.equal(r.ok, true);
  assert.match(r.content, /没有可快检的改动文件/);
  clean(d);
});

// ── the loop ───────────────────────────────────────────────────────────────

function loopHarness({ verifyResult, config = {}, turns = 4 }) {
  const messages = [{ role: 'user', content: 'go' }];
  const events = [];
  let calls = 0;
  let verifyRuns = 0;
  const callModel = async () => {
    calls++;
    if (calls >= turns) return { content: 'done' };
    return {
      content: '',
      toolCalls: [{ id: `t${calls}`, name: 'write_file', args: { path: 'x.js', content: 'const a = (' } }]
    };
  };
  const executeToolStub = async () => ({ ok: true, content: 'written' });
  const autoVerify = async () => { verifyRuns++; return verifyResult; };
  return {
    messages,
    events,
    run: () => runAgent({
      messages,
      callModel,
      executeTool: executeToolStub,
      onEvent: (t, p) => events.push([t, p]),
      config: { maxTurns: turns + 1, ...config },
      toolContext: { autoVerify }
    }),
    stats: () => ({ verifyRuns })
  };
}

test('agent loop: a failing verification is fed back as a concrete fix request', async () => {
  const h = loopHarness({
    verifyResult: { ran: true, ok: false, level: 'syntax', label: '语法快检', summary: '✗ x.js: SyntaxError: Unexpected end of input' },
    turns: 2
  });
  await h.run();
  const nudges = h.messages.filter((m) => m.role === 'user' && String(m.content).includes('自动验证未通过'));
  assert.equal(nudges.length, 1);
  assert.match(nudges[0].content, /SyntaxError/, 'the real failure text must reach the model');
  assert.match(nudges[0].content, /不要为了让检查通过而删改测试本身/);
  const ev = h.events.find(([t]) => t === 'verify');
  assert.ok(ev, 'a verify event must be emitted for the UI');
  assert.equal(ev[1].ok, false);
});

test('agent loop: repeated failures are capped by maxVerifyFixes, then it is told to stop', async () => {
  const h = loopHarness({
    verifyResult: { ran: true, ok: false, level: 'syntax', label: '语法快检', summary: '✗ still broken' },
    config: { maxVerifyFixes: 2 },
    turns: 6
  });
  await h.run();
  const nudges = h.messages.filter((m) => m.role === 'user' && String(m.content).includes('自动验证未通过（第'));
  assert.equal(nudges.length, 2, 'never more nudges than maxVerifyFixes');
  const giveUp = h.messages.filter((m) => m.role === 'user' && String(m.content).includes('已达 2 次自动修复上限'));
  assert.equal(giveUp.length, 1, 'the give-up message fires exactly once, not every turn');
});

test('agent loop: a passing verification emits an event but adds no noise to the context', async () => {
  const h = loopHarness({
    verifyResult: { ran: true, ok: true, level: 'syntax', label: '语法快检', summary: '语法快检通过（1 个文件）' },
    turns: 2
  });
  await h.run();
  const nudges = h.messages.filter((m) => m.role === 'user' && String(m.content).includes('自动验证'));
  assert.equal(nudges.length, 0);
  const ev = h.events.find(([t]) => t === 'verify');
  assert.equal(ev[1].ok, true);
});

test('agent loop: a skipped verification (ran:false) is silent', async () => {
  const h = loopHarness({ verifyResult: { ran: false, ok: true, reason: '无可快检文件' }, turns: 2 });
  await h.run();
  assert.equal(h.events.filter(([t]) => t === 'verify').length, 0);
});

test('agent loop: a verifier that throws must not break the run', async () => {
  const messages = [{ role: 'user', content: 'go' }];
  let calls = 0;
  const r = await runAgent({
    messages,
    callModel: async () => {
      calls++;
      if (calls >= 2) return { content: 'done' };
      return { content: '', toolCalls: [{ id: 'a', name: 'write_file', args: { path: 'x.js', content: 'y' } }] };
    },
    executeTool: async () => ({ ok: true, content: 'written' }),
    config: { maxTurns: 4 },
    toolContext: { autoVerify: async () => { throw new Error('verifier exploded'); } }
  });
  assert.equal(r.stopped, 'done');
});

test('agent loop: no verifier wired means no verification behaviour at all', async () => {
  const messages = [{ role: 'user', content: 'go' }];
  let calls = 0;
  const events = [];
  await runAgent({
    messages,
    callModel: async () => {
      calls++;
      if (calls >= 2) return { content: 'done' };
      return { content: '', toolCalls: [{ id: 'a', name: 'write_file', args: { path: 'x.js', content: 'y' } }] };
    },
    executeTool: async () => ({ ok: true, content: 'written' }),
    onEvent: (t, p) => events.push([t, p]),
    config: { maxTurns: 4, autoVerify: 'syntax' },
    toolContext: {}
  });
  assert.equal(events.filter(([t]) => t === 'verify').length, 0);
});
