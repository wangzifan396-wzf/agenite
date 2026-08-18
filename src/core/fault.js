// src/core/fault.js
//
// 根因驱动的结构化自愈与重规划（Resilient Self-Healing v2, v0.68）
// ──────────────────────────────────────────────────────────────────────────
// 现有自愈（Loop Engineering, 2026）只往上下文里塞一条"自检提醒"，模型靠
// 自觉去修正；它既无"机器可消费"的故障根因分类，也不区分
//   · 瞬时故障 → 应退避重试（retry）
//   · 结构性故障 → 应换工具 / 重规划（replan）
//   · 语义故障   → 应重读当前状态并修正参数（reflect）
//   · 认证故障   → 只能升级给人（escalate）
//   · 预算/上下文 → 应触发压缩（compress）
// 这一层把"发生了什么错"变成"该怎么治"，让轨迹 / OTel / 健康检查都能消费
// 同一份结构化结论，而不是各写一套判断。模块保持纯函数 + 可注入，与
// stallguard.js / client.js 同范式，便于单测与注入。

// 根因分类枚举。保持与 FAULT_CATEGORIES 数组一致。
export const FAULT_CATEGORIES = [
  'transient',  // 瞬时 / 网络类，可退避重试
  'structural', // 结构性：目标或工具不可达 / 永久失败，需换做法或重规划
  'semantic',   // 语义：参数或理解有误，重读当前状态并修正参数
  'auth',       // 认证 / 权限：需人介入，无法自动恢复
  'budget',     // 上下文 / 预算超限：触发压缩
  'unknown'     // 无法归类：按通用自检兜底
];

// 严重度：dominantCategory 用它从一组故障里挑出"最该被优先响应"的主因。
// 数值越大越需要激进的治理动作（escalate > replan > compress > reflect > retry）。
const CATEGORY_SEVERITY = {
  auth: 6,
  structural: 5,
  unknown: 4,
  semantic: 3,
  budget: 2,
  transient: 1
};

// errorClass（来自 client.js / tools.js）到根因分类的映射。
// 工具层与模型层共用同一套 errorClass 语义，这里只做归一化。
const CLASS_TO_CATEGORY = {
  // ── 瞬时 / 可重试的基础设施抖动 ──
  TRANSIENT: 'transient',
  RATE_LIMIT: 'transient',
  TIMEOUT: 'transient',
  NETWORK: 'transient',
  SERVER: 'transient',
  // ── 结构性：目标/工具不可达或永久失败，需要换工具或重规划 ──
  PERMANENT: 'structural',
  NOT_FOUND: 'structural',
  EDIT_NO_MATCH: 'structural',
  BISECT_FAILED: 'structural',
  VERIFY_FAILED: 'structural',
  // ── 语义：参数/理解有误，可重读后修正 ──
  SCHEMA_ERROR: 'semantic',
  // ── 认证 / 权限：必须升级给人 ──
  AUTH: 'auth',
  PERMISSION_DENIED: 'auth'
};

// 各分类的机器/人可读提示，供 self_heal 事件与 UI 直接展示。
const HINTS = {
  transient: '瞬时/网络类故障，应退避后重试。',
  structural: '结构性故障：目标或工具不可达/永久失败，应换工具或重规划。',
  semantic: '语义故障：参数或理解有误，应重读当前状态并修正参数。',
  auth: '认证/权限故障：需用户检查 API Key 或开启权限，无法自动恢复。',
  budget: '上下文/预算超限：应触发压缩以回收空间。',
  unknown: '未知故障：无法自动归类，按通用自检兜底处理。'
};

// 没有 errorClass 时，从错误文本 / HTTP 状态码推断根因。
function inferFromText(text, status) {
  const t = String(text || '').toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'transient';
  if (status >= 500) return 'transient';
  if (status === 404) return 'structural';
  if (status === 400 || status === 422) return 'semantic';
  if (/api key|unauthorized|forbidden|鉴权|密钥无效|权限/.test(t)) return 'auth';
  if (/context length|maximum context|token limit|上下文.*超限|too long|exceed.*context/i.test(t)) return 'budget';
  if (/econnreset|econnrefused|etimedout|socket hang up|fetch failed|network|timeout|rate limit|429|5\d{2}|bad gateway|gateway timeout|timed out/i.test(t)) return 'transient';
  if (/schema|参数|缺少|不能为空|非法|无效|未找到|找不到|不匹配|无法解析|malformed|invalid|bad request/i.test(t)) return 'semantic';
  if (/denied|拒绝|越界|不在工作区|电脑操作权限/i.test(t)) return 'auth';
  return 'unknown';
}

// 把一次错误归一到根因分类。优先用显式 errorClass，否则从文本/状态推断。
// 返回结构化结论，供 decideSelfHeal 与任意观测面消费。
export function classifyError(err, opts = {}) {
  const errorClass =
    (opts && opts.errorClass) ||
    (err && err.errorClass) ||
    null;
  const status =
    opts && opts.status != null ? opts.status : (err && err.status != null ? err.status : null);
  const text =
    opts && opts.text != null
      ? opts.text
      : (err && (err.message || err.text)) || '';
  const name = opts && opts.name != null ? opts.name : (err && err.name) || '';

  let category;
  if (errorClass && CLASS_TO_CATEGORY[errorClass]) {
    category = CLASS_TO_CATEGORY[errorClass];
  } else {
    category = inferFromText(text, status);
  }

  const severity = CATEGORY_SEVERITY[category] != null ? CATEGORY_SEVERITY[category] : 4;
  return {
    category,
    retryable: category === 'transient',
    replan: category === 'structural',
    escalate: category === 'auth',
    severity,
    hint: HINTS[category] || HINTS.unknown,
    errorClass: errorClass || null,
    status: status != null ? Number(status) : null,
    name: String(name || ''),
    text: String(text).slice(0, 400)
  };
}

