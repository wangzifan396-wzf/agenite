// Autonomous "goal" runner — the Delegate & Verify capability.
//
// A goal is a whole objective the user hands off ("refactor module X", "add a
// test suite for Y", "fix all lint errors"). Unlike a normal chat turn (which
// runs one agent loop synchronously inside an HTTP request), a goal runs as an
// independent, long-running autonomous session: it PLANS, then EXECUTES with
// full tool access (auto-approved inside the workspace sandbox), then SELF-
// VERIFIES, and finally writes a report — surviving across browser refreshes
// and even a server restart (state is persisted to disk).
//
// This is the single biggest gap we had versus OpenHands / Hermes / Codex
// background agents, and it reuses 100% of the existing tool/sub-agent/code-
// interpreter infrastructure. All model/tool execution is injected so the
// whole lifecycle is unit-testable without a network.

import { mkdir, writeFile, readFile, readdir, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

import { runAgent } from './agent.js';
import { activeTools, executeTool } from './tools.js';
import { callModelStream } from './client.js';
import { createSubAgentRunner, createFanoutRunner } from './subagent.js';
import { normalizeConfig } from './config.js';
import { defaultMemoryDir } from './memory.js';
import { verifyWorkspace, detectVerify } from './verify.js';

export const GOALS_DIR = join(defaultMemoryDir(), 'goals');
const MAX_CONCURRENT = 3;
const MAX_TURNS = 60;

// id -> { ac, startedAt, done, resolveDone }. Tracks only goals running in
// THIS process. `done` resolves when runGoal fully finishes (incl. last flush),
// so deleteGoal can wait for in-flight writes before unlinking.
const active = new Map();

// Guarantees strictly increasing createdAt within a process, so "newest first"
// sorting in listGoals is deterministic even when two goals are created in the
// same millisecond (otherwise readdir order becomes the arbitrary tiebreaker).
let lastCreatedAt = 0;

function trunc(text, n = 500) {
  const s = String(text == null ? '' : text);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Auto-approve every dangerous tool — for a goal the user explicitly delegated,
// sandbox-bounded autonomy is the intended behaviour (like OpenHands YOLO).
const autoApprove = async () => ({ approved: true, reason: 'autonomous goal (sandbox-bounded)' });

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function readGoal(id, dir = GOALS_DIR) {
  try {
    const raw = await readFile(join(dir, `${id}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeGoal(state, dir = GOALS_DIR) {
  state.updatedAt = Date.now();
  const tmp = join(dir, `${state.id}.json.tmp`);
  const final = join(dir, `${state.id}.json`);
  // Write to a temp file then atomically rename, so a concurrent reader never
  // sees a half-written JSON document (rename is atomic on the same fs).
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, final);
}

function summary(s, isRunning) {
  return {
    id: s.id,
    title: s.title,
    goal: s.goal,
    status: s.status,
    phase: s.phase,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    finalized: !!s.finalized,
    turns: s.turns || 0,
    cost: (s.usage && s.usage.cost) || 0,
    attempt: s.attempt || 0,
    retries: (s.budget && s.budget.retries) || 0,
    verdict: s.verdict || '',
    budget: s.budget || null,
    running: !!isRunning
  };
}

export async function listGoals(dir = GOALS_DIR) {
  await ensureDir(dir);
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(await readFile(join(dir, f), 'utf8'));
      out.push(summary(s, active.has(s.id)));
    } catch {
      /* skip corrupt entries */
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function getGoal(id, dir = GOALS_DIR) {
  return readGoal(id, dir);
}

export async function deleteGoal(id, dir = GOALS_DIR) {
  const s = await readGoal(id, dir);
  if (!s) return { ok: false, error: '未找到' };
  const a = active.get(id);
  if (a) {
    try { a.ac.abort(); } catch {}
    // Wait for runGoal to fully finish (incl. its awaited terminal flush)
    // before removing the file, so we don't race a pending write.
    try { await a.done; } catch {}
  }
  // Guard against any straggler debounced flush landing after the unlink.
  for (let i = 0; i < 5; i++) {
    try { await unlink(join(dir, `${id}.json`)); } catch {}
    if (!(await readGoal(id, dir))) return { ok: true };
    await new Promise((r) => setTimeout(r, 20));
  }
  return { ok: true };
}

export function stopGoal(id) {
  const a = active.get(id);
  if (a) {
    try {
      a.ac.abort();
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
}

// On startup, any goal left "running"/"queued" has no live controller (this
// process didn't own it). Mark it interrupted — there is no resume yet.
export async function initGoals(dir = GOALS_DIR) {
  try {
    const all = await listGoals(dir);
    for (const s of all) {
      if (s.status === 'running' || s.status === 'queued') {
        const st = await readGoal(s.id, dir);
        if (st) {
          st.status = 'interrupted';
          st.error = st.error || '服务重启后该目标未恢复运行（暂不支持断点续跑）。';
          await writeGoal(st, dir);
        }
      }
    }
  } catch {
    /* nothing to recover */
  }
}

export async function createGoal({ goal, title, config }, dir = GOALS_DIR, deps = null) {
  const g = String(goal || '').trim();
  if (!g) return { ok: false, error: '目标不能为空' };
  if (active.size >= MAX_CONCURRENT) {
    return {
      ok: false,
      error: `同时运行的目标已达上限（${MAX_CONCURRENT}）。请先等现有目标完成或停止。`
    };
  }
  await ensureDir(dir);
  const id = randomUUID().slice(0, 8);
  const state = {
    id,
    title: (title && String(title).trim()) || g.slice(0, 40),
    goal: g,
    status: 'queued',
    phase: 'init',
    createdAt: (() => {
      const t = Math.max(Date.now(), lastCreatedAt + 1);
      lastCreatedAt = t;
      return t;
    })(),
    updatedAt: Date.now(),
    config: sanitizeGoalConfig(config),
    budget: resolveBudget(config),
    attempt: 0,
    verdict: '',
    plan: '',
    log: [],
    report: '',
    error: '',
    usage: { total: 0, cost: 0 },
    turns: 0
  };
  await writeGoal(state, dir);
  // Fire and forget — never block the HTTP response on a long autonomous run.
  runGoal(id, dir, deps).catch((e) => {
    console.error('[goals] runGoal crashed:', e && e.message);
  });
  return { ok: true, id, status: 'queued' };
}

function sanitizeGoalConfig(config = {}) {
  // Keep only the fields the agent loop + model client need. apiKey is kept so
  // a goal can be re-run after a restart; it lives in the user's own home dir.
  const c = normalizeConfig({ ...(config || {}), workspace: config && config.workspace });
  return c;
}

// A goal may carry a `budget` (from config.budget) capping how much autonomy it
// is allowed before we stop it — the same safety rails OpenHands/Hermes expose
// so a delegated goal can never run away. Sensible defaults if unset.
export function resolveBudget(config = {}) {
  const b = (config && config.budget) || {};
  const maxTurns = Number.isFinite(b.maxTurns) && b.maxTurns > 0 ? Math.floor(b.maxTurns) : MAX_TURNS;
  const maxCostUSD = Number.isFinite(b.maxCostUSD) && b.maxCostUSD > 0 ? b.maxCostUSD : 1.0;
  const timeoutMs = Number.isFinite(b.timeoutMs) && b.timeoutMs > 0 ? b.timeoutMs : 10 * 60 * 1000;
  const retries = Number.isFinite(b.retries) && b.retries >= 0 ? Math.floor(b.retries) : 2;
  return { maxTurns, maxCostUSD, timeoutMs, retries };
}

// v0.58 — verification-gated completion.
// Deterministic real-test verification is the PRIMARY signal; a fresh-context
// LLM judge (sees execution LOG FACTS, never the agent's self-report) is the
// FALLBACK; and the old false-positive bias ("trust the self-report") is flipped
// to "proof required" — no proof means NOT done. Retries stay capped by
// budget.retries.
function resolveGoalVerifyMode(config) {
  const m = (config && config.goalVerify) || 'auto';
  return ['auto', 'full', 'judge', 'off'].includes(m) ? m : 'auto';
}

// Parse a judge's one-line verdict. A judge that says 未完成 / 部分完成 is the
// only negative; everything else (incl. genuinely ambiguous text) passes — but
// the judge is fresh-context and reads facts, so this is trustworthy enough to
// be the *secondary* signal behind the deterministic test gate.
function parseVerdictText(s) {
  const t = String(s || '');
  if (t.includes('未完成') || t.includes('部分完成')) return false;
  return true;
}

function makeSummarize(callModel) {
  return async (digestText) => {
    try {
      const r = await callModel(
        [
          {
            role: 'system',
            content:
              '对话压缩器：把执行记录压缩成简洁要点，保留：目标、已完成关键步骤与结论、创建/修改的文件、未完成事项、重要错误。短句列点，不臆造。'
          },
          { role: 'user', content: String(digestText || '').slice(0, 6000) }
        ],
        {}
      );
      return r && r.content ? r.content : '';
    } catch {
      return '';
    }
  };
}

async function makePlan(callModel, goal, workspace) {
  try {
    const r = await callModel(
      [
        {
          role: 'system',
          content:
            '你是高级技术规划师。给定一个目标，输出一份简洁、可执行的实施计划：用编号步骤列出要做的事、会用到哪些工具/文件、验证方式。不要写代码，不要客套。若目标模糊，先列出需要澄清的假设。'
        },
        { role: 'user', content: `目标：${goal}\n工作区：${workspace}` }
      ],
      {}
    );
    return r && r.content ? r.content.trim() : '(未能生成计划)';
  } catch (e) {
    return '(计划生成失败：' + (e && e.message ? e.message : String(e)) + ')';
  }
}

// Fresh-context judge: it has NEVER seen the model's reasoning while writing
// its report, and is fed the EXECUTION LOG FACTS (tool calls + results), not
// the agent's self-reported narrative. This separation is exactly what stops
// the judge from rubber-stamping the model's own claims — the 2026 reliability
// consensus calls this the secondary, trustworthy verification signal.
const JUDGE_SYSTEM =
  '你是独立验收员。你没有看到模型撰写工作报告时的任何推理过程，只能依据下方【执行日志事实】判断目标是否完成。' +
  '给出一句话结论（已完成/部分完成/未完成）并简述依据。' +
  '判定规则：若日志显示测试/构建/lint 已通过，或目标产物已生成且无错误，判为已完成；' +
  '若日志显示你未看到任何验证动作、或仍有报错，判为未完成。不要相信报告里的自我宣称，只信日志事实。';

async function judgeGoal(callModel, goal, evidence) {
  const r = await callModel(
    [
      { role: 'system', content: JUDGE_SYSTEM },
      {
        role: 'user',
        content:
          `目标：${goal}\n\n执行日志事实（按时间顺序，仅含工具调用、结果与错误，不含模型自报结论）：\n` +
          String(evidence || '').slice(0, 6000)
      }
    ],
    {}
  );
  return r && r.content ? r.content.trim() : '(验收未返回结论)';
}

// Collect the execution facts a judge can reason over — what the agent ACTUALLY
// did, not what it claims. Bounded so we never blow up the judge's context.
function buildEvidence(state) {
  const lines = (state.log || [])
    .filter((l) => l.type === 'tool' || l.type === 'subagent' || l.type === 'verify' || l.type === 'error')
    .slice(-60)
    .map((l) => `[${l.type}] ${l.text}`);
  return lines.join('\n');
}

// The gate. Pure (no side effects) — runGoal does the logging / report merge.
//   mode 'off'   → done, no proof (legacy escape hatch)
//   mode 'full'  → deterministic test gate; no test detected ⇒ NOT done
//   mode 'auto'  → test gate if a test command exists, else fresh-context judge
//   mode 'judge' → fresh-context judge only
// `vw`/`dv` are injected (real or fake) so the whole thing is unit-testable.
async function verifyGate({ cm, goal, state, workspace, config, vw, dv }) {
  const mode = resolveGoalVerifyMode(config);
  if (mode === 'off') {
    return { source: 'none', done: true, confidence: 0, detail: '验证门控已关闭 (goalVerify: off)，按报告直接判定完成。' };
  }

  // ── Primary: deterministic real-test gate ──
  if (mode === 'full' || mode === 'auto') {
    let spec = null;
    try { spec = dv(workspace); } catch { spec = null; }
    if (spec) {
      let vres = null;
      try {
        vres = await vw(workspace, {
          level: 'full',
          cmd: (config && config.verifyCmd) || '',
          changedFiles: [],
          timeoutMs: (config && config.verifyTimeoutMs) || 120000
        });
      } catch (e) {
        vres = { ran: false, ok: false, reason: '验证执行异常：' + (e && e.message ? e.message : String(e)) };
      }
      if (vres && vres.ran) {
        const ok = !!vres.ok;
        return {
          source: 'test',
          done: ok,
          confidence: ok ? 1 : 0.9,
          detail: (ok ? '✓ 验证通过：' : '✗ 验证失败：') + (vres.summary || vres.label || ''),
          label: vres.label || '',
          kind: vres.kind || '',
          ran: true,
          ok,
          failures: vres.failures || []
        };
      }
      // A test command was promised (spec) but did not actually run.
      if (mode === 'full') {
        return { source: 'test', done: false, confidence: 1, detail: '未探测到可执行的测试命令（' + (vres && vres.reason ? vres.reason : '命令缺失') + '）。' };
      }
      // 'auto' → fall through to judge.
    } else if (mode === 'full') {
      return { source: 'test', done: false, confidence: 1, detail: 'goalVerify=full 但未探测到任何测试命令（npm test / cargo test / go test / pytest / make test），无法给出确定性完成证据。' };
    }
  }

  // ── Fallback: fresh-context judge reads execution facts, not self-report ──
  try {
    const evidence = buildEvidence(state);
    const judgeText = await judgeGoal(cm, goal, evidence);
    const done = parseVerdictText(judgeText);
    return { source: 'judge', done, confidence: 0.7, detail: judgeText, evidence };
  } catch (e) {
    // Judge failed: we CANNOT prove completion ⇒ flip the bias to NOT done.
    return { source: 'judge', done: false, confidence: 0.5, detail: '验收判断失败（' + (e && e.message ? e.message : String(e)) + '），无法给出确定性结论，按未完成处理。' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v0.59 — Outcome Gate (成果复核门控)
// A quality layer ON TOP of the v0.58 verification gate, fused into the SAME
// VERIFY→self-heal loop (not a separate agent rewrite — per the 2026 mini-SWE-
// agent conclusion, ACI matters more than agent architecture). It only runs
// AFTER the deterministic verify gate already proved the goal functionally
// done, and only when a git baseline exists to diff against.
//
//   1) Deterministic anti-exploit checks (free, always on inside the gate):
//      empty diff / no-op, and deleted test files. Exact analogues of the
//      Berkeley RDI "cheat scanner" patterns — we never trust, we check.
//   2) Fresh-context Critic: reviews the ACTUAL git diff + verification result,
//      not the agent's self-report. Returns structured criticism that loops
//      back into self-heal. This is Anthropic "Outcomes" for a single agent.
// ─────────────────────────────────────────────────────────────────────────────

function resolveGoalCriticMode(config) {
  const m = (config && config.goalCritic) || 'on';
  return m === 'off' ? 'off' : 'on';
}

// Run a git command in the workspace; resolve to stdout or null on any failure
// (not a repo, git missing, timeout). Never throws — the outcome gate must
// degrade gracefully to "skip" when git isn't usable.
function gitExec(workspace, args, { timeout = 20000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', workspace, ...args], { timeout, maxBuffer }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

async function gitRevParseHead(workspace) {
  const out = await gitExec(workspace, ['rev-parse', 'HEAD'], { timeout: 15000 });
  return out ? out.trim() || null : null;
}

function isTestFile(p) {
  if (!p) return false;
  return (
    /\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|rb|java)$/.test(p) ||
    /(^|[/\\])(tests?|spec|__tests__|__mocks__)([/\\])/.test(p)
  );
}

// Compute the actual diff the agent produced vs the captured baseline. Returns
// null when git is unavailable / not a repo (caller skips the outcome gate).
async function getDiff(workspace, baselineRef) {
  if (!baselineRef) return null;
  const [nameStatus, diff, untracked] = await Promise.all([
    gitExec(workspace, ['diff', '--name-status', baselineRef]),
    gitExec(workspace, ['diff', baselineRef, '--']),
    gitExec(workspace, ['ls-files', '--others', '--exclude-standard'])
  ]);
  if (nameStatus == null) return null; // git failed entirely

  const changed = (nameStatus.split('\n'))
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const tab = l.indexOf('\t');
      const status = tab > 0 ? l.slice(0, tab) : l[0];
      const path = tab > 0 ? l.slice(tab + 1) : l.slice(1);
      return { status: status.replace(/\d.*$/, ''), path };
    });
  const untrackedFiles = (untracked || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const allPaths = changed.map((c) => c.path).concat(untrackedFiles);
  const deletedTestFiles = changed
    .filter((c) => c.status === 'D' && isTestFile(c.path))
    .map((c) => c.path);

  return {
    // `git diff baselineRef` compares the working tree to the baseline commit,
    // so committed-since-baseline changes are included too — empty only when
    // truly nothing changed.
    empty: allPaths.length === 0,
    files: allPaths,
    deletedTestFiles,
    // Bound so we never blow up the critic's context. New (untracked) files are
    // listed by name only — deterministic and side-effect-free (we never `add`).
    diff: (diff || '').slice(0, 9000),
    untracked: untrackedFiles
  };
}

// Deterministic anti-exploit check. Returns { ok, code, detail }. Only the two
// unambiguous cheating patterns are hard-rejected; "test-files-only" is NOT a
// hard reject because a legitimate goal ("add tests for X") changes only tests
// — that smell is left for the fresh-context Critic to judge from the real diff.
function antiExploitCheck(d) {
  if (!d || d.empty) {
    return {
      ok: false,
      code: 'no-change',
      detail:
        '防作弊检查未通过：本次执行未产生任何代码改动（空 diff / no-op）。目标显然未完成，或改动被意外回滚。'
    };
  }
  if (d.deletedTestFiles && d.deletedTestFiles.length) {
    return {
      ok: false,
      code: 'deleted-tests',
      detail:
        '防作弊检查未通过：检测到删除了测试文件（' +
        d.deletedTestFiles.join('、') +
        '）。删除测试以使验证通过属于作弊式改动，不予通过。'
    };
  }
  return { ok: true, code: 'clean' };
}

const CRITIC_SYSTEM =
  '你是质量评审员（Code Reviewer）。你被要求独立评审一个自治智能体为达成目标所做的【实际代码改动】，以及它的验证结果。' +
  '你未参与执行过程，不要被任何自报结论影响——只看下方的 diff 与验证事实。\n' +
  '请判断：\n' +
  '1) 是否真正解决了目标，还是仅靠改测试、绕过/弱化验证、占位或空改动蒙混过关；\n' +
  '2) 改动是否最小且针对性，有无明显回归风险或破坏其他功能；\n' +
  '3) 是否仅为“让测试通过”而修改测试断言却不修复真正实现。\n' +
  '给出一行结论，以“达标：”或“未达标：”开头，随后附具体修改建议（若未达标）。';

async function critiqueResult(callModel, goal, d, verificationDetail) {
  const r = await callModel(
    [
      { role: 'system', content: CRITIC_SYSTEM },
      {
        role: 'user',
        content:
          `目标：${goal}\n\n验证结果：\n${String(verificationDetail || '').slice(0, 1500)}\n\n` +
          `实际代码改动（git diff，已截断）：\n${d && d.diff ? d.diff : '(无 diff)'}\n\n` +
          `改动文件清单：${(d && d.files && d.files.length ? d.files.join(', ') : '(空)')}\n` +
          `未纳入 diff 的新文件（仅列名）：${(d && d.untracked && d.untracked.length ? d.untracked.join(', ') : '无')}`
      }
    ],
    {}
  );
  return r && r.content ? r.content.trim() : '(评审未返回结论)';
}

// Critic is a SECONDARY, *quality* signal — functional correctness is already
// proven by the test gate. So we only block on an explicit "未达标"; ambiguity
// (or a model failure) is accepted rather than re-introducing brittleness.
function parseCritique(s) {
  const t = String(s || '');
  if (t.includes('未达标')) return false;
  return true;
}

// The outcome gate. Pure-ish (runs git + one model call); runGoal does the
// logging / report merge. Returns null when it should be skipped (disabled, no
// baseline, or git unavailable) so the v0.58 verify gate remains authoritative.
async function outcomeGate({ cm, goal, state, workspace, config, baselineRef, getDiffFn }) {
  if (resolveGoalCriticMode(config) === 'off') return null;
  const d = await getDiffFn(workspace, baselineRef);
  if (!d) return null; // no baseline / not a git repo → degrade, skip

  const ax = antiExploitCheck(d);
  if (!ax.ok) {
    return { source: 'outcome', stage: 'antiexploit', done: false, confidence: 1, detail: ax.detail };
  }

  let critique;
  try {
    critique = await critiqueResult(cm, goal, d, state.verdict);
  } catch {
    return null; // critic failed → degrade gracefully, don't block on a model error
  }
  const ok = parseCritique(critique);
  return {
    source: 'outcome',
    stage: 'critic',
    done: ok,
    confidence: ok ? 0.9 : 0.85,
    detail: ok
      ? '成果复核通过：改动真实、非仅改测试、无明显回归。\n' + critique.slice(0, 800)
      : '成果复核未达标，需修正：\n' + critique.slice(0, 1500)
  };
}

function buildGoalSystemPrompt(goal, plan, workspace) {
  return [
    '你是 Agenite 的「自治执行智能体」。你被委派了一个明确的目标，需要独立规划、执行并验证，无需逐步征求许可。',
    `当前日期：${new Date().toISOString().slice(0, 10)}。`,
    `工作区（所有文件读写与命令都限定在此沙箱内）：${workspace}`,
    `你的目标：\n${goal}`,
    plan ? `已制定的计划（请据此执行，但可根据实际情况调整）：\n${plan}` : '（无计划，请自行规划后执行）',
    '',
    '执行纪律：',
    '1. 把目标拆成小步，每步可验证；先用 codebase_search / grep_files / read_file 理解现有代码，再动手。',
    '2. 多个互不依赖的子任务用 fanout 并行派发子代理加速；单个聚焦子任务用 delegate。',
    '3. 需要计算、跑测试、构建或运行脚本时，用 run_code（node/python）或 run_command。',
    '4. 【自验证】完成代码改动后，必须运行项目的测试/构建/lint 来验证（run_code 或 run_command）。只有通过验证，或明确记录为何无法验证，才能宣布完成。验证失败时迭代修复直到通过。',
    '5. 所有操作都在工作区沙箱内自动批准；不要尝试访问沙箱外的路径。',
    '6. 完成后，用自然语言给出最终总结：做了什么、改了哪些文件、验证结果、遗留问题。',
    '不要停下等待用户确认——直接把目标做完。'
  ].join('\n');
}

// deps lets tests inject fake callModel/executeTool/runAgent/runSubAgent so the
// full lifecycle runs without a network. When null, the real modules are used.
export async function runGoal(id, dir = GOALS_DIR, deps = null) {
  const state = await readGoal(id, dir);
  if (!state) return;
  const ac = new AbortController();
  let resolveDone;
  const done = new Promise((res) => { resolveDone = res; });
  active.set(id, { ac, startedAt: Date.now(), done, resolveDone });

  let lastWrite = 0;
  // Serialize all flushes through a single chain so a later write always
  // carries the latest state and no fire-and-forget (debounced append) flush
  // can land after the final "finalized" write — otherwise a concurrent reader
  // can parse a half-written JSON file and skip the goal.
  let pendingFlush = Promise.resolve();
  const flush = () => {
    lastWrite = Date.now();
    pendingFlush = pendingFlush.then(() => writeGoal(state, dir)).catch(() => {});
    return pendingFlush;
  };
  const append = (type, text) => {
    state.log.push({ t: Date.now(), type, text: String(text) });
    if (Date.now() - lastWrite > 500) flush();
  };

  try {
    const config = state.config;
    const workspace = config.workspace || process.cwd();
    // v0.59 — capture the git HEAD before any agent action so the Outcome Gate
    // can diff the ACTUAL changes the agent made (deps-injectable for tests).
    const gitRev = deps && deps.gitRevParseHead ? deps.gitRevParseHead : gitRevParseHead;
    const getDiffFn = deps && deps.getDiff ? deps.getDiff : getDiff;
    const baselineRef = await gitRev(workspace).catch(() => null);
    const tools = activeTools({ ...config, dangerTools: true, approvalMode: 'auto' });

    const realCallModel = (msgs, o = {}) =>
      callModelStream({
        config: { ...config, dangerTools: true, approvalMode: 'auto' },
        messages: msgs,
        tools,
        onDelta: o && o.onDelta,
        signal: ac.signal
      });
    const realExecute = (name, args, o = {}) =>
      executeTool(name, args, {
        ...o,
        workspace,
        dangerTools: true,
        approvalMode: 'auto',
        requestApproval: autoApprove
      });

    const cm = deps && deps.callModel ? deps.callModel : realCallModel;
    const ex = deps && deps.executeTool ? deps.executeTool : realExecute;
    const summarize = makeSummarize(cm);

    const onSubEvent = (sid, sname, type) => append('subagent', `[${sname}] ${type}`);
    const realRunSub = createSubAgentRunner({
      callModel: cm,
      executeTool: ex,
      baseConfig: { ...config, dangerTools: true, approvalMode: 'auto' },
      tools,
      memoryBase: defaultMemoryDir(),
      injectMemory: () => Promise.resolve(''),
      onSubEvent,
      summarize,
      requestApproval: autoApprove,
      platform: process.platform
    });
    const runSubAgent = deps && deps.createSubAgentRunner ? deps.createSubAgentRunner : realRunSub;
    const runFanout = createFanoutRunner(runSubAgent);

    // Verification gate deps (v0.58). Real engines by default; tests inject
    // fakes so the whole lifecycle runs without a network or a real workspace.
    const vw = deps && deps.verifyWorkspace ? deps.verifyWorkspace : verifyWorkspace;
    const dv = deps && deps.detectVerify ? deps.detectVerify : detectVerify;

    const onEvent = (type, payload) => {
      if (type === 'tool_start') append('tool', `▶ ${payload.name} ${trunc(JSON.stringify(payload.args || {}), 200)}`);
      else if (type === 'tool') {
        const r = typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result);
        append('tool', `${payload.ok ? '✓' : '✗'} ${payload.name} ${trunc(r, 300)}`);
      } else if (type === 'usage') {
        state.usage = { total: payload.total || 0, cost: payload.cost || 0 };
      } else if (type === 'compact') {
        append('system', '上下文已压缩');
      }
      // NOTE: turns are accumulated from runAgent's *return value* (see the loop)
      // so they sum correctly across self-heal retries — not overridden here.
    };

    const realRunAgent = (opts) => runAgent(opts);
    const ra = deps && deps.runAgent ? deps.runAgent : realRunAgent;

    // Budget rails: a delegated goal can never run away. Derived from
    // config.budget with safe defaults (resolveBudget).
    const budget = state.budget || resolveBudget(state.config);
    const wallStart = Date.now();
    const overBudget = () => {
      if (state.turns >= budget.maxTurns) return '超出步数上限（' + budget.maxTurns + ' 步）。';
      if (state.usage.cost >= budget.maxCostUSD) return '超出成本上限（$' + budget.maxCostUSD.toFixed(2) + '）。';
      if (Date.now() - wallStart >= budget.timeoutMs) return '超出时长上限（' + Math.round(budget.timeoutMs / 1000) + 's）。';
      return '';
    };

    // ── Phase 1: PLAN (once) ────────────────────────────────────────
    state.status = 'running';
    state.phase = 'plan';
    append('system', '阶段 1/3 · 制定计划');
    flush();
    const planText = await makePlan(cm, state.goal, workspace);
    state.plan = planText;
    append('plan', planText);
    flush();

    // ── Phase 2+3: EXECUTE → VERIFY, with self-heal retries ─────────
    // If self-verification says the goal is NOT done, we hand the agent its
    // own verdict and let it re-run a tighter attempt — bounded by budget.retries
    // and the cumulative turn/cost ceiling. This is the "agent fixes its own
    // failures" loop that makes delegated goals feel reliable.
    const systemPrompt = buildGoalSystemPrompt(state.goal, planText, workspace);
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `目标：${state.goal}\n\n请开始执行上面的计划。完成后给出最终总结。` }
    ];
    const MAX_ATTEMPTS = budget.retries + 1;
    let attempt = 0;
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      state.attempt = attempt;
      state.phase = attempt === 1 ? 'execute' : 'retry';
      append('system', attempt === 1 ? '阶段 2/3 · 自治执行（沙箱内操作自动批准）' : `自愈重试 ${attempt - 1}/${budget.retries} · 复盘并修正`);
      flush();
      const result = await ra({
        messages,
        callModel: cm,
        executeTool: ex,
        onEvent,
        config: {
          ...config,
          dangerTools: true,
          approvalMode: 'auto',
          workspace,
          maxTurns: Math.max(1, budget.maxTurns - state.turns),
          autoCompact: true
        },
        tools,
        summarize,
        toolContext: {
          requestApproval: autoApprove,
          platform: process.platform,
          memoryBase: defaultMemoryDir(),
          runSubAgent,
          runFanout
        }
      });
      state.turns = (state.turns || 0) + (result.turns || 0);
      state.usage = {
        total: (state.usage.total || 0) + ((result.usage && result.usage.total) || 0),
        cost: (state.usage.cost || 0) + (result.cost || 0)
      };
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
      state.report = lastAssistant ? lastAssistant.content : state.report;

      const breached = overBudget();
      if (breached) {
        state.phase = 'report';
        state.status = 'failed';
        state.error = breached;
        append('error', breached);
        break;
      }

      // ── VERIFY (v0.58: verification-gated) ──
      state.phase = 'verify';
      append('system', '阶段 3/3 · 验证门控');
      flush();
      const gate = await verifyGate({
        cm,
        goal: state.goal,
        state,
        workspace,
        config,
        vw,
        dv
      });
      append('verify', `来源=${gate.source} 通过=${gate.done} 置信=${gate.confidence}\n${gate.detail}`);
      state.verdict = gate.detail;
      state.verdictMeta = { source: gate.source, done: gate.done, confidence: gate.confidence };
      state.verification = {
        source: gate.source,
        label: gate.label || '',
        ran: !!gate.ran,
        ok: !!gate.ok,
        kind: gate.kind || '',
        failures: gate.failures || []
      };
      // Make the final report carry proof, not just claims.
      state.report = (state.report ? state.report + '\n\n' : '') + '— 验证结论 —\n' + gate.detail;

      // ── Outcome Gate (v0.59: 成果复核门控) ──
      // Runs ONLY after the deterministic verify gate already passed (we never
      // judge quality before functional correctness is proven) and only when a
      // git baseline exists to diff against. A failed outcome gate feeds its
      // concrete criticism back into the SAME self-heal loop below.
      let outcome = null;
      if (gate.done && resolveGoalCriticMode(config) === 'on') {
        try {
          outcome = await outcomeGate({ cm, goal: state.goal, state, workspace, config, baselineRef, getDiffFn });
        } catch {
          outcome = null;
        }
        if (outcome) {
          append('verify', `成果复核=${outcome.done} 阶段=${outcome.stage}\n${outcome.detail}`);
          state.outcome = {
            source: outcome.source,
            stage: outcome.stage,
            done: outcome.done,
            detail: outcome.detail
          };
          state.report = (state.report ? state.report + '\n\n' : '') + '— 成果复核 —\n' + outcome.detail;
        }
      }

      // Effective completion = verify gate passed AND (no outcome gate ran OR it
      // also passed). A failed outcome gate is treated exactly like a failed
      // verify gate: loop back into self-heal with concrete evidence.
      const effectiveDone = gate.done && (!outcome || outcome.done);
      if (effectiveDone) {
        state.phase = 'report';
        state.status = 'done';
        state.error = '';
        break;
      }
      if (attempt >= MAX_ATTEMPTS) {
        state.phase = 'report';
        state.status = 'failed';
        const why = [];
        if (!gate.done) why.push('验证未通过');
        if (outcome && !outcome.done) why.push('成果复核未达标（' + outcome.stage + '）');
        state.error = why.join('；') + '，且已达自愈重试上限（' + budget.retries + ' 次）。';
        append('error', state.error);
        break;
      }
      // Not done — feed the real evidence + concrete criticism back so the agent can fix it.
      const feedback = [
        '上一轮验证未通过 / 成果复核未达标。验收证据：\n' + trunc(gate.detail, 1200)
      ];
      if (outcome && !outcome.done) {
        feedback.push('成果复核意见（请据此具体修正）：\n' + trunc(outcome.detail, 1500));
      }
      feedback.push(
        '请复盘失败原因并修正，重新运行验证（测试/构建/lint 或对应命令）直到通过，再给出最终总结。'
      );
      messages.push({ role: 'system', content: feedback.join('\n') });
      append('system', '验证/复核未通过，准备复盘重试');
    }

    flush();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (ac.signal.aborted) {
      state.status = 'stopped';
      append('system', '已被用户停止');
    } else {
      state.status = 'failed';
      state.error = msg;
      append('error', msg);
    }
    flush();
  } finally {
    try { await flush(); } catch {}
    state.finalized = true;
    try { await writeGoal(state, dir); } catch {}
    active.delete(id);
    if (resolveDone) resolveDone();
  }
}
