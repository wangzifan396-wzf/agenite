// Network layer: stream chat completions from OpenAI-compatible or Anthropic
// providers. Uses global fetch (Node 18+). The fetch implementation is
// injectable so the streaming logic can be unit-tested without real network.
import { toOpenAITools, toAnthropicTools, toAnthropicMessages, normalizeToolCalls, anthropicBlocksToMessage } from './provider.js';

// Parse one SSE line ("data: {...}"). Returns the parsed object or null.
export function parseSSELine(line) {
  const s = line.trim();
  if (!s.startsWith('data:')) return null;
  const payload = s.slice(5).trim();
  if (payload === '[DONE]') return { __done: true };
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export async function callOpenAIStream({ config, messages, tools = [], onDelta, signal, fetchImpl = globalThis.fetch }) {
  const body = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    top_p: config.topP,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (tools.length) {
    body.tools = toOpenAITools(tools);
    body.tool_choice = 'auto';
  }
  const res = await fetchImpl(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await safeText(res);
    const info = classifyProviderError(res.status, txt);
    throw new Error(info.message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  const toolAcc = {};
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      const obj = parseSSELine(raw);
      if (!obj || obj.__done) continue;
      const choice = obj.choices && obj.choices[0];
      if (!choice) {
        if (obj.usage) usage = obj.usage;
        continue;
      }
      const delta = choice.delta || {};
      if (delta.content) {
        content += delta.content;
        if (onDelta) onDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index != null ? tc.index : 0;
          const acc = toolAcc[idx] || { id: '', name: '', args: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function && tc.function.name) acc.name = tc.function.name;
          if (tc.function && tc.function.arguments) acc.args += tc.function.arguments;
          toolAcc[idx] = acc;
        }
      }
      if (obj.usage) usage = obj.usage;
    }
  }

  const rawToolCalls = Object.keys(toolAcc)
    .sort((a, b) => a - b)
    .map((k) => ({ id: toolAcc[k].id || toolAcc[k].name, type: 'function', function: { name: toolAcc[k].name, arguments: toolAcc[k].args } }));
  const toolCalls = normalizeToolCalls(rawToolCalls);
  return { content, toolCalls, usage };
}

