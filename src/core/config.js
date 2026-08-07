// Configuration model + validation. Pure (no DOM, no fs).

// Curated provider catalog. Each entry carries a `models` list (popular model
// ids + their context window in tokens) so the UI can offer a one-click model
// picker instead of asking the user to memorize model ids. `ctx` is the model's
// context window in tokens (approximate, used for the picker badge + budget).
export const PROVIDER_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKeyPlaceholder: 'sk-...',
    defaultModel: 'gpt-4o-mini',
    protocol: 'openai',
    icon: '🟢',
    models: [
      { id: 'gpt-4o', ctx: 128000 },
      { id: 'gpt-4o-mini', ctx: 128000 },
      { id: 'gpt-4.1', ctx: 1000000 },
      { id: 'gpt-4.1-mini', ctx: 1000000 },
      { id: 'o3-mini', ctx: 200000 },
      { id: 'o4-mini', ctx: 200000 }
    ]
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyPlaceholder: 'sk-...',
    defaultModel: 'deepseek-chat',
    protocol: 'openai',
    icon: '🔵',
    models: [
      { id: 'deepseek-chat', ctx: 64000 },
      { id: 'deepseek-reasoner', ctx: 64000 }
    ]
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseURL: 'https://api.moonshot.cn/v1',
    apiKeyPlaceholder: 'sk-...',
    defaultModel: 'moonshot-v1-8k',
    protocol: 'openai',
    icon: '🌀',
    models: [
      { id: 'moonshot-v1-8k', ctx: 8000 },
      { id: 'moonshot-v1-32k', ctx: 32000 },
      { id: 'moonshot-v1-128k', ctx: 128000 }
    ]
  },
  {
    id: 'qwen',
    label: '通义千问 (Qwen)',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyPlaceholder: 'sk-...',
    defaultModel: 'qwen-plus',
    protocol: 'openai',
    icon: '🟣',
    models: [
      { id: 'qwen-plus', ctx: 32768 },
      { id: 'qwen-max', ctx: 32768 },
      { id: 'qwen-turbo', ctx: 1000000 },
      { id: 'qwen-long', ctx: 1000000 }
    ]
  },
  {
    id: 'zhipu',
    label: '智谱 (GLM)',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyPlaceholder: 'sk-...',
    defaultModel: 'glm-4-flash',
    protocol: 'openai',
    icon: '🟡',
    models: [
      { id: 'glm-4-flash', ctx: 128000 },
      { id: 'glm-4-air', ctx: 128000 },
      { id: 'glm-4-plus', ctx: 128000 },
      { id: 'glm-4-long', ctx: 1000000 }
    ]
  },
  {
    id: 'groq',
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyPlaceholder: 'gsk_...',
    defaultModel: 'llama-3.1-8b-instant',
    protocol: 'openai',
    icon: '⚡',
    models: [
      { id: 'llama-3.1-8b-instant', ctx: 8000 },
      { id: 'mixtral-8x7b-32768', ctx: 32768 },
      { id: 'qwen-2.5-32b', ctx: 32768 },
      { id: 'llama-3.3-70b-versatile', ctx: 128000 }
    ]
  },
  {
    id: 'ollama',
    label: 'Ollama (本地)',
    baseURL: 'http://localhost:11434/v1',
    apiKeyPlaceholder: 'ollama (可留空)',
    defaultModel: 'llama3.1',
    protocol: 'openai',
    icon: '🦙',
    models: [
      { id: 'llama3.1', ctx: 128000 },
      { id: 'qwen2.5', ctx: 32768 },
      { id: 'deepseek-r1', ctx: 64000 },
      { id: 'mistral', ctx: 32768 }
    ]
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyPlaceholder: 'sk-or-...',
    defaultModel: 'openai/gpt-4o-mini',
    protocol: 'openai',
    icon: '🔀',
    models: [
      { id: 'openai/gpt-4o', ctx: 128000 },
      { id: 'anthropic/claude-3.5-sonnet', ctx: 200000 },
      { id: 'google/gemini-2.0-pro', ctx: 1000000 },
      { id: 'deepseek/deepseek-r1', ctx: 64000 },
      { id: 'meta-llama/llama-3.1-70b-instruct', ctx: 131072 }
    ]
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    baseURL: 'https://api.anthropic.com',
    apiKeyPlaceholder: 'sk-ant-...',
    defaultModel: 'claude-3-5-sonnet-latest',
    protocol: 'anthropic',
    icon: '🟠',
    models: [
      { id: 'claude-3-5-sonnet-latest', ctx: 200000 },
      { id: 'claude-3-5-haiku-latest', ctx: 200000 },
      { id: 'claude-3-7-sonnet-latest', ctx: 200000 },
      { id: 'claude-3-opus-latest', ctx: 200000 }
    ]
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeyPlaceholder: 'AIza...',
    defaultModel: 'gemini-2.0-flash',
    protocol: 'openai',
    icon: '🔷',
    models: [
      { id: 'gemini-2.0-flash', ctx: 1000000 },
      { id: 'gemini-2.0-pro-exp-02-05', ctx: 1000000 },
      { id: 'gemini-1.5-pro', ctx: 1000000 },
      { id: 'gemini-2.5-pro-preview-03-25', ctx: 1000000 }
    ]
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow (硅基流动)',
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKeyPlaceholder: 'sk-...',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    protocol: 'openai',
    icon: '💎',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', ctx: 64000 },
      { id: 'deepseek-ai/DeepSeek-R1', ctx: 64000 },
      { id: 'Qwen/Qwen2.5-72B-Instruct', ctx: 32768 },
      { id: 'meta-llama/Llama-3.3-70B-Instruct', ctx: 32768 },
      { id: 'THUDM/glm-4-9b-chat', ctx: 32768 }
    ]
  },
  {
    id: 'custom',
    label: '自定义 (OpenAI 兼容)',
    baseURL: '',
    apiKeyPlaceholder: 'your-api-key',
    defaultModel: '',
    protocol: 'openai',
    icon: '⚙️',
    models: []
  }
];

