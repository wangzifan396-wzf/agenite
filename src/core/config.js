// Configuration model + validation. Pure (no DOM, no fs).

export const PROVIDER_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKeyPlaceholder: 'sk-...',
    defaultModel: 'gpt-4o-mini',
    protocol: 'openai'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyPlaceholder: 'sk-...',
    defaultModel: 'deepseek-chat',
    protocol: 'openai'
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseURL: 'https://api.moonshot.cn/v1',
    apiKeyPlaceholder: 'sk-...',
    defaultModel: 'moonshot-v1-8k',
    protocol: 'openai'
  },
  {
    id: 'qwen',
    label: '通义千问 (Qwen)',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyPlaceholder: 'sk-...',
    defaultModel: 'qwen-plus',
    protocol: 'openai'
  },
  {
    id: 'zhipu',
    label: '智谱 (GLM)',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyPlaceholder: 'sk-...',
    defaultModel: 'glm-4-flash',
    protocol: 'openai'
  },
  {
    id: 'groq',
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyPlaceholder: 'gsk_...',
    defaultModel: 'llama-3.1-8b-instant',
    protocol: 'openai'
  },
  {
    id: 'ollama',
    label: 'Ollama (本地)',
    baseURL: 'http://localhost:11434/v1',
    apiKeyPlaceholder: 'ollama (可留空)',
    defaultModel: 'llama3.1',
    protocol: 'openai'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyPlaceholder: 'sk-or-...',
    defaultModel: 'openai/gpt-4o-mini',
    protocol: 'openai'
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    baseURL: 'https://api.anthropic.com',
    apiKeyPlaceholder: 'sk-ant-...',
    defaultModel: 'claude-3-5-sonnet-latest',
    protocol: 'anthropic'
  },
  {
    id: 'custom',
    label: '自定义 (OpenAI 兼容)',
    baseURL: '',
    apiKeyPlaceholder: 'your-api-key',
    defaultModel: '',
    protocol: 'openai'
  }
];

export function defaultConfig() {
  return {
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    protocol: 'openai',
    temperature: 0.7,
    maxTokens: 2048,
    topP: 1,
    agentEnabled: true,
    dangerTools: false
  };
}

// Merge user input over defaults, applying a provider preset when the
// provider id is recognized (so baseURL/protocol/model get sensible values).
export function normalizeConfig(input = {}) {
  const cfg = { ...defaultConfig(), ...input };
  const preset = PROVIDER_PRESETS.find((p) => p.id === cfg.provider);
  if (preset) {
    cfg.protocol = preset.protocol;
    if (!cfg.baseURL && preset.baseURL) cfg.baseURL = preset.baseURL;
    if (!cfg.model && preset.defaultModel) cfg.model = preset.defaultModel;
  }
  cfg.temperature = clampNum(cfg.temperature, 0, 2, 0.7);
  cfg.maxTokens = clampNum(cfg.maxTokens, 1, 128000, 2048);
  cfg.topP = clampNum(cfg.topP, 0, 1, 1);
  cfg.agentEnabled = !!cfg.agentEnabled;
  cfg.dangerTools = !!cfg.dangerTools;
  return cfg;
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Validate config for an actual API call. Returns { ok, errors: string[] }.
export function validateConfig(cfg) {
  const errors = [];
  if (!cfg) errors.push('配置为空');
  if (!cfg.baseURL || !/^https?:\/\//.test(cfg.baseURL)) {
    errors.push('baseURL 无效（需要以 http(s):// 开头）');
  }
  if (!cfg.model || !cfg.model.trim()) {
    errors.push('未填写模型名称 (model)');
  }
  // Ollama allows an empty key; everyone else needs one.
  if (cfg.provider !== 'ollama' && (!cfg.apiKey || !cfg.apiKey.trim())) {
    errors.push('未填写 API Key');
  }
  if (cfg.protocol !== 'openai' && cfg.protocol !== 'anthropic') {
    errors.push('不支持的协议: ' + cfg.protocol);
  }
  return { ok: errors.length === 0, errors };
}
