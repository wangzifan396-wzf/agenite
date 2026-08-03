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

import { runAgent } from './agent.js';
import { activeTools, executeTool } from './tools.js';
import { callModelStream } from './client.js';
import { createSubAgentRunner, createFanoutRunner } from './subagent.js';
import { normalizeConfig } from './config.js';
import { defaultMemoryDir } from './memory.js';

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

async function verify(callModel, goal, report, workspace) {
  try {
    const r = await callModel(
      [
        {
          role: 'system',
          content:
            '你是质量验收员。根据你刚才的工作报告，判断目标是否已实质性完成且经过验证（如运行了测试/构建）。给出一句话结论（已完成/部分完成/未完成）并简述依据。'
        },
        { role: 'user', content: `目标：${goal}\n工作报告（节选）：${String(report || '').slice(0, 2000)}` }
      ],
      {}
    );
    return r && r.content ? r.content.trim() : '(未能生成验收结论)';
  } catch (e) {
    return '(验收失败：' + (e && e.message ? e.message : String(e)) + ')';
  }
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

    const onEvent = (type, payload) => {
      if (type === 'tool_start') append('tool', `▶ ${payload.name} ${trunc(JSON.stringify(payload.args || {}), 200)}`);
      else if (type === 'tool') {
        const r = typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result);
        append('tool', `${payload.ok ? '✓' : '✗'} ${payload.name} ${trunc(r, 300)}`);
      } else if (type === 'usage') {
        state.usage = { total: payload.total || 0, cost: payload.cost || 0 };
      } else if (type === 'compact') {
        append('system', '上下文已压缩');
      } else if (type === 'done') {
        state.turns = payload.turns;
      }
    };

    const realRunAgent = (opts) => runAgent(opts);
    const ra = deps && deps.runAgent ? deps.runAgent : realRunAgent;

    // ── Phase 1: PLAN ───────────────────────────────────────────────
    state.status = 'running';
    state.phase = 'plan';
    append('system', '阶段 1/3 · 制定计划');
    flush();
    const planText = await makePlan(cm, state.goal, workspace);
    state.plan = planText;
    append('plan', planText);
    flush();

    // ── Phase 2: EXECUTE (autonomous) ───────────────────────────────
    state.phase = 'execute';
    append('system', '阶段 2/3 · 自治执行（沙箱内操作自动批准）');
    flush();
    const systemPrompt = buildGoalSystemPrompt(state.goal, planText, workspace);
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `目标：${state.goal}\n\n请开始执行上面的计划。完成后给出最终总结。` }
    ];
    const result = await ra({
      messages,
      callModel: cm,
      executeTool: ex,
      onEvent,
      config: { ...config, dangerTools: true, approvalMode: 'auto', workspace, maxTurns: MAX_TURNS, autoCompact: true },
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
    state.turns = result.turns;
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
    state.report = lastAssistant ? lastAssistant.content : '';
    state.usage = {
      total: (result.usage && result.usage.total) || state.usage.total,
      cost: result.cost || state.usage.cost
    };

    // ── Phase 3: VERIFY (explicit self-check) ───────────────────────
    state.phase = 'verify';
    append('system', '阶段 3/3 · 自验证');
    flush();
    const verdict = await verify(cm, state.goal, state.report, workspace);
    append('verify', verdict);

    state.phase = 'report';
    state.status = result.stopped === 'max_turns' ? 'failed' : 'done';
    state.error =
      result.stopped === 'max_turns'
        ? '达到最大步数上限，未能在步数内完成（可重试或把目标拆细）。'
        : '';
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
