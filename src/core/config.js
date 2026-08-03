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

// How the agent asks for permission before touching the machine.
// - 'ask'  : every write / command needs a human click (default, safest useful mode)
// - 'auto' : no prompts — the agent acts on its own inside the workspace
// - 'deny' : refuse every dangerous tool outright (read-only agent)
export const APPROVAL_MODES = [
  { id: 'ask', label: '每次询问', hint: '写文件 / 执行命令前弹窗确认（推荐）' },
  { id: 'auto', label: '自动放行', hint: '沙箱内不再询问，速度快但风险自负' },
  { id: 'deny', label: '只读模式', hint: '拒绝一切写入与命令执行' }
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
    planMode: false,
    memoryEnabled: true,
    dangerTools: false,
    // Let the agent auto-crystallize complex workflows into reusable SKILL.md
    // files after a run (opt-in: costs one extra tool-free model call).
    autoSkill: false,
    // Active persona (role) — a built-in name, a saved custom name, or ''.
    persona: '',
    // --- machine control ---
    approvalMode: 'ask',
    // Empty means "the folder Agenite was started from"; the server fills it in.
    workspace: '',
    // Escape hatch: allow the agent outside the workspace root. Off by default.
    allowOutsideWorkspace: false,
    systemPrompt: '',
    // --- agent loop ---
    // How many model round-trips one request may take before we stop and ask.
    maxTurns: 20,
    // --- context management ---
    // 0 = derive from the model name. Set it if you know better than our table.
    contextWindow: 0,
    autoCompact: true,
    // Use a real (cheap) model call to summarize dropped turns instead of a
    // mechanical digest. Costs one small extra request when it triggers.
    smartCompact: true,
    // --- cost accounting (0 = use the built-in price table) ---
    priceIn: 0,
    priceOut: 0,
    priceCurrency: 'CNY',
    // --- approvals ---
    // Tools that never need a click again ("始终允许" in the approval dialog).
    toolAllowlist: [],
    // Let obviously read-only MCP tools (get_/list_/search_…) run without a
    // prompt. Anything that can change state still asks.
    mcpAutoApproveReadonly: true,
    // Mirror conversations into ~/.agenite/sessions so they survive a browser
    // change or a cleared cache.
    syncSessions: true
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
  cfg.allowOutsideWorkspace = !!cfg.allowOutsideWorkspace;
  if (!APPROVAL_MODES.some((m) => m.id === cfg.approvalMode)) cfg.approvalMode = 'ask';
  cfg.workspace = typeof cfg.workspace === 'string' ? cfg.workspace.trim() : '';
  cfg.systemPrompt = typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt : '';
  cfg.persona = typeof cfg.persona === 'string' ? cfg.persona.trim() : '';
  cfg.maxTurns = Math.round(clampNum(cfg.maxTurns, 1, 100, 20));
  cfg.contextWindow = Math.round(clampNum(cfg.contextWindow, 0, 2000000, 0));
  cfg.autoCompact = cfg.autoCompact !== false;
  cfg.smartCompact = cfg.smartCompact !== false;
  cfg.syncSessions = cfg.syncSessions !== false;
  cfg.mcpAutoApproveReadonly = cfg.mcpAutoApproveReadonly !== false;
  cfg.priceIn = clampNum(cfg.priceIn, 0, 100000, 0);
  cfg.priceOut = clampNum(cfg.priceOut, 0, 100000, 0);
  cfg.priceCurrency = ['CNY', 'USD', 'EUR'].includes(cfg.priceCurrency) ? cfg.priceCurrency : 'CNY';
  cfg.toolAllowlist = Array.isArray(cfg.toolAllowlist)
    ? [...new Set(cfg.toolAllowlist.filter((s) => typeof s === 'string' && s))].slice(0, 200)
    : [];
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