// 指数退避 + 抖动（与 client.js 的 backoff 思路一致，但做成纯函数便于测试）。
// attempt 从 0 起；rng 可注入以实现确定性单测。
export function backoffMs(attempt, { base = 400, cap = 30000, rng = Math.random } = {}) {
  const a = Math.max(0, Number(attempt) || 0);
  const raw = base * Math.pow(2, a); // 400, 800, 1600, ...
  const jitter = Math.floor(rng() * 300);
  return Math.min(cap, raw + jitter);
}

// 从一组分类里挑出严重度最高的主因（机器/多故障聚合时用）。
export function dominantCategory(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return 'unknown';
  let best = 'unknown';
  let bestSev = -1;
  for (const c of categories) {
    const sev = CATEGORY_SEVERITY[c] != null ? CATEGORY_SEVERITY[c] : 4;
    if (sev > bestSev) {
      bestSev = sev;
      best = c;
    }
  }
  return best;
}

// 根因驱动的自愈决策。输入一次回合的故障上下文，输出"该怎么做"。
// 返回 { action, message, backoffMs?, escalate?, replan?, retryable? }。
//   action:
//     'none'      —— 不处理（selfHeal 关闭或无故障）
//     'retry'     —— 退避后重试（瞬时）
//     'reflect'   —— 重读当前状态并修正参数（语义 / 首次结构失败）
//     'replan'    —— 换工具 / 重拆解目标（卡住循环）
//     'compress'  —— 触发上下文压缩（预算超限）
//     'escalate'  —— 升级给人，停止盲试（认证 / 超过反思上限）
// ctx.reflections 是当前已用反思次数（本决策前）；消息里的序号用 reflections+1，
// 调用方在推送消息后 selfHealAttempt++ / reflections++ 即可对齐。
export function decideSelfHeal(ctx = {}) {
  const {
    category = 'unknown',
    loopStreak = 0,
    failedMutation = 0,
    failedNames = [],
    reflections = 0,
    cap = 3,
    attempt = 0,
    maxAttempts = 3,
    selfHeal = true
  } = ctx;

  if (selfHeal === false) {
    return { action: 'none', message: '', escalate: false, replan: false, retryable: false };
  }

  const looping = loopStreak >= 2;
  const reachedCap = reflections >= cap;
  const names = Array.isArray(failedNames) ? failedNames.join('、') : '';

  // 认证 / 权限：永远升级给人，无法自动恢复。
  if (category === 'auth') {
    return {
      action: 'escalate',
      message: `🔴 认证 / 权限故障（${names || category}）：无法自动恢复，请检查 API Key 或开启权限后重试，或向用户说明卡点。`,
      escalate: true, replan: false, retryable: false
    };
  }

  // 预算 / 上下文：触发压缩回收空间。
  if (category === 'budget') {
    return {
      action: 'compress',
      message: `🧹 上下文 / 预算接近上限：已触发压缩回收空间，请在此后尽量精简输出与中间结果。`,
      escalate: false, replan: false, retryable: false
    };
  }

  // 瞬时：退避重试，受 maxAttempts 约束；耗尽则升级。
  if (category === 'transient') {
    if (attempt < maxAttempts - 1) {
      const ms = backoffMs(attempt);
      return {
        action: 'retry',
        backoffMs: ms,
        message: `🔁 瞬时故障（${names || '请求'}）：第 ${attempt + 1}/${maxAttempts} 次退避重试（${ms}ms）。`,
        escalate: false, replan: false, retryable: true
      };
    }
    return {
      action: 'escalate',
      message: `🔴 瞬时故障已重试 ${maxAttempts} 次仍失败，疑似持续性服务问题，请向用户说明并建议稍后重试。`,
      escalate: true, replan: false, retryable: false
    };
  }

  // 结构性 / 语义：反思预算用尽 → 升级；卡住循环 → 重规划；否则先 reflect。
  if (reachedCap) {
    return {
      action: 'escalate',
      message: `🔴 已尝试 ${reflections}/${cap} 次仍失败，无法自动突破，请停止盲试并向用户说明卡点。`,
      escalate: true, replan: false, retryable: false
    };
  }
  if (looping) {
    return {
      action: 'replan',
      message: `⚠️ 自检（第 ${reflections + 1}/${cap} 次）：本回合工具调用与上几回合【完全相同】，说明当前思路已卡死。请立即重规划：重新拆解目标、换用不同工具或参数，或向用户澄清——不要重复相同调用。`,
      escalate: false, replan: true, retryable: false
    };
  }
  // 首次失败且未循环：按分类给针对性提示。
  const detail =
    category === 'structural'
      ? `结构性故障（${names || '工具调用'}）：目标或工具不可达 / 永久失败，请换一种做法或工具，而非原样重试。`
      : `语义故障（${names || '工具调用'}）：参数或理解可能有误，请重新读取相关文件确认【当前】内容，再核对参数后重试。`;
  return {
    action: 'reflect',
    message: `⚠️ 自检（第 ${reflections + 1}/${cap} 次）：${detail} 不要原样重复刚才失败的调用。`,
    escalate: false, replan: false, retryable: false
  };
}
