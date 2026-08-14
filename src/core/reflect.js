// Metacognitive Reflection & Experience Manual — Agenite v0.56
//
// This is the *behavior-layer* half of Agenite's self-improvement loop, sitting
// on top of v0.54's *config-layer* self-evolution (Experience Compounding):
//
//   v0.44  self-heal reflection      (react to a stuck run, in the moment)
//   v0.54  self-evolve config        (distill the best-known config from runs)
//   v0.56  metacognitive reflection  (distill reusable EXPERIENCE from runs)
//
// Why this is worth doing in 2026: the field's dominant theme is self-evolution
// (Hermes "grows with you", MARS metacognitive reflection, EmbodiSkill typed
// reflection). But most of those *guess* — they dump a 5-tool-call heuristic or
// a fuzzy "it got better". Agenite grounds reflection in the same hard signals
// it already collects per run: did auto-verify pass, did it loop, did it mutate
// without verifying, did it finish. So a lesson is *earned from evidence*, and
// the lesson is typed (principle / procedure / warning / skill-defect / ...)
// exactly as EmbodiSkill argues you should — so a genuine skill gap and a one-off
// execution slip are not conflated.
//
// Pure module: no DOM, no fs, no node: imports. Safe to import from the browser
// bundle (app.js) and from node:test. The server does the fs persistence and the
// (optional) LLM enrichment; this file only reasons about runs and lessons.

// ── Lesson taxonomy ──────────────────────────────────────────────────────────
// Mirrors EmbodiSkill's split: a SKILL_DEFECT means the agent's knowledge/skill
// itself is incomplete and should be repaired; an EXECUTION_LAPSE means the agent
// blundered this once and the skill is fine. We don't auto-edit skills here (that
// is v0.46's job), but typing the lesson keeps the two failure modes distinct.
export const LESSON_TYPES = {
  principle: '原则',
  procedure: '流程',
  warning: '警示',
  skillDefect: '技能缺陷',
  executionLapse: '执行失误',
  preference: '偏好',
  general: '经验'
};

const TYPE_EN = {
  principle: 'principle',
  procedure: 'procedure',
  warning: 'warning',
  skillDefect: 'skill-defect',
  executionLapse: 'execution-lapse',
  preference: 'preference',
  general: 'experience'
};

export function lessonTypeName(t) {
  return LESSON_TYPES[t] || LESSON_TYPES.general;
}
export function lessonTypeEn(t) {
  return TYPE_EN[t] || 'experience';
}

// ── Small pure helpers ────────────────────────────────────────────────────────

// FNV-1a 32-bit hash → stable, dependency-free id. Used so the *same* lesson
// produced by different runs collapses to one entry (dedup/merge by content).
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(36);
}

function clampScore(x) {
  x = Number(x);
  if (!Number.isFinite(x)) return 0.5;
  return Math.max(0.05, Math.min(1, Math.round(x * 1000) / 1000));
}

