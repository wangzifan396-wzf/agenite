// Thin, dependency-free git helper used by two callers:
//   - the `git` tool (manual status/diff/commit/undo/log from the model)
//   - the auto-checkpoint harness in server.js (commit after each mutating turn)
//
// Every commit the agent makes is attributed to "Agenite Agent (agenite)" on
// BOTH the author and committer lines, so a user can tell agent edits apart
// from their own with `git log --author=agenite` or `git log --grep=agent:`.
// Undo is always *non-destructive*: `git revert` adds a new commit instead of
// rewriting history, so nothing is ever lost.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const AGENT_NAME = 'Agenite Agent';
const AGENT_EMAIL = 'agenite@local';
// The "(agenite)" tag in the display name lets `git log --author=agenite` filter
// every AI-authored commit at once.
export const AGENITE_AUTHOR = `${AGENT_NAME} (agenite) <${AGENT_EMAIL}>`;

export function isGitRepo(dir) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    return true;
  } catch {
    return false;
  }
}

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

export async function gitStatus(dir) {
  const r = await git(['status', '--porcelain', '-b'], dir, { allowFail: true });
  return r.stdout;
}

export async function isClean(dir) {
  const s = await gitStatus(dir);
  // strip the "## branch" line; anything else means dirty
  const body = s.split('\n').filter((l) => !l.startsWith('##')).join('\n').trim();
  return body === '';
}

export async function gitAddAll(dir) {
  await git(['add', '-A'], dir);
}

/** Commit staged (or, with addAll first, all) changes. Default author is the
 * agent; pass { author } to attribute a commit to the user (pre-edit snapshot). */
export async function gitCommit(dir, message, { addAll = true, author = AGENITE_AUTHOR } = {}) {
  if (addAll) await gitAddAll(dir);
  if (await isClean(dir)) return { ok: true, committed: false, hash: null, message: '(already clean — nothing to commit)' };
  await git(
    [
      '-c', `user.name=${AGENT_NAME} (agenite)`,
      '-c', `user.email=${AGENT_EMAIL}`,
      'commit',
      '-m', message,
      '--author', author
    ],
    dir
  );
  const h = await git(['rev-parse', '--short', 'HEAD'], dir, { allowFail: true });
  return { ok: true, committed: true, hash: h.stdout.trim(), message };
}

/** Non-destructive undo: revert the most recent commit with a new commit. */
export async function gitUndo(dir) {
  const head = await git(['rev-parse', '--short', 'HEAD'], dir, { allowFail: true });
  if (!head.ok) return { ok: false, error: '没有可回退的提交（仓库可能为空的初始提交）。' };
  const r = await git(
    [
      '-c', `user.name=${AGENT_NAME} (agenite)`,
      '-c', `user.email=${AGENT_EMAIL}`,
      'revert', '--no-edit', 'HEAD'
    ],
    dir,
    { allowFail: true }
  );
  if (!r.ok) return { ok: false, error: r.stderr.trim() || '回退失败。' };
  const h = await git(['rev-parse', '--short', 'HEAD'], dir, { allowFail: true });
  return { ok: true, hash: h.stdout.trim(), reverted: head.stdout.trim() };
}

export async function gitDiff(dir) {
  const working = await git(['--no-pager', 'diff', 'HEAD'], dir, { allowFail: true });
  if (working.stdout.trim()) return working.stdout;
  // Clean working tree — show what the last agent commit changed instead.
  const last = await git(['--no-pager', 'show', '--stat', 'HEAD'], dir, { allowFail: true });
  return last.ok ? `（工作区干净，以下是最近一次提交的差异摘要）\n${last.stdout}` : '（干净，无差异）';
}

export async function gitLog(dir, n = 10) {
  const r = await git(['--no-pager', 'log', `--oneline`, `-${n}`], dir, { allowFail: true });
  return r.ok ? r.stdout : '(无提交历史)';
}

export async function gitInit(dir) {
  const r = await git(['init'], dir, { allowFail: true });
  if (!r.ok) throw new Error(r.stderr.trim() || 'git init 失败');
  return true;
}
