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
    throw new Error(`OpenAI 接口错误 ${res.status}: ${txt.slice(0, 300)}`);
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
    throw new Error(`Anthropic 接口错误 ${res.status}: ${txt.slice(0, 300)}`);
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

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}
