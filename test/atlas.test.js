import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyGraph,
  addNode,
  linkNodes,
  resolveId,
  searchAtlas,
  removeNode,
  removeEdge,
  atlasStats,
  parseAtlasExtraction,
  applyExtraction,
  loadAtlas,
  saveAtlas,
  nodeId,
  graphToContext
} from '../src/core/atlas.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'agenite-atlas-'));
}

test('addNode creates a typed, slugged node', () => {
  const g = emptyGraph();
  const r = addNode(g, { type: 'project', label: 'Agenite', description: '本地智能体' });
  assert.equal(r.ok, true);
  assert.equal(r.existed, false);
  assert.equal(r.node.id, nodeId('project', 'Agenite'));
  assert.equal(r.node.label, 'Agenite');
  assert.equal(g.nodes[r.node.id].type, 'project');
});

test('addNode dedupes by type+label (case/space insensitive)', () => {
  const g = emptyGraph();
  addNode(g, { type: 'project', label: 'Agenite', description: '' });
  const r = addNode(g, { type: 'Project', label: ' agenite ', description: '后来的描述' });
  assert.equal(r.ok, true);
  assert.equal(r.existed, true);
  // description only backfills when originally empty
  assert.equal(g.nodes[r.node.id].description, '后来的描述');
  assert.equal(Object.keys(g.nodes).length, 1);
});

test('linkNodes connects and dedupes; rejects self-link and missing nodes', () => {
  const g = emptyGraph();
  addNode(g, { type: 'project', label: 'Agenite' });
  addNode(g, { type: 'project', label: 'OpenHands' });
  const r1 = linkNodes(g, { from: 'Agenite', to: 'OpenHands', type: 'competes_with' });
  assert.equal(r1.ok, true);
  assert.equal(r1.existed, false);
  const r2 = linkNodes(g, { from: 'Agenite', to: 'OpenHands', type: 'competes_with' });
  assert.equal(r2.existed, true);
  assert.equal(g.edges.length, 1);
  assert.equal(g.nodes[nodeId('project', 'Agenite')].degree, 1);
  const self = linkNodes(g, { from: 'Agenite', to: 'Agenite' });
  assert.equal(self.ok, false);
  const missing = linkNodes(g, { from: 'Agenite', to: 'Ghost' });
  assert.equal(missing.ok, false);
});

test('resolveId finds by id or label', () => {
  const g = emptyGraph();
  addNode(g, { type: 'person', label: '张三' });
  const id = nodeId('person', '张三');
  assert.equal(resolveId(g, id), id);
  assert.equal(resolveId(g, '张三'), id);
  assert.equal(resolveId(g, ' 张三 '), id);
  assert.equal(resolveId(g, '不存在'), null);
});

test('searchAtlas filters by keyword across label/description/type', () => {
  const g = emptyGraph();
  addNode(g, { type: 'project', label: 'Agenite', description: '本地智能体 框架' });
  addNode(g, { type: 'person', label: '李四', description: '设计师' });
  const hits = searchAtlas(g, '本地');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, 'Agenite');
  assert.equal(searchAtlas(g, '').length, 2); // empty query returns all
});

test('removeNode drops node and its edges; degrees recompute', () => {
  const g = emptyGraph();
  addNode(g, { type: 'project', label: 'A' });
  addNode(g, { type: 'project', label: 'B' });
  addNode(g, { type: 'project', label: 'C' });
  linkNodes(g, { from: 'A', to: 'B' });
  linkNodes(g, { from: 'A', to: 'C' });
  const r = removeNode(g, 'A');
  assert.equal(r.ok, true);
  assert.equal(Object.keys(g.nodes).length, 2);
  assert.equal(g.edges.length, 0); // B-C never linked
  assert.equal(resolveId(g, 'A'), null);
});

test('removeEdge removes only the edge and fixes degrees', () => {
  const g = emptyGraph();
  addNode(g, { type: 'project', label: 'A' });
  addNode(g, { type: 'project', label: 'B' });
  const l = linkNodes(g, { from: 'A', to: 'B' });
  const r = removeEdge(g, l.edge.id);
  assert.equal(r.ok, true);
  assert.equal(g.edges.length, 0);
  assert.equal(g.nodes[nodeId('project', 'A')].degree, 0);
  assert.equal(removeEdge(g, 'nope').ok, false);
});

test('atlasStats aggregates node count, edge count and types', () => {
  const g = emptyGraph();
  addNode(g, { type: 'project', label: 'A' });
  addNode(g, { type: 'person', label: 'B' });
  addNode(g, { type: 'person', label: 'C' });
  linkNodes(g, { from: 'A', to: 'B' });
  const s = atlasStats(g);
  assert.equal(s.nodes, 3);
  assert.equal(s.edges, 1);
  assert.equal(s.types.project, 1);
  assert.equal(s.types.person, 2);
});

