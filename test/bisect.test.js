// Regression Hunter — the payoff of the git safety net + the verify engine.
// The pure helpers are tested directly; the hunt itself is driven against a
// real throwaway repo with a *known* culprit commit, because the whole value
// proposition ("it finds the right commit") is only provable end to end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import test from 'node:test';
import {
  parseFirstBadHash,
  countRounds,
  diagnoseNoFind,
  formatHuntReport,
  chooseGoodRef,
  findBadCommit
} from '../src/core/bisect.js';
import { executeTool } from '../src/core/tools.js';

// The test command every fixture repo carries: exit 1 once value.txt says
// BROKEN. Small, fast, and deterministic — a stand-in for `npm test`.
const CHECK_JS = `const fs = require('fs');
const v = fs.readFileSync(__dirname + '/value.txt', 'utf8');
process.exit(v.includes('BROKEN') ? 1 : 0);
`;

function sh(cmd, dir) {
  return execSync(cmd, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

/**
 * Build a repo whose history breaks at a known point.
 * @param {string[]} values one commit per entry, in order
 * @returns {{dir:string, hashes:string[], branch:string}}
 */
function makeHistory(values) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenite-bisect-'));
  sh('git init -q', dir);
  sh('git config user.email t@t.t', dir);
  sh('git config user.name tester', dir);
  sh('git config commit.gpgsign false', dir);
  fs.writeFileSync(path.join(dir, 'check.js'), CHECK_JS);

  const hashes = [];
  values.forEach((v, i) => {
    fs.writeFileSync(path.join(dir, 'value.txt'), v + '\n');
    // One shell call does add + commit + report HEAD. On Windows spawning git
    // is slow, so collapsing the three ops into a single process cuts the
    // fixture-build time roughly in half.
    hashes.push(sh(`git add -A && git commit -qm "c${i + 1}" && git rev-parse HEAD`, dir));
  });
  const branch = sh('git rev-parse --abbrev-ref HEAD', dir);
  return { dir, hashes, branch };
}

const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ } };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const H = '9f2c1ab5d3e4f6a7b8c9d0e1f2a3b4c5d6e7f8a9'; // 40 hex, a real SHA-1 width

test('bisect: parseFirstBadHash reads the English verdict line', () => {
  const out = `Bisecting: 3 revisions left to test after this (roughly 2 steps)
[${H}] tweak parser
${H} is the first bad commit
commit ${H}
Author: someone <s@example.com>`;
  assert.equal(parseFirstBadHash(out), H);
});

test('bisect: parseFirstBadHash falls back to the commit header under a localized git', () => {
  // git translates the verdict sentence but never the "commit <hash>" header.
  const zh = `二分查找：在此之后，还剩 0 个版本待测试（大约需要 0 步）
${H} 是第一个坏的提交
commit ${H}
Author: someone <s@example.com>`;
  assert.equal(parseFirstBadHash(zh), H);
  // Same, in a SHA-256 repository.
  const h256 = 'e'.repeat(64);
  assert.equal(parseFirstBadHash(`commit ${h256}\nAuthor: x <x@y.z>`), h256);
  assert.equal(parseFirstBadHash('nothing useful here'), null);
  assert.equal(parseFirstBadHash(''), null);
  assert.equal(parseFirstBadHash(null), null);
});

test('bisect: countRounds counts checkouts, not localized prose', () => {
  const h1 = 'a'.repeat(40);
  const h2 = 'b'.repeat(40);
  const out = `Bisecting: 3 revisions left
[${h1}] one
Bisecting: 1 revision left
[${h2}] two`;
  assert.equal(countRounds(out), 2);
  assert.equal(countRounds(`二分查找中\n[${'c'.repeat(40)}] three`), 1);
  // SHA-256 repositories use 64-hex hashes — git supports them, so must we.
  assert.equal(countRounds(`[${'d'.repeat(64)}] sha256 repo`), 1);
  assert.equal(countRounds(''), 0);
});

test('bisect: diagnoseNoFind always yields an actionable reason + hint', () => {
  const headPass = diagnoseNoFind('head-pass');
  assert.equal(headPass.kind, 'head-pass');
  assert.match(headPass.reason, /通过/);
  assert.ok(headPass.hint.length > 0);

  const goodBad = diagnoseNoFind('good-bad', { ref: 'v0.45.0' });
  assert.match(goodBad.reason, /v0\.45\.0/);

  const missing = diagnoseNoFind('missing-cmd', { cmd: 'pytest' });
  assert.match(missing.reason, /pytest/);

  const capped = diagnoseNoFind('max-rounds', { remaining: 17 });
  assert.match(capped.reason, /17/);

  // Unknown kinds degrade instead of throwing.
  const unknown = diagnoseNoFind('who-knows');
  assert.equal(unknown.kind, 'unknown');
  assert.ok(unknown.reason && unknown.hint);
});

