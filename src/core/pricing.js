// Token accounting and cost estimation.
//
// You cannot manage what you cannot see: without this, a long agent run burns
// money silently. Prices are per 1,000,000 tokens and change often, so they are
// explicitly "estimates" and every number can be overridden in settings
// (config.priceIn / priceOut / priceCurrency).
//
// Pure: no DOM, no fs, no network.

// Matched in order, first hit wins.
// [pattern, inputPricePer1M, outputPricePer1M, currency]
export const PRICE_RULES = [
  // --- OpenAI (USD) ---
  [/^gpt-4o-mini/i, 0.15, 0.6, 'USD'],
  [/^gpt-4o/i, 2.5, 10, 'USD'],
  [/^gpt-4\.1-nano/i, 0.1, 0.4, 'USD'],
  [/^gpt-4\.1-mini/i, 0.4, 1.6, 'USD'],
  [/^gpt-4\.1/i, 2, 8, 'USD'],
  [/^gpt-4-turbo/i, 10, 30, 'USD'],
  [/^gpt-3\.5/i, 0.5, 1.5, 'USD'],
  [/^o4-mini|^o3-mini/i, 1.1, 4.4, 'USD'],
  [/^o3/i, 2, 8, 'USD'],
  // --- Anthropic (USD) ---
  [/haiku/i, 0.8, 4, 'USD'],
  [/opus/i, 15, 75, 'USD'],
  [/sonnet/i, 3, 15, 'USD'],
  // --- DeepSeek (CNY) ---
  [/^deepseek-reasoner/i, 4, 16, 'CNY'],
  [/^deepseek/i, 2, 8, 'CNY'],
  // --- Moonshot / Kimi (CNY) ---
  [/^moonshot-v1-128k/i, 60, 60, 'CNY'],
  [/^moonshot-v1-32k/i, 24, 24, 'CNY'],
  [/^moonshot-v1-8k|^kimi/i, 12, 12, 'CNY'],
  // --- Alibaba Qwen (CNY) ---
  [/^qwen-max/i, 2.4, 9.6, 'CNY'],
  [/^qwen-plus/i, 0.8, 2, 'CNY'],
  [/^qwen-turbo/i, 0.3, 0.6, 'CNY'],
  [/^qwen-long/i, 0.5, 2, 'CNY'],
  [/^qwen/i, 0.8, 2, 'CNY'],
  // --- Zhipu GLM (CNY) ---
  [/^glm-4-flash|^glm-4\.5-flash/i, 0, 0, 'CNY'],
  [/^glm-4-air/i, 0.5, 0.5, 'CNY'],
  [/^glm-4\.5/i, 2, 8, 'CNY'],
  [/^glm-4/i, 5, 5, 'CNY'],
  // --- Groq / open models (USD) ---
  [/llama-3\.1-8b|llama3.*8b/i, 0.05, 0.08, 'USD'],
  [/llama-3\.[13]-70b|llama3.*70b/i, 0.59, 0.79, 'USD'],
  [/mixtral/i, 0.24, 0.24, 'USD']
];

// Local models cost nothing to call.
export function isLocalProvider(config) {
  const url = String((config && config.baseURL) || '');
  return (
    (config && config.provider === 'ollama') ||
    /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(url)
  );
}

/**
 * Resolve the price for a model. Explicit config overrides always win, so a
 * user on a discounted/enterprise plan can enter their real numbers.
 * @returns {{in:number, out:number, currency:string, source:'config'|'table'|'unknown'|'local'}}
 */
export function priceFor(model, config = {}) {
  const hasOverride =
    Number.isFinite(Number(config.priceIn)) && Number.isFinite(Number(config.priceOut)) &&
    (Number(config.priceIn) > 0 || Number(config.priceOut) > 0);
  if (hasOverride) {
    return {
      in: Number(config.priceIn),
      out: Number(config.priceOut),
      currency: config.priceCurrency || 'CNY',
      source: 'config'
    };
  }
  if (isLocalProvider(config)) return { in: 0, out: 0, currency: 'CNY', source: 'local' };
  const m = String(model || '');
  for (const [re, pin, pout, cur] of PRICE_RULES) {
    if (re.test(m)) return { in: pin, out: pout, currency: cur, source: 'table' };
  }
  return { in: 0, out: 0, currency: 'CNY', source: 'unknown' };
}

/**
 * Normalize the many shapes of `usage` into { prompt, completion, total }.
 * OpenAI:    { prompt_tokens, completion_tokens, total_tokens }
 * Anthropic: { input_tokens, output_tokens }  (and cache_* variants)
 */
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return { prompt: 0, completion: 0, total: 0 };
  const cacheRead = num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
  const prompt = num(u.prompt_tokens) || num(u.input_tokens) + cacheRead || 0;
  const completion = num(u.completion_tokens) || num(u.output_tokens) || 0;
  const total = num(u.total_tokens) || prompt + completion;
  return { prompt, completion, total };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function emptyUsage() {
  return { prompt: 0, completion: 0, total: 0, calls: 0 };
}

// Fold one API response's usage into a running total (mutates `acc`).
export function addUsage(acc, usage) {
  const u = normalizeUsage(usage);
  acc.prompt += u.prompt;
  acc.completion += u.completion;
  acc.total += u.total;
  if (u.total > 0) acc.calls += 1;
  return acc;
}

/**
 * Cost of a usage total under a price.
 * @returns {{amount:number, currency:string, known:boolean}}
 */
export function costOf(usage, price) {
  const u = usage && usage.prompt != null ? usage : normalizeUsage(usage);
  const p = price || { in: 0, out: 0, currency: 'CNY', source: 'unknown' };
  const amount = (u.prompt * p.in + u.completion * p.out) / 1e6;
  return {
    amount,
    currency: p.currency || 'CNY',
    known: p.source === 'config' || p.source === 'table' || p.source === 'local'
  };
}

export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + 'k';
  return (v / 1000000).toFixed(2) + 'M';
}

export function formatCost(amount, currency) {
  const a = Number(amount) || 0;
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '¥';
  if (a === 0) return sym + '0';
  if (a < 0.01) return sym + a.toFixed(4);
  if (a < 1) return sym + a.toFixed(3);
  return sym + a.toFixed(2);
}
