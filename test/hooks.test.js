import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HookBus,
  createPluginRegistry,
  runToolPipeline,
  reflectionGuardPlugin,
  detectInstructionFiles,
  formatInstructionBlock
} from '../src/core/hooks.js';

// ── HookBus ──────────────────────────────────────────────────────────────────
test('HookBus: handlers run in ascending order', async () => {
  const bus = new HookBus();
  const seen = [];
  bus.on('e', () => seen.push('b'), { order: 2 });
  bus.on('e', () => seen.push('a'), { order: 1 });
  await bus.emit('e', {});
  assert.deepEqual(seen, ['a', 'b']);
});

test('HookBus: a throwing handler is isolated and its error is captured', async () => {
  const bus = new HookBus();
  bus.on('e', () => { throw new Error('boom'); });
  bus.on('e', () => 42);
  const results = await bus.emit('e', {});
  assert.equal(results.length, 2);
  assert.ok(results[0] && results[0].error && results[0].error.includes('boom'));
  assert.equal(results[1], 42);
});

test('HookBus: off() removes a handler', async () => {
  const bus = new HookBus();
  let n = 0;
  const off = bus.on('e', () => { n++; });
  off();
  await bus.emit('e', {});
  assert.equal(n, 0);
});

// ── Plugin registry ──────────────────────────────────────────────────────────
test('createPluginRegistry: applyAll registers plugins onto a HookBus', () => {
  const reg = createPluginRegistry();
  let registered = false;
  reg.register({ id: 'x', register(hooks) { hooks.on('tool:before', () => { registered = true; }); } });
  const bus = new HookBus();
  reg.applyAll(bus);
  // registering adds the listener; emitting should flip the flag
  return bus.emit('tool:before', {}).then(() => assert.equal(registered, true));
});

// ── runToolPipeline ──────────────────────────────────────────────────────────
test('runToolPipeline: passes through to execute and returns its result', async () => {
  const bus = new HookBus();
  const executed = [];
  const res = await runToolPipeline({
    name: 'read_file', args: { path: 'x' }, opts: {},
    execute: async (n, a, o) => { executed.push([n, a, o]); return { ok: true, content: 'hello' }; },
    hooks: bus
  });
  assert.equal(executed.length, 1);
  assert.deepEqual(res, { ok: true, content: 'hello' });
});

test('runToolPipeline: a tool:before abort blocks execution entirely', async () => {
  const bus = new HookBus();
  bus.on('tool:before', () => ({ abort: true, reason: 'nope' }));
  let ran = false;
  const res = await runToolPipeline({
    name: 'run_command', args: {}, opts: {},
    execute: async () => { ran = true; return { ok: true }; },
    hooks: bus
  });
  assert.equal(ran, false);
  assert.equal(res.blocked, true);
  assert.equal(res.error, 'nope');
});

test('runToolPipeline: warn decision is folded into the tool result content', async () => {
  const bus = new HookBus();
  bus.on('tool:before', () => ({ warns: ['be careful'] }));
  const events = [];
  const res = await runToolPipeline({
    name: 'write_file', args: {}, opts: {},
    execute: async () => ({ ok: true, content: 'file body', path: 'a' }),
    hooks: bus,
    onEvent: (lvl, p) => events.push([lvl, p])
  });
  assert.ok(res.content.startsWith('⚠️ 经验护栏提醒：be careful'));
  assert.ok(res.content.includes('file body'));
  // a pre-flight warn SSE was emitted
  assert.ok(events.some(([l, p]) => l === 'guard' && p.level === 'warn'));
});

test('runToolPipeline: an execute() throw is captured, not thrown', async () => {
  const bus = new HookBus();
  const res = await runToolPipeline({
    name: 'x', args: {}, opts: {},
    execute: async () => { throw new Error('kaboom'); },
    hooks: bus
  });
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('kaboom'));
});

// ── reflectionGuardPlugin ─────────────────────────────────────────────────────
const SAFETY_LESSONS = [
  { type: 'warning', context: '变更后缺验证', score: 0.66, text: '变更后请跑验证。' },
  { type: 'procedure', context: '验证失败', score: 0.78, text: '先看真实错误再修。' },
  { type: 'principle', context: '高质量收尾模式', score: 0.72, text: 'good pattern' }
];
const LOOP_LESSON = { type: 'warning', context: '卡死循环', score: 0.82, text: '别用相同参数死循环重试。' };

test('reflectionGuardPlugin: off mode is a pure pass-through', async () => {
  const bus = new HookBus();
  const reg = createPluginRegistry();
  reg.register(reflectionGuardPlugin({ getLessons: () => ({ lessons: SAFETY_LESSONS }), isDestructive: () => true, mode: 'off' }));
  reg.applyAll(bus);
  const r = await bus.emit('tool:before', { name: 'write_file' });
  assert.equal(r.length, 0); // no plugin registered a hook
});

