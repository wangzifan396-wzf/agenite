// Context window management.
//
// Why this exists: an agent run keeps appending tool results to `messages`,
// and tool results are the biggest things in a conversation (a grep over a
// repo, a fetched web page, an MCP browser snapshot). Left unmanaged, a long
// run dies with a provider 400 "context length exceeded" — and it dies late,
// right when the task was about to succeed. This module keeps the history
// inside the model's window by (1) shrinking old tool output, then (2) dropping
// the oldest turns and replacing them with a digest.
//
// Pure: no DOM, no fs, no network. `summarize` is injected so the caller can
// use a real model call, otherwise a mechanical digest is produced.

// --- token estimation -------------------------------------------------------

// A real tokenizer would need a 2 MB table per model family. This heuristic is
// deliberately slightly pessimistic (over-counts a little) so we compact a bit
// early rather than a bit late: CJK is ~1 token per character, Latin text is
// ~3.6 characters per token.
export function estimateTokens(text) {
  if (text == null) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  if (!s) return 0;
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      (c >= 0x2e80 && c <= 0x9fff) || // CJK radicals..unified ideographs
      (c >= 0xac00 && c <= 0xd7af) || // Hangul
      (c >= 0xf900 && c <= 0xfaff) || // CJK compatibility
      (c >= 0xff00 && c <= 0xffef) // full-width forms
    ) cjk++;
  }
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest / 3.6);
}

// Per-message overhead the APIs charge for role/name/delimiters.
const MSG_OVERHEAD = 4;

export function messageTokens(msg) {
  if (!msg) return 0;
  let n = MSG_OVERHEAD;
  n += estimateTokens(msg.content || '');
  if (msg.name) n += estimateTokens(msg.name);
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      n += 8;
      n += estimateTokens(tc.function ? tc.function.name : '');
      n += estimateTokens(tc.function ? tc.function.arguments : '');
    }
  }
  return n;
}

export function totalTokens(messages = []) {
  let n = 0;
  for (const m of messages) n += messageTokens(m);
  return n;
}

// Tool *definitions* also live in every request and are far from free —
// 14 built-ins plus a chatty MCP server can be several thousand tokens.
export function toolsTokens(tools = []) {
  let n = 0;
  for (const t of tools) {
    n += 12 + estimateTokens(t.name) + estimateTokens(t.description) + estimateTokens(t.parameters || {});
  }
  return n;
}

// --- model context windows --------------------------------------------------

// Matched in order, first hit wins. Conservative values on purpose: being
// wrong low costs one extra compaction, being wrong high costs a failed run.
export const MODEL_CONTEXT_RULES = [
  [/gpt-4o|gpt-4\.1|gpt-4-turbo|o1|o3|o4/i, 128000],
  [/gpt-3\.5/i, 16385],
  [/claude-3-5|claude-3-7|claude-sonnet|claude-opus|claude-haiku|claude-4/i, 200000],
  [/claude-3/i, 200000],
  [/deepseek-reasoner/i, 65536],
  [/deepseek/i, 65536],
  [/moonshot-v1-128k|kimi-k2|kimi-latest/i, 128000],
  [/moonshot-v1-32k/i, 32768],
  [/moonshot-v1-8k/i, 8192],
  [/qwen-long/i, 1000000],
  [/qwen-max|qwen-plus|qwen2\.5|qwen3/i, 131072],
  [/qwen-turbo/i, 131072],
  [/glm-4\.5|glm-4-plus|glm-4-long/i, 128000],
  [/glm-4/i, 128000],
  [/llama-3\.[123]|llama3/i, 131072],
  [/mixtral|mistral/i, 32768],
  [/gemini/i, 1000000],
  [/gemma/i, 8192]
];

export const DEFAULT_CONTEXT_WINDOW = 32000;

export function contextWindowFor(model, fallback = DEFAULT_CONTEXT_WINDOW) {
  const m = String(model || '');
  for (const [re, ctx] of MODEL_CONTEXT_RULES) if (re.test(m)) return ctx;
  return fallback;
}

// How many tokens the history may occupy: the window minus room for the reply
// minus a safety margin (our estimate is approximate, and providers count
// system scaffolding we cannot see).
export function historyBudget({ contextWindow, maxTokens = 2048, toolTokens = 0, safety = 0.9 }) {
  const win = Number(contextWindow) > 0 ? Number(contextWindow) : DEFAULT_CONTEXT_WINDOW;
  const reserve = Math.max(512, Number(maxTokens) || 0) + toolTokens;
  return Math.max(2000, Math.floor(win * safety) - reserve);
}

// --- grouping ---------------------------------------------------------------

// A group is an atomic unit that must be kept or dropped as a whole. An
// assistant message with tool_calls and the tool results answering it are one
// group — splitting them makes the provider reject the request ("tool message
// without preceding tool_calls" / "tool_calls without responses"). Leading
// system messages are their own pinned group.
export function groupMessages(messages = []) {
  const groups = [];
  let i = 0;
  const head = [];
  while (i < messages.length && messages[i] && messages[i].role === 'system') head.push(messages[i++]);
  if (head.length) groups.push({ pinned: true, items: head });
  while (i < messages.length) {
    const m = messages[i];
    const items = [m];
    i++;
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      while (i < messages.length && messages[i] && messages[i].role === 'tool') items.push(messages[i++]);
    } else {
      // A stray tool message (history edited by hand) rides along rather than
      // becoming an orphan group.
      while (i < messages.length && messages[i] && messages[i].role === 'tool') items.push(messages[i++]);
    }
    groups.push({ pinned: false, items });
  }
  return groups;
}

