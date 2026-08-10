// Self-evolving skills, part 2: AUTOMATIC precipitation — now VERIFICATION-GATED.
//
// After the agent finishes a genuinely complex task, we ask the model (once,
// tool-free) whether the workflow it just performed is worth saving as a
// reusable SKILL.md. If yes, we persist it via memory.js saveSkill. This closes
// the "skill compound interest" loop with zero manual bookkeeping.
//
// What v0.46 adds, and why it matters:
//
//   1. A GATE. Most self-improving agents (Hermes et al.) decide "was that a
//      success?" by asking the model about its own work — self-report, i.e. the
//      least reliable signal there is. Agenite already produces *objective*
//      evidence every turn: v0.44 runs a real verification command, v0.43 makes
//      a real git checkpoint. So we crystallize a skill only when the evidence
//      says the run actually worked. A red verify never becomes a skill.
//
//   2. ANTI-PATTERNS. SEED's "hindsight skills" insight: the failures on the way
//      to success are worth more than the happy path. Every verify failure and
//      every self-heal reflection in the transcript is mined into an explicit
//      "don't do this" list stored with the skill.
//
//   3. SUPERSEDE, not overwrite. MindMemOS: skills must evolve with an audit
//      trail. Re-learning a skill bumps its version and parks the old revision.
//
// Everything decision-critical here is a pure function so it can be unit-tested
// without a network or a model.

import { saveSkill } from './memory.js';

// A task only merits a saved skill if it actually involved non-trivial work:
// at least 3 tool uses OR 2+ distinct tools. Trivial Q&A / single lookups are
// not worth a skill and would just clutter the catalog.
export function countToolActivity(messages = []) {
  let calls = 0;
  const tools = new Set();
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'tool') {
      calls++;
      if (m.name) tools.add(m.name);
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const n = tc && tc.function && tc.function.name;
        if (n) tools.add(n);
      }
    }
  }
  return { calls, distinct: tools.size };
}

export function isComplexEnough(messages = []) {
  const { calls, distinct } = countToolActivity(messages);
  return calls >= 3 || distinct >= 2;
}

// ---- the verification gate ----
// `gate` is assembled by the server from what actually happened this run:
//   { verifyOk: true|false|null, verifyLabel, gitCommit, todoDone, aborted }
// verifyOk === null means no verification ran (e.g. a pure research task that
// never touched a file) — that is not evidence of failure, so we still allow
// distillation but mark the skill unverified.

export function computeVerified(gate) {
  return !!gate && gate.verifyOk === true;
}

export function shouldDistill(gate) {
  // No gate at all → legacy behaviour (callers from before v0.46).
  if (!gate) return { ok: true, verified: false, reason: 'no verification signal' };
  if (gate.aborted) {
    return { ok: false, verified: false, reason: '本次运行被中断，不沉淀技能' };
  }
  if (gate.verifyOk === false) {
    return {
      ok: false,
      verified: false,
      reason: `自动验证未通过${gate.verifyLabel ? `（${gate.verifyLabel}）` : ''}，拒绝把失败的工作流固化成技能`
    };
  }
  if (computeVerified(gate)) {
    return { ok: true, verified: true, reason: `已通过${gate.verifyLabel ? `「${gate.verifyLabel}」` : ''}真实验证` };
  }
  if (gate.gitCommit) {
    return { ok: true, verified: false, reason: '有 git 检查点但未跑验证' };
  }
  return { ok: true, verified: false, reason: '本次未触发自动验证' };
}