test('parseAtlasExtraction tolerates fences, prose and shape', () => {
  const fenced = ['```json', JSON.stringify({ nodes: [{ type: 'project', label: 'X' }], edges: [] }), '```'].join('\n');
  const r1 = parseAtlasExtraction(fenced);
  assert.equal(r1.nodes.length, 1);
  assert.equal(r1.nodes[0].label, 'X');

  const prose = '好的，这是结果：' + JSON.stringify({ nodes: [{ label: 'Y', type: 'concept' }], edges: [{ from: 'Y', to: 'Z', type: 'uses' }] });
  const r2 = parseAtlasExtraction(prose);
  assert.equal(r2.nodes.length, 1);
  assert.equal(r2.edges.length, 1);
  assert.equal(r2.edges[0].from, 'Y');

  assert.deepEqual(parseAtlasExtraction(''), { nodes: [], edges: [] });
  assert.deepEqual(parseAtlasExtraction('no json here'), { nodes: [], edges: [] });
});

test('applyExtraction adds nodes then links them by label', () => {
  const g = emptyGraph();
  const ext = {
    nodes: [
      { type: 'project', label: 'Agenite', description: '本地智能体' },
      { type: 'project', label: 'OpenHands', description: '开源 Agent' }
    ],
    edges: [{ from: 'Agenite', to: 'OpenHands', type: 'competes_with' }]
  };
  const res = applyExtraction(g, ext);
  assert.equal(res.added, 2);
  assert.equal(res.linked, 1);
  assert.equal(g.edges.length, 1);
});

test('saveAtlas + loadAtlas round-trips atomically', async () => {
  const dir = tmpDir();
  try {
    const g = emptyGraph();
    addNode(g, { type: 'project', label: 'Agenite', description: 'test' });
    addNode(g, { type: 'person', label: '张三' });
    linkNodes(g, { from: 'Agenite', to: '张三', type: 'maintained_by' });
    await saveAtlas(g, dir);

    const loaded = await loadAtlas(dir);
    assert.equal(Object.keys(loaded.nodes).length, 2);
    assert.equal(loaded.edges.length, 1);
    assert.equal(loaded.nodes[nodeId('project', 'Agenite')].degree, 1);
    // corrupt file falls back to empty graph
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'atlas.json'), '{ not valid json ', 'utf8');
    const safe = await loadAtlas(dir);
    assert.equal(Object.keys(safe.nodes).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('graphToContext returns empty string for an empty graph', () => {
  assert.equal(graphToContext(emptyGraph()), '');
  assert.equal(graphToContext(null), '');
});

test('graphToContext lists nodes with type labels and a summary line', () => {
  const g = emptyGraph();
  addNode(g, { type: 'project', label: 'Agenite', description: '本地智能体' });
  addNode(g, { type: 'person', label: '张三', description: '贡献者' });
  const ctx = graphToContext(g);
  assert.match(ctx, /\[project\] Agenite/);
  assert.match(ctx, /\[person\] 张三/);
  assert.match(ctx, /共 2 个实体/);
});

test('graphToContext sorts by degree and truncates to maxNodes', () => {
  const g = emptyGraph();
  // hub: linked to many leaves (degree 5); isolated nodes (degree 0)
  addNode(g, { type: 'person', label: 'hub' });
  for (let i = 0; i < 5; i++) {
    addNode(g, { type: 'concept', label: 'leaf' + i });
    linkNodes(g, { from: 'hub', to: 'leaf' + i, type: 'related_to' });
  }
  for (let i = 0; i < 10; i++) addNode(g, { type: 'concept', label: 'iso' + i }); // degree 0
  // total 16 nodes; maxNodes 6 keeps the hub + its 5 leaves, drops all iso*
  const ctx = graphToContext(g, { maxNodes: 6, maxEdges: 5 });
  // hub and its leaves are present, isolated nodes are dropped
  assert.match(ctx, /\[person\] hub/);
  assert.match(ctx, /\[concept\] leaf0/);
  assert.ok(!ctx.includes('iso0'));
  // summary notes truncation (16 > 6)
  assert.match(ctx, /仅展示其中最相关的 6 个/);
});

test('graphToContext only shows edges whose endpoints are visible', () => {
  const g = emptyGraph();
  addNode(g, { type: 'project', label: 'Agenite' });
  addNode(g, { type: 'project', label: 'OpenHands' });
  addNode(g, { type: 'concept', label: 'hidden' });
  linkNodes(g, { from: 'Agenite', to: 'OpenHands', type: 'competes_with' });
  linkNodes(g, { from: 'Agenite', to: 'hidden', type: 'relates_to' });
  const ctx = graphToContext(g, { maxNodes: 2, maxEdges: 10 });
  // only the visible edge (Agenite -> OpenHands) should be rendered
  assert.match(ctx, /Agenite —competes_with→ OpenHands/);
  assert.ok(!ctx.includes('hidden'));
});