test('bisect: formatHuntReport renders a found culprit and a miss', () => {
  const found = formatHuntReport({
    ok: true,
    found: true,
    commit: { hash: 'a'.repeat(40), short: 'aaaaaaa', subject: 'break the parser', author: 'dev', date: '2026-08-10' },
    files: ['src/parse.js'],
    goodRef: { ref: 'v0.45.0' },
    badRef: { ref: 'HEAD' },
    searchSpace: 42,
    rounds: 6,
    label: 'npm run test',
    ms: 12000
  });
  assert.match(found, /aaaaaaa/);
  assert.match(found, /break the parser/);
  assert.match(found, /42 个提交/);
  assert.match(found, /git show aaaaaaa/);

  const miss = formatHuntReport({ ok: true, found: false, reason: '没有回归', hint: '换个命令' });
  assert.match(miss, /没有回归/);
  assert.match(miss, /换个命令/);

  assert.match(formatHuntReport({ ok: false, error: '炸了' }), /炸了/);
});

// ---------------------------------------------------------------------------
// Against a real repository
// ---------------------------------------------------------------------------

test('bisect: chooseGoodRef prefers the most recent tag over a raw offset', async () => {
  const { dir, hashes } = makeHistory(['ok1', 'ok2', 'ok3']);
  try {
    // No tag yet → falls back to walking back through history.
    const noTag = await chooseGoodRef(dir);
    assert.ok(noTag, '有多个提交时必须能给出基准');
    assert.equal(noTag.hash, hashes[0]);

    sh(`git tag v1.0.0 ${hashes[1]}`, dir);
    const tagged = await chooseGoodRef(dir);
    assert.equal(tagged.ref, 'v1.0.0');
    assert.equal(tagged.hash, hashes[1]);
    assert.match(tagged.source, /tag/);
  } finally {
    cleanup(dir);
  }
});

test('bisect: chooseGoodRef returns null when there is nothing to bisect', async () => {
  const { dir } = makeHistory(['only']);
  try {
    assert.equal(await chooseGoodRef(dir), null);
  } finally {
    cleanup(dir);
  }
});

test('bisect: findBadCommit pinpoints the exact commit that broke the build', async () => {
  // 4 commits; #4 (index 3) is the culprit. A linear scan needs 4 runs —
  // bisect proves its worth with ~2 rounds and still lands on the right hash.
  const { dir, hashes, branch } = makeHistory([
    'ok1', 'ok2', 'ok3', 'BROKEN here'
  ]);
  try {
    const r = await findBadCommit(dir, {
      goodRef: hashes[0],
      testCmd: 'node check.js'
    });

    assert.equal(r.ok, true, `hunt 应当成功：${r.error || ''}`);
    assert.equal(r.found, true, `应当找到坏提交，实际：${r.reason || ''}`);
    assert.equal(r.commit.hash, hashes[3], '必须精确命中第 4 个提交');
    assert.equal(r.commit.subject, 'c4');
    assert.equal(r.searchSpace, 3);
    assert.ok(r.rounds >= 1 && r.rounds <= 2, `二分应在 log2(3) 轮内收敛，实际 ${r.rounds}`);
    assert.ok(r.files.includes('value.txt'));
    assert.equal(r.label, 'node check.js');
    // The pre-flight runs are recorded alongside the bisect rounds.
    assert.ok(r.tested.some((t) => t.phase === 'preflight-head' && t.verdict === 'bad'));
    assert.ok(r.tested.some((t) => t.phase === 'preflight-good' && t.verdict === 'good'));

    // Non-negotiable: the tree is exactly where we left it.
    assert.equal(sh('git rev-parse --abbrev-ref HEAD', dir), branch, '必须回到原分支，不能停在 detached HEAD');
    assert.equal(sh('git rev-parse HEAD', dir), hashes[3], '必须回到原来的 HEAD');
    assert.equal(sh('git status --porcelain', dir), '', '工作区必须干净');
    assert.equal(fs.existsSync(path.join(dir, '.git', 'BISECT_LOG')), false, 'bisect 状态必须已清理');
  } finally {
    cleanup(dir);
  }
});

test('bisect: findBadCommit streams per-round progress', async () => {
  // Deliberately tiny: every git call costs real wall-clock time on Windows,
  // and this test is about the callback contract, not about search depth.
  const { dir, hashes } = makeHistory(['ok-a', 'ok-b', 'BROKEN']);
  const seen = [];
  try {
    const r = await findBadCommit(dir, {
      goodRef: hashes[0],
      testCmd: 'node check.js',
      onProgress: (e) => seen.push(e)
    });
    assert.equal(r.found, true);
    assert.ok(seen.length >= 3, '至少要报告两次预检 + 一轮二分');
    assert.ok(seen.every((e) => e.hash && e.verdict && e.phase), '每个进度事件都要带 hash/verdict/phase');
    // A throwing callback must never take the hunt down with it.
    const r2 = await findBadCommit(dir, {
      goodRef: hashes[0],
      testCmd: 'node check.js',
      onProgress: () => { throw new Error('UI blew up'); }
    });
    assert.equal(r2.found, true);
  } finally {
    cleanup(dir);
  }
});

