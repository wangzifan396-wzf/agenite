// src/core/hooks.js — v0.57 composable runtime
// ---------------------------------------------------------------------------
// Borrowed in spirit from DeepSeek Harness's "everything is a plugin" idea:
// a tiny HookBus + a tool-execution pipeline with pre/post stages, plus the two
// ready-made plugins that make Agenite a more *usable* agent:
//
//   1) reflectionGuardPlugin — turns the v0.56 Experience Manual into a PRE-FLIGHT
//      safety gate. Before a world-mutating tool runs, it recalls the agent's own
//      hard-won lessons and (warn | block) surfaces them, instead of only
//      injecting them passively into the system prompt after the fact.
//   2) instruction-file auto-load (AGENTS.md / CLAUDE.md compatible) — fold a
//      repo's "how to work here" file into the system prompt automatically.
//
// Pure & dependency-free so it is fully unit-testable. No agent.js / tools.js
// edits are required — the server wraps its existing executor with the pipeline.

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

// Safety-relevant lesson contexts distilled by classifyRun() (v0.56). The
// pre-flight guard only surfaces these — they are the "be careful when you
// mutate / you ran away with tools" lessons, not the generic "good pattern"
// principles. Keeps signal high and noise low.
const GUARD_CONTEXTS = new Set([
  '变更后缺验证',
  '验证失败',
  '中断 / 护栏',
  '工具失败偏多',
  '卡死循环'
]);

// Verbs where a hard block is justified: high blast radius, easy to abuse, and
// the ones a runaway loop loves to spam. Block mode only refuses these.
const HARD_BLOCK_TOOLS = new Set([
  'run_command', 'shell', 'exec', 'git_reset', 'delete_file', 'move_file', 'rename_file'
]);

// ── HookBus: ordered, error-isolated event emitter ────────────────────────────
export class HookBus {
  constructor() {
    this._map = new Map();
  }
  // Returns an unsubscribe function. Handlers run in ascending `order`.
  on(event, handler, opts = {}) {
    if (!this._map.has(event)) this._map.set(event, []);
    const entry = { handler, order: Number(opts && opts.order) || 0 };
    this._map.get(event).push(entry);
    this._map.get(event).sort((a, b) => a.order - b.order);
    return () => this.off(event, handler);
  }
  off(event, handler) {
    const arr = this._map.get(event);
    if (!arr) return;
    const i = arr.findIndex((e) => e.handler === handler);
    if (i >= 0) arr.splice(i, 1);
  }
  // Fire every handler; a throwing handler can never break the pipeline — its
  // error is captured and returned so callers can decide what to do with it.
  async emit(event, payload) {
    const arr = this._map.get(event) || [];
    const results = [];
    for (const e of arr) {
      try {
        results.push(await e.handler(payload));
      } catch (err) {
        results.push({ error: String((err && err.message) || err) });
      }
    }
    return results;
  }
}

// ── Plugin registry: collect plugins, apply them all to a HookBus ─────────────
export function createPluginRegistry() {
  const plugins = [];
  return {
    register(p) {
      if (p && typeof p.register === 'function') plugins.push(p);
      return p;
    },
    list() {
      return plugins.slice();
    },
    applyAll(hooks) {
      for (const p of plugins) {
        try {
          p.register(hooks);
        } catch {
          /* a broken plugin must never break boot */
        }
      }
    }
  };
}

// ── Tool pipeline: the single composable seam ────────────────────────────────
//   tool:before → collect abort / warn decisions (PRE-FLIGHT)
//   execute     → the real executor (skipped entirely if aborted)
//   tool:after  → post-stage hooks (logging, UI render, result rewrite)
//
// `onEvent(level, payload)` lets plugins surface real-time UI events (e.g. a
// guard toast) without the executor knowing anything about the transport.
export async function runToolPipeline({ name, args, opts = {}, execute, hooks, onEvent, ctx = {} }) {
  const before = await hooks.emit('tool:before', { name, args, opts, ctx });

  // Merge pre-flight decisions from all plugins.
  let abort = null;
  const warns = [];
  for (const r of before) {
    if (!r || typeof r !== 'object') continue;
    if (r.abort && !abort) abort = r;
    if (Array.isArray(r.warns)) warns.push(...r.warns);
    if (r.warn) warns.push(r.warn);
  }

  // PRE-FLIGHT BLOCK: refuse to run the tool at all. The agent gets a clear
  // reason it can adapt to, and the user sees it in the UI.
  if (abort) {
    const blocked = {
      ok: false,
      blocked: true,
      name,
      error: abort.reason || '已被前置护栏拦截',
      content: abort.reason || '已被前置护栏拦截',
      lesson: abort.lesson || null
    };
    if (onEvent) {
      try {
        onEvent('guard', { level: 'block', name, reason: blocked.reason, lesson: abort.lesson || null });
      } catch { /* transport errors must not surface as tool errors */ }
    }
    await hooks.emit('tool:after', { name, args, opts, result: blocked, blocked: true, warns });
    return blocked;
  }

  if (warns.length && onEvent) {
    try {
      onEvent('guard', { level: 'warn', name, reasons: warns.slice(0, 3) });
    } catch { /* transport errors must not surface as tool errors */ }
  }

  // EXECUTE the real tool.
  let result;
  try {
    result = await execute(name, args, opts);
  } catch (err) {
    const errored = { ok: false, error: String((err && err.message) || err), name };
    await hooks.emit('tool:error', { name, args, opts, error: err });
    await hooks.emit('tool:after', { name, args, opts, result: errored, errored: true });
    if (onEvent) {
      try {
        onEvent('guard', { level: 'error', name, error: errored.error });
      } catch { /* transport errors must not surface as tool errors */ }
    }
    return errored;
  }

  // Fold the warning into the tool result so the model sees the lesson IN-CONTEXT
  // (non-blocking for warn mode). Clearly labelled so it is never mistaken for
  // the tool's own output.
  if (warns.length && result && typeof result === 'object') {
    const note = warns.map((w) => `⚠️ 经验护栏提醒：${w}`).join('\n');
    if (typeof result.content === 'string') result.content = note + '\n\n' + result.content;
    else if (typeof result.text === 'string') result.text = note + '\n\n' + result.text;
    else result.note = note;
  }

  await hooks.emit('tool:after', { name, args, opts, result, warns });
  return result;
}