test('reflectionGuardPlugin: warn mode surfaces safety lessons for destructive tools only', async () => {
  const bus = new HookBus();
  const reg = createPluginRegistry();
  reg.register(reflectionGuardPlugin({ getLessons: () => ({ lessons: SAFETY_LESSONS }), isDestructive: (n) => n === 'write_file', mode: 'warn' }));
  reg.applyAll(bus);

  const onDestructive = await bus.emit('tool:before', { name: 'write_file' });
  assert.ok(onDestructive[0] && Array.isArray(onDestructive[0].warns) && onDestructive[0].warns.length >= 2);

  const onSafe = (await bus.emit('tool:before', { name: 'read_file' })).filter(Boolean);
  assert.equal(onSafe.length, 0); // non-destructive → no guard
});

test('reflectionGuardPlugin: warn mode ignores low-score / non-safety lessons', async () => {
  const bus = new HookBus();
  const reg = createPluginRegistry();
  // only a low-score unrelated lesson → nothing should surface
  const lowOnly = [{ type: 'warning', context: '中断 / 护栏', score: 0.5, text: 'weak' }];
  reg.register(reflectionGuardPlugin({ getLessons: () => ({ lessons: lowOnly }), isDestructive: () => true, mode: 'warn' }));
  reg.applyAll(bus);
  const r = (await bus.emit('tool:before', { name: 'write_file' })).filter(Boolean);
  assert.equal(r.length, 0);
});

test('reflectionGuardPlugin: block mode refuses HARD_BLOCK_TOOLS on a strong loop lesson', async () => {
  const bus = new HookBus();
  const reg = createPluginRegistry();
  reg.register(reflectionGuardPlugin({ getLessons: () => ({ lessons: [LOOP_LESSON] }), isDestructive: () => true, mode: 'block' }));
  reg.applyAll(bus);

  const onDanger = await bus.emit('tool:before', { name: 'run_command' });
  assert.ok(onDanger[0] && onDanger[0].abort, 'run_command should be aborted');
  assert.ok(onDanger[0].reason.includes('卡死循环'));

  // a non-hard-block destructive tool is NOT hard-blocked even with the lesson
  const onWrite = (await bus.emit('tool:before', { name: 'write_file' })).filter(Boolean);
  assert.equal(onWrite.length, 0);
});

test('reflectionGuardPlugin: block mode is a no-op without a strong lesson', async () => {
  const bus = new HookBus();
  const reg = createPluginRegistry();
  reg.register(reflectionGuardPlugin({ getLessons: () => ({ lessons: SAFETY_LESSONS }), isDestructive: () => true, mode: 'block' }));
  reg.applyAll(bus);
  const r = (await bus.emit('tool:before', { name: 'run_command' })).filter(Boolean);
  assert.equal(r.length, 0); // none of SAFETY_LESSONS reach score ≥ 0.8
});

// ── instruction-file auto-load ────────────────────────────────────────────────
test('detectInstructionFiles + formatInstructionBlock: AGENTS.md / CLAUDE.md / .agenite/instructions/*', () => {
  const root = mkdtempSync(join(tmpdir(), 'agenite-inst-'));
  writeFileSync(join(root, 'AGENTS.md'), '# Agents\nDo X.\n');
  writeFileSync(join(root, 'CLAUDE.md'), '# Claude\nDo Y.\n');
  writeFileSync(join(root, 'README.md'), 'ignore me'); // should NOT be picked up
  writeFileSync(join(root, 'notes.txt'), 'ignore me'); // wrong ext

  const found = detectInstructionFiles(root);
  assert.ok(found.some((f) => f.endsWith('AGENTS.md')));
  assert.ok(found.some((f) => f.endsWith('CLAUDE.md')));
  assert.equal(found.some((f) => f.endsWith('README.md')), false);

  const block = formatInstructionBlock(found);
  assert.ok(block.includes('## 项目指令'));
  assert.ok(block.includes('Do X.'));
  assert.ok(block.includes('Do Y.'));
});

test('detectInstructionFiles: .agenite/instructions/*.md are collected too', () => {
  const root = mkdtempSync(join(tmpdir(), 'agenite-inst2-'));
  const dir = join(root, '.agenite', 'instructions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'conventions.md'), 'Be consistent.');
  writeFileSync(join(dir, 'style.md'), 'Use 2 spaces.');
  writeFileSync(join(dir, 'ignore.json'), '{}'); // wrong ext

  const found = detectInstructionFiles(root);
  assert.ok(found.some((f) => f.endsWith('conventions.md')));
  assert.ok(found.some((f) => f.endsWith('style.md')));
  assert.equal(found.some((f) => f.endsWith('ignore.json')), false);
});

test('detectInstructionFiles: returns [] when no instruction files exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'agenite-inst3-'));
  assert.deepEqual(detectInstructionFiles(root), []);
  assert.equal(formatInstructionBlock([]), '');
});
