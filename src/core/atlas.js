// Agenite Atlas — a local-first, zero-dependency memory knowledge graph.
//
// The idea (and our competitive differentiator vs chat-only agents like
// OpenHands / Devin, and vs cloud graph-memory like Mem0 / Graphiti that ship
// heavy deps or leak data off-machine): the agent keeps a *living, queryable
// map of what it knows about you and your work* — people, projects, concepts,
// files, preferences, facts — connected by typed relationships. It persists to
// <memoryDir>/atlas.json so it survives restarts and is fully yours.
//
// Everything here is pure (no I/O) except loadAtlas / saveAtlas, which are
// dependency-injected by passing a directory — so the whole engine is unit
// testable without touching the filesystem.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultMemoryDir } from './memory.js';

export const ATLAS_FILE = 'atlas.json';
export const ATLAS_DIR = defaultMemoryDir();

export function emptyGraph() {
  return { version: 1, nodes: {}, edges: [], meta: { createdAt: 0, updatedAt: 0 } };
}

function slug(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'n'
  );
}

// Stable node id = type + label (case/space insensitive dedup key).
export function nodeId(type, label) {
  return slug(type) + '--' + slug(label);
}

function stamp(graph) {
  graph.meta = graph.meta || {};
  graph.meta.updatedAt = Date.now();
  if (!graph.meta.createdAt) graph.meta.createdAt = graph.meta.updatedAt;
}

// --- pure graph operations (mutate `graph` in place) ---