// ── Plugin: pre-flight Experience Guard ──────────────────────────────────────
// Reads the SAME Experience Manual the system prompt injects (v0.56) and acts on
// it BEFORE the tool mutates the world. mode:
//   'off'   → disabled (pure pass-through)
//   'warn'  (default) → surface the top relevant safety lessons as a pre-flight
//              reminder in the UI + folded into the tool result. Tool still runs.
//   'block' → additionally refuse HARD_BLOCK_TOOLS when a strong (score ≥ 0.8)
//              runaway-loop lesson exists. Conservative by design.
export function reflectionGuardPlugin({ getLessons, isDestructive, mode = 'warn' } = {}) {
  if (mode === 'off' || typeof getLessons !== 'function') {
    return { id: 'reflection-guard', enabled: false, register() {} };
  }
  const isFn = typeof isDestructive === 'function' ? isDestructive : () => true;
  return {
    id: 'reflection-guard',
    enabled: true,
    register(hooks) {
      hooks.on('tool:before', ({ name }) => {
        if (!isFn(name)) return; // only gate world-mutating tools
        let state;
        try {
          state = getLessons();
        } catch {
          return;
        }
        const lessons = state && Array.isArray(state.lessons) ? state.lessons : [];
        const matches = lessons
          .filter((l) => l && (l.type === 'warning' || l.type === 'procedure') && GUARD_CONTEXTS.has(l.context))
          .sort((a, b) => (b.score || 0) - (a.score || 0));
        if (!matches.length) return;

        if (mode === 'block') {
          const hard = matches.find((m) => (m.score || 0) >= 0.8 && HARD_BLOCK_TOOLS.has(name));
          if (hard) {
            return {
              abort: true,
              reason:
                `经验护栏：此前「${hard.context}」曾导致问题，已拦截高风险的 ${name}。` +
                `建议改用更安全的方式，或先向用户确认后再执行。`,
              lesson: { type: hard.type, context: hard.context, text: hard.text }
            };
          }
          return; // nothing strong enough to block
        }

        // warn: surface the top relevant lessons (capped, score-filtered)
        const top = matches.filter((m) => (m.score || 0) > 0.5).slice(0, 2);
        if (!top.length) return;
        return { warns: top.map((m) => `${m.text}（经验·${m.context}）`) };
      });
    }
  };
}

// ── Instruction-file auto-load (AGENTS.md / CLAUDE.md compatible) ────────────
// Mirrors how modern agent harnesses read a repo's "how to work here" file and
// fold it into the system prompt. Also supports .agenite/instructions/*.md for
// splitting conventions across several files.
export function detectInstructionFiles(rootDir) {
  const found = [];
  const top = ['AGENTS.md', 'CLAUDE.md', 'AGENT.md', '.agenite/instructions.md'];
  for (const rel of top) {
    const p = join(rootDir, rel);
    try {
      if (statSync(p).isFile()) found.push(p);
    } catch { /* missing file is normal */ }
  }
  const dir = join(rootDir, '.agenite', 'instructions');
  try {
    for (const e of readdirSync(dir).sort()) {
      if (!e.endsWith('.md')) continue;
      const p = join(dir, e);
      try {
        if (statSync(p).isFile()) found.push(p);
      } catch { /* ignore unreadable */ }
    }
  } catch { /* no instructions dir is normal */ }
  return found;
}

export function formatInstructionBlock(files) {
  if (!Array.isArray(files) || !files.length) return '';
  const parts = [];
  for (const f of files) {
    let text = '';
    try {
      text = readFileSync(f, 'utf8').trim();
    } catch {
      continue;
    }
    if (!text) continue;
    parts.push(`### ${basename(f)}\n${text}`);
  }
  if (!parts.length) return '';
  return (
    '## 项目指令（来自工作区配置文件，优先级等同项目约定）\n' +
    '以下指令来自当前工作区的配置文件（AGENTS.md / CLAUDE.md 等），请在本会话中始终遵守：\n\n' +
    parts.join('\n\n')
  );
}
