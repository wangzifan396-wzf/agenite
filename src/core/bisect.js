// Regression Hunter — automatically find the commit that broke the build.
//
// This is the payoff of the two harnesses we already ship: the git safety net
// (v0.43) gives us a clean, committed history to search, and the verify engine
// (v0.44) already knows how *this* project checks itself. Point them at each
// other and you get the single highest-leverage debugging move there is:
// binary-search the history until the culprit falls out. What takes a human
// twenty minutes of "git checkout, run tests, hmm, checkout again" takes
// log2(N) automated rounds — 1000 commits collapse to ~10 test runs.
//
// Three implementation decisions worth defending:
//
//   1. We do NOT use `git bisect run`. It looks like the obvious tool, but it
//      execs the command itself — which breaks on Windows where npm/yarn are
//      .cmd shims — and the only way to learn the answer is to parse git's
//      "<hash> is the first bad commit" line, which is *translated* under a
//      non-English locale. Driving the loop ourselves fixes both: we reuse
//      verify.js's spawn (shell on Windows) and read the answer out of
//      refs/bisect/*, which is locale-independent by construction.
//
//   2. We pre-flight both ends. bisect trusts your "good" marking blindly, so a
//      stale baseline silently yields a confidently wrong culprit. Two extra
//      test runs turn that into an actionable "your baseline is broken too,
//      go further back".
//
//   3. The working tree is always restored. Every path out of findBadCommit —
//      success, failure, exception — runs `git bisect reset` in a finally.
//      A debugging tool that can strand you on a detached HEAD is worse than
//      no tool at all.
//
// Dependency-free (node:child_process only).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isGitRepo, isClean } from './git.js';
import { detectVerify, parseVerifyCmd, runVerify, summarizeFailure } from './verify.js';

const execFileAsync = promisify(execFile);

const DEFAULT_ROUND_TIMEOUT = 120_000;
const DEFAULT_MAX_ROUNDS = 12; // 2^12 = 4096 commits; a safety valve, not a limit
const DEFAULT_DEPTH = 20; // how far back to look when no tag is available

async function git(args, dir, { allowFail = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: dir,
      maxBuffer: 16 * 1024 * 1024
    });
    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (e) {
    if (allowFail) {
      return { ok: false, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString() };
    }
    throw new Error(`git ${args.join(' ')} 失败: ${(e.stderr || e.stdout || e.message || '').toString().trim()}`);
  }
}

const out = (r) => (r.stdout || '').trim();

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without a repo)
// ---------------------------------------------------------------------------

/**
 * Pull the culprit hash out of `git bisect` output.
 *
 * We normally read refs/bisect/bad instead — this exists as a belt-and-braces
 * fallback and because parsing is the part most likely to silently rot, so it
 * deserves its own tests.
 */
// Hash widths: 40 hex for SHA-1, 64 for a SHA-256 repo (git supports both, and
// pinning this to 40 would silently break every hunt in a SHA-256 repo).
const HASH_RE = '[0-9a-f]{7,64}';

export function parseFirstBadHash(output) {
  const raw = String(output || '');
  // English phrasing: "<hash> is the first bad commit"
  const direct = raw.match(new RegExp(`\\b(${HASH_RE})\\b[^\\n]{0,40}first bad commit`, 'i'));
  if (direct) return direct[1];
  // Localized git translates that sentence, but the commit header it prints
  // right afterwards is never translated.
  const header = raw.match(/^commit\s+([0-9a-f]{40,64})\s*$/m);
  if (header) return header[1];
  return null;
}

/**
 * How many checkout rounds a bisect transcript went through. The "[<hash>]
 * subject" line git prints on every checkout is locale-independent; the
 * "Bisecting:" prefix is not, so it is only a fallback.
 */
export function countRounds(output) {
  const raw = String(output || '');
  const brackets = raw.match(new RegExp(`^\\[${HASH_RE}\\]`, 'gm'));
  if (brackets) return brackets.length;
  const bisecting = raw.match(/^Bisecting:/gm);
  return bisecting ? bisecting.length : 0;
}

