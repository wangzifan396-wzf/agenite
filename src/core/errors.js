// Human-facing error diagnosis for the chat surface. Pure (no DOM), so it is
// unit-testable. The agent already classifies provider errors on the server
// (classifyProviderError in client.js); this layer turns an error *message*
// into a short, actionable "what to try next" hint for the user, matching the
// 2026 agent-UX pattern of a 3-part error surface: what / why / next.

// Order matters: earlier rules win. Keep hints short and concrete.
const RULES = [
  { re: /(incorrect api key|invalid api key|unauthorized|401|鉴权|未授权|api key.*(无效|错误|invalid))/i, hint: 'API Key 无效或过期。去「模型」设置重新填入，或点 ⚙ 测试连接。' },
  { re: /(403|forbidden|权限|不被允许|not allowed)/i, hint: '该密钥没有调用此模型的权限（可能被限额或禁用）。换密钥或联系供应商。' },
  { re: /(model_not_found|does not exist|404|模型不存在|找不到模型)/i, hint: '模型名不存在。去「模型」设置确认 model id 是否拼写正确。' },
  { re: /(429|rate.?limit|请求过于频繁|too many requests|限流)/i, hint: '请求过于频繁被限流。稍等几秒再试，或换一个不共享的密钥。' },
  { re: /(insufficient_quota|quota|余额|额度|额度不足)/i, hint: '账户余额不足或额度耗尽。去供应商后台充值后重试。' },
  { re: /(400|422|bad_request|参数错误|参数不合法)/i, hint: '请求参数有问题（很可能 model / baseURL 填错）。检查「模型」设置。' },
  { re: /(maximum context|context length|上下文|token.*(超限|超出)|exceeds.*limit)/i, hint: '超出模型上下文窗口。开启「自动压缩上下文」，或开始一个新对话。' },
  { re: /(timeout|超时|etimedout|abort|timed out)/i, hint: '连接超时。检查网络，并确认 baseURL 可达（本地模型需服务在运行）。' },
  { re: /(econnrefused|enotfound|failed to fetch|networkerror|无法连接|network)/i, hint: '无法连接到模型服务。确认服务在运行、baseURL 正确，且本机网络可达。' }
];

// Returns a short, actionable next-step hint for the given error text.
// Falls back to a generic but useful suggestion when nothing matches.
export function errorHint(message = '') {
  const text = String(message || '');
  for (const r of RULES) {
    if (r.re.test(text)) return r.hint;
  }
  return '已记入执行轨迹。可点「重试」让模型重跑这一步，或把上面的错误贴给模型看。';
}

// A one-word severity tag used for styling the error card.
export function errorSeverity(message = '') {
  const text = String(message || '');
  if (/(401|403|429|rate.?limit|quota|鉴权|权限|限流|余额)/i.test(text)) return 'auth';
  if (/(timeout|超时|econnrefused|enotfound|failed to fetch|network|无法连接)/i.test(text)) return 'net';
  if (/(model_not_found|404|模型不存在|does not exist)/i.test(text)) return 'model';
  return 'generic';
}
