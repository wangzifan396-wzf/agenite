import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTool, resolveMode, evaluateGuardrail } from '../src/core/guardrails.js';

test('classifyTool maps known tools to risk categories', () => {
  assert.equal(classifyTool('read_file'), 'read');
  assert.equal(classifyTool('list_dir'), 'read');
  assert.equal(classifyTool('codebase_search'), 'read');
  assert.equal(classifyTool('context_retrieve'), 'read');
  assert.equal(classifyTool('write_file'), 'write');
  assert.equal(classifyTool('edit_file'), 'write');
  assert.equal(classifyTool('make_dir'), 'write');
  assert.equal(classifyTool('apply_patch'), 'write');
  assert.equal(classifyTool('run_command'), 'exec');
  assert.equal(classifyTool('run_code'), 'exec');
  assert.equal(classifyTool('web_fetch'), 'network');
  assert.equal(classifyTool('web_search'), 'network');
  assert.equal(classifyTool('frobnicate'), 'unknown');
});

test('classifyTool flags secret args as secret regardless of tool', () => {
  assert.equal(classifyTool('read_file', { path: '/etc/secrets/api_key.txt' }), 'secret');
  assert.equal(classifyTool('read_file', { path: '.env' }), 'secret');
  assert.equal(classifyTool('write_file', { path: 'credentials.json' }), 'secret');
});

test('classifyTool flags destructive exec commands', () => {
  assert.equal(classifyTool('run_command', { command: 'rm -rf /tmp/x' }), 'destructive');
  assert.equal(classifyTool('run_command', { command: 'mkfs.ext4 /dev/sda1' }), 'destructive');
  // a normal command stays exec
  assert.equal(classifyTool('run_command', { command: 'ls -la' }), 'exec');
});

test('resolveMode normalizes the approval triad and defaults to ask', () => {
  assert.equal(resolveMode('auto'), 'auto');
  assert.equal(resolveMode('ALLOW'), 'auto');
  assert.equal(resolveMode('yolo'), 'auto');
  assert.equal(resolveMode('ask'), 'ask');
  assert.equal(resolveMode(''), 'ask');
  assert.equal(resolveMode(undefined), 'ask');
  assert.equal(resolveMode('deny'), 'deny');
  assert.equal(resolveMode('block'), 'deny');
  assert.equal(resolveMode('off'), 'deny');
});

test('evaluateGuardrail hard-denies secret access', () => {
  const r = evaluateGuardrail({ tool: 'read_file', args: { path: '.env' }, policy: { mode: 'auto' } });
  assert.equal(r.decision, 'deny');
  assert.equal(r.category, 'secret');
  assert.equal(r.reason, 'secret-access-blocked');
});

test('evaluateGuardrail honors explicit denyList', () => {
  const r = evaluateGuardrail({ tool: 'run_command', args: {}, policy: { mode: 'auto', denyList: ['run_command'] } });
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'deny-list');
});

test('evaluateGuardrail enforces network rate cap', () => {
  // under the cap: allowed
  const ok = evaluateGuardrail({ tool: 'web_fetch', args: { url: 'x' }, policy: { mode: 'auto', networkCap: 2 }, stats: { netCount: 1 } });
  assert.equal(ok.decision, 'allow');
  // at/over the cap: denied
  const blocked = evaluateGuardrail({ tool: 'web_fetch', args: { url: 'x' }, policy: { mode: 'auto', networkCap: 2 }, stats: { netCount: 2 } });
  assert.equal(blocked.decision, 'deny');
  assert.equal(blocked.reason, 'network-rate-limit');
  // -1 means unlimited
  const unlimited = evaluateGuardrail({ tool: 'web_fetch', args: { url: 'x' }, policy: { mode: 'auto', networkCap: -1 }, stats: { netCount: 999 } });
  assert.equal(unlimited.decision, 'allow');
});

test('evaluateGuardrail enforces allowList when set', () => {
  const blocked = evaluateGuardrail({ tool: 'write_file', args: {}, policy: { mode: 'auto', allowList: ['read_file'] } });
  assert.equal(blocked.decision, 'deny');
  assert.equal(blocked.reason, 'not-in-allow-list');
  const allowed = evaluateGuardrail({ tool: 'read_file', args: {}, policy: { mode: 'auto', allowList: ['read_file'] } });
  assert.equal(allowed.decision, 'allow');
});

test('evaluateGuardrail routes by mode: deny blocks everything', () => {
  const r = evaluateGuardrail({ tool: 'read_file', args: {}, policy: { mode: 'deny' } });
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'mode-deny');
});

test('evaluateGuardrail routes by mode: ask gates risky classes, allows reads', () => {
  assert.equal(evaluateGuardrail({ tool: 'write_file', args: {}, policy: { mode: 'ask' } }).decision, 'ask');
  assert.equal(evaluateGuardrail({ tool: 'run_command', args: {}, policy: { mode: 'ask' } }).decision, 'ask');
  assert.equal(evaluateGuardrail({ tool: 'web_fetch', args: {}, policy: { mode: 'ask' } }).decision, 'ask');
  const read = evaluateGuardrail({ tool: 'read_file', args: {}, policy: { mode: 'ask' } });
  assert.equal(read.decision, 'allow');
  assert.equal(read.reason, 'readonly');
});

test('evaluateGuardrail routes by mode: auto allows after the hard floor', () => {
  const r = evaluateGuardrail({ tool: 'write_file', args: {}, policy: { mode: 'auto' } });
  assert.equal(r.decision, 'allow');
  assert.equal(r.reason, 'mode-auto');
});

test('evaluateGuardrail floor beats a permissive mode (secret under auto)', () => {
  const r = evaluateGuardrail({ tool: 'read_file', args: { path: 'token.txt' }, policy: { mode: 'auto' } });
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'secret-access-blocked');
});
