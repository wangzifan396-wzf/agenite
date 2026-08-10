// Git safety-net: the harness auto-commits agent edits (Aider-style), and the
// `git` tool lets the agent (and the user) inspect / revert. These tests drive
// a real throwaway repo so we prove commits, undo and diff behaviour.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import test from 'node:test';
import { executeTool } from '../src/core/tools.js';
import {
  isGitRepo,
  isClean,
  gitStatus,
  gitCommit,
  gitUndo,
  gitDiff,
  gitLog
} from '../src/core/git.js';

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenite-git-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@t.t && git config user.name tester', { cwd: dir });
  return dir;
}
const opt = (dir) => ({ workspace: dir, dangerTools: true });

test('git.js: isGitRepo distinguishes git vs plain dir', () => {
  const repo = makeRepo();
  assert.equal(isGitRepo(repo), true);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agenite-plain-'));
  assert.equal(isGitRepo(plain), false);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(plain, { recursive: true, force: true });
});

test('git.js: commit is attributed to (agenite) and undo reverts via a new commit', async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  execSync('git add -A && git commit -qm init', { cwd: dir });

  // Mutate, then commit — this time there IS something to commit.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2\n');
  const r1 = await gitCommit(dir, 'agent: edit a.txt');
  assert.equal(r1.ok, true);
  assert.equal(r1.committed, true);
  assert.ok(r1.hash);

  // Author must read "(agenite)" even though the OS git user is "tester".
  const author = execSync('git log -1 --format=%an', { cwd: dir }).toString().trim();
  assert.match(author, /\(agenite\)/);

  // Undo must produce a *new* revert commit, not rewrite history.
  const before = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
  const u = await gitUndo(dir);
  assert.equal(u.ok, true);
  const after = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
  assert.notEqual(before, after);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'v1\n');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('git.js: clean repo commit is a no-op, not an error', async () => {
  const dir = makeRepo();
  const r = await gitCommit(dir, 'nothing');
  assert.equal(r.ok, true);
  assert.equal(r.committed, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('git.js: status / diff / isClean reflect working tree', async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  execSync('git add -A && git commit -qm init', { cwd: dir });
  assert.equal(await isClean(dir), true);
  const cleanStatus = await gitStatus(dir);
  assert.match(cleanStatus, /##/); // porcelain -b always prints the branch

  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2\n');
  assert.equal(await isClean(dir), false);
  assert.match(await gitStatus(dir), / M a\.txt/);
  assert.match(await gitDiff(dir), /\+v2/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('git tool: status/commit/undo/log/diff round-trip', async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  execSync('git add -A && git commit -qm init', { cwd: dir });

  let r = await executeTool('git', { action: 'status' }, opt(dir));
  assert.equal(r.ok, true);
  assert.match(r.content, /##|干净/);

  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2\n');
  r = await executeTool('git', { action: 'commit', message: 'agent: edit a.txt' }, opt(dir));
  assert.equal(r.ok, true);
  assert.match(r.content, /✅ 已提交/);

  r = await executeTool('git', { action: 'log' }, opt(dir));
  assert.equal(r.ok, true);
  assert.match(r.content, /agent: edit a\.txt/);

  r = await executeTool('git', { action: 'undo' }, opt(dir));
  assert.equal(r.ok, true);
  assert.match(r.content, /已通过新提交回退/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'v1\n');

  r = await executeTool('git', { action: 'diff' }, opt(dir));
  assert.equal(r.ok, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('git tool: unknown action returns SCHEMA_ERROR', async () => {
  const dir = makeRepo();
  const r = await executeTool('git', { action: 'frobnicate' }, opt(dir));
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'SCHEMA_ERROR');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('git tool: auto git-init when workspace is not a repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenite-noinit-'));
  fs.writeFileSync(path.join(dir, 'x.txt'), 'hi\n');
  const r = await executeTool('git', { action: 'commit', message: 'boot' }, opt(dir));
  assert.equal(r.ok, true);
  assert.equal(isGitRepo(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