export async function callAnthropicStream({ config, messages, tools = [], onDelta, signal, fetchImpl = globalThis.fetch }) {
  const { system, messages: antMessages } = toAnthropicMessages(messages);
  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    system: system || undefined,
    messages: antMessages,
    stream: true
  };
  if (tools.length) body.tools = toAnthropicTools(tools);
  const res = await fetchImpl(`${config.baseURL}/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await safeText(res);
    const info = classifyProviderError(res.status, txt);
    throw new Error(info.message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const blocks = [];
  let text = '';
  let currentTool = null;
  let usage = null;
  let stopReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      if (!raw.startsWith('event:') && !raw.startsWith('data:')) continue;
      let payload = raw;
      if (raw.startsWith('event:')) continue; // skip event name lines
      payload = raw.slice(5).trim();
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      switch (evt.type) {
        case 'content_block_start': {
          const b = evt.content_block;
          if (b.type === 'tool_use') {
            currentTool = { type: 'tool_use', id: b.id, name: b.name, input: '' };
            blocks.push(currentTool);
          }
          break;
        }
        case 'content_block_delta': {
          const d = evt.delta;
          if (d.type === 'text_delta') {
            text += d.text;
            if (onDelta) onDelta(d.text);
          } else if (d.type === 'input_json_delta' && currentTool) {
            currentTool.input += d.partial_json;
          }
          break;
        }
        case 'content_block_stop': {
          currentTool = null;
          break;
        }
        case 'message_delta': {
          if (evt.usage) usage = evt.usage;
          if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
          break;
        }
        default:
          break;
      }
    }
  }

  const msg = anthropicBlocksToMessage(blocks, stopReason);
  return { content: msg.content, toolCalls: msg.toolCalls, usage };
}

export function callModelStream({ config, messages, tools, onDelta, signal, fetchImpl }) {
  if (config.protocol === 'anthropic') {
    return callAnthropicStream({ config, messages, tools, onDelta, signal, fetchImpl });
  }
  return callOpenAIStream({ config, messages, tools, onDelta, signal, fetchImpl });
}

// Map a raw provider HTTP error to a friendly, actionable message. Shared by
// the streaming callers and the standalone key-verifier so the user always
// sees "密钥无效" / "额度不足" instead of "OpenAI 接口错误 401: {...}".
export function classifyProviderError(status, text = '') {
  const body = String(text).slice(0, 400).toLowerCase();
  if (status === 401) {
    return { errorClass: 'AUTH', message: 'API Key 无效或已过期，请检查后重试。' };
  }
  if (status === 403) {
    return { errorClass: 'AUTH', message: '密钥无权限访问该模型（可能被封禁或区域受限）。' };
  }
  if (status === 404) {
    return { errorClass: 'NOT_FOUND', message: '模型或接口地址不存在 —— 检查 Base URL 与模型名称。' };
  }
  if (status === 429) {
    return { errorClass: 'RATE_LIMIT', message: '请求过于频繁或额度已用完（429）。稍后再试或换个 Key。' };
  }
  if (status === 400 || status === 422) {
    // Surface the provider's own reason when present (e.g. "model not found").
    const m = String(text).match(/(?:error|message)\"?\s*[:=]\s*"?([^"{}]{4,120})/i);
    const detail = m ? m[1].trim() : '请求被拒绝（检查模型名称 / 参数）。';
    return { errorClass: 'BAD_REQUEST', message: '请求被拒绝：' + detail };
  }
  if (status >= 500) {
    return { errorClass: 'SERVER', message: '模型服务端错误（5xx），请稍后重试。' };
  }
  return { errorClass: 'UNKNOWN', message: `模型接口返回 ${status}：${String(text).slice(0, 200)}` };
}

// Actually validate a provider key/model by issuing a *minimal* (1-token,
// non-streaming) completion call. This is what "测试连接" should have done all
// along: a /health ping only proves the local server is up, not that the user's
// key works. Returns { ok, errorClass, message }. `fetchImpl` is injectable so
// it is unit-testable without real network. Ollama needs no key → treated ok.
export async function verifyKey(config, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  if (!config) return { ok: false, errorClass: 'BAD_REQUEST', message: '配置为空' };
  if (config.provider === 'ollama') {
    return { ok: true, errorClass: 'OK', message: '本地模型（Ollama）无需校验密钥。' };
  }
  if (!config.apiKey || !config.apiKey.trim()) {
    return { ok: false, errorClass: 'AUTH', message: '未填写 API Key。' };
  }
  if (!config.baseURL || !/^https?:\/\//.test(config.baseURL)) {
    return { ok: false, errorClass: 'BAD_REQUEST', message: 'Base URL 无效（需要以 http(s):// 开头）。' };
  }
  const headers = config.protocol === 'anthropic'
    ? { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` };
  const url = config.protocol === 'anthropic'
    ? `${config.baseURL}/messages`
    : `${config.baseURL}/chat/completions`;
  const body = config.protocol === 'anthropic'
    ? { model: config.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
    : { model: config.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'POST', signal: ctrl.signal, headers, body: JSON.stringify(body) });
    if (res.ok) return { ok: true, errorClass: 'OK', message: '密钥有效，模型可调用。' };
    const txt = await safeText(res);
    const info = classifyProviderError(res.status, txt);
    return { ok: false, errorClass: info.errorClass, message: info.message };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { ok: false, errorClass: 'TIMEOUT', message: '连接超时，请检查 Base URL / 网络 / 代理。' };
    }
    return { ok: false, errorClass: 'NETWORK', message: '无法连接服务端，请检查网络 / Base URL。' };
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}
