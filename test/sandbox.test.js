// Tests for the two gates that stand between the model and your machine:
// the workspace sandbox and the approval hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executeTool, resolveSafePath, globToRegExp, htmlToText, activeTools } from '../src/core/tools.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agenite-ws-'));
  await writeFile(join(dir, 'readme.md'), '# hello\nworld', 'utf8');
  await mkdir(join(dir, 'sub'), { recursive: true });
  await writeFile(join(dir, 'sub', 'a.js'), 'export const a = 1;', 'utf8');
  return dir;
}

// ---- sandbox ----

test('resolveSafePath keeps relative paths inside the workspace', async () => {
  const ws = await fixture();
  assert.equal(resolveSafePath('readme.md', { workspace: ws }), resolve(ws, 'readme.md'));
  assert.equal(resolveSafePath('.', { workspace: ws }), resolve(ws));
});

test('resolveSafePath blocks traversal outside the workspace', async () => {
  const ws = await fixture();
  assert.throws(() => resolveSafePath('../../etc/passwd', { workspace: ws }), /路径越界/);
  assert.throws(() => resolveSafePath(resolve(ws, '..'), { workspace: ws }), /路径越界/);
});

test('resolveSafePath allows escape when explicitly permitted', async () => {
  const ws = await fixture();
  const out = resolveSafePath('..', { workspace: ws, allowOutsideWorkspace: true });
  assert.equal(out, resolve(ws, '..'));
});

test('read_file refuses to leave the workspace', async () => {
  const ws = await fixture();
  const r = await executeTool('read_file', { path: '../../../etc/hosts' }, { workspace: ws });
  assert.equal(r.ok, false);
  assert.match(r.error, /路径越界/);
});

test('write_file lands inside the workspace and creates parents', async () => {
  const ws = await fixture();
  const w = await executeTool(
    'write_file',
    { path: 'deep/nested/note.txt', content: 'ok' },
    { workspace: ws, dangerTools: true, approvalMode: 'auto' }
  );
  assert.equal(w.ok, true);
  const r = await executeTool('read_file', { path: 'deep/nested/note.txt' }, { workspace: ws });
  assert.equal(r.content, 'ok');
});

// ---- approval gate ----

test('approval mode "deny" refuses dangerous tools', async () => {
  const ws = await fixture();
  const r = await executeTool(
    'write_file',
    { path: 'x.txt', content: 'y' },
    { workspace: ws, dangerTools: true, approvalMode: 'deny' }
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /只读模式/);
});

test('approval mode "ask" waits for the human and honours a refusal', async () => {
  const ws = await fixture();
  const asked = [];
  const r = await executeTool(
    'write_file',
    { path: 'x.txt', content: 'y' },
    {
      workspace: ws,
      dangerTools: true,
      approvalMode: 'ask',
      requestApproval: async (req) => { asked.push(req.name); return { approved: false, reason: '不允许' }; }
    }
  );
  assert.deepEqual(asked, ['write_file']);
  assert.equal(r.ok, false);
  assert.match(r.error, /不允许/);
});

test('approval mode "ask" proceeds once approved', async () => {
  const ws = await fixture();
  const r = await executeTool(
    'write_file',
    { path: 'ok.txt', content: 'yes' },
    { workspace: ws, dangerTools: true, approvalMode: 'ask', requestApproval: async () => ({ approved: true }) }
  );
  assert.equal(r.ok, true);
});

test('safe tools never trigger an approval prompt', async () => {
  const ws = await fixture();
  let asked = 0;
  const r = await executeTool('list_dir', { path: '.' }, {
    workspace: ws,
    requestApproval: async () => { asked++; return { approved: true }; }
  });
  assert.equal(r.ok, true);
  assert.equal(asked, 0);
});

test('activeTools hides danger tools in read-only mode', () => {
  const names = activeTools({ dangerTools: true, approvalMode: 'deny' }).map((t) => t.name);
  assert.ok(!names.includes('run_command'));
  assert.ok(names.includes('read_file'));
});

// ---- new tools ----

test('edit_file replaces a unique snippet', async () => {
  const ws = await fixture();
  const opts = { workspace: ws, dangerTools: true, approvalMode: 'auto' };
  const e = await executeTool('edit_file', { path: 'readme.md', old_text: 'world', new_text: 'agenite' }, opts);
  assert.equal(e.ok, true);
  const r = await executeTool('read_file', { path: 'readme.md' }, { workspace: ws });
  assert.equal(r.content, '# hello\nagenite');
});

test('edit_file refuses ambiguous matches', async () => {
  const ws = await fixture();
  const opts = { workspace: ws, dangerTools: true, approvalMode: 'auto' };
  await executeTool('write_file', { path: 'dup.txt', content: 'aa aa' }, opts);
  const e = await executeTool('edit_file', { path: 'dup.txt', old_text: 'aa', new_text: 'b' }, opts);
  assert.equal(e.ok, false);
  assert.match(e.error, /多次/);
});

test('find_files matches by glob and reports relative paths', async () => {
  const ws = await fixture();
  const r = await executeTool('find_files', { pattern: '*.js' }, { workspace: ws });
  assert.equal(r.ok, true);
  assert.match(r.content, /sub\/a\.js/);
});

test('list_dir shows the directory contents', async () => {
  const ws = await fixture();
  const r = await executeTool('list_dir', {}, { workspace: ws });
  assert.match(r.content, /readme\.md/);
  assert.match(r.content, /sub\//);
});

test('system_info reports the workspace', async () => {
  const ws = await fixture();
  const r = await executeTool('system_info', {}, { workspace: ws });
  assert.equal(r.ok, true);
  assert.match(r.content, /操作系统/);
  assert.ok(r.content.includes(resolve(ws)));
});

test('run_command executes a shell line inside the workspace', async () => {
  const ws = await fixture();
  const r = await executeTool('run_command', { command: 'node -e "console.log(1+1)"' }, {
    workspace: ws, dangerTools: true, approvalMode: 'auto'
  });
  assert.equal(r.ok, true);
  assert.match(r.content, /^2/);
});

test('run_command surfaces a non-zero exit as a failure with output', async () => {
  const ws = await fixture();
  const r = await executeTool('run_command', { command: 'node -e "process.exit(3)"' }, {
    workspace: ws, dangerTools: true, approvalMode: 'auto'
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /退出码 3/);
});

test('open_path is gated by approval like any other danger tool', async () => {
  const r = await executeTool('open_path', { target: 'https://example.com' }, { dangerTools: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /电脑操作权限/);
});

// ---- helpers ----

test('globToRegExp handles * and ?', () => {
  assert.ok(globToRegExp('*.md').test('readme.md'));
  assert.ok(!globToRegExp('*.md').test('readme.txt'));
  assert.ok(globToRegExp('a?c.js').test('abc.js'));
  assert.ok(globToRegExp('src/**').test('src/core/util.js'));
});

test('htmlToText strips tags, scripts and entities', () => {
  const out = htmlToText('<html><head><style>b{}</style></head><body><script>x()</script><h1>Hi &amp; bye</h1><p>Line</p></body></html>');
  assert.ok(!out.includes('<'));
  assert.ok(!out.includes('x()'));
  assert.match(out, /Hi & bye/);
  assert.match(out, /Line/);
});
