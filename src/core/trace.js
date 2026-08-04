// Agenite Run Trace — a local-first, zero-dependency execution trace.
//
// Every agent run emits a stream of typed "steps" (spans) that together form
// the decision evidence chain of that run. This is the agent-observability
// layer: a healthy HTTP 200 can still hide a wrong tool call, a stale memory
// read, or a silent loop — a trace turns one request into an inspectable,
// replayable record. It maps cleanly onto the four observability pillars:
//
//   turn      model reasoning step (assistant message)        -> reasoning span
//   tool      tool call (name/args/result/ok/ms)              -> tool-call span
//     └ memory_*  -> memory-operation pillar (a tool subclass)
//     └ mcp__*    -> external MCP tool
//   subagent  a spawned child agent (multi-agent handoff)     -> nested span
//   compact   conversation history was shrunk                -> state transition
//
// The model is a flat `steps` array; each step may carry a `parentId` so the
// execution tree (turn -> tool, subagent -> tool) can be reconstructed. Pure
// functions only (except the persistence block, which takes an injected dir),
// so the whole thing is unit-testable without a DOM or a server.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir, readdir, unlink, stat, rename } from 'node:fs/promises';

export const TRACE_VERSION = 1;
export const TRACES_DIR = join(homedir(), '.agenite', 'traces');
const TRACE_FILE = (runId) => `${runId}.json`;
const MAX_TRACES = 200; // cap the folder like sessions.js

export function emptyStats() {
  return {
    steps: 0,
    tools: 0,
    subagents: 0,
    errors: 0,
    compactions: 0,
    memoryOps: 0,
    totalMs: 0
  };
}

function rid() {
  return 'run_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function newTrace(meta = {}) {
  return {
    version: TRACE_VERSION,
    runId: meta.runId || rid(),
    title: meta.title || '',
    model: meta.model || '',
    provider: meta.provider || '',
    createdAt: meta.createdAt || Date.now(),
    startedAt: null,
    finishedAt: null,
    stopped: null,
    turns: 0,
    cost: 0,
    steps: [],
    stats: emptyStats()
  };
}

// Sub-class a tool name into the pillar it belongs to.
export function classifyTool(name = '') {
  if (name.startsWith('memory_')) return 'memory';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'tool';
}

// Append a step. `step` is { kind, name, parentId, ts, ms, status, data }.
// Returns the normalized step. Also maintains a children[] index and stats.
export function addStep(trace, step) {
  const s = {
    id: step.id || 's' + (trace.steps.length + 1),
    parentId: step.parentId || null,
    kind: step.kind || 'turn',
    name: step.name || '',
    ts: step.ts || Date.now(),
    ms: step.ms || 0,
    status: step.status || 'ok',
    data: step.data || {},
    children: []
  };
  trace.steps.push(s);
  if (s.parentId) {
    const p = trace.steps.find((x) => x.id === s.parentId);
    if (p) p.children.push(s.id);
  }
  const st = trace.stats;
  st.steps++;
  if (s.kind === 'tool') {
    st.tools++;
    if (s.status !== 'ok') st.errors++;
    if (classifyTool(s.name) === 'memory') st.memoryOps++;
  } else if (s.kind === 'subagent') {
    st.subagents++;
  } else if (s.kind === 'compact') {
    st.compactions++;
  }
  st.totalMs += s.ms || 0;
  return s;
}

// Find tools called many times total (a coarse "the agent hammered X" signal).
export function detectLoops(trace, threshold = 3) {
  const counts = new Map();
  for (const s of trace.steps) {
    if (s.kind !== 'tool') continue;
    const e = counts.get(s.name) || { name: s.name, kind: classifyTool(s.name), count: 0 };
    e.count++;
    counts.set(s.name, e);
  }
  const loops = [];
  for (const e of counts.values()) {
    if (e.count >= Math.max(2, threshold)) {
      loops.push({ name: e.name, kind: e.kind, count: e.count });
    }
  }
  loops.sort((a, b) => b.count - a.count);
  return loops;
}

// Find the longest run of *identical* (name + args) tool calls back-to-back —
// the real "stuck in a loop, burning budget" signal Braintrust calls out.
export function detectConsecutiveLoops(trace, min = 3) {
  let best = null;
  let cur = null;
  for (const s of trace.steps) {
    if (s.kind !== 'tool') {
      cur = null;
      continue;
    }
    const key = s.name + '|' + JSON.stringify(s.data.args || {});
    if (cur && cur.key === key) {
      cur.count++;
    } else {
      cur = { key, name: s.name, args: s.data.args || {}, count: 1 };
    }
    if (!best || cur.count > best.count) best = { ...cur };
  }
  if (best && best.count >= Math.max(2, min)) return best;
  return null;
}

export function traceSummary(trace) {
  const loops = detectLoops(trace);
  const consecutive = detectConsecutiveLoops(trace);
  return {
    runId: trace.runId,
    title: trace.title,
    model: trace.model,
    provider: trace.provider,
    createdAt: trace.createdAt,
    finishedAt: trace.finishedAt,
    stopped: trace.stopped,
    turns: trace.turns,
    cost: trace.cost,
    loops,
    consecutiveLoop: consecutive,
    stats: { ...trace.stats }
  };
}

// --- persistence (injected directory) ---

export async function listTraces(dir = TRACES_DIR) {
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const t = await loadTrace(dir, n.replace(/\.json$/, ''));
      out.push(traceSummary(t));
    } catch {
      // skip unreadable / corrupt trace files
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function loadTrace(dir = TRACES_DIR, runId) {
  const text = await readFile(join(dir, TRACE_FILE(runId)), 'utf8');
  const t = JSON.parse(text);
  if (!t || !Array.isArray(t.steps)) throw new Error('损坏的轨迹文件');
  if (!t.stats) t.stats = emptyStats();
  return t;
}

export async function saveTrace(trace, dir = TRACES_DIR) {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, TRACE_FILE(trace.runId) + '.tmp');
  const final = join(dir, TRACE_FILE(trace.runId));
  await writeFile(tmp, JSON.stringify(trace), 'utf8');
  await rename(tmp, final);
  // belt-and-suspenders: make sure the .tmp never lingers on a failed rename
  return trace;
}

export async function deleteTrace(dir = TRACES_DIR, runId) {
  try {
    await unlink(join(dir, TRACE_FILE(runId)));
    return true;
  } catch {
    return false;
  }
}

// Keep at most MAX_TRACES, dropping the oldest by createdAt.
export async function pruneTraces(dir = TRACES_DIR, max = MAX_TRACES) {
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return 0;
  }
  if (names.length <= max) return 0;
  const withTime = [];
  for (const n of names) {
    try {
      const s = await stat(join(dir, n));
      withTime.push({ n, t: s.mtimeMs });
    } catch {
      /* ignore */
    }
  }
  withTime.sort((a, b) => a.t - b.t);
  let removed = 0;
  for (const { n } of withTime.slice(0, withTime.length - max)) {
    try {
      await unlink(join(dir, n));
      removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
}
