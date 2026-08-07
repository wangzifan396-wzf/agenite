// Provider protocol conversions. Pure (no network, no DOM).
// Canonical internal message shape (OpenAI-ish):
//   { role: 'system'|'user'|'assistant'|'tool', content, tool_calls?, tool_call_id?, name? }

export function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}

export function toAnthropicTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }));
}

// Split a browser `data:` URL into { mediaType, data } so Anthropic's base64
// image source can be built. OpenAI takes the whole data URL as-is.
export function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)(?:;[^,]*)*?,([\s\S]*)$/.exec(dataUrl || '');
  if (!m) return { mediaType: 'image/png', data: '' };
  return { mediaType: m[1] || 'image/png', data: m[2] };
}

// Convert internal messages to OpenAI's chat shape. A user message that carries
// `images` (array of data URLs) is expanded into a content array of {type:text}
// + {type:image_url} parts so vision-capable models can actually see the picture.
// Messages without images keep their plain-string `content` — existing behaviour
// for every non-multimodal turn is untouched.
export function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const url of m.images) content.push({ type: 'image_url', image_url: { url } });
      return { role: 'user', content };
    }
    return m;
  });
}

// Normalize raw OpenAI tool_calls (arguments may be a JSON string) into
// { id, name, args } where args is always an object.
export function normalizeToolCalls(rawToolCalls) {
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls.map((tc) => {
    let args = {};
    const fn = tc.function || {};
    if (typeof fn.arguments === 'string') {
      try {
        args = JSON.parse(fn.arguments || '{}');
      } catch {
        args = { _raw: fn.arguments };
      }
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      args = fn.arguments;
    }
    return { id: tc.id || fn.name, name: fn.name, args };
  });
}

// Convert internal messages to Anthropic's shape. Returns { system, messages }.
export function toAnthropicMessages(messages) {
  let system = '';
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n' : '') + (m.content || '');
      continue;
    }
    if (m.role === 'tool') {
      // attach as tool_result under a user message
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: m.content || ''
      };
      if (out.length && out[out.length - 1].role === 'user') {
        out[out.length - 1].content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          let input = {};
          if (typeof fn.arguments === 'string') {
            try { input = JSON.parse(fn.arguments || '{}'); } catch { input = {}; }
          } else if (fn.arguments) input = fn.arguments;
          content.push({ type: 'tool_use', id: tc.id, name: fn.name, input });
        }
      }
      out.push({ role: 'assistant', content });
      continue;
    }
    // user (optionally with attached images)
    const content = [{ type: 'text', text: m.content || '' }];
    if (Array.isArray(m.images) && m.images.length) {
      for (const url of m.images) {
        const { mediaType, data } = parseDataUrl(url);
        content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
      }
    }
    out.push({ role: 'user', content });
  }
  return { system, messages: out };
}

// Convert Anthropic streamed tool_use blocks + text into internal assistant msg.
export function anthropicBlocksToMessage(contentBlocks, stopReason) {
  let text = '';
  const toolCalls = [];
  for (const b of contentBlocks) {
    if (b.type === 'text') text += b.text;
    else if (b.type === 'tool_use') {
      let args = {};
      if (typeof b.input === 'string') {
        try { args = JSON.parse(b.input || '{}'); } catch { args = { _raw: b.input }; }
      } else if (b.input && typeof b.input === 'object') {
        args = b.input;
      }
      toolCalls.push({ id: b.id, name: b.name, args });
    }
  }
  return {
    content: text,
    toolCalls: stopReason === 'tool_use' ? toolCalls : [],
    stopReason
  };
}