test('bisect: a passing HEAD is reported as "no regression", not a fake culprit', async () => {
  const { dir, hashes } = makeHistory(['ok-a', 'ok-b']);
  try {
    const r = await findBadCommit(dir, { goodRef: hashes[0], testCmd: 'node check.js' });
    assert.equal(r.ok, true);
    assert.equal(r.found, false);
    assert.equal(r.kind, 'head-pass');
    assert.match(r.reason, /HEAD/);
    assert.ok(r.hint);
  } finally {
    cleanup(dir);
  }
});

test('bisect: a broken baseline is called out instead of silently blamed', async () => {
  // Everything is broken, including the "known good" commit we were handed.
  const { dir, hashes } = makeHistory(['BROKEN-a', 'BROKEN-b']);
  try {
    const r = await findBadCommit(dir, { goodRef: hashes[0], testCmd: 'node check.js' });
    assert.equal(r.ok, true);
    assert.equal(r.found, false);
    assert.equal(r.kind, 'good-bad');
    assert.match(r.hint, /更早/);
    assert.equal(sh('git status --porcelain', dir), '', '失败路径同样要还原工作区');
  } finally {
    cleanup(dir);
  }
});

test('bisect: refuses to run on a dirty tree instead of trashing uncommitted work', async () => {
  const { dir, hashes } = makeHistory(['ok', 'BROKEN']);
  try {
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'work in progress\n');
    const r = await findBadCommit(dir, { goodRef: hashes[0], testCmd: 'node check.js' });
    assert.equal(r.ok, false);
    assert.equal(r.errorClass, 'BISECT_FAILED');
    assert.match(r.error, /未提交/);
    assert.ok(fs.existsSync(path.join(dir, 'scratch.txt')), '未提交的文件必须原封不动');
  } finally {
    cleanup(dir);
  }
});

test('bisect: a non-repo directory fails loudly and safely', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agenite-plain-'));
  try {
    const r = await findBadCommit(plain, { testCmd: 'node -e ""' });
    assert.equal(r.ok, false);
    assert.match(r.error, /git 仓库/);
  } finally {
    cleanup(plain);
  }
});

test('bisect: an unresolvable good_ref is reported, not guessed at', async () => {
  const { dir } = makeHistory(['ok', 'BROKEN']);
  try {
    const r = await findBadCommit(dir, { goodRef: 'v9.9.9-nope', testCmd: 'node check.js' });
    assert.equal(r.ok, true);
    assert.equal(r.found, false);
    assert.equal(r.kind, 'no-good-ref');
  } finally {
    cleanup(dir);
  }
});

test('bisect: caps the search at max_rounds instead of grinding forever', async () => {
  const { dir, hashes } = makeHistory(['ok', 'BROKEN', 'BROKEN2', 'BROKEN3']);
  try {
    const r = await findBadCommit(dir, { goodRef: hashes[0], testCmd: 'node check.js', maxRounds: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.found, false);
    assert.equal(r.kind, 'max-rounds');
    assert.equal(r.rounds, 1);
    assert.equal(sh('git status --porcelain', dir), '');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

test('regression_hunt tool: gated behind dangerTools and returns a readable report', async () => {
  const { dir, hashes } = makeHistory(['ok1', 'ok2', 'ok3', 'BROKEN']);
  try {
    // Gate first: without dangerTools it must not touch the repo at all.
    const denied = await executeTool('regression_hunt', {}, { workspace: dir });
    assert.equal(denied.ok, false);

    const r = await executeTool(
      'regression_hunt',
      { good_ref: hashes[0], test_cmd: 'node check.js' },
      { workspace: dir, dangerTools: true }
    );
    assert.equal(r.ok, true, r.error || '');
    assert.match(r.content, /找到引入问题的提交/);
    assert.match(r.content, /c4/);
    assert.equal(r.meta.commit.hash, hashes[3]);
  } finally {
    cleanup(dir);
  }
});

test('regression_hunt tool: is hidden from sub-agents (shared working tree)', async () => {
  const { scopeTools } = await import('../src/core/subagent.js');
  const scoped = scopeTools([{ name: 'read_file' }, { name: 'git' }, { name: 'regression_hunt' }, { name: 'delegate' }]);
  assert.deepEqual(scoped.map((t) => t.name), ['read_file']);
});