// Models for one provider's picker (empty list => free-text entry).
export function modelsForProvider(id) {
  const p = PROVIDER_PRESETS.find((x) => x.id === id);
  return p && Array.isArray(p.models) ? p.models : [];
}

// Every known model id, flattened, for a global <datalist> autocomplete.
export const ALL_MODELS = PROVIDER_PRESETS.flatMap((p) =>
  (p.models || []).map((m) => ({ ...m, provider: p.id, providerLabel: p.label }))
);

// Short human label for a model id (used in chips / usage lines).
export function modelLabel(id) {
  if (!id) return '';
  const hit = ALL_MODELS.find((m) => m.id === id);
  return hit ? `${hit.providerLabel} · ${id}` : id;
}

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
    // Curated skill packs enabled from the 🧩 技能 gallery (names from
    // BUILTIN_SKILLS). Their methodology prompts are injected into the system
    // message so the agent follows them. Empty = none active.
    skills: [],
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
    syncSessions: true,
    // --- Atlas memory graph ---
    // Inject the local knowledge graph (nodes + typed edges) into the system
    // prompt so the agent "knows the map" and can reference known people /
    // projects / relations. On by default; cheap (bounded text, read-only).
    atlasInject: true,
    // Silently extract entities/relations from the last stretch of a finished
    // conversation into the graph (one extra model call per completion — like
    // autoSkill). Off by default; you can also build manually from the panel.
    atlasAutoBuild: false,
    // On app launch, if the memory graph has content, open the Atlas panel
    // automatically so the user lands on their living memory (the "second
    // brain" landing). On by default; turn off if the auto-modal annoys you.
    atlasAutoOpen: true,
    // --- local knowledge base (RAG) ---
    // When on, the agent retrieves the top-k chunks from your local KB and
    // injects them as grounded context before each run. Fully local (SQLite
    // FTS5), nothing leaves the machine.
    kbEnabled: false,
    kbTopK: 5,
    // --- conversational UX ---
    // After each assistant reply, ask the model for 3 short follow-up prompts
    // and render them as clickable chips ("suggested next steps"). A tiny extra
    // call per turn (cheap, skippable); turned off here for users who dislike
    // the suggestion or want zero added latency/cost.
    suggestFollowups: true
  };
}

// Merge user input over defaults, applying a provider preset when the
// provider id is recognized (so baseURL/protocol/model get sensible values).
export function normalizeConfig(input = {}) {
  const cfg = { ...defaultConfig(), ...input };
  const preset = PROVIDER_PRESETS.find((p) => p.id === cfg.provider);
  if (preset) {
    cfg.protocol = preset.protocol;
    // Only adopt the preset's baseURL/model when the caller didn't supply its
    // own — otherwise a fresh config keeps the deepseek default and switching
    // provider (Gemini, etc.) would silently keep the wrong endpoint.
    if ((input.baseURL == null || input.baseURL === '') && preset.baseURL) cfg.baseURL = preset.baseURL;
    if ((input.model == null || input.model === '') && preset.defaultModel) cfg.model = preset.defaultModel;
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
  cfg.skills = Array.isArray(cfg.skills)
    ? cfg.skills.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 24)
    : [];
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
  cfg.atlasInject = cfg.atlasInject !== false;
  cfg.atlasAutoBuild = !!cfg.atlasAutoBuild;
  cfg.atlasAutoOpen = cfg.atlasAutoOpen !== false;
  cfg.kbEnabled = !!cfg.kbEnabled;
  cfg.kbTopK = Math.round(clampNum(cfg.kbTopK, 1, 20, 5));
  cfg.suggestFollowups = cfg.suggestFollowups !== false;
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