export function addNode(graph, { type = 'concept', label, description = '', provenance = '' }) {
  if (!label || !String(label).trim()) return { ok: false, error: 'label 不能为空' };
  const id = nodeId(type, label);
  const existed = !!graph.nodes[id];
  if (existed) {
    const n = graph.nodes[id];
    if (description && !n.description) n.description = description;
    if (provenance && !n.provenance) n.provenance = provenance;
    n.updatedAt = Date.now();
    stamp(graph);
    return { ok: true, existed: true, node: n };
  }
  const node = {
    id,
    type: String(type).trim() || 'concept',
    label: String(label).trim(),
    description: String(description || '').trim(),
    provenance: String(provenance || '').trim(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    degree: 0
  };
  graph.nodes[id] = node;
  stamp(graph);
  return { ok: true, existed: false, node };
}

// Resolve a user/agent reference to a node id. Accepts an exact id, or a label
// (matched case/space-insensitively across types; first match wins).
export function resolveId(graph, ref) {
  if (!ref) return null;
  if (graph.nodes[ref]) return ref;
  const key = slug(ref);
  const byLabel = Object.values(graph.nodes).find((n) => slug(n.label) === key);
  return byLabel ? byLabel.id : null;
}

export function linkNodes(graph, { from, to, type = 'relates_to', label = '' }) {
  const fid = resolveId(graph, from);
  const tid = resolveId(graph, to);
  if (!fid || !tid) return { ok: false, error: `节点不存在：from=${from} to=${to}` };
  if (fid === tid) return { ok: false, error: '不能把节点连向自己' };
  const dup = graph.edges.find((e) => e.from === fid && e.to === tid && e.type === type);
  if (dup) return { ok: true, existed: true, edge: dup };
  const edge = {
    id: `e${graph.edges.length + 1}_${Date.now().toString(36)}`,
    from: fid,
    to: tid,
    type: String(type || 'relates_to').trim(),
    label: String(label || '').trim(),
    createdAt: Date.now()
  };
  graph.edges.push(edge);
  if (graph.nodes[fid]) graph.nodes[fid].degree = (graph.nodes[fid].degree || 0) + 1;
  if (graph.nodes[tid]) graph.nodes[tid].degree = (graph.nodes[tid].degree || 0) + 1;
  stamp(graph);
  return { ok: true, existed: false, edge };
}

export function searchAtlas(graph, query, { limit = 24 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const all = Object.values(graph.nodes);
  if (!q) return all;
  const toks = q.split(/\s+/).filter(Boolean);
  const hits = all.filter((n) => {
    const hay = (n.label + ' ' + n.description + ' ' + n.type).toLowerCase();
    return toks.every((t) => hay.includes(t));
  });
  return hits.slice(0, limit);
}

export function removeNode(graph, ref) {
  const id = resolveId(graph, ref);
  if (!id) return { ok: false, error: '未找到节点' };
  delete graph.nodes[id];
  graph.edges = graph.edges.filter((e) => e.from !== id && e.to !== id);
  for (const n of Object.values(graph.nodes)) n.degree = 0;
  for (const e of graph.edges) {
    if (graph.nodes[e.from]) graph.nodes[e.from].degree++;
    if (graph.nodes[e.to]) graph.nodes[e.to].degree++;
  }
  stamp(graph);
  return { ok: true };
}

export function removeEdge(graph, edgeId) {
  const before = graph.edges.length;
  graph.edges = graph.edges.filter((e) => e.id !== edgeId);
  if (graph.edges.length === before) return { ok: false, error: '未找到边' };
  for (const n of Object.values(graph.nodes)) n.degree = 0;
  for (const e of graph.edges) {
    if (graph.nodes[e.from]) graph.nodes[e.from].degree++;
    if (graph.nodes[e.to]) graph.nodes[e.to].degree++;
  }
  stamp(graph);
  return { ok: true };
}

export function atlasStats(graph) {
  const types = {};
  for (const n of Object.values(graph.nodes)) types[n.type] = (types[n.type] || 0) + 1;
  return {
    nodes: Object.keys(graph.nodes).length,
    edges: graph.edges.length,
    types,
    updatedAt: graph.meta && graph.meta.updatedAt
  };
}

// Parse structured extraction returned by the model. Tolerant of ```json
// fences, leading prose, and either an object {nodes,edges} or an array of
// nodes. Returns { nodes: [...], edges: [...] }.
export function parseAtlasExtraction(text) {
  const out = { nodes: [], edges: [] };
  if (!text) return out;
  let s = String(text).trim();
  // strip markdown code fences if present
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(s);
  if (fence) s = fence[1].trim();
  // find the first balanced-looking {...} or [...] block
  let obj = null;
  const objMatch = /\{[\s\S]*\}/.exec(s);
  const arrMatch = /\[[\s\S]*\]/.exec(s);
  const candidate = objMatch ? objMatch[0] : arrMatch ? arrMatch[0] : null;
  if (candidate) {
    try {
      obj = JSON.parse(candidate);
    } catch {
      obj = null;
    }
  }
  if (!obj) return out;
  if (Array.isArray(obj)) {
    out.nodes = obj.filter((x) => x && (x.label || x.name)).map((x) => ({
      type: x.type || 'concept',
      label: x.label || x.name,
      description: x.description || ''
    }));
  } else {
    if (Array.isArray(obj.nodes)) {
      out.nodes = obj.nodes
        .filter((x) => x && (x.label || x.name))
        .map((x) => ({ type: x.type || 'concept', label: x.label || x.name, description: x.description || '' }));
    }
    if (Array.isArray(obj.edges)) {
      out.edges = obj.edges
        .filter((x) => x && (x.from || x.source) && (x.to || x.target))
        .map((x) => ({
          from: x.from || x.source,
          to: x.to || x.target,
          type: x.type || x.relation || 'relates_to',
          label: x.label || ''
        }));
    }
  }
  return out;
}

// Apply a parsed extraction onto the graph: add nodes, then link by label.
export function applyExtraction(graph, ext) {
  const added = [];
  for (const n of ext.nodes || []) {
    const r = addNode(graph, n);
    if (r.ok) added.push(r.node);
  }
  const linked = [];
  for (const e of ext.edges || []) {
    const r = linkNodes(graph, e);
    if (r.ok) linked.push(r.edge);
  }
  return { added: added.length, linked: linked.length };
}

// --- persistence (injected directory) ---

export async function loadAtlas(dir = ATLAS_DIR) {
  try {
    const text = await readFile(join(dir, ATLAS_FILE), 'utf8');
    const g = JSON.parse(text);
    if (!g || typeof g !== 'object' || !g.nodes) return emptyGraph();
    g.edges = Array.isArray(g.edges) ? g.edges : [];
    g.meta = g.meta || {};
    // ensure degrees are correct after a load
    for (const n of Object.values(g.nodes)) n.degree = 0;
    for (const e of g.edges) {
      if (g.nodes[e.from]) g.nodes[e.from].degree++;
      if (g.nodes[e.to]) g.nodes[e.to].degree++;
    }
    return g;
  } catch {
    return emptyGraph();
  }
}

export async function saveAtlas(graph, dir = ATLAS_DIR) {
  await mkdir(dir, { recursive: true });
  stamp(graph);
  const tmp = join(dir, ATLAS_FILE + '.tmp');
  const final = join(dir, ATLAS_FILE);
  await writeFile(tmp, JSON.stringify(graph), 'utf8');
  await rename(tmp, final); // atomic on same filesystem
  return graph;
}