const NO_FIND_REASONS = {
  'head-pass': {
    reason: 'HEAD 当前是通过的 —— 没有可定位的回归。',
    hint: '如果 bug 只在特定场景复现，用 test_cmd 指定一条能真正复现失败的命令再试。'
  },
  'good-bad': {
    reason: '基准提交同样失败 —— 回归比它更早。',
    hint: '把 good_ref 指向更早的提交（例如再上一个 tag）后重试。'
  },
  'no-test-cmd': {
    reason: '没有探测到项目的校验命令，无法判定每个提交的好坏。',
    hint: '用 test_cmd 显式指定，例如 "npm test" 或 "pytest -q"。'
  },
  'missing-cmd': {
    reason: '测试命令在 PATH 上不存在，无法执行。',
    hint: '确认命令已安装，或换一条 test_cmd。'
  },
  'no-good-ref': {
    reason: '找不到可用的基准提交（历史里只有一个提交，或指定的 good_ref 无法解析）。',
    hint: '用 good_ref 显式指定一个已知正常的提交或 tag。'
  },
  'all-skipped': {
    reason: '候选区间里的提交都无法测试（命令缺失或反复超时），已放弃。',
    hint: '这段历史可能无法构建；换一个更近的 good_ref 缩小范围。'
  },
  'max-rounds': {
    reason: '达到最大轮数上限，仍未收敛到唯一提交。',
    hint: '调大 max_rounds，或把 good_ref 指得更近一些。'
  },
  'dirty': {
    reason: '工作区有未提交的改动，bisect 会来回切换提交，可能覆盖它们。',
    hint: '先提交或暂存（git stash）这些改动，再运行回归猎手。'
  },
  'not-repo': {
    reason: '当前工作区不是 git 仓库。',
    hint: '回归猎手依赖提交历史，请先 git init 并提交。'
  }
};

/**
 * Map a failure kind to a human explanation plus the next action.
 * Always returns something — an unknown kind degrades, never throws.
 */
export function diagnoseNoFind(kind, detail = {}) {
  const base = NO_FIND_REASONS[kind] || {
    reason: '未能定位到引入问题的提交。',
    hint: '检查 good_ref 与 test_cmd 是否合理后重试。'
  };
  let reason = base.reason;
  if (kind === 'good-bad' && detail.ref) reason = `基准提交 ${detail.ref} 同样失败 —— 回归比它更早。`;
  if (kind === 'missing-cmd' && detail.cmd) reason = `测试命令 ${detail.cmd} 在 PATH 上不存在，无法执行。`;
  if (kind === 'max-rounds' && detail.remaining) {
    reason = `达到最大轮数上限，仍剩 ${detail.remaining} 个候选提交未收敛。`;
  }
  return { kind: NO_FIND_REASONS[kind] ? kind : 'unknown', reason, hint: base.hint };
}