export function groupTokens(g) {
  return totalTokens(g.items);
}

// --- trimming ---------------------------------------------------------------

// Keep the head and the tail of a long tool result: the head usually has the
// shape of the answer, the tail usually has the conclusion / error.
export function trimText(text, max) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = Math.max(0, max - head - 40);
  return (
    s.slice(0, head) +
    `\n… [中间 ${s.length - head - tail} 字符已省略以节省上下文] …\n` +
    (tail ? s.slice(-tail) : '')
  );
}

// --- digest -----------------------------------------------------------------

const DIGEST_HEADER = '【早期对话摘要（为节省上下文已压缩，细节可能缺失）】';

export function mechanicalDigest(groups, { maxChars = 2400 } = {}) {
  const lines = [];
  for (const g of groups) {
    for (const m of g.items) {
      if (!m) continue;
      if (m.role === 'user') {
        lines.push('· 用户: ' + oneLine(m.content, 180));
      } else if (m.role === 'assistant') {
        if (m.content) lines.push('· 助手: ' + oneLine(m.content, 180));
        for (const tc of m.tool_calls || []) {
          const n = tc.function ? tc.function.name : '?';
          lines.push('  → 调用 ' + n + '(' + oneLine(tc.function ? tc.function.arguments : '', 90) + ')');
        }
      } else if (m.role === 'tool') {
        const bad = /^Error:/i.test(String(m.content || ''));
        lines.push('  ← ' + (m.name || 'tool') + (bad ? ' 失败: ' : ' 结果: ') + oneLine(m.content, 120));
      }
    }
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（摘要本身也已截断）';
  return DIGEST_HEADER + '\n' + text;
}

function oneLine(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// --- the main entry point ---------------------------------------------------

/**
 * Shrink `messages` to fit `budget` tokens, without ever breaking a
 * tool_calls/tool pair and without touching the most recent turns.
 *
 * @param {object[]} messages
 * @param {object}   opts
 * @param {number}   opts.budget            token ceiling for the whole history
 * @param {number}   opts.keepRecentGroups  never touch this many trailing groups
 * @param {number}   opts.toolTrimTo        max chars for an old tool result
 * @param {Function} opts.summarize         async (text) => string, optional
 * @returns {Promise<{messages, compacted, before, after, droppedGroups, trimmed, digest}>}
 */
export async function compactMessages(messages = [], opts = {}) {
  const budget = Math.max(1000, Number(opts.budget) || 12000);
  const keepRecentGroups = Math.max(1, Number(opts.keepRecentGroups) || 3);
  const toolTrimTo = Math.max(200, Number(opts.toolTrimTo) || 1200);
  const before = totalTokens(messages);
  const unchanged = {
    messages, compacted: false, before, after: before, droppedGroups: 0, trimmed: 0, digest: ''
  };
  if (before <= budget) return unchanged;

  let groups = groupMessages(messages);
  const pinned = groups.filter((g) => g.pinned);
  let body = groups.filter((g) => !g.pinned);
  if (!body.length) return unchanged;

  // --- phase 1: shrink tool output in everything but the recent tail --------
  let trimmed = 0;
  const protectedFrom = Math.max(0, body.length - keepRecentGroups);
  for (let i = 0; i < protectedFrom; i++) {
    for (const m of body[i].items) {
      if (m.role !== 'tool') continue;
      const c = String(m.content == null ? '' : m.content);
      if (c.length > toolTrimTo) {
        m.content = trimText(c, toolTrimTo);
        trimmed++;
      }
    }
  }

  let after = totalTokens(flatten(pinned.concat(body)));
  if (after <= budget) {
    return { messages: flatten(pinned.concat(body)), compacted: true, before, after, droppedGroups: 0, trimmed, digest: '' };
  }

  // --- phase 2: drop the oldest groups and replace them with a digest -------
  const dropped = [];
  while (body.length > keepRecentGroups && after > budget) {
    dropped.push(body.shift());
    after = totalTokens(flatten(pinned.concat(body)));
  }

  let digest = '';
  if (dropped.length) {
    if (typeof opts.summarize === 'function') {
      try {
        const s = await opts.summarize(mechanicalDigest(dropped, { maxChars: 8000 }));
        digest = s ? DIGEST_HEADER + '\n' + String(s).trim() : mechanicalDigest(dropped);
      } catch {
        digest = mechanicalDigest(dropped);
      }
    } else {
      digest = mechanicalDigest(dropped);
    }
  }

  const out = flatten(pinned.concat(body));
  if (digest) {
    // Attach the digest to the system message. Appending is the only placement
    // that is safe on both OpenAI-style and Anthropic-style APIs (Anthropic
    // hoists `system` out of the message list and rejects stray roles).
    const sys = out.find((m) => m && m.role === 'system');
    if (sys) sys.content = String(sys.content || '') + '\n\n' + digest;
    else out.unshift({ role: 'system', content: digest });
  }

  // Last resort: the protected tail alone still busts the budget (one huge
  // tool result). Trim it too rather than let the request fail outright.
  after = totalTokens(out);
  if (after > budget) {
    for (const m of out) {
      if (m.role !== 'tool' && m.role !== 'user') continue;
      const c = String(m.content == null ? '' : m.content);
      const hard = Math.max(400, toolTrimTo * 2);
      if (c.length > hard) { m.content = trimText(c, hard); trimmed++; }
    }
    after = totalTokens(out);
  }

  return { messages: out, compacted: true, before, after, droppedGroups: dropped.length, trimmed, digest };
}

function flatten(groups) {
  const out = [];
  for (const g of groups) for (const m of g.items) out.push(m);
  return out;
}