// Normalize a lesson to a stable dedup key: type + lowercased/whitespace-folded
// text. Two lessons that say the same thing in different casing/punctuation
// spacing still merge.
function dedupeKey(l) {
  const text = (l.text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return (l.type || 'general') + '::' + text;
}

function lessonId(l) {
  return 'lz_' + hash32(dedupeKey(l));
}

function withId(l) {
  return { id: lessonId(l), ...l };
}

// What we remember about the run a lesson was distilled from. Kept deliberately
// small so persisted lessons stay compact and the provenance is auditable.
function provenance(r) {
  const rr = r || {};
  return {
    stopped: rr.stopped || null,
    turns: Number(rr.turns) || 0,
    cost: typeof rr.cost === 'number' ? rr.cost : 0,
    verifyOk: rr.verifyOk === true ? true : rr.verifyOk === false ? false : null,
    loopDetected: !!rr.loopDetected,
    destructiveUsed: !!rr.destructiveUsed,
    errorTools: Number(rr.errorTools) || 0,
    maxTurnsHit: rr.stopped === 'max_turns',
    taskHint: rr.taskHint ? String(rr.taskHint).slice(0, 200) : ''
  };
}

// ── classifyRun: turn a finished run into typed lesson candidates ─────────────
// `run` is a plain object (all fields optional). The server builds it from the
// run's `done` payload + the objective `gate` + the trace. Keeping the input a
// plain object (not the live agent loop) makes this trivially unit-testable.
//
// Fields understood:
//   { stopped, turns, cost, verifyOk, verifyLabel, gitCommit, todoDone, aborted,
//     errorTools, destructiveUsed, loopDetected, taskHint }
export function classifyRun(run = {}) {
  const r = run || {};
  const out = [];
  const add = (lesson) => out.push(withId(lesson));

  // 1) Stuck loop → execution lapse. The agent already *acts* on loops mid-run
  //    (v0.55 breaker); this crystallizes the lesson so next run starts wiser.
  if (r.loopDetected) {
    add({
      type: 'executionLapse',
      score: 0.82,
      text: '遇到重复调用相同工具且参数不变却无进展时，立即换思路：拆解目标、换用不同工具或参数，或向用户澄清卡点——不要继续用相同参数重试。',
      context: '卡死循环'
    });
  }

  // 2) Verification failed → procedure. The fix is "read the real error, don't
  //    paper over it" — a concrete, reusable workflow lesson.
  if (r.verifyOk === false) {
    add({
      type: 'procedure',
      score: 0.78,
      text: '自动验证未通过时，先读取真实错误信息与当前文件内容再定位根因；不要为了让检查通过而删改测试或掩盖错误。',
      context: '验证失败' + (r.verifyLabel ? '·' + r.verifyLabel : '')
    });
  }

  // 3) Mutated the world but never verified → warning. The single most common
  //    way agents silently rot a codebase.
  if (r.destructiveUsed && r.verifyOk !== true) {
    add({
      type: 'warning',
      score: 0.66,
      text: '执行了写文件 / 运行命令等变更类操作后，应跑一次验证（构建 / 测试 / 类型检查）确认没有破坏既有功能，再交付。',
      context: '变更后缺验证'
    });
  }

  // 4) Clean finish with verify + git checkpoint → a durable principle. This is
  //    the *good* pattern worth repeating, not just a fix for a failure.
  if (r.stopped === 'done' && r.verifyOk === true && r.gitCommit) {
    add({
      type: 'principle',
      score: 0.72,
      text: '完成改动后用「自动验证 + git 检查点」收尾，既证明结果正确又保留可回退点，是高质交付的稳定节奏。',
      context: '高质量收尾模式'
    });
  }

  // 5) Hit the turn ceiling unfinished → warning about decomposition.
  if (r.stopped === 'max_turns') {
    add({
      type: 'warning',
      score: 0.65,
      text: '在达到最大轮次前仍未完成任务，说明目标拆解或工具选择有问题；下次应更早把任务拆成可验证的小步，并更频繁对照待办清单。',
      context: '超轮次未完成'
    });
  }

  // 6) Tool failures were frequent → procedure about pre-call checks.
  if (Number(r.errorTools) > 0) {
    add({
      type: 'procedure',
      score: 0.55,
      text: `本次有 ${Number(r.errorTools)} 次工具调用失败；失败多源于参数格式或权限问题，下次调用前先确认参数与文件当前状态。`,
      context: '工具失败偏多'
    });
  }

  // 7) Aborted / guardrailed → cost & scope warning.
  if (r.aborted || r.stopped === 'guardrail') {
    add({
      type: 'warning',
      score: 0.5,
      text: '本次运行被护栏 / 中断终止；注意控制单次任务的工具调用规模与成本，必要时拆分任务。',
      context: '中断 / 护栏'
    });
  }

  // Stamp provenance + lifecycle fields.
  const now = new Date().toISOString();
  const src = provenance(r);
  for (const l of out) {
    l.source = src;
    l.createdAt = now;
    l.updatedAt = now;
    l.enabled = true;
    l.hits = 0;
    l.seen = 1;
  }
  return out;
}

// ── mergeLessons: combine a persisted set with fresh candidates ──────────────
// Same-content lessons collapse (dedup by content); repeated reinforcement
// nudges the score up (but never to 1); the richer text wins; a user-disabled
// lesson stays disabled even if a new identical one arrives. Capped to `max`.
export function mergeLessons(existing = [], incoming = [], opts = {}) {
  const max = Number.isFinite(Number(opts.max)) ? Number(opts.max) : 80;
  const map = new Map();

  const push = (l) => {
    const key = dedupeKey(l);
    if (map.has(key)) {
      const cur = map.get(key);
      cur.score = clampScore((cur.score + (Number(l.score) || 0.5)) / 2 + 0.02);
      cur.hits = (cur.hits || 0) + (Number(l.hits) || 0);
      cur.seen = (cur.seen || 0) + 1;
      cur.updatedAt = l.updatedAt || cur.updatedAt;
      // keep the longer (more specific) text
      if ((l.text || '').length > (cur.text || '').length) cur.text = l.text;
      if (l.context) cur.context = l.context;
      if (l.source) cur.source = l.source;
      // respect a prior user disable
      if (cur.enabled === false) cur.enabled = false;
      else cur.enabled = l.enabled !== false;
    } else {
      map.set(key, {
        id: lessonId(l),
        type: l.type || 'general',
        text: String(l.text || ''),
        context: l.context ? String(l.context) : '',
        score: clampScore(l.score),
        hits: Number(l.hits) || 0,
        seen: 1,
        enabled: l.enabled !== false,
        createdAt: l.createdAt || new Date().toISOString(),
        updatedAt: l.updatedAt || l.createdAt || new Date().toISOString(),
        source: l.source || null
      });
    }
  };

  for (const l of existing || []) push(l);
  for (const l of incoming || []) push(l);

  let arr = [...map.values()];
  arr.sort((a, b) => b.score - a.score || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  // Keep every enabled lesson, plus the top few disabled ones (so a disabled
  // lesson isn't silently dropped the next time it resurfaces).
  const enabled = arr.filter((l) => l.enabled !== false);
  const disabled = arr.filter((l) => l.enabled === false).slice(0, Math.max(0, max - enabled.length));
  return [...enabled, ...disabled].slice(0, max);
}

// ── selectForPrompt: pick the highest-value lessons to inject ────────────────
// Filters to enabled, sorts by score, then takes up to `limit` lessons or until
// the soft `maxTokens` budget is spent. Deterministic — no randomness.
export function selectForPrompt(lessons = [], opts = {}) {
  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 6;
  const maxTokens = Number.isFinite(Number(opts.maxTokens)) ? Number(opts.maxTokens) : 900;
  const sorted = [...(lessons || [])]
    .filter((l) => l.enabled !== false)
    .sort((a, b) => b.score - a.score);
  const out = [];
  let used = 0;
  for (const l of sorted) {
    if (out.length >= limit) break;
    const approx = (l.text || '').length + (l.context ? l.context.length : 0) + 16;
    if (used + approx > maxTokens && out.length > 0) break;
    out.push(l);
    used += approx;
  }
  return out;
}

// ── lessonToPromptText: render selected lessons as a system-prompt section ───
// Returns '' when there is nothing to inject, so callers can skip appending.
export function lessonToPromptText(lessons = [], opts = {}) {
  const picks = lessons && lessons.length ? lessons : selectForPrompt(lessons, opts);
  if (!picks.length) return '';
  const lines = picks.map((l) => {
    const label = lessonTypeName(l.type);
    const ctx = l.context ? `（${l.context}）` : '';
    return `- [${label}${ctx}] ${l.text}`;
  });
  const head = opts.title || '## 经验手册（来自过往运行的反思，仅供参考；请按当前情况判断是否适用，不要盲从）';
  return head + '\n' + lines.join('\n');
}

// ── enrichLesson: optional LLM pass to make a template lesson concrete ───────
// Pure function: takes a lesson + a `callModelFn(messages) -> Promise<{content}>`.
// On any failure (no fn, network error, bad output) it returns the original
// lesson unchanged — the template is always good enough, enrichment only adds
// specificity. Never throws.
export async function enrichLesson(lesson, callModelFn, opts = {}) {
  if (!lesson || typeof callModelFn !== 'function') return lesson;
  const src = lesson.source || {};
  const signals = [
    src.stopped ? `运行结果：${src.stopped}` : '',
    src.verifyOk === true ? '自动验证：通过' : src.verifyOk === false ? '自动验证：未通过' : '',
    src.loopDetected ? '检测到卡死循环' : '',
    src.destructiveUsed ? '执行了变更类操作' : '',
    src.errorTools ? `失败工具调用 ${src.errorTools} 次` : '',
    src.maxTurnsHit ? '达到最大轮次仍未完成' : '',
    src.taskHint ? `任务：${String(src.taskHint).slice(0, 120)}` : ''
  ].filter(Boolean).join('；');

  const messages = [
    {
      role: 'system',
      content:
        '你是一名严谨的 AI 工程教练。下面给出一条「运行信号提炼出的经验模板」与对应的运行信号，' +
        '请把模板改写成一条简短、具体、可执行的工程经验（中文，40–70 字，不写标点列表、不写解释）。' +
        '它会被注入未来的 Agent 系统提示，所以只输出经验正文本身。'
    },
    {
      role: 'user',
      content:
        `经验类型：${lessonTypeName(lesson.type)}（${lessonTypeEn(lesson.type)}）\n` +
        `原始模板：${lesson.text}\n` +
        `运行信号：${signals || '（无）'}`
    }
  ];

  try {
    const r = await callModelFn(messages);
    const text = (r && typeof r.content === 'string' ? r.content : '').trim();
    if (text && text.length >= 12 && text.length <= 220) {
      return { ...lesson, text, enriched: true, updatedAt: new Date().toISOString() };
    }
  } catch {
    /* fall back to the template lesson */
  }
  return lesson;
}

// ── detectLoopFromTrace: reconstruct a stuck-loop signal from a saved trace ──
// Mirrors the agent loop's own loopStreak (>=2 consecutive identical tool-call
// turns ⇒ a loop). We compute it from the persisted trace so reflection needs
// no special event wiring. Sub-agent tools (sub:true) are ignored — only the
// main thread counts.
export function detectLoopFromTrace(trace) {
  const t = trace || {};
  const steps = Array.isArray(t.steps) ? t.steps : [];
  const turnTools = new Map(); // turnId -> [toolSigs]
  const turnOrder = [];
  for (const s of steps) {
    if (s.kind === 'turn') {
      turnOrder.push(s.id);
      if (!turnTools.has(s.id)) turnTools.set(s.id, []);
    } else if (s.kind === 'tool' && s.data && s.data.sub !== true) {
      const parent = s.parentId;
      if (parent && turnTools.has(parent)) {
        const args = typeof s.data.args === 'string' ? s.data.args : JSON.stringify(s.data.args || {});
        turnTools.get(parent).push((s.name || '') + ' ' + args);
      }
    }
  }
  let prev = null;
  let streak = 0;
  for (const tid of turnOrder) {
    const sig = (turnTools.get(tid) || []).slice().sort().join('|');
    if (!sig) continue; // a no-tool turn (e.g. final answer) breaks nothing
    if (sig === prev) streak++;
    else streak = 0;
    prev = sig;
    if (streak >= 2) return true; // 3 identical consecutive turns
  }
  return false;
}

// ── serialization (server persists; browser only renders) ───────────────────
// State shape: { meta: { version, injectionEnabled, enrich, updatedAt }, lessons: [...] }

function normalizeLesson(l) {
  return {
    id: l.id || lessonId(l),
    type: l.type || 'general',
    text: String(l.text || ''),
    context: l.context ? String(l.context) : '',
    score: clampScore(l.score),
    hits: Number(l.hits) || 0,
    seen: Number(l.seen) || 1,
    enabled: l.enabled !== false,
    createdAt: l.createdAt || new Date().toISOString(),
    updatedAt: l.updatedAt || l.createdAt || new Date().toISOString(),
    source: l.source || null,
    enriched: !!l.enriched
  };
}

export function serializeLessons(state = {}) {
  const s = state || {};
  return {
    meta: {
      version: 1,
      injectionEnabled: s.meta ? s.meta.injectionEnabled !== false : true,
      enrich: !!(s.meta && s.meta.enrich),
      updatedAt: new Date().toISOString()
    },
    lessons: Array.isArray(s.lessons) ? s.lessons.map(normalizeLesson) : []
  };
}

export function deserializeLessons(raw) {
  if (!raw || typeof raw !== 'object') {
    return { meta: { version: 1, injectionEnabled: true, enrich: false, updatedAt: null }, lessons: [] };
  }
  const meta = raw.meta || {};
  return {
    meta: {
      version: 1,
      injectionEnabled: meta.injectionEnabled !== false,
      enrich: !!meta.enrich,
      updatedAt: meta.updatedAt || null
    },
    lessons: Array.isArray(raw.lessons) ? raw.lessons.map(normalizeLesson) : []
  };
}
