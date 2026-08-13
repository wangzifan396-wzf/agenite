import assert from 'node:assert';
import { test } from 'node:test';

import {
  PRESET_FIELDS, buildPreset, validatePreset, applyPresetToConfig, presetSummary, BUILTIN_PRESETS
} from '../src/core/presets.js';
import { defaultConfig } from '../src/core/config.js';

test('PRESET_FIELDS excludes apiKey + workspace but covers the shareable config', () => {
  const def = defaultConfig();
  assert.ok(!PRESET_FIELDS.includes('apiKey'), 'apiKey must never be shareable');
  assert.ok(!PRESET_FIELDS.includes('workspace'), 'workspace must never be shareable');
  // A representative slice of the real config must be present.
  for (const f of ['provider', 'model', 'approvalMode', 'skills', 'systemPrompt', 'autoVerify', 'kbEnabled']) {
    assert.ok(PRESET_FIELDS.includes(f), `PRESET_FIELDS should include ${f}`);
  }
  // Every shareable field should be a real config field.
  for (const f of PRESET_FIELDS) assert.ok(f in def, `PRESET_FIELDS has unknown field ${f}`);
});

test('buildPreset captures the full shareable slice and drops secrets', () => {
  const cfg = { ...defaultConfig(), apiKey: 'sk-TOPSECRET', workspace: '/secret/dir', model: 'gpt-4o-mini', dangerTools: true };
  const p = buildPreset(cfg, { name: '我的助手', description: 'desc', author: 'me' });
  assert.equal(p.name, '我的助手');
  assert.equal(p.description, 'desc');
  assert.equal(p.config.model, 'gpt-4o-mini');
  assert.equal(p.config.dangerTools, true);
  assert.ok(!('apiKey' in p.config), 'apiKey must not be in preset');
  assert.ok(!('workspace' in p.config), 'workspace must not be in preset');
  assert.equal(p.config.apiKey, undefined);
});

test('validatePreset rejects non-objects and missing name, strips apiKey', () => {
  assert.throws(() => validatePreset(null), /格式无效/);
  assert.throws(() => validatePreset('nope'), /格式无效/);
  assert.throws(() => validatePreset({}), /缺少 name/);
  // A malicious preset carrying a secret is sanitized, not thrown.
  const clean = validatePreset({ name: 'x', config: { apiKey: 'sk-leak', model: 'm', workspace: '/p' } });
  assert.ok(!('apiKey' in clean.config), 'apiKey must be stripped');
  assert.ok(!('workspace' in clean.config), 'workspace must be stripped');
  assert.equal(clean.config.model, 'm');
  assert.equal(clean.name, 'x');
  // Unknown fields are dropped; only PRESET_FIELDS survive.
  const withJunk = validatePreset({ name: 'y', config: { model: 'm', hacker: true } });
  assert.ok(!('hacker' in withJunk.config));
});

test('applyPresetToConfig merges preset and preserves base apiKey + workspace', () => {
  const base = { ...defaultConfig(), apiKey: 'sk-BASE', workspace: '/base/dir', model: 'deepseek-chat', approvalMode: 'ask' };
  const preset = buildPreset({ ...defaultConfig(), model: 'gpt-4o-mini', approvalMode: 'deny', dangerTools: false });
  const merged = applyPresetToConfig(preset, base);
  assert.equal(merged.model, 'gpt-4o-mini');
  assert.equal(merged.approvalMode, 'deny');
  assert.equal(merged.dangerTools, false);
  // Secrets + local path always come from the base user config.
  assert.equal(merged.apiKey, 'sk-BASE');
  assert.equal(merged.workspace, '/base/dir');
  // Applying a malicious preset that claims a secret cannot override the base.
  const evil = { name: 'evil', config: { apiKey: 'sk-EVIL', workspace: '/evil', model: 'm' } };
  const safe = applyPresetToConfig(evil, base);
  assert.equal(safe.apiKey, 'sk-BASE');
  assert.equal(safe.workspace, '/base/dir');
  assert.equal(safe.model, 'm');
});

test('presetSummary produces a readable one-liner', () => {
  const s = presetSummary({ name: 'r', config: { model: 'deepseek-chat', approvalMode: 'deny', dangerTools: false, skills: ['a', 'b'], planMode: true, autoVerify: 'full' } });
  assert.match(s, /deepseek-chat/);
  assert.match(s, /只读模式/);
  assert.match(s, /危险工具:关/);
  assert.match(s, /技能:2/);
  assert.match(s, /计划:开/);
  assert.match(s, /验证:full/);
});

test('BUILTIN_PRESETS are all valid and cleanly applicable', () => {
  assert.ok(BUILTIN_PRESETS.length >= 3, 'should ship at least 3 example presets');
  const names = BUILTIN_PRESETS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, 'builtin preset names must be unique');
  const base = defaultConfig();
  for (const p of BUILTIN_PRESETS) {
    const applied = applyPresetToConfig(p, base);
    assert.ok(applied.model, `builtin "${p.name}" should set a model`);
    assert.ok(!('apiKey' in p.config), `builtin "${p.name}" must not carry apiKey`);
    assert.ok(!('workspace' in p.config), `builtin "${p.name}" must not carry workspace`);
  }
  // The read-only researcher must actually be read-only.
  const ro = BUILTIN_PRESETS.find((p) => p.name === '只读研究助手');
  assert.equal(applyPresetToConfig(ro, base).approvalMode, 'deny');
  // The code engineer must actually verify.
  const eng = BUILTIN_PRESETS.find((p) => p.name === '代码工程师');
  assert.equal(applyPresetToConfig(eng, base).autoVerify, 'full');
});
