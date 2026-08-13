// Shareable agent configuration presets.
//
// A preset captures the *shareable* slice of the config — everything except
// secrets and local paths — so users can export / import / clone agent
// "personas" without leaking their API key or pointing at someone else's
// machine. Pure module: no DOM, no fs — safe to import from both the browser
// (app.js) and node:test.

import { defaultConfig, normalizeConfig } from './config.js';

// Fields that may travel inside a preset. `apiKey` + `workspace` are
// deliberately excluded so a shared preset can never carry a secret or a local
// directory. Derived from defaultConfig so any new config field is picked up
// automatically (and stays out only if explicitly added here).
const EXCLUDED_FIELDS = ['apiKey', 'workspace'];
export const PRESET_FIELDS = Object.keys(defaultConfig()).filter(
  (k) => !EXCLUDED_FIELDS.includes(k)
);

export const PRESET_VERSION = 1;

// Snapshot the *current* (shareable) config as a preset. Always takes the full
// PRESET_FIELDS subset so a saved preset reproduces the agent exactly (minus
// secrets / workspace, which are restored from the user's own config on apply).
export function buildPreset(config, meta = {}) {
  const name = (meta.name || '').toString().trim();
  const description = (meta.description || '').toString().trim();
  const author = (meta.author || '').toString().trim();
  const cfg = {};
  const def = defaultConfig();
  for (const f of PRESET_FIELDS) {
    cfg[f] = config && Object.prototype.hasOwnProperty.call(config, f) ? config[f] : def[f];
  }
  // Belt-and-suspenders: never export secrets even if the caller's config has
  // them under a name we forgot to exclude.
  delete cfg.apiKey;
  delete cfg.workspace;
  return {
    name: name || '未命名预设',
    description,
    author,
    version: PRESET_VERSION,
    createdAt: Date.now(),
    config: cfg
  };
}

// Validate + sanitize an untrusted preset (e.g. one pasted from the internet).
// Throws on structural errors; otherwise returns a cleaned clone whose apiKey /
// workspace are stripped and whose config contains only known shareable fields.
export function validatePreset(preset) {
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
    throw new Error('预设格式无效：应是一个对象');
  }
  if (!preset.name || typeof preset.name !== 'string' || !preset.name.trim()) {
    throw new Error('预设缺少 name 字段');
  }
  const raw = preset.config && typeof preset.config === 'object' && !Array.isArray(preset.config)
    ? preset.config
    : {};
  // Hard rule: a preset must never carry secrets or local paths.
  const safe = { ...raw };
  delete safe.apiKey;
  delete safe.workspace;
  // Keep only known shareable fields; drop anything unexpected.
  const cfg = {};
  for (const f of PRESET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(safe, f)) cfg[f] = safe[f];
  }
  return {
    name: preset.name.trim(),
    description: typeof preset.description === 'string' ? preset.description.trim() : '',
    author: typeof preset.author === 'string' ? preset.author.trim() : '',
    version: Number.isFinite(preset.version) ? preset.version : PRESET_VERSION,
    createdAt: Number.isFinite(preset.createdAt) ? preset.createdAt : 0,
    config: cfg
  };
}

// Merge a preset over the current config, returning a normalized config.
// The user's own apiKey + workspace are ALWAYS preserved — a preset can never
// overwrite a secret or relocate the sandbox.
export function applyPresetToConfig(preset, baseConfig) {
  const clean = validatePreset(preset);
  const merged = { ...baseConfig, ...clean.config };
  merged.apiKey = baseConfig ? baseConfig.apiKey : '';
  merged.workspace = baseConfig ? baseConfig.workspace : '';
  return normalizeConfig(merged);
}

// One-line human summary for cards / toasts.
export function presetSummary(preset) {
  const c = (preset && preset.config) || {};
  const approve = { ask: '每次询问', auto: '自动放行', deny: '只读模式' };
  const parts = [];
  if (c.model) parts.push(String(c.model));
  if (c.approvalMode) parts.push('权限:' + (approve[c.approvalMode] || c.approvalMode));
  parts.push('危险工具:' + (c.dangerTools ? '开' : '关'));
  const skills = Array.isArray(c.skills) ? c.skills : [];
  parts.push('技能:' + skills.length);
  parts.push('计划:' + (c.planMode ? '开' : '关'));
  if (c.autoVerify) parts.push('验证:' + c.autoVerify);
  if (c.kbEnabled) parts.push('知识库:开');
  return parts.join(' · ');
}

// Curated, ready-to-use example presets shipped with Agenite. These are partial
// overrides (they set the distinctive fields and leave the rest at the user's
// defaults), so they read cleanly when shared.
export const BUILTIN_PRESETS = [
  {
    name: '通用助手',
    description: '全能型日常助手：开放全部工具、自动验证、记忆与图谱全开。适合绝大多数任务。',
    author: 'Agenite',
    version: PRESET_VERSION,
    createdAt: 0,
    config: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      agentEnabled: true,
      planMode: false,
      memoryEnabled: true,
      dangerTools: true,
      autoSkill: true,
      approvalMode: 'ask',
      atlasInject: true,
      atlasAutoBuild: false,
      atlasAutoOpen: true,
      autoVerify: 'syntax',
      gitCheckpoint: true,
      selfHeal: true,
      contextCompress: 'smart',
      suggestFollowups: true,
      systemPrompt: '你是一个乐于助人、严谨、务实的中文 AI 助手。遇到复杂或多步骤任务时，先给出简洁的计划，再逐步执行；遇到不确定之处主动澄清，而不是臆测。回答要准确、有结构、可操作。'
    }
  },
  {
    name: '代码工程师',
    description: '谨慎的代码搭档：开启完整验证与计划模式、自动 git 检查点、危险工具开放但每次确认。适合真实工程改动。',
    author: 'Agenite',
    version: PRESET_VERSION,
    createdAt: 0,
    config: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      agentEnabled: true,
      planMode: true,
      memoryEnabled: true,
      dangerTools: true,
      autoSkill: true,
      approvalMode: 'ask',
      atlasInject: true,
      autoVerify: 'full',
      gitCheckpoint: true,
      selfHeal: true,
      maxReflections: 4,
      contextCompress: 'smart',
      suggestFollowups: true,
      systemPrompt: '你是一名资深的软件工程师助手。改动代码前先理解相关文件与约定；优先做最小、可逆的修改，并在每次改动后运行项目的验证命令（如测试/构建/lint）。绝不臆测不存在的 API；遇到报错先读错误、再定位、最后修复，并把根因讲清楚。'
    }
  },
  {
    name: '只读研究助手',
    description: '纯研究模式：只读（拒绝一切写入与命令）、开启本地知识库检索与记忆图谱。适合查资料、做综述、不希望它动你的文件。',
    author: 'Agenite',
    version: PRESET_VERSION,
    createdAt: 0,
    config: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      agentEnabled: true,
      planMode: false,
      memoryEnabled: true,
      dangerTools: false,
      autoSkill: false,
      approvalMode: 'deny',
      atlasInject: true,
      kbEnabled: true,
      kbTopK: 6,
      autoVerify: 'off',
      gitCheckpoint: false,
      selfHeal: false,
      contextCompress: 'smart',
      suggestFollowups: true,
      systemPrompt: '你是一名严谨的研究助手，工作在只读模式下：你不会写入文件或执行命令，只会检索、阅读、归纳与对比资料。引用来源、区分事实与推断，并在信息不足时明确说明。优先使用本地知识库与记忆图谱中的内容。'
    }
  }
];