// ---- anti-pattern mining ----
// Pull the concrete stumbles out of the transcript: failed verifications,
// self-heal reflections, and hard tool errors. These become the skill's
// "反模式" section — the part a future run reads to avoid repeating history.
export function extractAntiHints(messages = []) {
  const hints = [];
  const push = (s) => {
    const v = String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (v && !hints.includes(v)) hints.push(v);
  };
  for (const m of messages) {
    if (!m) continue;
    const text = String(m.content || '');
    if (m.role === 'user' && text.startsWith('❌ 自动验证')) {
      const label = /——(.+?)[:：]/.exec(text);
      const detail = text.split('\n').slice(1).find((l) => l.trim() && !l.startsWith('这是你刚才'));
      push(`${label ? label[1] : '验证'}曾失败：${detail || '见验证摘要'}`);
    } else if (m.role === 'user' && text.startsWith('⚠️ 自检提醒')) {
      const names = /未成功（(.+?)）/.exec(text);
      if (names) push(`${names[1]} 首次调用失败过——动手前先重新读取目标文件确认当前内容`);
    } else if (m.role === 'tool' && /^Error \[/.test(text)) {
      const cls = /^Error \[([A-Z_]+)\]:\s*([\s\S]*)$/.exec(text);
      if (cls) push(`${m.name || '工具'} 报过 ${cls[1]}：${cls[2].slice(0, 100)}`);
    }
  }
  return hints.slice(0, 6);
}

// Build a compact, privacy-minded transcript for the extractor: drop the system
// prompt, keep user asks + assistant text + tool names + short result snippets.
export function compactTranscript(messages = []) {
  const parts = [];
  for (const m of messages) {
    if (!m || m.role === 'system') continue;
    if (m.role === 'user') {
      parts.push('USER: ' + String(m.content || '').slice(0, 600));
    } else if (m.role === 'assistant') {
      const txt = String(m.content || '').slice(0, 600);
      const tcs = Array.isArray(m.tool_calls)
        ? m.tool_calls.map((tc) => tc && tc.function && tc.function.name).filter(Boolean)
        : [];
      parts.push('ASSISTANT: ' + (txt ? txt + '\n' : '') + (tcs.length ? 'tools: ' + tcs.join(', ') : ''));
    } else if (m.role === 'tool') {
      const r = String(m.content || '').replace(/\s+/g, ' ').slice(0, 240);
      parts.push(`TOOL(${m.name || '?'}): ${r}`);
    }
  }
  return parts.join('\n').slice(0, 6000);
}

export function buildSkillReflectionMessages(transcript, { verified = false, antiHints = [], verifyLabel = '' } = {}) {
  const evidence = verified
    ? `EVIDENCE: this run PASSED a real automated verification${verifyLabel ? ` ("${verifyLabel}")` : ''}. ` +
      'The workflow demonstrably works — write the playbook as a confident, concrete procedure.'
    : 'EVIDENCE: no automated verification ran for this task. Only save a skill if the ' +
      'procedure is still objectively repeatable; keep claims modest.';
  const stumbles = antiHints.length
    ? 'OBSERVED STUMBLES (mine these into anti_patterns, rephrased as actionable warnings):\n' +
      antiHints.map((h) => '- ' + h).join('\n')
    : 'No explicit failures were recorded; infer anti_patterns only if the transcript clearly shows a wrong turn.';
  return [
    {
      role: 'system',
      content:
        'You are a "skill extractor" for a local AI coding/automation agent. Given a ' +
        'transcript of a just-completed task, decide whether the task involved a ' +
        'non-trivial, REUSABLE workflow worth saving as a SKILL.md for future sessions. ' +
        'Save a skill only if it encodes a concrete, repeatable procedure (specific ' +
        'steps, file paths, commands, tool sequences, gotchas) — NOT for one-off Q&A ' +
        'or trivial lookups. Respond with ONLY a JSON object, no markdown fences, no prose:\n' +
        '{"save": boolean, "name": string, "description": string, ' +
        '"when_to_use": string, "body": string, "anti_patterns": string[], "reason": string}\n' +
        'name: short title-case or kebab skill name. description: one sentence what it does. ' +
        'when_to_use: the trigger scenario. body: concrete step-by-step playbook ' +
        '(use the actual paths/commands/tools seen), under 350 words. ' +
        'anti_patterns: 0-5 short imperative warnings distilled from what went wrong on the ' +
        'way to success ("不要 X，会 Y"); omit generic advice. reason: why save or not.\n' +
        evidence
    },
    { role: 'user', content: stumbles + '\n\nTranscript:\n' + transcript }
  ];
}

// Robustly pull a skill decision out of model output that may be wrapped in ```
// fences or have trailing prose. Returns { save:false } on any parse failure so
// a malformed response never crashes the chat.
export function parseSkillDecision(text) {
  const raw = String(text || '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const jsonStr = fence ? fence[1] : raw;
  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return { save: false };
  let obj;
  try { obj = JSON.parse(jsonStr.slice(start, end + 1)); } catch { return { save: false }; }
  if (obj && obj.save !== true) {
    return { save: false, reason: typeof obj.reason === 'string' ? obj.reason : '' };
  }
  const rawAnti = obj.anti_patterns != null ? obj.anti_patterns : obj.antiPatterns;
  const antiPatterns = (Array.isArray(rawAnti) ? rawAnti : String(rawAnti == null ? '' : rawAnti).split(/\s*\|\s*/))
    .map((x) => String(x).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 5);
  return {
    save: true,
    name: String(obj.name || '').trim(),
    description: String(obj.description || '').trim(),
    whenToUse: String(obj.when_to_use || obj.whenToUse || '').trim(),
    body: String(obj.body || '').trim(),
    antiPatterns,
    reason: String(obj.reason || '').trim()
  };
}

// Orchestrator: called by the server after a successful run. Fire-and-forget
// friendly — every failure path returns gracefully so the chat is never broken
// by a failed skill extraction.
//
// `callModel` is the SERVER-SUPPLIED, tool-free reflection caller (it must pass
// tools:[] so the model only returns text — autoSaveSkill reads content only).
// `gate` is optional; when omitted the pre-v0.46 behaviour is preserved.
export async function autoSaveSkill({ messages, callModel, sse, memoryBase, gate = null }) {
  if (typeof callModel !== 'function' || !memoryBase) return null;
  if (!isComplexEnough(messages)) return { skipped: true, reason: 'task too simple' };

  // The gate runs BEFORE the model call: refusing to distill is also refusing to
  // spend a request on it.
  const verdict = shouldDistill(gate);
  if (!verdict.ok) {
    if (sse) sse('skill_auto', { saved: false, gated: true, reason: verdict.reason });
    return { skipped: true, gated: true, reason: verdict.reason };
  }

  const transcript = compactTranscript(messages);
  if (!transcript.trim()) return { skipped: true, reason: 'empty transcript' };

  const antiHints = extractAntiHints(messages);

  let decision;
  try {
    const r = await callModel(
      buildSkillReflectionMessages(transcript, {
        verified: verdict.verified,
        antiHints,
        verifyLabel: gate && gate.verifyLabel ? gate.verifyLabel : ''
      }),
      { onDelta: () => {} }
    );
    decision = parseSkillDecision(r && r.content ? r.content : '');
  } catch {
    return { skipped: true, reason: 'reflection call failed' };
  }

  if (!decision.save || !decision.name || !decision.description) {
    if (sse) sse('skill_auto', { saved: false, reason: decision.reason || 'not worth saving' });
    return { saved: false, reason: decision.reason || 'not worth saving' };
  }

  // Prefer the model's phrasing of the anti-patterns; fall back to the raw mined
  // hints so a terse model never loses the hard-won failure knowledge.
  const antiPatterns = (decision.antiPatterns && decision.antiPatterns.length ? decision.antiPatterns : antiHints).slice(0, 5);

  let result;
  try {
    result = await saveSkill(memoryBase, {
      name: decision.name,
      description: decision.description,
      whenToUse: decision.whenToUse,
      body: decision.body,
      antiPatterns,
      verified: verdict.verified,
      source: 'auto'
    });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (sse) sse('skill_auto', { saved: false, error: msg });
    return { saved: false, error: msg };
  }

  if (sse) {
    sse('skill_auto', {
      saved: result.ok,
      name: decision.name,
      slug: result.slug,
      version: result.version,
      verified: verdict.verified,
      antiPatterns,
      gateReason: verdict.reason,
      reason: decision.reason
    });
  }
  return {
    saved: result.ok,
    name: decision.name,
    slug: result.slug,
    version: result.version,
    verified: verdict.verified,
    antiPatterns
  };
}