/** Render a hunt result as the compact block shown in chat and in the UI. */
export function formatHuntReport(result) {
  if (!result) return '（无结果）';
  if (result.ok === false) return `✗ 回归猎手无法运行：${result.error || '未知错误'}`;

  const lines = [];
  if (!result.found) {
    lines.push(`○ 未定位到坏提交：${result.reason || '未知原因'}`);
    if (result.hint) lines.push(`  → ${result.hint}`);
    if (result.label) lines.push(`  测试命令：${result.label}`);
    return lines.join('\n');
  }

  const c = result.commit || {};
  lines.push(`🔍 找到引入问题的提交：${c.short || c.hash}`);
  if (c.subject) lines.push(`  标题：${c.subject}`);
  if (c.author) lines.push(`  作者：${c.author}${c.date ? `  ${c.date}` : ''}`);
  lines.push(
    `  搜索范围：${result.searchSpace} 个提交（${result.goodRef?.ref || '?'} → ${result.badRef?.ref || 'HEAD'}）` +
    `，测试 ${result.rounds} 轮${result.ms ? `，耗时 ${Math.round(result.ms / 1000)}s` : ''}`
  );
  if (result.label) lines.push(`  测试命令：${result.label}`);
  if (result.files?.length) {
    lines.push(`  改动文件：${result.files.slice(0, 8).join('、')}${result.files.length > 8 ? ` 等 ${result.files.length} 个` : ''}`);
  }
  if (result.failure) lines.push('', '--- 该提交上的失败摘要 ---', result.failure);
  lines.push('', `查看完整改动：git show ${c.short || c.hash}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Repo helpers
// ---------------------------------------------------------------------------

/**
 * Pick a plausible "last known good" commit: the most recent tag that isn't
 * HEAD itself, else N commits back along first-parent.
 */
export async function chooseGoodRef(dir, { preferTag = true, depth = DEFAULT_DEPTH } = {}) {
  const head = out(await git(['rev-parse', 'HEAD'], dir, { allowFail: true }));
  if (!head) return null;

  if (preferTag) {
    for (const start of ['HEAD', 'HEAD^']) {
      const tag = out(await git(['describe', '--tags', '--abbrev=0', start], dir, { allowFail: true }));
      if (!tag) continue;
      const hash = out(await git(['rev-parse', `${tag}^{commit}`], dir, { allowFail: true }));
      if (hash && hash !== head) return { ref: tag, hash, source: '最近的 tag' };
    }
  }

  const list = out(await git(['rev-list', `--max-count=${depth + 1}`, '--first-parent', 'HEAD'], dir, { allowFail: true }))
    .split('\n').map((s) => s.trim()).filter(Boolean);
  if (list.length < 2) return null;
  const hash = list[list.length - 1];
  return { ref: hash.slice(0, 12), hash, source: `HEAD 之前第 ${list.length - 1} 个提交` };
}

async function resolveCommit(dir, ref) {
  const hash = out(await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], dir, { allowFail: true }));
  return hash || null;
}

async function commitInfo(dir, hash) {
  const r = await git(
    ['--no-pager', 'show', '-s', '--format=%H%n%h%n%s%n%an%n%ad', '--date=short', hash],
    dir,
    { allowFail: true }
  );
  const [full, short, subject, author, date] = out(r).split('\n');
  const files = out(await git(['--no-pager', 'show', '--name-only', '--pretty=format:', hash], dir, { allowFail: true }))
    .split('\n').map((s) => s.trim()).filter(Boolean);
  return { hash: full || hash, short: short || String(hash).slice(0, 7), subject: subject || '', author: author || '', date: date || '', files };
}

/**
 * Commits still in play: reachable from the bad ref but not from any good ref.
 * This is exactly git's own candidate set, read straight from refs/bisect/* —
 * no output parsing, so it behaves the same under any locale.
 */
async function candidateRevs(dir) {
  const goods = out(await git(['for-each-ref', '--format=%(refname)', 'refs/bisect/good-*'], dir, { allowFail: true }))
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const r = await git(['rev-list', 'refs/bisect/bad', ...goods.map((g) => `^${g}`)], dir, { allowFail: true });
  return out(r).split('\n').map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// The hunt
// ---------------------------------------------------------------------------

/**
 * Binary-search history for the commit that introduced a failure.
 *
 * @param {string} dir workspace root (must be a clean git repo)
 * @param {object} o
 * @param {string} [o.goodRef]  known-good commit/tag; auto-chosen when omitted
 * @param {string} [o.testCmd]  override the detected verify command
 * @param {number} [o.maxRounds]
 * @param {number} [o.timeoutMs] per-round timeout
 * @param {boolean} [o.verifyGood] pre-flight the baseline (default true)
 * @param {(e:object)=>void} [o.onProgress] per-round callback for streaming UIs
 */
export async function findBadCommit(dir, {
  goodRef = '',
  testCmd = '',
  maxRounds = DEFAULT_MAX_ROUNDS,
  timeoutMs = DEFAULT_ROUND_TIMEOUT,
  preferTag = true,
  verifyGood = true,
  onProgress = null
} = {}) {
  const started = Date.now();
  const emit = (e) => { try { onProgress && onProgress(e); } catch { /* UI must never break the hunt */ } };

  if (!dir) return { ok: false, error: '缺少工作区路径。', errorClass: 'BISECT_FAILED' };
  if (!isGitRepo(dir)) {
    const d = diagnoseNoFind('not-repo');
    return { ok: false, error: `${d.reason} ${d.hint}`, errorClass: 'BISECT_FAILED' };
  }
  if (!(await isClean(dir))) {
    const d = diagnoseNoFind('dirty');
    return { ok: false, error: `${d.reason} ${d.hint}`, errorClass: 'BISECT_FAILED' };
  }

  // Which command decides good vs bad
  const spec = (testCmd && parseVerifyCmd(testCmd)) || detectVerify(dir);
  if (!spec) return { ok: true, found: false, ...diagnoseNoFind('no-test-cmd') };

  const rounds = { n: 0 };
  const tested = [];
  const runTest = async (hash, phase) => {
    const r = await runVerify(dir, spec, { timeoutMs });
    const verdict = r.missing || r.timedOut ? 'skip' : (r.ok ? 'good' : 'bad');
    tested.push({ hash: String(hash).slice(0, 12), verdict, ms: r.ms, phase });
    emit({ phase, hash: String(hash).slice(0, 12), verdict, ms: r.ms, round: rounds.n });
    return { ...r, verdict };
  };

  const badHash = await resolveCommit(dir, 'HEAD');
  if (!badHash) return { ok: false, error: '无法解析 HEAD（仓库可能还没有提交）。', errorClass: 'BISECT_FAILED' };

  // --- Pre-flight 1: HEAD must actually be broken ---------------------------
  const headRun = await runTest(badHash, 'preflight-head');
  if (headRun.missing) {
    return { ok: true, found: false, label: spec.label, ...diagnoseNoFind('missing-cmd', { cmd: spec.cmd }) };
  }
  if (headRun.verdict === 'good') {
    return {
      ok: true, found: false, label: spec.label, rounds: 0, tested,
      ms: Date.now() - started, ...diagnoseNoFind('head-pass')
    };
  }
  const headFailure = summarizeFailure(headRun.output).text;

  // --- Resolve the baseline -------------------------------------------------
  let good = null;
  if (goodRef) {
    const hash = await resolveCommit(dir, goodRef);
    if (!hash) {
      return { ok: true, found: false, label: spec.label, ...diagnoseNoFind('no-good-ref') };
    }
    good = { ref: goodRef, hash, source: '用户指定' };
  } else {
    good = await chooseGoodRef(dir, { preferTag });
    if (!good) return { ok: true, found: false, label: spec.label, ...diagnoseNoFind('no-good-ref') };
  }
  if (good.hash === badHash) {
    return { ok: true, found: false, label: spec.label, ...diagnoseNoFind('no-good-ref') };
  }
  // The baseline has to be an ancestor, otherwise bisect has nothing to walk.
  const isAncestor = (await git(['merge-base', '--is-ancestor', good.hash, badHash], dir, { allowFail: true })).ok;
  if (!isAncestor) {
    return {
      ok: true, found: false, label: spec.label,
      reason: `基准提交 ${good.ref} 不是 HEAD 的祖先，无法二分。`,
      hint: '换一个位于当前分支历史上的提交或 tag。',
      kind: 'no-good-ref'
    };
  }

  const searchSpace = out(await git(['rev-list', '--count', `${good.hash}..${badHash}`], dir, { allowFail: true }));
  const originalRef =
    out(await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir, { allowFail: true })) || badHash;

  let restoreNeeded = false;
  try {
    // --- Pre-flight 2: the baseline must actually be good -------------------
    // bisect believes whatever you tell it; a stale baseline yields a
    // confidently wrong culprit. Two extra runs buy a truthful answer.
    if (verifyGood) {
      const co = await git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', good.hash], dir, { allowFail: true });
      if (co.ok) {
        restoreNeeded = true;
        const baseRun = await runTest(good.hash, 'preflight-good');
        await git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', originalRef], dir, { allowFail: true });
        restoreNeeded = false;
        if (baseRun.verdict === 'bad') {
          return {
            ok: true, found: false, label: spec.label, tested, searchSpace: Number(searchSpace) || 0,
            ms: Date.now() - started, ...diagnoseNoFind('good-bad', { ref: good.ref })
          };
        }
      }
    }

    // --- Bisect loop --------------------------------------------------------
    await git(['bisect', 'start'], dir, { allowFail: true });
    restoreNeeded = true;
    await git(['bisect', 'bad', badHash], dir);
    await git(['bisect', 'good', good.hash], dir);

    let culprit = null;
    let lastHead = null;
    let repeats = 0;
    let skips = 0;

    while (true) {
      const remaining = await candidateRevs(dir);
      if (remaining.length === 0) { culprit = badHash; break; }
      if (remaining.length === 1) { culprit = remaining[0]; break; }
      if (rounds.n >= maxRounds) {
        return {
          ok: true, found: false, label: spec.label, tested, rounds: rounds.n,
          searchSpace: Number(searchSpace) || 0, ms: Date.now() - started,
          ...diagnoseNoFind('max-rounds', { remaining: remaining.length })
        };
      }

      const current = out(await git(['rev-parse', 'HEAD'], dir, { allowFail: true }));
      if (!current) break;
      // git ran out of testable commits and parked us somewhere already seen.
      if (current === lastHead) {
        if (++repeats >= 2) break;
      } else {
        repeats = 0;
      }
      lastHead = current;

      rounds.n += 1;
      const r = await runTest(current, `round-${rounds.n}`);
      const mark = r.verdict === 'skip' ? 'skip' : r.verdict;
      if (mark === 'skip') skips += 1;
      const marked = await git(['bisect', mark], dir, { allowFail: true });
      // Once git prints the verdict it stops checking commits out; read the
      // hash from its output only as a shortcut — the loop would find it anyway.
      const parsed = parseFirstBadHash(marked.stdout + '\n' + marked.stderr);
      if (parsed) { culprit = parsed; break; }
      if (skips > 0 && skips >= remaining.length) break;
    }

    if (!culprit) {
      return {
        ok: true, found: false, label: spec.label, tested, rounds: rounds.n,
        searchSpace: Number(searchSpace) || 0, ms: Date.now() - started,
        ...diagnoseNoFind('all-skipped')
      };
    }

    const full = (await resolveCommit(dir, culprit)) || culprit;
    const info = await commitInfo(dir, full);
    return {
      ok: true,
      found: true,
      commit: { hash: info.hash, short: info.short, subject: info.subject, author: info.author, date: info.date },
      files: info.files,
      goodRef: { ref: good.ref, hash: good.hash, source: good.source },
      badRef: { ref: 'HEAD', hash: badHash },
      searchSpace: Number(searchSpace) || 0,
      rounds: rounds.n,
      tested,
      label: spec.label,
      failure: headFailure,
      ms: Date.now() - started
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), errorClass: 'BISECT_FAILED' };
  } finally {
    // Non-negotiable: never leave the user on a detached HEAD.
    if (restoreNeeded) {
      await git(['bisect', 'reset'], dir, { allowFail: true });
      const nowHead = out(await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir, { allowFail: true }));
      if (!nowHead && originalRef) {
        await git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', originalRef], dir, { allowFail: true });
      }
    }
  }
}
