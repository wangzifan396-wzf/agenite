// Self-evolving skills, part 2: AUTOMATIC precipitation.
// After the agent finishes a genuinely complex task, we ask the model (once,
// tool-free) whether the workflow it just performed is worth saving as a
// reusable SKILL.md. If yes, we persist it via memory.js saveSkill. This closes
// the "skill compound interest" loop with zero manual bookkeeping — the agent
// gets smarter the more it is used, and every skill is a plain local file.
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

export function buildSkillReflectionMessages(transcript) {
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
        '"when_to_use": string, "body": string, "reason": string}\n' +
        'name: short title-case or kebab skill name. description: one sentence what it does. ' +
        'when_to_use: the trigger scenario. body: concrete step-by-step playbook ' +
        '(use the actual paths/commands/tools seen), under 350 words. reason: why save or not.'
    },
    { role: 'user', content: 'Transcript:\n' + transcript }
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
  return {
    save: true,
    name: String(obj.name || '').trim(),
    description: String(obj.description || '').trim(),
    whenToUse: String(obj.when_to_use || obj.whenToUse || '').trim(),
    body: String(obj.body || '').trim(),
    reason: String(obj.reason || '').trim()
  };
}

// Orchestrator: called by the server after a successful run. Fire-and-forget
// friendly — every failure path returns gracefully so the chat is never broken
// by a failed skill extraction.
//
// `callModel` is the SERVER-SUPPLIED, tool-free reflection caller (it must pass
// tools:[] so the model only returns text — autoSaveSkill reads content only).
export async function autoSaveSkill({ messages, callModel, sse, memoryBase }) {
  if (typeof callModel !== 'function' || !memoryBase) return null;
  if (!isComplexEnough(messages)) return { skipped: true, reason: 'task too simple' };

  const transcript = compactTranscript(messages);
  if (!transcript.trim()) return { skipped: true, reason: 'empty transcript' };

  let decision;
  try {
    const r = await callModel(buildSkillReflectionMessages(transcript), { onDelta: () => {} });
    decision = parseSkillDecision(r && r.content ? r.content : '');
  } catch {
    return { skipped: true, reason: 'reflection call failed' };
  }

  if (!decision.save || !decision.name || !decision.description) {
    if (sse) sse('skill_auto', { saved: false, reason: decision.reason || 'not worth saving' });
    return { saved: false, reason: decision.reason || 'not worth saving' };
  }

  let result;
  try {
    result = await saveSkill(memoryBase, {
      name: decision.name,
      description: decision.description,
      whenToUse: decision.whenToUse,
      body: decision.body
    });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (sse) sse('skill_auto', { saved: false, error: msg });
    return { saved: false, error: msg };
  }

  if (sse) sse('skill_auto', { saved: result.ok, name: decision.name, slug: result.slug, reason: decision.reason });
  return { saved: result.ok, name: decision.name, slug: result.slug };
}
