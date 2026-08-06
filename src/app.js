// Agenite browser controller: settings, streaming chat with tool visualization
// and human-in-the-loop approvals, multi-conversation management, theme.
// Talks to the local server, which is the part that can actually touch the machine.
import { renderMarkdown } from './core/markdown.js';
import { uid, escapeHtml, fuzzyFilter, formatBytes } from './core/util.js';
import { defaultConfig, PROVIDER_PRESETS, APPROVAL_MODES, modelsForProvider, modelLabel } from './core/config.js';
import { errorHint, errorSeverity } from './core/errors.js';
import { listSnippets, addSnippet, removeSnippet, insertSnippetInto } from './core/snippets.js';

const $ = (id) => document.getElementById(id);
const LS = {
  config: 'agenite:config',
  convs: 'agenite:conversations',
  cur: 'agenite:current',
  theme: 'agenite:theme',
  mcp: 'agenite:mcp'
};

const STARTERS = [
  { title: '看看这台电脑', text: '用 system_info 看看我这台电脑的配置，然后一句话点评。' },
  { title: '整理当前目录', text: '列出工作区里的文件，告诉我这个项目大概是做什么的。' },
  { title: '写个小脚本', text: '在工作区新建 hello.js，打印当前时间，然后运行它把输出给我。' },
  { title: '联网查资料', text: '抓取 https://news.ycombinator.com 首页，挑 5 条最有意思的标题翻译成中文。' }
];

let config = loadConfig();
let conversations = loadConvs();
let currentId = localStorage.getItem(LS.cur) || (conversations[0] && conversations[0].id) || null;
let abortCtrl = null;
let sessionAutoApprove = false;
let workspacePath = '';
let workspaceFiles = [];   // [{ path, size }] from /api/files
let refs = [];             // files the user attached with "@" for the next message
// Live numbers for the top-right chip: how full the context is and what the
// conversation has cost so far. Reset whenever you switch conversations.
let ctxState = { used: 0, budget: 0, window: 0 };

// Slash commands available from the composer.
const COMMANDS = [
  { name: '/new', hint: '开一个新对话', run: () => newConv() },
  { name: '/clear', hint: '清空当前对话的消息', run: () => clearCurrent() },
  { name: '/rename', hint: '重命名当前对话', run: () => renameCurrent() },
  { name: '/export', hint: '把当前对话导出为 Markdown', run: () => exportCurrentMarkdown() },
  { name: '/model', hint: '打开模型设置', run: () => openSettings('model') },
  { name: '/workspace', hint: '查看 / 修改工作区与权限', run: () => openSettings('power') },
  { name: '/help', hint: '显示快捷键速查', run: () => openKeys() }
];

function loadConfig() {
  try { return { ...defaultConfig(), ...JSON.parse(localStorage.getItem(LS.config) || '{}') }; }
  catch { return defaultConfig(); }
}
function saveConfig() { localStorage.setItem(LS.config, JSON.stringify(config)); }

// ---------- MCP server config (client-side registry) ----------
function getMcpServers() {
  try { return JSON.parse(localStorage.getItem(LS.mcp) || '[]'); }
  catch { return []; }
}
function saveMcpServers(list) {
  localStorage.setItem(LS.mcp, JSON.stringify(list));
}
// Popular, copy-paste-free presets so connecting real tool servers is one click.
const MCP_PRESETS = {
  playwright: { id: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {}, enabled: true },
  computer: { id: 'computer', command: 'npx', args: ['-y', 'windows-computer-use-mcp'], env: {}, enabled: true },
  screenhand: { id: 'screenhand', command: 'npx', args: ['-y', 'screenhand'], env: {}, enabled: true }
};
function upsertMcpServer(srv) {
  const list = getMcpServers();
  const i = list.findIndex((s) => s.id === srv.id);
  if (i >= 0) list[i] = { ...list[i], ...srv };
  else list.push(srv);
  saveMcpServers(list);
  return list;
}
function loadConvs() { try { return JSON.parse(localStorage.getItem(LS.convs) || '[]'); } catch { return []; } }
function saveConvs() {
  try {
    localStorage.setItem(LS.convs, JSON.stringify(conversations));
  } catch (e) {
    // Quota exceeded: a few long agent runs with big tool outputs fill the 5MB
    // localStorage budget, and every later save fails silently. Warn once.
    if (!saveConvs._warned) { saveConvs._warned = true; toast('浏览器存储已满，旧对话可能无法保存，请导出后清理'); }
  }
  scheduleSessionSync();
}
function currentConv() { return conversations.find((c) => c.id === currentId) || null; }

// ---------- server-side session mirror ----------
// localStorage is per-browser and one "clear site data" away from oblivion.
// Mirror the active conversation into ~/.agenite/sessions so it survives.
let syncTimer = null;
function scheduleSessionSync() {
  if (config.syncSessions === false) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const c = currentConv();
    if (!c || !c.messages.length) return;
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conv: c })
    }).catch(() => { /* offline server is not worth a toast on every keystroke */ });
  }, 1500);
}

// Pull conversations back from disk. Used on first run in a fresh browser and
// from the "从本机恢复" button.
async function restoreSessions({ silent = false } = {}) {
  try {
    const r = await fetch('/api/sessions');
    const j = await r.json();
    const list = (j && j.sessions) || [];
    const have = new Set(conversations.map((c) => c.id));
    const missing = list.filter((s) => !have.has(s.id));
    if (!missing.length) {
      if (!silent) toast('本机没有更多可恢复的会话');
      return 0;
    }
    const loaded = [];
    for (const s of missing.slice(0, 100)) {
      try {
        const rr = await fetch('/api/sessions/' + encodeURIComponent(s.id));
        const jj = await rr.json();
        if (jj && jj.conv && Array.isArray(jj.conv.messages)) loaded.push(jj.conv);
      } catch { /* skip */ }
    }
    if (!loaded.length) return 0;
    conversations = [...conversations, ...loaded].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    localStorage.setItem(LS.convs, JSON.stringify(conversations));
    renderConvList();
    if (!silent) toast('已从本机恢复 ' + loaded.length + ' 个会话');
    return loaded.length;
  } catch {
    if (!silent) toast('无法读取本机会话（本地服务未运行？）');
    return 0;
  }
}

function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

// ---------- theme ----------
const SUN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';

function getInitialTheme() {
  const t = localStorage.getItem(LS.theme);
  if (t) return t;
  // Agenite Atlas ships with a studio dark look as the signature default.
  return 'dark';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('theme-toggle').innerHTML = theme === 'dark' ? SUN : MOON;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#191816' : '#faf9f7');
  localStorage.setItem(LS.theme, theme);
}
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}

// ---------- conversations ----------
function newConv() {
  const c = { id: uid('conv'), title: '新对话', messages: [], createdAt: Date.now(), updatedAt: Date.now(), usage: emptyUsage() };
  conversations.unshift(c);
  currentId = c.id;
  localStorage.setItem(LS.cur, currentId);
  ctxState = { used: 0, budget: 0, window: 0 };
  saveConvs();
  renderConvList();
  renderMessages();
  updateTitle();
  renderUsageChip();
  $('input').focus();
  return c;
}
function selectConv(id) {
  currentId = id;
  localStorage.setItem(LS.cur, currentId);
  ctxState = { used: 0, budget: 0, window: 0 };
  renderConvList();
  renderMessages();
  updateTitle();
  renderUsageChip();
  document.body.classList.remove('side-open');
}
function deleteConv(id) {
  conversations = conversations.filter((c) => c.id !== id);
  if (currentId === id) currentId = conversations[0] ? conversations[0].id : null;
  if (currentId) localStorage.setItem(LS.cur, currentId); else localStorage.removeItem(LS.cur);
  saveConvs();
  renderConvList();
  renderMessages();
  updateTitle();
}
let convQuery = '';

function renderConvList() {
  const el = $('conv-list');
  el.innerHTML = '';
  const q = convQuery.trim().toLowerCase();

  const match = (c) =>
    (c.title || '').toLowerCase().includes(q) ||
    (c.messages || []).some((m) => typeof m.content === 'string' && m.content.toLowerCase().includes(q));

  let pinned = conversations.filter((c) => c.pinned);
  let rest = conversations.filter((c) => !c.pinned);
  if (q) { pinned = pinned.filter(match); rest = rest.filter(match); }

  if (!pinned.length && !rest.length) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = q ? '没有匹配的对话' : '还没有对话';
    el.appendChild(empty);
    return;
  }

  if (pinned.length) {
    const lab = document.createElement('div');
    lab.className = 'conv-group';
    lab.textContent = '置顶';
    el.appendChild(lab);
    for (const c of pinned) el.appendChild(convItemEl(c));
  }
  for (const g of groupByTime(rest)) {
    const lab = document.createElement('div');
    lab.className = 'conv-group';
    lab.textContent = g.label;
    el.appendChild(lab);
    for (const c of g.items) el.appendChild(convItemEl(c));
  }
}

// Build one conversation row with a hover pin (★) and delete (✕) action.
function convItemEl(c) {
  const item = document.createElement('div');
  item.className = 'conv-item' + (c.id === currentId ? ' active' : '');
  const t = document.createElement('div');
  t.className = 'conv-title';
  t.textContent = c.title || '新对话';

  const actions = document.createElement('div');
  actions.className = 'conv-actions';

  const pin = document.createElement('button');
  pin.className = 'conv-pin' + (c.pinned ? ' on' : '');
  pin.title = c.pinned ? '取消置顶' : '置顶';
  pin.textContent = c.pinned ? '★' : '☆';
  pin.onclick = (e) => { e.stopPropagation(); togglePin(c.id); };

  const del = document.createElement('button');
  del.className = 'conv-del';
  del.title = '删除';
  del.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  del.onclick = (e) => { e.stopPropagation(); deleteConv(c.id); };

  actions.append(pin, del);
  item.append(t, actions);
  item.onclick = () => selectConv(c.id);
  return item;
}

// Bucket conversations by recency (updatedAt) while preserving order within
// each bucket. The conversations array is already newest-first.
function groupByTime(list) {
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yest0 = new Date(today0); yest0.setDate(today0.getDate() - 1);
  const weekAgo = new Date(today0); weekAgo.setDate(today0.getDate() - 7);
  const buckets = { 今天: [], 昨天: [], 本周: [], 更早: [] };
  for (const c of list) {
    const t = c.updatedAt || c.createdAt || 0;
    const d = new Date(t);
    if (d >= today0) buckets['今天'].push(c);
    else if (d >= yest0) buckets['昨天'].push(c);
    else if (d >= weekAgo) buckets['本周'].push(c);
    else buckets['更早'].push(c);
  }
  return Object.entries(buckets)
    .filter(([, items]) => items.length)
    .map(([label, items]) => ({ label, items }));
}

function togglePin(id) {
  const c = conversations.find((x) => x.id === id);
  if (!c) return;
  c.pinned = !c.pinned;
  saveConvs();
  renderConvList();
}
function updateTitle() {
  const c = currentConv();
  $('chat-title').textContent = (c && c.title) || '新对话';
}

// ---------- token usage & cost ----------
// The server does the counting (it is the one talking to the provider); the
// browser only accumulates and displays. Without this you have no idea what a
// long agent run actually costs until the bill arrives.
const CURRENCY_SIGN = { CNY: '¥', USD: '$', EUR: '€' };

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
  return String(v);
}
function fmtCost(amount, currency) {
  const v = Number(amount) || 0;
  const sign = CURRENCY_SIGN[currency] || '';
  if (v === 0) return sign + '0';
  if (v < 0.01) return sign + v.toFixed(4);
  return sign + v.toFixed(v < 1 ? 3 : 2);
}
// Field names mirror the server (src/core/pricing.js) exactly, so an event can
// be copied across without a translation layer that would silently drift.
function emptyUsage() {
  return { prompt: 0, completion: 0, total: 0, cost: 0, currency: 'CNY', known: false };
}
function convUsage(c) {
  if (!c) return emptyUsage();
  // Old conversations were stored before usage existed, or with the previous
  // field names — normalise instead of rendering NaN.
  if (!c.usage || c.usage.total == null) c.usage = emptyUsage();
  return c.usage;
}
// The server streams RUNNING TOTALS for the current request, so a usage event
// replaces the request tally rather than adding to it.
function setUsageFrom(target, data) {
  target.prompt = Number(data.prompt) || 0;
  target.completion = Number(data.completion) || 0;
  target.total = Number(data.total) || 0;
  if (data.cost) {
    target.cost = Number(data.cost.amount) || 0;
    target.currency = data.cost.currency || target.currency;
    target.known = !!data.cost.known;
  }
  return target;
}
// Conversation-level tally: add one finished request to the running total.
function addUsageTo(target, u) {
  target.prompt += Number(u.prompt) || 0;
  target.completion += Number(u.completion) || 0;
  target.total += Number(u.total) || 0;
  target.cost += Number(u.cost) || 0;
  if (u.currency) target.currency = u.currency;
  if (u.known) target.known = true;
  return target;
}

// Top-right chip: context fill ring + tokens + money.
function renderUsageChip() {
  const chip = $('usage-chip');
  if (!chip) return;
  const u = convUsage(currentConv());
  const hasUsage = u.total > 0;
  const hasCtx = ctxState.used > 0 && ctxState.budget > 0;
  if (!hasUsage && !hasCtx) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  const pct = hasCtx ? Math.min(100, Math.round((ctxState.used / ctxState.budget) * 100)) : 0;
  const ring = $('ctx-ring');
  if (ring) {
    ring.style.setProperty('--pct', pct + '%');
    ring.classList.toggle('warn', pct >= 70 && pct < 90);
    ring.classList.toggle('hot', pct >= 90);
  }
  const money = u.known ? ' · ' + fmtCost(u.cost, u.currency) : '';
  $('usage-text').textContent = fmtTokens(u.total) + money;
  chip.title =
    `上下文 ${fmtTokens(ctxState.used)} / ${fmtTokens(ctxState.budget)}（${pct}%）\n` +
    `本对话累计：输入 ${fmtTokens(u.prompt)} · 输出 ${fmtTokens(u.completion)}\n` +
    (u.known ? `预估花费 ${fmtCost(u.cost, u.currency)}（按价格表估算，仅供参考）` : '该模型未知单价，只统计 token');
}

// Small footer under an assistant reply: what this single answer consumed.
function renderMsgUsage(el, m) {
  if (!el || !m || !m.usage || !m.usage.total) return;
  let line = el.querySelector('.msg-usage');
  if (!line) {
    line = document.createElement('div');
    line.className = 'msg-usage';
    const bubble = el.querySelector('.bubble');
    (bubble || el).appendChild(line);
  }
  const u = m.usage;
  const parts = [`↑${fmtTokens(u.prompt)}`, `↓${fmtTokens(u.completion)}`];
  if (m.turns > 1) parts.push(`${m.turns} 轮`);
  if (u.known) parts.push(fmtCost(u.cost, u.currency));
  line.textContent = parts.join(' · ');
  line.title = `本次回答共消耗 ${fmtTokens(u.total)} tokens`;
}

// ---------- rendering ----------
const THINKING = '<span class="thinking"><i></i><i></i><i></i></span>';

// A zero-dependency, XSS-safe highlighter. It re-escapes already-escaped text
// and wraps tokens in spans we control, so user content can never inject markup.
const HL_KEYWORDS = new Set((
  'const let var function return if else for while do switch case break continue new class extends super this ' +
  'import export from default async await yield try catch finally throw typeof instanceof in of delete void ' +
  'true false null undefined ' +
  'def elif except raise with as pass lambda print None True False ' +
  'public private protected static final void int double string boolean then fi echo'
).split(/\s+/).filter(Boolean));

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightCode(raw, lang) {
  const l = (lang || '').toLowerCase();
  if (/^(?:html|xml|svg|css)$/i.test(l)) return escHtml(raw); // tags/selectors: keep plain
  const scriptLike = !/^(?:json|bash|sh|shell|sql|markdown|md|yaml|yml|toml|text|txt)$/i.test(l);
  const hashComment = /^(?:python|py|bash|sh|shell|ruby|rb|yaml|yml|toml)$/i.test(l);
  const re = new RegExp(
    '(/\\*[\\s\\S]*?\\*/)' +
    (scriptLike ? '|((?://)[^\\n]*?)' : '') +
    (hashComment ? '|(#[^\\n]*?)' : '') +
    '|("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)' +
    '|(\\b\\d[\\d_]*\\.?\\d*(?:[eE][+-]?\\d+)?\\b)' +
    '|([A-Za-z_$][\\w$]*)' +
    '|(\\s+)' +
    '|([\\s\\S])',
    'g'
  );
  let out = '';
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[1]) out += '<span class="tok-com">' + escHtml(m[1]) + '</span>';
    else if (m[2]) out += '<span class="tok-com">' + escHtml(m[2]) + '</span>';
    else if (m[3]) out += '<span class="tok-com">' + escHtml(m[3]) + '</span>';
    else if (m[4]) out += '<span class="tok-str">' + escHtml(m[4]) + '</span>';
    else if (m[5]) out += '<span class="tok-num">' + escHtml(m[5]) + '</span>';
    else if (m[6]) {
      const w = m[6];
      out += HL_KEYWORDS.has(w) ? '<span class="tok-kw">' + escHtml(w) + '</span>' : escHtml(w);
    } else if (m[7]) out += m[7];
    else out += escHtml(m[8]);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

function highlightRoot(root) {
  if (!root) return;
  root.querySelectorAll('pre.code-block:not([data-hl]) > code').forEach((code) => {
    const lang = code.parentElement.getAttribute('data-lang') || '';
    code.innerHTML = highlightCode(code.textContent, lang);
    code.parentElement.setAttribute('data-hl', '1');
  });
}

function paint(mdEl, src) {
  mdEl.innerHTML = renderMarkdown(src) || '';
  highlightRoot(mdEl);
}
function paintOrThinking(mdEl, src) {
  if (src && src.trim()) paint(mdEl, src);
  else mdEl.innerHTML = THINKING;
}
function paintFallback(mdEl, src, fallback) {
  const h = renderMarkdown(src);
  if (h) { mdEl.innerHTML = h; highlightRoot(mdEl); }
  else mdEl.innerHTML = fallback;
}

function renderMessages() {
  const box = $('messages');
  box.innerHTML = '';
  const c = currentConv();
  if (!c || c.messages.filter((m) => m.role !== 'system').length === 0) {
    box.appendChild(buildEmptyState());
    return;
  }
  c.messages.forEach((m, i) => {
    if (m.role === 'tool' || m.role === 'system') return;
    box.appendChild(buildMessageEl(m, i));
  });
  scrollBottom();
}

function buildEmptyState() {
  const wrap = document.createElement('div');
  wrap.className = 'welcome';
  const features = [
    { ico: '🔒', t: '本地优先', d: '数据不出本机，API Key 只经本地服务转发' },
    { ico: '🌐', t: '浏览器 Agent', d: '看得见、可干预的网页自动化' },
    { ico: '🧩', t: '36 个工具', d: '文件 / 命令 / 联网 / MCP 即插即用' },
    { ico: '🗺️', t: '记忆 + 计划', d: '长期记忆图谱，计划模式先审后做' }
  ];
  const feat = features.map((f) =>
    `<div class="welcome-feature"><div class="wf-ico">${f.ico}</div><div class="wf-t">${escapeHtml(f.t)}</div><div class="wf-d">${escapeHtml(f.d)}</div></div>`
  ).join('');
  const grid = STARTERS.map((s, i) =>
    `<button class="starter" data-i="${i}"><b>${escapeHtml(s.title)}</b><span>${escapeHtml(s.text)}</span></button>`
  ).join('');
  // First-run guidance: if no model key is configured, surface a one-click
  // setup CTA so a brand-new user lands on the provider/key form directly.
  const needsKey = (!config.apiKey || !config.apiKey.trim()) && config.provider !== 'ollama';
  const onboard = needsKey
    ? '<button id="onboard-setup" class="onboard-btn">⚙ 一键配置模型</button>' +
      '<p class="welcome-foot">还没配置模型密钥，点上面按钮填入 API Key 即可开始（密钥只存在本机浏览器）。</p>'
    : '';
  wrap.innerHTML =
    '<div class="welcome-glow" aria-hidden="true"></div>' +
    '<div class="welcome-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18.4 9l-4.6 1.8L12 15.4 10.2 10.8 5.6 9l4.6-1.4z"/><path d="M18 15l.9 2.3L21 18l-2.1.8L18 21l-.9-2.3L15 18l2.1-.7z"/></svg></div>' +
    '<h1 class="welcome-h">今天想让 Agenite 做点什么？</h1>' +
    '<p class="welcome-sub">运行在你自己电脑上的本地智能体 —— 能读写文件、执行命令、联网查资料，并把每一步都摊开给你看。</p>' +
    onboard +
    `<div class="welcome-features">${feat}</div>` +
    `<div class="starter-grid">${grid}</div>` +
    '<p class="welcome-foot">提示：按 <kbd>Ctrl</kbd>+<kbd>/</kbd> 看全部快捷键 · 点左侧「🌐 浏览器」看 Agent 正在操作的网页</p>';
  wrap.querySelectorAll('.starter').forEach((btn) => {
    btn.onclick = () => {
      const s = STARTERS[Number(btn.dataset.i)];
      $('input').value = s.text;
      autoGrow();
      $('input').focus();
    };
  });
  const ob = wrap.querySelector('#onboard-setup');
  if (ob) ob.onclick = () => openSettings('model');
  return wrap;
}

const ICO_COPY = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICO_REDO = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/></svg>';
const ICO_EDIT = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

function actionBtn(cls, icon, label, idx) {
  return `<button class="msg-act ${cls}" data-idx="${idx}" title="${label}" aria-label="${label}">${icon}<span>${label}</span></button>`;
}

function buildMessageEl(m, index) {
  const el = document.createElement('div');
  if (m.role === 'user') {
    el.className = 'msg user';
    el.innerHTML = '<div class="avatar">你</div><div class="bubble"></div>';
    el.querySelector('.bubble').textContent = m.display || m.content || '';
    if (Array.isArray(m.refs) && m.refs.length) {
      const tags = document.createElement('div');
      tags.className = 'msg-refs';
      tags.innerHTML = m.refs.map((p) => `<span class="ref-chip sm">${escapeHtml(p)}</span>`).join('');
      el.querySelector('.bubble').appendChild(tags);
    }
    if (typeof index === 'number') {
      const acts = document.createElement('div');
      acts.className = 'msg-acts';
      acts.innerHTML = actionBtn('act-copy', ICO_COPY, '复制', index) + actionBtn('act-edit', ICO_EDIT, '编辑', index);
      el.appendChild(acts);
    }
    return el;
  }
  el.className = 'msg assistant';
  if (typeof index === 'number') el.dataset.idx = index;
  el.innerHTML = '<div class="avatar">A</div><div class="bubble"><div class="notices"></div><div class="tools"></div><div class="md"></div></div>';
  el.querySelector('.md').innerHTML = renderMarkdown(m.content || '') || '';
  highlightRoot(el.querySelector('.md'));
  if (Array.isArray(m.toolCalls)) for (const t of m.toolCalls) upsertToolCard(el, t);
  if (Array.isArray(m.notices)) for (const n of m.notices) addNotice(el, n);
  if (m.selfCheck) renderSelfCheck(el, m.selfCheck);
  renderMsgUsage(el, m);
  if (m.canContinue) addContinueBar(el);
  if (m.error) renderErrorCard(el, m.error);
  if (Array.isArray(m.followups) && m.followups.length) renderFollowups(el, m.followups);
  if (typeof index === 'number') {
    const acts = document.createElement('div');
    acts.className = 'msg-acts';
    const c = currentConv();
    if (c && c.awaitingPlanApproval && c.planMsgIndex === index) {
      // Plan mode: let the human read AND edit the proposed plan before the
      // agent executes it. The plan text is reconstructed from the `plan` tool
      // call so the textarea starts with exactly what the model proposed.
      const planTool = (m.toolCalls || []).find((t) => t.name === 'plan');
      const steps = planTool && planTool.args && Array.isArray(planTool.args.steps) ? planTool.args.steps : [];
      const initial = steps.length
        ? steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
        : (planTool && planTool.args && planTool.args.text) || (m.content || '');
      acts.innerHTML = actionBtn('act-copy', ICO_COPY, '复制', index) +
        '<div class="plan-approve">' +
          '<div class="plan-edit-hint">可修改计划后再执行：</div>' +
          '<textarea class="plan-edit-area" rows="6" spellcheck="false">' + escapeHtml(initial) + '</textarea>' +
          '<div class="plan-approve-btns">' +
            '<button type="button" class="plan-approve-btn">✓ 批准并执行</button>' +
            '<button type="button" class="plan-reject-btn">✕ 拒绝</button>' +
          '</div>' +
        '</div>';
      const area = acts.querySelector('.plan-edit-area');
      acts.querySelector('.plan-approve-btn').onclick = () => approvePlanWith(area.value);
      acts.querySelector('.plan-reject-btn').onclick = () => rejectPlan();
    } else {
      acts.innerHTML = actionBtn('act-copy', ICO_COPY, '复制', index) + actionBtn('act-redo', ICO_REDO, '重新生成', index);
    }
    el.appendChild(acts);
  }
  return el;
}

// An inline, low-key strip inside a reply — used for "history was compacted"
// and similar events the user should know about but not be alarmed by.
function addNotice(el, n) {
  const box = el.querySelector('.notices');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'notice ' + (n.kind || 'info');
  div.innerHTML = `<span class="notice-ico">${n.kind === 'compact' ? '⛁' : 'ℹ'}</span><span></span>`;
  div.lastElementChild.textContent = n.text;
  if (n.detail) div.title = n.detail;
  box.appendChild(div);
  return div;
}

// A structured error card: what went wrong + why/what to try + a one-click
// retry. Replaces the old flat "⚠️ message" so failures are actionable, not
// just visible — the #1 agent-UX pain point per 2026 research (what/why/next).
function renderErrorCard(el, message) {
  const bubble = el.querySelector('.bubble');
  if (!bubble) return null;
  let card = el.querySelector('.err-card');
  if (!card) {
    card = document.createElement('div');
    card.className = 'err-card sev-' + errorSeverity(message);
    card.innerHTML =
      '<div class="err-head"><span class="err-ico">⚠️</span><span>运行出错</span></div>' +
      '<div class="err-msg"></div>' +
      '<div class="err-why"></div>' +
      '<div class="err-actions">' +
      '<button class="mini-btn err-retry">↻ 重试</button>' +
      '<button class="mini-btn err-copy">复制错误</button>' +
      '</div>';
    bubble.appendChild(card);
  }
  card.querySelector('.err-msg').textContent = message;
  card.querySelector('.err-why').textContent = '建议：' + errorHint(message);
  return card;
}

// Clickable "suggested next steps" chips under an assistant reply. When
// `loading` is true it renders a placeholder while the suggestion call is in
// flight; an empty list removes the box entirely (no suggestions = nothing).
function renderFollowups(el, suggestions, loading) {
  let box = el.querySelector('.followups');
  if (!box) {
    box = document.createElement('div');
    box.className = 'followups';
    const bubble = el.querySelector('.bubble');
    if (bubble) bubble.appendChild(box);
  }
  if (loading) {
    box.innerHTML = '<span class="fu-loading">建议下一步…</span>';
    return box;
  }
  const list = Array.isArray(suggestions) ? suggestions.filter((s) => s && String(s).trim()) : [];
  if (!list.length) { box.remove(); return null; }
  box.innerHTML = list
    .map((s) => `<button class="fu-chip" title="点击发送这条追问">${escapeHtml(String(s))}</button>`)
    .join('');
  return box;
}

// Fire a cheap suggestion call after a completed (non-planning, non-errored,
// substantive) assistant turn. Best-effort: any failure silently removes the
// placeholder. Results are persisted on the message so they survive reload.
async function maybeSuggestFollowups(conv, aMsg, el) {
  if (config.suggestFollowups === false) return;
  if (!config.apiKey && config.provider !== 'ollama') return;
  const lastUserMsg = conv.messages.filter((m) => m.role === 'user').pop();
  const lastUser = (lastUserMsg && (lastUserMsg.display || lastUserMsg.content)) || '';
  renderFollowups(el, null, true);
  try {
    const r = await fetch('/api/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, lastUser, lastAssistant: aMsg.content || '' })
    });
    const j = await r.json().catch(() => ({ suggestions: [] }));
    const sugs = Array.isArray(j.suggestions) ? j.suggestions : [];
    if (sugs.length) {
      aMsg.followups = sugs;
      conv.updatedAt = Date.now();
      saveConvs();
    }
    renderFollowups(el, sugs);
  } catch {
    const box = el.querySelector('.followups');
    if (box) box.remove();
  }
}

// A graded self-check report card appended to an assistant reply. Built from
// the server's diagnoseTrace payload (ok / warn / bad). Persisted on the
// message as `selfCheck` so it re-renders when the conversation is rebuilt.
function renderSelfCheck(el, d) {
  const bubble = el.querySelector('.bubble');
  if (!bubble) return;
  let card = el.querySelector('.selfcheck');
  if (!card) {
    card = document.createElement('div');
    card.className = 'selfcheck';
    bubble.appendChild(card);
  }
  const sev = (d && d.severity) || 'ok';
  const SEV = {
    ok: { cls: 'sev-ok', ico: '✓', label: '运行正常' },
    warn: { cls: 'sev-warn', ico: '⚠', label: '需要关注' },
    bad: { cls: 'sev-bad', ico: '✕', label: '发现问题' }
  }[sev] || { cls: 'sev-ok', ico: '✓', label: '运行正常' };

  const cost = (d && typeof d.cost === 'number') ? d.cost : 0;
  const mins = d && d.durationMs ? Math.max(1, Math.round(d.durationMs / 1000)) : 0;
  const metrics = [
    `工具调用 ${d.tools || 0}`,
    `子智能体 ${d.subagents || 0}`,
    `失败 ${d.errors || 0}`,
    `花费 $${cost.toFixed(4)}`,
    `轮次 ${d.turns || 0}`,
    mins ? `${mins}s` : ''
  ].filter(Boolean).join(' · ');

  let html = `<div class="sc-head ${SEV.cls}"><span class="sc-ico">${SEV.ico}</span>` +
    `<span class="sc-title">运行自检 · ${SEV.label}</span></div>` +
    `<div class="sc-metrics">${escapeHtml(metrics)}</div>`;

  const findings = (d && d.findings) || [];
  if (findings.length) {
    html += '<div class="sc-findings">';
    for (const f of findings) {
      const fi = f.level === 'bad' ? '✕' : '⚠';
      html += `<div class="sc-find ${f.level === 'bad' ? 'fb' : 'fw'}"><span class="scf-ico">${fi}</span>` +
        `<div><div class="scf-title">${escapeHtml(f.title)}</div>` +
        (f.detail ? `<div class="scf-detail">${escapeHtml(f.detail)}</div>` : '') + '</div></div>';
    }
    html += '</div>';
  } else {
    html += '<div class="sc-ok-note">未检测到空转、高频失败或超预算等异常，本次运行健康。</div>';
  }

  card.className = 'selfcheck ' + SEV.cls;
  card.innerHTML = html;
  return card;
}

// Shown when the agent stopped only because it hit the turn ceiling. Without
// this the run just ends mid-task and looks like the model gave up.
function addContinueBar(el) {
  const bubble = el.querySelector('.bubble');
  if (!bubble || bubble.querySelector('.continue-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'continue-bar';
  bar.innerHTML =
    '<span>已达到本次最大轮次，任务可能还没做完。</span>' +
    '<button class="continue-btn" type="button">▶ 继续执行</button>';
  bubble.appendChild(bar);
}

const TOOL_ICONS = {
  calculator: '𝑓', current_datetime: '◷', system_info: '▣', web_fetch: '⇩',
  read_file: '≡', list_dir: '▤', find_files: '⌕', write_file: '✎',
  edit_file: '✎', make_dir: '▢', run_command: '❯', open_path: '↗'
};

function peekArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const key = ['path', 'command', 'url', 'expression', 'pattern', 'target'].find((k) => args[k]);
  const val = key ? String(args[key]) : Object.values(args).map(String)[0] || '';
  return val.length > 60 ? val.slice(0, 60) + '…' : val;
}

// Create the card on tool_start, fill it in on tool completion.
// Render the streaming steps of a delegated sub-agent as a collapsible card.
// The server sends one `subagent` SSE per child event, tagged with `subId`.
function handleSubAgentEvent(el, data) {
  const holder = el.querySelector('.tools');
  if (!holder) return;
  if (!el._subAgents) el._subAgents = {};
  let card = el._subAgents[data.subId];
  if (!card) {
    card = document.createElement('div');
    card.className = 'subagent-card';
    card.innerHTML =
      '<div class="sa-head">' +
      '<span class="sa-caret">▸</span>' +
      '<span class="sa-name"></span>' +
      '<span class="sa-status">运行中…</span>' +
      '</div><div class="sa-body"></div>';
    card.querySelector('.sa-name').textContent = data.name || '子代理';
    card.querySelector('.sa-head').addEventListener('click', () => {
      const open = card.classList.toggle('open');
      card.querySelector('.sa-caret').textContent = open ? '▾' : '▸';
    });
    holder.appendChild(card);
    el._subAgents[data.subId] = card;
  }
  const body = card.querySelector('.sa-body');
  const status = card.querySelector('.sa-status');
  const ev = data.event;
  if (ev === 'tool_start') {
    const chip = document.createElement('div');
    chip.className = 'sa-tool running';
    chip.dataset.tid = String(data.id);
    chip.innerHTML = '<span class="sa-tool-name"></span>';
    chip.querySelector('.sa-tool-name').textContent = '⏳ ' + (data.name || 'tool');
    body.appendChild(chip);
  } else if (ev === 'tool') {
    const chip = [...body.querySelectorAll('.sa-tool')].find((c) => c.dataset.tid === String(data.id));
    if (chip) {
      chip.classList.remove('running');
      chip.classList.add(data.ok ? 'ok' : 'fail');
      chip.querySelector('.sa-tool-name').textContent = (data.ok ? '✓ ' : '✗ ') + (data.name || 'tool');
    }
  } else if (ev === 'delta') {
    let txt = body.querySelector('.sa-text');
    if (!txt) { txt = document.createElement('div'); txt.className = 'sa-text'; body.appendChild(txt); }
    txt.textContent += (data.content || '');
  } else if (ev === 'done') {
    status.textContent = `完成 · ${data.turns || '?'} 步`;
    card.classList.add('open');
    card.querySelector('.sa-caret').textContent = '▾';
  }
}

function upsertToolCard(el, t) {
  const holder = el.querySelector('.tools');
  let card = holder.querySelector(`[data-tid="${CSS.escape(String(t.id))}"]`);
  const running = t.ok === undefined;
  const isMcp = typeof t.name === 'string' && t.name.startsWith('mcp__');
  if (!card) {
    card = document.createElement('div');
    card.className = 'tool-card' + (isMcp ? ' mcp' : '');
    card.dataset.tid = String(t.id);
    const badge = isMcp ? '<span class="mcp-badge">MCP</span>' : '';
    card.innerHTML =
      '<div class="tool-head">' +
      `<span class="tool-ico">${isMcp ? '🔌' : escapeHtml(TOOL_ICONS[t.name] || '⚙')}</span>` +
      `<span class="tname">${escapeHtml(t.name)}</span>${badge}` +
      '<span class="targs-peek"></span><span class="tstatus"></span><span class="tcaret">▶</span>' +
      '</div>' +
      '<div class="tool-body"><div><b>参数</b><pre class="t-args"></pre></div><div><b>结果</b><pre class="t-res"></pre></div></div>';
    card.querySelector('.tool-head').onclick = () => card.classList.toggle('open');
    holder.appendChild(card);
  }
  card.querySelector('.targs-peek').textContent = peekArgs(t.args);
  card.querySelector('.t-args').textContent = JSON.stringify(t.args || {}, null, 2);
  const status = card.querySelector('.tstatus');
  if (running) {
    status.className = 'tstatus run';
    status.textContent = '执行中';
  } else {
    status.className = 'tstatus ' + (t.ok ? 'ok' : 'err');
    status.textContent = (t.ok ? '完成' : '失败') + (t.ms ? ` · ${t.ms}ms` : '');
    card.querySelector('.t-res').textContent = String(t.result == null ? '' : t.result);
    if (!t.ok) card.classList.add('open');
    // Diff preview + one-click undo for file-mutating tools.
    let diffWrap = card.querySelector('.tool-diff');
    if (t.diff) {
      if (!diffWrap) {
        diffWrap = document.createElement('div');
        diffWrap.className = 'tool-diff';
        diffWrap.innerHTML = '<b>改动预览 (diff)</b><pre class="t-diff"></pre>';
        if (t.undoToken) {
          const ub = document.createElement('button');
          ub.className = 'undo-btn';
          ub.dataset.token = String(t.undoToken);
          ub.textContent = '↩ 撤销此改动';
          diffWrap.appendChild(ub);
        }
        card.querySelector('.tool-body').appendChild(diffWrap);
      }
      diffWrap.querySelector('.t-diff').textContent = String(t.diff);
    }
  }
  // The `plan` tool records an inspectable, numbered plan — surface it as a
  // checklist so the human can review the approach before approving execution.
  if (t.name === 'plan' && t.args) {
    let pw = card.querySelector('.plan-list');
    if (!pw) {
      pw = document.createElement('div');
      pw.className = 'plan-list';
      card.querySelector('.tool-body').appendChild(pw);
    }
    const steps = Array.isArray(t.args.steps) ? t.args.steps : [];
    const text = typeof t.args.text === 'string' ? t.args.text : '';
    if (steps.length) {
      pw.innerHTML = '<b>计划</b><ol>' + steps.map((s) => `<li>${escapeHtml(String(s))}</li>`).join('') + '</ol>';
    } else if (text) {
      pw.innerHTML = '<b>计划</b><pre class="t-res">' + escapeHtml(text) + '</pre>';
    }
  }
  updateToolLedger(holder);
  return card;
}

// Compact, color-coded "progress ledger" so a multi-step run is scannable at a
// glance — research ranks a live, color-coded transcript as the #1 trust lever
// for agentic products. It only reads the cards already in the DOM, so it can
// never interfere with tool execution or streaming.
function updateToolLedger(holder) {
  const cards = holder.querySelectorAll('.tool-card');
  const total = cards.length;
  let led = holder.querySelector('.tool-ledger');
  if (!total) { if (led) led.remove(); return; }
  let running = 0, ok = 0, err = 0;
  cards.forEach((c) => {
    const s = c.querySelector('.tstatus');
    if (!s) return;
    if (s.classList.contains('run')) running++;
    else if (s.classList.contains('ok')) ok++;
    else if (s.classList.contains('err')) err++;
  });
  if (!led) {
    led = document.createElement('div');
    led.className = 'tool-ledger';
    led.innerHTML = '<span class="led-sum"></span><span class="led-bar"><i></i></span>';
    holder.prepend(led);
  }
  const pct = Math.round(((ok + err) / total) * 100);
  led.querySelector('.led-sum').innerHTML =
    '工具调用 <b>' + total + '</b>' +
    (running ? ' · <span class="led-run">执行中 ' + running + '</span>' : '') +
    (ok ? ' · <span class="led-ok">完成 ' + ok + '</span>' : '') +
    (err ? ' · <span class="led-err">失败 ' + err + '</span>' : '');
  const fill = led.querySelector('.led-bar i');
  fill.style.width = pct + '%';
  fill.className = err ? 'led-err-fill' : 'led-ok-fill';
}

function scrollBottom() {
  const s = $('scroller');
  // jump instantly even though #scroller uses scroll-behavior:smooth, so
  // streaming output doesn't lag behind while the wheel/trackbar stays usable
  if (s.scrollTo) s.scrollTo({ top: s.scrollHeight, behavior: 'auto' });
  else s.scrollTop = s.scrollHeight;
}
function nearBottom() {
  const s = $('scroller');
  return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
}

// ---------- streaming ----------
function stripForApi(m) {
  const o = { role: m.role };
  if (m.content != null) o.content = m.content;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) o.tool_calls = m.tool_calls;
  if (m.tool_call_id != null) o.tool_call_id = m.tool_call_id;
  if (m.name != null) o.name = m.name;
  return o;
}

// Providers reject a history where an assistant `tool_calls` has no matching
// `tool` reply (and vice versa). That happens for real: hit Stop mid-tool, or
// close the tab while a call is in flight, and the next message 400s forever
// with a cryptic error. Repair the history instead of letting that happen.
function sanitizeHistory(list) {
  const answered = new Set();
  for (const m of list) if (m.role === 'tool' && m.tool_call_id) answered.add(m.tool_call_id);

  const out = [];
  const kept = new Set();
  for (const m of list) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const live = m.tool_calls.filter((tc) => answered.has(tc.id));
      for (const tc of live) kept.add(tc.id);
      // An assistant turn with neither text nor a surviving call is noise.
      if (!live.length && !String(m.content || '').trim()) continue;
      out.push(live.length === m.tool_calls.length ? m : { ...m, tool_calls: live });
      continue;
    }
    if (m.role === 'tool') {
      if (!m.tool_call_id || !kept.has(m.tool_call_id)) continue; // orphan result
      out.push(m);
      continue;
    }
    out.push(m);
  }
  return out;
}

async function postStream(url, body, onEvent, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let pendingEv = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { pendingEv = null; continue; }
      if (line.startsWith('event:')) pendingEv = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        let obj;
        try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
        onEvent(pendingEv || 'message', obj);
      }
    }
  }
}

async function sendMessage(preset) {
  const input = $('input');
  const text = (preset || input.value).trim();
  if (!text || abortCtrl) return;
  if (!config.apiKey && config.provider !== 'ollama') {
    openSettings();
    toast('先填入模型 API Key');
    return;
  }
  let conv = currentConv() || newConv();
  // Attached files travel with the message so the agent knows what to read.
  const attached = refs.slice();
  const content = attached.length
    ? text + '\n\n' + attached.map((p) => `（请参考工作区文件：${p}）`).join('\n')
    : text;
  conv.messages.push({ role: 'user', content, display: text, refs: attached });
  input.value = '';
  clearRefs();
  closeAc();
  autoGrow();
  renderMessages();

  await runTurn(conv, { planning: !!config.planMode });
}

// After a plan has been presented, the user approves it and the agent executes.
async function approvePlan() {
  if (abortCtrl) return;
  const conv = currentConv();
  if (!conv) return;
  conv.messages.push({ role: 'user', content: '已批准上述计划，请现在开始执行。', display: '（批准计划 · 开始执行）' });
  conv.awaitingPlanApproval = false;
  saveConvs();
  renderMessages();
  await runTurn(conv, { planning: false });
}

// Plan mode: approve a (possibly edited) plan and let the agent execute it.
// The edited text becomes the human's instruction, so the model acts on what
// the user actually signed off on — not a stale copy of the original proposal.
async function approvePlanWith(edited) {
  if (abortCtrl) return;
  const conv = currentConv();
  if (!conv) return;
  const plan = (edited || '').trim();
  conv.messages.push({
    role: 'user',
    content: plan
      ? '已批准（修订后）计划，请据此执行：\n' + plan
      : '已批准上述计划，请现在开始执行。',
    display: '（批准计划 · 开始执行）'
  });
  conv.awaitingPlanApproval = false;
  saveConvs();
  renderMessages();
  await runTurn(conv, { planning: false });
}

// Plan mode: reject without auto-rerunning. The conversation then waits for
// the human's next instruction, so the agent doesn't spin proposing plans in
// a loop — the person stays in control of what happens next.
function rejectPlan() {
  const conv = currentConv();
  if (!conv) return;
  conv.awaitingPlanApproval = false;
  saveConvs();
  renderMessages();
  toast('已拒绝计划，可直接给出新的指令');
}

// The streaming turn itself, split out so "regenerate" can reuse it.
async function runTurn(conv, opts = {}) {
  const planning = !!opts.planning;
  abortCtrl = new AbortController();
  const aMsg = { role: 'assistant', content: '', tool_calls: [], toolCalls: [], notices: [] };
  conv.messages.push(aMsg);
  const el = buildMessageEl(aMsg);
  el.querySelector('.md').innerHTML = THINKING;
  el.classList.add('is-thinking');
  $('messages').appendChild(el);
  scrollBottom();
  setBusy(true);

  // Start a fresh live trace for this run (rendered in the Trace panel if open).
  const firstUser = (conv.messages.find((m) => m.role === 'user')?.content || '').toString();
  traceReset(firstUser);
  if (!$('trace-modal').classList.contains('hidden')) { historyTrace = null; $('trace-title').textContent = '实时轨迹'; renderTrace(); }

  const md = el.querySelector('.md');
  const turnUsage = emptyUsage();
  try {
    await postStream('/api/chat', {
      messages: sanitizeHistory(conv.messages.filter((m) => m !== aMsg)).map(stripForApi),
      config,
      agentEnabled: config.agentEnabled,
      planning,
      mcpServers: getMcpServers()
    }, (event, data) => {
      traceOnEvent(event, data);
      const stick = nearBottom();
      if (event === 'delta') {
        aMsg.content += data.content || '';
        paintOrThinking(md, aMsg.content);
      } else if (event === 'approval') {
        handleApprovalRequest(data);
      } else if (event === 'tool_start') {
        upsertToolCard(el, data);
      } else if (event === 'tool') {
        aMsg.tool_calls.push({ id: data.id, type: 'function', function: { name: data.name, arguments: JSON.stringify(data.args || {}) } });
        conv.messages.push({ role: 'tool', tool_call_id: data.id, name: data.name, content: data.ok ? data.result : 'Error: ' + data.result });
        aMsg.toolCalls.push(data);
        upsertToolCard(el, data);
        // Flash the overlay marker the agent just acted on so the user can see
        // exactly which element was clicked/typed into on the live page.
        if (data.ref && !$('browser-modal').classList.contains('hidden')) {
          flashOverlayMark(data.ref);
        }
        if (aMsg.content === '') md.innerHTML = THINKING;
      } else if (event === 'subagent') {
        handleSubAgentEvent(el, data);
      } else if (event === 'skill_auto') {
        if (data.saved) {
          toast(`💡 自动沉淀技能：${data.name || ''}`);
          refreshSkillsInfo();
        } else if (data.error) {
          toast(`技能沉淀失败：${data.error}`, 3200);
        } else {
          toast(`技能沉淀跳过：${data.reason || '暂不需要'}`);
        }
      } else if (event === 'start') {
        ctxState.window = data.contextWindow || 0;
        ctxState.budget = data.budget || 0;
        renderUsageChip();
      } else if (event === 'compact') {
        // The server had to shrink the history to fit. Say so — silently
        // losing context is exactly the kind of thing users hate discovering.
        const saved = Math.max(0, (data.before || 0) - (data.after || 0));
        const n = {
          kind: 'compact',
          text: `上下文已自动压缩：${fmtTokens(data.before)} → ${fmtTokens(data.after)} tokens` +
            (data.dropped ? `（归纳了较早的 ${data.dropped} 轮）` : '（裁剪了旧的工具输出）'),
          detail: `节省 ${fmtTokens(saved)} tokens，避免超出模型上下文窗口。`
        };
        aMsg.notices.push(n);
        addNotice(el, n);
      } else if (event === 'usage') {
        setUsageFrom(turnUsage, data);
        aMsg.usage = { ...turnUsage };
        aMsg.turns = data.turn || aMsg.turns || 1;
        renderMsgUsage(el, aMsg);
      } else if (event === 'error') {
        aMsg.error = data.message || '出错了';
        renderErrorCard(el, aMsg.error);
        paintFallback(md, aMsg.content, '<span class="muted small">（无文本输出）</span>');
      } else if (event === 'guardrail') {
        // The server hit the interactive cost cap and forced a stop. Toast it so
        // the user knows why the run ended early, not just that it did.
        toast('🛡️ 预算护栏触发：已达 $' + (Number(data.max) || 0).toFixed(2) + ' 上限，已强制停止并让模型总结', 4500);
      } else if (event === 'diagnosis') {
        // Graded self-check for this run. Persist on the message so it survives
        // re-renders, and render it inline as a report card.
        aMsg.selfCheck = data;
        renderSelfCheck(el, data);
      } else if (event === 'done' || event === 'end') {
        el.classList.remove('is-thinking');
        paintFallback(md, aMsg.content, '<span class="muted small">（没有文本输出）</span>');
        if (event === 'done' && data.canContinue) {
          aMsg.canContinue = true;
          addContinueBar(el);
        }
        if (event === 'end') {
          if (data.historyTokens) ctxState.used = data.historyTokens;
          if (data.budget) ctxState.budget = data.budget;
        }
        if (planning) {
          conv.awaitingPlanApproval = true;
          conv.planMsgIndex = conv.messages.indexOf(aMsg);
          saveConvs();
          renderMessages();
        } else if (!aMsg.error && (aMsg.content || '').trim().length >= 12) {
          // Surface "suggested next steps" after a real answer lands.
          maybeSuggestFollowups(conv, aMsg, el);
        }
      }
      if (stick) scrollBottom();
    }, abortCtrl.signal);
  } catch (e) {
    if (e.name !== 'AbortError') {
      const hint = /Failed to fetch|NetworkError/i.test(e.message)
        ? '无法连接本地服务，请确认 Agenite 服务正在运行（start.cmd / node server.js）。'
        : e.message;
      aMsg.error = hint;
      renderErrorCard(el, hint);
      if (!aMsg.content) md.innerHTML = '<span class="muted small">（无文本输出）</span>';
    } else if (!aMsg.content) {
      el.classList.remove('is-thinking');
      md.innerHTML = '<span class="muted small">已停止</span>';
    } else {
      el.classList.remove('is-thinking');
    }
  } finally {
    closeApproval();
    setBusy(false);
    abortCtrl = null;
    if (conv.title === '新对话') {
      const firstUser = conv.messages.find((m) => m.role === 'user');
      if (firstUser) conv.title = firstUser.content.slice(0, 28);
      renderConvList();
      updateTitle();
    }
    addUsageTo(convUsage(conv), turnUsage);
    renderUsageChip();
    conv.updatedAt = Date.now();
    saveConvs();
  }
}

// "继续执行" — the history already ends with the tool results from the last
// turn, so simply running another turn resumes exactly where it stopped.
async function continueRun() {
  if (abortCtrl) return;
  const conv = currentConv();
  if (!conv) return;
  for (const m of conv.messages) if (m.canContinue) delete m.canContinue;
  renderMessages();
  await runTurn(conv);
}

function setBusy(busy) {
  $('send').classList.toggle('hidden', busy);
  $('stop').classList.toggle('hidden', !busy);
}

// ---------- message actions ----------

// Drop everything from `index` onward, then re-run the model on what's left.
async function regenerateFrom(index) {
  if (abortCtrl) return;
  const conv = currentConv();
  if (!conv) return;
  conv.messages = conv.messages.slice(0, index);
  saveConvs();
  renderMessages();
  await runTurn(conv);
}

// Put a past user message back in the composer and cut the history after it.
function editUserMessage(index) {
  if (abortCtrl) return;
  const conv = currentConv();
  if (!conv) return;
  const m = conv.messages[index];
  if (!m || m.role !== 'user') return;
  $('input').value = m.display || m.content || '';
  refs = Array.isArray(m.refs) ? m.refs.slice() : [];
  renderRefs();
  conv.messages = conv.messages.slice(0, index);
  saveConvs();
  renderMessages();
  autoGrow();
  $('input').focus();
}

function copyText(text, okMsg = '已复制') {
  navigator.clipboard.writeText(text).then(() => toast(okMsg)).catch(() => toast('复制失败'));
}

// ---------- conversation utilities ----------
function clearCurrent() {
  const c = currentConv();
  if (!c || !c.messages.length) return toast('当前对话是空的');
  if (!confirm('清空当前对话的消息？')) return;
  c.messages = [];
  saveConvs();
  renderMessages();
}

function renameCurrent() {
  const c = currentConv();
  if (!c) return toast('还没有对话');
  const name = prompt('新的对话名称：', c.title || '新对话');
  if (name == null) return;
  c.title = name.trim() || '新对话';
  saveConvs();
  renderConvList();
  updateTitle();
}

// Turn the current conversation into a readable Markdown transcript.
function conversationToMarkdown(conv) {
  const lines = [`# ${conv.title || '对话'}`, ''];
  if (conv.createdAt) lines.push(`> 创建于 ${new Date(conv.createdAt).toLocaleString()}`, '');
  for (const m of conv.messages) {
    if (m.role === 'user') {
      lines.push('## 🧑 我', '', (m.display || m.content || '').trim(), '');
      if (Array.isArray(m.refs) && m.refs.length) {
        lines.push('引用文件：' + m.refs.map((p) => '`' + p + '`').join('、'), '');
      }
    } else if (m.role === 'assistant') {
      lines.push('## 🤖 Agenite', '');
      if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
        for (const t of m.toolCalls) {
          const status = t.ok ? '成功' : '失败';
          lines.push(`<details><summary>🔧 ${t.name} — ${status}</summary>`, '');
          lines.push('```json', JSON.stringify(t.args || {}, null, 2), '```', '');
          lines.push('```', String(t.result == null ? '' : t.result).slice(0, 2000), '```', '');
          lines.push('</details>', '');
        }
      }
      if ((m.content || '').trim()) lines.push(m.content.trim(), '');
    }
  }
  lines.push('---', '', '_由 [Agenite](https://github.com/your-org/agenite) 导出_');
  return lines.join('\n');
}

function downloadBlob(name, text, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCurrentMarkdown() {
  const c = currentConv();
  if (!c || !c.messages.length) return toast('当前对话是空的');
  const safe = (c.title || '对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  downloadBlob(`${safe}.md`, conversationToMarkdown(c), 'text/markdown;charset=utf-8');
  toast('已导出 Markdown');
}

function conversationToText(conv) {
  const lines = [conv.title || '对话', new Date(conv.createdAt || Date.now()).toLocaleString(), ''];
  for (const m of conv.messages) {
    if (m.role === 'user') lines.push('我: ' + (m.display || m.content || '').trim());
    else if (m.role === 'assistant') lines.push('Agenite: ' + (m.content || '').trim());
    lines.push('');
  }
  return lines.join('\n');
}
function exportCurrentJson() {
  const c = currentConv();
  if (!c || !c.messages.length) return toast('当前对话是空的');
  const safe = (c.title || '对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  downloadBlob(`${safe}.json`, JSON.stringify(c, null, 2), 'application/json');
  toast('已导出 JSON');
}
function exportCurrentText() {
  const c = currentConv();
  if (!c || !c.messages.length) return toast('当前对话是空的');
  const safe = (c.title || '对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  downloadBlob(`${safe}.txt`, conversationToText(c), 'text/plain;charset=utf-8');
  toast('已导出纯文本');
}

function openKeys() { $('keys-modal').classList.remove('hidden'); }

// ---------- command palette (Ctrl+K) ----------
let paletteState = { items: [], filtered: [], index: 0 };

function openPalette() {
  paletteState.index = 0;
  paletteState.items = buildPaletteItems();
  paletteState.filtered = paletteState.items;
  renderPalette('');
  $('palette-modal').classList.remove('hidden');
  const inp = $('palette-input');
  inp.value = '';
  inp.focus();
}
function closePalette() { $('palette-modal').classList.add('hidden'); }

function buildPaletteItems() {
  const actions = [
    { type: '命令', label: '新对话', hint: '开一个空白对话', run: () => newConv() },
    { type: '命令', label: '导出当前对话 (Markdown)', hint: '/export', run: () => exportCurrentMarkdown() },
    { type: '命令', label: '模型设置', hint: '配置供应商 / 密钥 / 模型', run: () => openSettings('model') },
    { type: '命令', label: '工作区与权限', hint: '电脑操作权限', run: () => openSettings('power') },
    { type: '操作', label: '切换主题（深 / 浅）', hint: '', run: () => toggleTheme() },
    { type: '面板', label: '打开智能体画廊', hint: '', run: () => openAgents() },
    { type: '面板', label: '打开知识库', hint: '', run: () => openKb() },
    { type: '面板', label: '打开记忆图谱', hint: '', run: () => openAtlas() },
    { type: '面板', label: '打开目标任务', hint: '', run: () => openGoals() },
    { type: '面板', label: '打开执行轨迹', hint: '', run: () => openTrace() },
    { type: '帮助', label: '快捷键速查', hint: '', run: () => openKeys() }
  ];
  const recents = conversations.slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 6)
    .map((c) => ({ type: '对话', label: c.title || '新对话', hint: '跳转到该对话', run: () => selectConv(c.id) }));
  return [...actions, ...recents];
}

function renderPalette(q) {
  const list = $('palette-list');
  const items = q && q.trim()
    ? fuzzyFilter(paletteState.items, q.trim(), { key: (i) => i.label + ' ' + (i.hint || ''), limit: 20 })
    : paletteState.items;
  paletteState.filtered = items;
  paletteState.index = 0;
  if (!items.length) { list.innerHTML = '<div class="palette-empty">无匹配</div>'; return; }
  list.innerHTML = items.map((it, i) =>
    `<div class="palette-item ${i === 0 ? 'active' : ''}" data-i="${i}">` +
    `<span class="pi-type">${escapeHtml(it.type)}</span>` +
    `<span class="pi-label">${escapeHtml(it.label)}</span>` +
    `<span class="pi-hint">${escapeHtml(it.hint || '')}</span></div>`
  ).join('');
  list.querySelectorAll('.palette-item').forEach((el) => {
    el.onclick = () => runPalette(Number(el.dataset.i));
  });
}

function runPalette(i) {
  const items = paletteState.filtered || paletteState.items;
  const it = items[i];
  if (!it) return;
  closePalette();
  it.run();
}

function movePalette(delta) {
  const items = paletteState.filtered || paletteState.items;
  if (!items.length) return;
  paletteState.index = (paletteState.index + delta + items.length) % items.length;
  const nodes = $('palette-list').querySelectorAll('.palette-item');
  nodes.forEach((n, i) => n.classList.toggle('active', i === paletteState.index));
  const active = nodes[paletteState.index];
  if (active) active.scrollIntoView({ block: 'nearest' });
}
function closeKeys() { $('keys-modal').classList.add('hidden'); }

// ---------- approvals ----------
let pendingApprovalId = null;

function answerApproval(id, approved) {
  fetch('/api/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, approved })
  }).catch(() => {});
}

let pendingApprovalName = '';

function handleApprovalRequest(data) {
  if (sessionAutoApprove) return answerApproval(data.id, true);
  pendingApprovalId = data.id;
  pendingApprovalName = data.name || '';
  $('approval-title').innerHTML = `执行 <code>${escapeHtml(data.name)}</code>`;
  $('approval-desc').textContent = data.description || '';
  $('approval-args').textContent = JSON.stringify(data.args || {}, null, 2);
  $('approval-remember').checked = false;
  $('approval-modal').classList.remove('hidden');
  $('approval-allow').focus();
}

function closeApproval() {
  pendingApprovalId = null;
  pendingApprovalName = '';
  $('approval-modal').classList.add('hidden');
}

function resolveApproval(approved) {
  if (!pendingApprovalId) return;
  if (approved && $('approval-remember').checked) {
    sessionAutoApprove = true;
    toast('本次会话内不再询问');
  }
  answerApproval(pendingApprovalId, approved);
  closeApproval();
}

// Permanent version of "remember": the tool name goes into the config, so it
// is skipped in every future session too. Reversible from the settings.
function approveAlways() {
  if (!pendingApprovalId) return;
  const name = pendingApprovalName;
  if (name) {
    const list = Array.isArray(config.toolAllowlist) ? config.toolAllowlist.slice() : [];
    if (!list.includes(name)) list.push(name);
    config.toolAllowlist = list;
    saveConfig();
    renderAllowlist();
    toast(`已把 ${name} 加入白名单，之后不再询问`);
  }
  answerApproval(pendingApprovalId, true);
  closeApproval();
}

// Chips in the settings so a permanent allow can be taken back.
function renderAllowlist() {
  const box = $('allowlist-box');
  if (!box) return;
  const list = Array.isArray(config.toolAllowlist) ? config.toolAllowlist : [];
  if (!list.length) {
    box.innerHTML = '<span class="muted small">（空）每个危险操作都会弹窗询问。</span>';
    return;
  }
  box.innerHTML = list
    .map((n) => `<span class="allow-chip">${escapeHtml(n)}<button data-rm="${escapeHtml(n)}" title="移除">✕</button></span>`)
    .join('');
  box.querySelectorAll('[data-rm]').forEach((b) => {
    b.onclick = () => {
      config.toolAllowlist = list.filter((x) => x !== b.dataset.rm);
      saveConfig();
      renderAllowlist();
    };
  });
}

// ---------- settings ----------
function permState() {
  if (!config.dangerTools || config.approvalMode === 'deny') return { text: '只读', cls: '' };
  if (config.approvalMode === 'auto') return { text: '全权', cls: 'danger' };
  return { text: '需确认', cls: 'warn' };
}
function renderPermChip() {
  const s = permState();
  const chip = $('perm-chip');
  chip.className = 'chip ' + s.cls;
  $('perm-text').textContent = s.text;
  chip.title = `电脑操作权限：${s.text}（点击切换）`;
}
function cyclePerm() {
  if (!config.dangerTools || config.approvalMode === 'deny') {
    config.dangerTools = true; config.approvalMode = 'ask';
  } else if (config.approvalMode === 'ask') {
    config.approvalMode = 'auto';
  } else {
    config.dangerTools = false; config.approvalMode = 'ask';
  }
  saveConfig();
  renderPermChip();
  toast('电脑操作权限：' + permState().text);
}

function renderAgentChip() {
  $('agent-toggle').classList.toggle('active', config.agentEnabled !== false);
}
function renderPlanChip() {
  $('plan-toggle').classList.toggle('active', config.planMode === true);
}
function renderModelChip() {
  const ready = !!config.model && (!!config.apiKey || config.provider === 'ollama');
  $('model-chip').classList.toggle('ready', ready);
  const p = PROVIDER_PRESETS.find((x) => x.id === config.provider);
  const icon = p ? (p.icon || '') : '';
  $('model-label').textContent = config.model ? `${icon} ${config.model}` : '未配置模型';
}

// Fill the model <datalist> from the active provider's curated catalog and
// refresh the context-window badge next to the model field.
function refreshModelList() {
  const dl = $('model-list');
  if (!dl) return;
  const models = modelsForProvider($('set-provider').value);
  dl.innerHTML = models
    .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)} · ${Math.round(m.ctx / 1000)}K 上下文</option>`)
    .join('');
  updateModelCtxBadge();
}
function updateModelCtxBadge() {
  const el = $('model-ctx');
  if (!el) return;
  const m = modelsForProvider($('set-provider').value).find((x) => x.id === ($('set-model').value || '').trim());
  el.textContent = m ? `上下文 ${Math.round(m.ctx / 1000)}K` : '';
}

function populateProviders() {
  const sel = $('set-provider');
  sel.innerHTML = '';
  for (const p of PROVIDER_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = (p.icon ? p.icon + ' ' : '') + p.label;
    sel.appendChild(opt);
  }
  refreshModelList();
}
function renderApprovalModes() {
  const box = $('approval-modes');
  box.innerHTML = '';
  for (const m of APPROVAL_MODES) {
    const item = document.createElement('label');
    item.className = 'radio-item' + (config.approvalMode === m.id ? ' on' : '');
    item.innerHTML =
      `<input type="radio" name="apv" value="${m.id}" ${config.approvalMode === m.id ? 'checked' : ''} />` +
      `<span><b>${escapeHtml(m.label)}</b><em>${escapeHtml(m.hint)}</em></span>`;
    item.querySelector('input').onchange = () => {
      config.approvalMode = m.id;
      renderApprovalModes();
    };
    box.appendChild(item);
  }
}
function fillSettings() {
  $('set-provider').value = config.provider || 'deepseek';
  $('set-baseURL').value = config.baseURL || '';
  $('set-apiKey').value = config.apiKey || '';
  $('set-model').value = config.model || '';
  $('set-temperature').value = config.temperature;
  $('temp-val').textContent = config.temperature;
  $('set-maxTokens').value = config.maxTokens;
  $('set-agentEnabled').checked = config.agentEnabled !== false;
  $('set-dangerTools').checked = !!config.dangerTools;
  $('set-allowOutside').checked = !!config.allowOutsideWorkspace;
  $('set-systemPrompt').value = config.systemPrompt || '';
  $('set-mcpReadonly').checked = config.mcpAutoApproveReadonly !== false;
  $('set-memoryEnabled').checked = config.memoryEnabled !== false;
  $('set-autoSkill').checked = config.autoSkill === true;
  $('set-atlasInject').checked = config.atlasInject !== false;
  $('set-atlasAutoBuild').checked = config.atlasAutoBuild === true;
  $('set-atlasAutoOpen').checked = config.atlasAutoOpen !== false;
  $('set-autoCompact').checked = config.autoCompact !== false;
  $('set-smartCompact').checked = config.smartCompact !== false;
  $('set-maxTurns').value = config.maxTurns || 20;
  $('set-contextWindow').value = config.contextWindow || 0;
  $('set-maxCostUSD').value = (config.budget && Number(config.budget.maxCostUSD) > 0) ? config.budget.maxCostUSD : 0;
  $('set-priceIn').value = config.priceIn || 0;
  $('set-priceOut').value = config.priceOut || 0;
  $('set-priceCurrency').value = config.priceCurrency || 'CNY';
  $('set-syncSessions').checked = config.syncSessions !== false;
  $('set-suggestFollowups').checked = config.suggestFollowups !== false;
  $('ws-path').textContent = workspacePath || '（未连接本地服务）';
  renderApprovalModes();
  renderAllowlist();
  refreshSessionsInfo();
}

// A one-line "N conversations on disk" so the mirror is visibly real.
async function refreshSessionsInfo() {
  const el = $('sessions-info');
  if (!el) return;
  try {
    const r = await fetch('/api/sessions');
    const j = await r.json();
    const n = (j.sessions || []).length;
    el.textContent = n ? `本机已存 ${n} 个会话 · ${j.dir}` : '本机还没有会话备份。';
  } catch {
    el.textContent = '';
  }
}
function openSettings(tab) {
  populateProviders();
  fillSettings();
  syncOllamaUi();
  if (tab) switchTab(tab);
  $('settings-modal').classList.remove('hidden');
  $('settings-msg').textContent = '';
  refreshMcp();
  refreshSkillsInfo();
  populatePersonaSelect();
}

async function populatePersonaSelect() {
  const sel = $('set-persona');
  if (!sel) return;
  try {
    const r = await fetch('/api/personas');
    const j = await r.json();
    const builtin = Array.isArray(j.builtin) ? j.builtin : [];
    const custom = Array.isArray(j.custom) ? j.custom : [];
    const opts = ['<option value="default">默认（通用智能体）</option>'];
    for (const p of builtin) {
      if (p.name === 'default') continue;
      opts.push(`<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)} — ${escapeHtml(p.description || '')}</option>`);
    }
    for (const p of custom) {
      opts.push(`<option value="${escapeHtml(p.slug)}">★ ${escapeHtml(p.name)} — ${escapeHtml(p.description || '')}</option>`);
    }
    sel.innerHTML = opts.join('');
    sel.value = config.persona || 'default';
  } catch { /* ignore — personas are optional */ }
}

async function saveNewPersona() {
  const name = ($('persona-name').value || '').trim();
  const prompt = ($('set-systemPrompt').value || '').trim();
  const msg = $('persona-msg');
  if (!name) { msg.textContent = '请先填写角色名。'; return; }
  if (!prompt) { msg.textContent = '「系统提示词」为空，没有可保存的指令。'; return; }
  try {
    const res = await fetch('/api/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: '', system_prompt: prompt })
    });
    const j = await res.json();
    if (!res.ok) { msg.textContent = '保存失败：' + (j.error || res.status); return; }
    config.persona = j.slug || name;
    $('set-persona').value = config.persona;
    saveConfig();
    msg.textContent = `✅ 已保存角色「${name}」，可在上方下拉切换。`;
  } catch (e) {
    msg.textContent = '保存失败：' + e.message;
  }
}

async function refreshSkillsInfo() {
  const el = $('skills-info');
  if (!el) return;
  try {
    const r = await fetch('/api/skills');
    const j = await r.json();
    const n = Array.isArray(j.skills) ? j.skills.length : 0;
    el.textContent = n ? `${n} 条技能已沉淀` : '暂无技能（让 agent 完成复杂任务后沉淀）';
  } catch {
    el.textContent = '技能库读取失败';
  }
}
function closeSettings() { $('settings-modal').classList.add('hidden'); }

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  if (name === 'mcp') refreshMcp();
}

function onProviderChange() {
  const preset = PROVIDER_PRESETS.find((p) => p.id === $('set-provider').value);
  if (!preset) return;
  if (preset.baseURL) $('set-baseURL').value = preset.baseURL;
  if (preset.defaultModel) $('set-model').value = preset.defaultModel;
  $('set-apiKey').placeholder = preset.apiKeyPlaceholder || 'your-api-key';
  refreshModelList();
  syncOllamaUi();
}

// When the provider is Ollama, reveal the local-model picker and populate it
// from the running Ollama daemon. No-op (and hidden) for cloud providers.
function syncOllamaUi() {
  const isOllama = $('set-provider').value === 'ollama';
  $('ollama-box').classList.toggle('hidden', !isOllama);
  if (isOllama) refreshOllamaModels();
}

async function refreshOllamaModels() {
  const hint = $('ollama-hint');
  const box = $('ollama-models');
  if (!box) return;
  hint.textContent = '正在探测本地 Ollama…';
  hint.classList.remove('green');
  try {
    const r = await fetch('/api/ollama/models');
    const j = await r.json();
    if (j.running && Array.isArray(j.models) && j.models.length) {
      box.innerHTML = j.models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
      if (!($('set-model').value || '').trim()) $('set-model').value = j.models[0];
      hint.textContent = `本地模型 · 零成本 · 已发现 ${j.models.length} 个`;
      hint.classList.add('green');
      const dl = $('model-list');
      if (dl) {
        const have = new Set([...dl.options].map((o) => o.value));
        for (const m of j.models) {
          if (!have.has(m)) {
            const o = document.createElement('option');
            o.value = m; o.textContent = `${m} · 本地`;
            dl.appendChild(o);
          }
        }
      }
    } else {
      hint.textContent = '未检测到 Ollama（先运行 ollama serve 并 pull 模型）';
    }
  } catch {
    hint.textContent = '未检测到 Ollama 服务';
  }
}

function saveSettings() {
  const preset = PROVIDER_PRESETS.find((p) => p.id === $('set-provider').value);
  config = {
    ...config,
    provider: $('set-provider').value,
    protocol: preset ? preset.protocol : 'openai',
    baseURL: $('set-baseURL').value.trim(),
    apiKey: $('set-apiKey').value.trim(),
    model: $('set-model').value.trim(),
    temperature: Number($('set-temperature').value),
    maxTokens: Number($('set-maxTokens').value),
    agentEnabled: $('set-agentEnabled').checked,
    dangerTools: $('set-dangerTools').checked,
    allowOutsideWorkspace: $('set-allowOutside').checked,
    systemPrompt: $('set-systemPrompt').value,
    mcpAutoApproveReadonly: $('set-mcpReadonly').checked,
    memoryEnabled: $('set-memoryEnabled').checked,
    autoSkill: $('set-autoSkill').checked,
    atlasInject: $('set-atlasInject').checked,
    atlasAutoBuild: $('set-atlasAutoBuild').checked,
    atlasAutoOpen: $('set-atlasAutoOpen').checked,
    persona: $('set-persona').value || 'default',
    autoCompact: $('set-autoCompact').checked,
    smartCompact: $('set-smartCompact').checked,
    maxTurns: clampNum($('set-maxTurns').value, 1, 100, 20),
    contextWindow: clampNum($('set-contextWindow').value, 0, 2000000, 0),
    // Budget guardrail: 0 = use the server default ($3) for interactive chat.
    // Stored under `budget` (what the server reads); goals carry their own rails.
    budget: { maxCostUSD: clampNum($('set-maxCostUSD').value, 0, 10000, 0) },
    priceIn: Math.max(0, Number($('set-priceIn').value) || 0),
    priceOut: Math.max(0, Number($('set-priceOut').value) || 0),
    priceCurrency: $('set-priceCurrency').value || 'CNY',
    syncSessions: $('set-syncSessions').checked,
    suggestFollowups: $('set-suggestFollowups').checked
  };
  saveConfig();
  renderPermChip();
  renderAgentChip();
  renderModelChip();
  renderUsageChip();
  closeSettings();
  toast('已保存');
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

async function testConnection() {
  const msgEl = $('settings-msg');
  msgEl.className = 'muted small';
  msgEl.textContent = '正在校验密钥…';
  const payload = {
    provider: $('set-provider').value,
    baseURL: $('set-baseURL').value.trim(),
    apiKey: $('set-apiKey').value.trim(),
    model: $('set-model').value.trim()
  };
  try {
    const res = await fetch('/api/verifykey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await res.json();
    if (j.ok) {
      msgEl.className = 'verify-ok';
      msgEl.textContent = '✅ ' + (j.message || '密钥有效，模型可调用。');
    } else {
      msgEl.className = 'verify-err';
      msgEl.textContent = '❌ ' + (j.message || '校验失败。');
    }
  } catch {
    msgEl.className = 'verify-err';
    msgEl.textContent = '❌ 无法连接本地服务，请确认 Agenite 已启动（start.cmd / node server.js）。';
  }
}

// ---------- data ----------
function exportData() {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), conversations }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `agenite-chats-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出 ' + conversations.length + ' 个对话');
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      const list = Array.isArray(data) ? data : data.conversations;
      if (!Array.isArray(list)) throw new Error('格式不对');
      conversations = [...list, ...conversations];
      saveConvs();
      renderConvList();
      toast('已导入 ' + list.length + ' 个对话');
    } catch (e) {
      toast('导入失败：' + e.message);
    }
  };
  reader.readAsText(file);
}
function resetAll() {
  if (!confirm('清空全部对话和设置？此操作不可撤销。')) return;
  localStorage.removeItem(LS.convs);
  localStorage.removeItem(LS.cur);
  localStorage.removeItem(LS.config);
  location.reload();
}

// ---------- MCP tool servers ----------
function parseMcpArgs(text) {
  const t = (text || '').trim();
  if (!t) return [];
  try { return JSON.parse(t); } catch { return t.split(/\s+/).filter(Boolean); }
}
function parseMcpEnv(text) {
  const t = (text || '').trim();
  if (!t) return {};
  try { return JSON.parse(t); } catch { toast('env 不是合法 JSON'); return {}; }
}
// What a server row says it is: a local process or a remote endpoint.
function mcpTarget(s) {
  if (s.url) return s.url;
  return [s.command, ...(s.args || [])].join(' ');
}
function transportLabel(t) {
  if (t === 'http') return 'HTTP';
  if (t === 'sse') return 'SSE';
  return 'stdio';
}
function updateMcpChip(servers) {
  const n = (servers || []).reduce((s, x) => s + (x.toolCount || 0), 0);
  const el = $('mcp-count');
  if (el) el.textContent = String(n);
  const chip = $('mcp-chip');
  if (chip) chip.classList.toggle('on', n > 0);
}
function renderMcpList(servers) {
  const box = $('mcp-list');
  if (!box) return;
  const list = getMcpServers();
  if (!list.length) {
    box.innerHTML = '<div class="mcp-empty">还没有服务器。点上面的快速添加，或手动添加一个。</div>';
    return;
  }
  const statusById = {};
  for (const s of (servers || [])) statusById[s.id] = s;
  box.innerHTML = '';
  for (const s of list) {
    const st = statusById[s.id];
    const status = st ? st.status : 'disconnected';
    const toolCount = st ? st.toolCount : 0;
    const err = st && st.error ? st.error : '';
    const row = document.createElement('div');
    row.className = 'mcp-row ' + status;
    const toolsHtml = st && st.tools && st.tools.length
      ? '<div class="mcp-tools">' + st.tools.map((t) =>
        `<span class="tool-chip${t.readOnly ? ' ro' : ''}" title="${escapeHtml(t.description || '')}${t.readOnly ? '\n（只读工具）' : ''}">${escapeHtml(t.name)}</span>`).join('') + '</div>'
      : '';
    const tp = s.transport || (s.url ? 'http' : 'stdio');
    row.innerHTML =
      `<div class="mcp-row-head">` +
      `<span class="mcp-name">${escapeHtml(s.id)}</span>` +
      `<span class="mcp-transport">${transportLabel(tp)}</span>` +
      `<span class="mcp-status ${status}">${statusText(status, toolCount)}</span>` +
      `<div class="grow"></div>` +
      `<button class="mini-btn" data-act="toggle" data-id="${escapeHtml(s.id)}">${s.enabled ? '停用' : '启用'}</button>` +
      `<button class="mini-btn" data-act="del" data-id="${escapeHtml(s.id)}">删除</button>` +
      `</div>` +
      `<div class="mcp-cmd"><code>${escapeHtml(mcpTarget(s))}</code></div>` +
      toolsHtml +
      (err ? `<div class="mcp-err">${escapeHtml(err.slice(0, 300))}</div>` : '');
    box.appendChild(row);
  }
  box.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.id;
      const list2 = getMcpServers();
      const item = list2.find((x) => x.id === id);
      if (!item) return;
      if (b.dataset.act === 'del') {
        saveMcpServers(list2.filter((x) => x.id !== id));
        refreshMcp();
      } else if (b.dataset.act === 'toggle') {
        item.enabled = !item.enabled;
        saveMcpServers(list2);
        refreshMcp();
      }
    };
  });
}
function statusText(status, toolCount) {
  if (status === 'connected') return '✅ 已连接 · ' + toolCount + ' 工具';
  if (status === 'connecting') return '⏳ 连接中…';
  if (status === 'error') return '⚠️ 错误';
  return '○ 未连接';
}
async function refreshMcp() {
  const servers = getMcpServers();
  try {
    await fetch('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ servers })
    });
    const r = await fetch('/api/mcp/status');
    const j = await r.json();
    renderMcpList(j.servers || []);
    updateMcpChip(j.servers || []);
  } catch {
    renderMcpList([]);
  }
}

// ---------- "@" file refs & "/" commands ----------
// A single autocomplete popup serves both triggers. `acState` is null when closed.
let acState = null; // { kind:'file'|'cmd', start:number, query:string, items:[], index:number }

function closeAc() {
  acState = null;
  $('ac-pop').classList.add('hidden');
}

// Look at the text just before the caret and decide whether to open a popup.
function detectTrigger() {
  const ta = $('input');
  const caret = ta.selectionStart;
  const before = ta.value.slice(0, caret);

  // "/" only counts at the very beginning of the input (like Claude Code / Slack)
  const cmdMatch = /^\/([a-z]*)$/i.exec(before);
  if (cmdMatch) return { kind: 'cmd', start: 0, query: cmdMatch[1] };

  // "@" counts after start-of-input or whitespace; query stops at whitespace
  const atMatch = /(^|\s)@([^\s@]*)$/.exec(before);
  if (atMatch) {
    const start = caret - atMatch[2].length - 1;
    return { kind: 'file', start, query: atMatch[2] };
  }
  return null;
}

function renderAc() {
  const pop = $('ac-pop');
  if (!acState || !acState.items.length) {
    pop.classList.add('hidden');
    return;
  }
  pop.innerHTML = acState.items
    .map((entry, i) => {
      const active = i === acState.index ? ' active' : '';
      if (acState.kind === 'cmd') {
        return `<div class="ac-item${active}" data-i="${i}" role="option">` +
          `<span class="ac-main">${escapeHtml(entry.item.name)}</span>` +
          `<span class="ac-side">${escapeHtml(entry.item.hint)}</span></div>`;
      }
      const p = entry.item.path;
      const slash = p.lastIndexOf('/');
      const dir = slash === -1 ? '' : p.slice(0, slash + 1);
      const base = slash === -1 ? p : p.slice(slash + 1);
      return `<div class="ac-item${active}" data-i="${i}" role="option">` +
        `<span class="ac-main"><em>${escapeHtml(dir)}</em>${escapeHtml(base)}</span>` +
        `<span class="ac-side">${escapeHtml(formatBytes(entry.item.size))}</span></div>`;
    })
    .join('');
  pop.classList.remove('hidden');
  pop.querySelectorAll('.ac-item').forEach((el) => {
    el.onmousedown = (e) => { e.preventDefault(); applyAc(Number(el.dataset.i)); };
  });
  const active = pop.querySelector('.ac-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function updateAc() {
  const trig = detectTrigger();
  if (!trig) return closeAc();

  if (trig.kind === 'cmd') {
    const items = fuzzyFilter(COMMANDS, trig.query, { key: (c) => c.name.slice(1), limit: 8 });
    acState = { ...trig, items, index: 0 };
  } else {
    if (!workspaceFiles.length) { loadWorkspaceFiles(); }
    const items = fuzzyFilter(workspaceFiles, trig.query, { key: (f) => f.path, limit: 12 });
    acState = { ...trig, items, index: 0 };
  }
  renderAc();
}

function moveAc(delta) {
  if (!acState || !acState.items.length) return;
  const n = acState.items.length;
  acState.index = (acState.index + delta + n) % n;
  renderAc();
}

function applyAc(i) {
  if (!acState) return;
  const entry = acState.items[typeof i === 'number' ? i : acState.index];
  if (!entry) return;
  const ta = $('input');

  if (acState.kind === 'cmd') {
    const cmd = entry.item;
    ta.value = '';
    closeAc();
    autoGrow();
    cmd.run();
    return;
  }

  // File: drop the "@query" text and register the file as a ref chip instead.
  const caret = ta.selectionStart;
  ta.value = ta.value.slice(0, acState.start) + ta.value.slice(caret);
  ta.selectionStart = ta.selectionEnd = acState.start;
  addRef(entry.item.path);
  closeAc();
  autoGrow();
  ta.focus();
}

async function loadWorkspaceFiles(force) {
  if (workspaceFiles.length && !force) return workspaceFiles;
  try {
    const r = await fetch('/api/files');
    const j = await r.json();
    workspaceFiles = Array.isArray(j.files) ? j.files : [];
  } catch {
    workspaceFiles = [];
  }
  if (acState && acState.kind === 'file') updateAc();
  return workspaceFiles;
}

function addRef(path) {
  if (!path || refs.includes(path)) return;
  refs.push(path);
  renderRefs();
}
function removeRef(path) {
  refs = refs.filter((p) => p !== path);
  renderRefs();
}
function clearRefs() {
  refs = [];
  renderRefs();
}
function renderRefs() {
  const bar = $('ref-bar');
  if (!refs.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML =
    '<span class="ref-label">引用</span>' +
    refs.map((p) =>
      `<span class="ref-chip" title="${escapeHtml(p)}">${escapeHtml(p)}` +
      `<button class="ref-x" data-p="${escapeHtml(p)}" aria-label="移除">✕</button></span>`
    ).join('');
  bar.querySelectorAll('.ref-x').forEach((b) => { b.onclick = () => removeRef(b.dataset.p); });
}

// ---------- misc ----------
function autoGrow() {
  const ta = $('input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
}

function updateWorkspaceChip(ok) {
  const dot = $('conn-status');
  dot.className = 'ws-dot ' + (ok ? 'ok' : 'err');
  const label = $('workspace-label');
  if (ok) {
    const parts = workspacePath.split(/[\\/]/).filter(Boolean);
    label.textContent = parts.slice(-2).join('/') || workspacePath;
    label.title = workspacePath;
  } else {
    label.textContent = '本地服务未连接';
    label.title = '运行 start.cmd 或 node server.js';
  }
}

async function pingHealth() {
  try {
    const r = await fetch('/api/health');
    const j = await r.json();
    const firstConnect = !workspacePath && j.workspace;
    workspacePath = j.workspace || '';
    updateWorkspaceChip(!!j.ok);
    if (firstConnect) loadWorkspaceFiles(true);
  } catch {
    updateWorkspaceChip(false);
  }
}

// ── Autonomous goals board ("fire and forget" + self-verify) ──────────────────
let goalsPoll = null;

function openGoals() {
  $('goals-modal').classList.remove('hidden');
  $('goal-msg').textContent = '';
  refreshGoals();
}
function closeGoals() {
  $('goals-modal').classList.add('hidden');
  if (goalsPoll) {
    clearInterval(goalsPoll);
    goalsPoll = null;
  }
}

async function refreshGoals() {
  try {
    const r = await fetch('/api/goals').then((x) => x.json());
    renderGoals(r.goals || []);
  } catch (e) {
    $('goals-list').innerHTML = `<div class="muted small">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function statusLabel(s) {
  return (
    { queued: '排队中', running: '执行中', done: '已完成', failed: '失败', stopped: '已停止', interrupted: '已中断' }[s] ||
    s
  );
}

function goalCard(g) {
  const badge = `<span class="goal-badge ${g.status}">${statusLabel(g.status)}</span>`;
  const stopBtn =
    g.running || g.status === 'running' ? `<button class="mini-btn" data-stop="${g.id}">停止</button>` : '';
  const detail = `
    <div id="goal-detail-${g.id}" class="goal-detail hidden">
      ${g.plan ? `<div class="goal-sub"><b>计划</b><pre class="goal-pre">${escapeHtml(g.plan)}</pre></div>` : ''}
      <div class="goal-sub"><b>进度日志</b><div class="goal-log">${
        (g.log || [])
          .slice(-80)
          .map(
            (l) =>
              `<div class="goal-line ${l.type}"><span class="gl-t">${new Date(l.t).toLocaleTimeString()}</span> ${escapeHtml(
                l.text
              )}</div>`
          )
          .join('') || '<span class="muted">（暂无）</span>'
      }</div></div>
      ${g.report ? `<div class="goal-sub"><b>最终报告</b><pre class="goal-pre">${escapeHtml(g.report)}</pre></div>` : ''}
      ${g.verdict ? `<div class="goal-sub"><b>验收结论</b> ${escapeHtml(g.verdict)}</div>` : ''}
      ${g.error ? `<div class="goal-sub goal-err"><b>说明</b> ${escapeHtml(g.error)}</div>` : ''}
    </div>`;
  return `
    <div class="goal-card">
      <div class="goal-card-head">
        <div class="goal-meta">
          <div class="goal-name">${escapeHtml(g.title)}</div>
          <div class="goal-goal muted small">${escapeHtml(g.goal)}</div>
        </div>
        <div class="goal-right">
          ${badge}
          <button class="mini-btn" data-toggle="${g.id}">详情</button>
          <button class="mini-btn" data-del="${g.id}">删除</button>
          ${stopBtn}
        </div>
      </div>
      <div class="goal-foot muted small">步数 ${g.turns || 0} · 花费 ¥${(g.cost || 0).toFixed(4)}${
    g.attempt > 1 ? ' · 尝试 ' + g.attempt : ''
  } · ${new Date(g.updatedAt).toLocaleString()}</div>
      ${detail}
    </div>`;
}

function renderGoals(goals) {
  const list = $('goals-list');
  $('goals-count').textContent = goals.length ? `${goals.length} 个` : '';
  if (!goals.length) {
    list.innerHTML = `<div class="muted small">还没有目标。在上面描述一个目标，交给 Agent 自治执行。</div>`;
    return;
  }
  list.innerHTML = goals.map((g) => goalCard(g)).join('');
  list.querySelectorAll('[data-stop]').forEach((b) => {
    b.onclick = () => stopGoal(b.getAttribute('data-stop'));
  });
  list.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => deleteGoal(b.getAttribute('data-del'));
  });
  list.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = () => {
      const d = $('goal-detail-' + b.getAttribute('data-toggle'));
      if (d) d.classList.toggle('hidden');
    };
  });
  const running = goals.some((g) => g.running || g.status === 'running');
  if (running && !goalsPoll) goalsPoll = setInterval(refreshGoals, 1500);
  else if (!running && goalsPoll) {
    clearInterval(goalsPoll);
    goalsPoll = null;
  }
}

async function assignGoal() {
  const goal = $('goal-input').value.trim();
  if (!goal) {
    $('goal-msg').textContent = '请先描述一个目标。';
    return;
  }
  const title = $('goal-title').value.trim();
  $('goal-assign').disabled = true;
  $('goal-msg').textContent = '已委派，Agent 开始自治执行…';
  try {
    const budget = {};
    const mt = parseFloat($('goal-maxturns').value);
    const mc = parseFloat($('goal-maxcost').value);
    const rt = parseInt($('goal-retries').value, 10);
    if (Number.isFinite(mt) && mt > 0) budget.maxTurns = mt;
    if (Number.isFinite(mc) && mc > 0) budget.maxCostUSD = mc;
    if (Number.isFinite(rt) && rt >= 0) budget.retries = rt;
    const body = { goal, title, config: Object.assign({}, config) };
    // A goal always uses its OWN rails (resolveBudget in goals.js). Never let the
    // interactive-chat budget (e.g. the $3 default) leak in and silently cap a
    // delegated goal — so strip it when the goal form is left empty.
    if (Object.keys(budget).length) body.config.budget = budget;
    else delete body.config.budget;
    const r = await fetch('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then((x) => x.json());
    if (!r.ok) $('goal-msg').textContent = '委派失败：' + (r.error || '未知错误');
    else {
      $('goal-input').value = '';
      $('goal-title').value = '';
      $('goal-maxturns').value = '';
      $('goal-maxcost').value = '';
      $('goal-retries').value = '';
      $('goal-msg').textContent = '已创建目标 ' + r.id + '，正在执行（可关闭本面板，进度会自动保存）。';
      refreshGoals();
    }
  } catch (e) {
    $('goal-msg').textContent = '委派失败：' + e.message;
  } finally {
    $('goal-assign').disabled = false;
  }
}

async function stopGoal(id) {
  try {
    await fetch('/api/goals/' + encodeURIComponent(id) + '/stop', { method: 'POST' });
  } catch {
    /* ignore */
  }
  refreshGoals();
}

async function deleteGoal(id) {
  try {
    await fetch('/api/goals/' + encodeURIComponent(id), { method: 'DELETE' });
  } catch {
    /* ignore */
  }
  refreshGoals();
}

// ---------- Agenite Atlas: the living memory graph ----------

const ATLAS_COLORS = {
  person: '#ff7a59', project: '#6ea8ff', concept: '#c879ff', file: '#46c8a0',
  tool: '#f5c451', preference: '#ff8fb3', fact: '#7fd1ff', event: '#9aa7ff'
};
const ATLAS_TYPE_LABELS = {
  person: '人物', project: '项目', concept: '概念', file: '文件',
  tool: '工具', preference: '偏好', fact: '事实', event: '事件'
};
const atlasState = { graph: null, pos: {}, k: 1, tx: 0, ty: 0, drag: null, pan: null, sel: null };

function openAtlas() {
  $('atlas-modal').classList.remove('hidden');
  atlasInitEvents();
  refreshAtlas();
}
function closeAtlas() {
  $('atlas-modal').classList.add('hidden');
}

async function refreshAtlas() {
  try {
    const r = await fetch('/api/atlas').then((x) => x.json());
    atlasState.graph = r.graph || { nodes: {}, edges: [] };
    renderAtlas();
  } catch (e) {
    $('atlas-stats').textContent = '加载失败：' + e.message;
  }
}

// Lightweight force-directed layout (synchronous; fine for personal graphs).
function atlasLayout(graph) {
  const ids = Object.keys(graph.nodes);
  const N = ids.length;
  const pos = {};
  const cx = 0, cy = 0;
  ids.forEach((id, i) => {
    const a = (i / Math.max(1, N)) * Math.PI * 2;
    pos[id] = { x: Math.cos(a) * 230 + (Math.random() - 0.5) * 30, y: Math.sin(a) * 230 + (Math.random() - 0.5) * 30, vx: 0, vy: 0 };
  });
  if (!N) return pos;
  const iters = N > 140 ? 120 : 260;
  const W = 130;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < N; i++) {
      const pa = pos[ids[i]];
      for (let j = i + 1; j < N; j++) {
        const pb = pos[ids[j]];
        let dx = pa.x - pb.x, dy = pa.y - pb.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { d2 = 0.01; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
        const d = Math.sqrt(d2);
        const f = 2600 / d2;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        pa.vx += fx; pa.vy += fy; pb.vx -= fx; pb.vy -= fy;
      }
    }
    for (const e of graph.edges) {
      const pa = pos[e.from], pb = pos[e.to];
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - W) * 0.045;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      pa.vx += fx; pa.vy += fy; pb.vx -= fx; pb.vy -= fy;
    }
    for (const id of ids) {
      const p = pos[id];
      p.vx = p.vx * 0.86 - p.x * 0.0018;
      p.vy = p.vy * 0.86 - p.y * 0.0018;
      p.x += p.vx; p.y += p.vy;
    }
  }
  return pos;
}

function atlasEdgeColor(e) {
  return 'var(--border-strong)';
}

function renderAtlas() {
  const g = atlasState.graph || { nodes: {}, edges: [] };
  const ids = Object.keys(g.nodes);
  const stats = $('atlas-stats');
  const empty = $('atlas-empty');
  if (!ids.length) {
    empty.classList.remove('hidden');
    stats.textContent = '';
  } else {
    empty.classList.add('hidden');
    const types = {};
    ids.forEach((id) => { const t = g.nodes[id].type; types[t] = (types[t] || 0) + 1; });
    stats.textContent = `${ids.length} 节点 · ${g.edges.length} 关系`;
  }
  // (re)layout only when graph identity changed — preserve positions on rescale
  const sig = ids.length + ':' + g.edges.length + ':' + ids.join(',').length;
  if (atlasState.sig !== sig || !atlasState.pos || Object.keys(atlasState.pos).length !== ids.length) {
    atlasState.pos = atlasLayout(g);
    atlasState.sig = sig;
  }
  const pos = atlasState.pos;
  const svg = $('atlas-svg');
  const w = svg.clientWidth || 800, h = svg.clientHeight || 520;

  let edgeSvg = '';
  for (const e of g.edges) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) continue;
    const color = ATLAS_COLORS[g.nodes[e.from] && g.nodes[e.from].type] || '#9aa3b2';
    edgeSvg += `<line class="atlas-edge" data-edge="${e.id}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${color}"></line>`;
    if (e.label) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      edgeSvg += `<text class="atlas-edge-label" x="${mx.toFixed(1)}" y="${(my - 3).toFixed(1)}" text-anchor="middle">${escapeHtml(e.label)}</text>`;
    }
  }
  let nodeSvg = '';
  for (const id of ids) {
    const n = g.nodes[id];
    const p = pos[id];
    if (!p) continue;
    const r = 9 + Math.min(16, (n.degree || 0) * 2.4);
    const color = ATLAS_COLORS[n.type] || '#9aa3b2';
    const label = n.label.length > 14 ? n.label.slice(0, 13) + '…' : n.label;
    nodeSvg += `<g class="atlas-node${atlasState.sel === id ? ' sel' : ''}" data-node="${id}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">
      <circle r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.18" stroke="${color}"></circle>
      <circle r="3.4" class="dot-mark" fill="${color}"></circle>
      <text x="0" y="${(r + 13).toFixed(1)}" text-anchor="middle">${escapeHtml(label)}</text>
    </g>`;
  }
  svg.innerHTML = `<g id="atlas-g">${edgeSvg}${nodeSvg}</g>`;
  // center the view on first render
  if (atlasState.firstRender !== sig) {
    atlasFit();
    atlasState.firstRender = sig;
  } else {
    atlasApplyTransform();
  }
  atlasRenderLegend();
  atlasApplySearch();
}

function atlasApplyTransform() {
  const g = $('atlas-svg').querySelector('#atlas-g');
  if (g) g.setAttribute('transform', `translate(${atlasState.tx.toFixed(1)},${atlasState.ty.toFixed(1)}) scale(${atlasState.k.toFixed(3)})`);
}

function atlasFit() {
  const g = atlasState.graph || { nodes: {} };
  const ids = Object.keys(g.nodes);
  const svg = $('atlas-svg');
  const w = svg.clientWidth || 800, h = svg.clientHeight || 520;
  if (!ids.length) { atlasState.k = 1; atlasState.tx = w / 2; atlasState.ty = h / 2; atlasApplyTransform(); return; }
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const id of ids) { const p = atlasState.pos[id]; if (!p) continue; minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const gw = Math.max(1, maxX - minX), gh = Math.max(1, maxY - minY);
  const pad = 70;
  const k = Math.min(2, Math.max(0.3, Math.min((w - pad * 2) / gw, (h - pad * 2) / gh)));
  atlasState.k = k;
  atlasState.tx = w / 2 - ((minX + maxX) / 2) * k;
  atlasState.ty = h / 2 - ((minY + maxY) / 2) * k;
  atlasApplyTransform();
}

function atlasRenderLegend() {
  const box = $('atlas-legend');
  box.innerHTML = Object.keys(ATLAS_TYPE_LABELS).map((t) =>
    `<div class="lg-item"><span class="lg-dot" style="background:${ATLAS_COLORS[t]};color:${ATLAS_COLORS[t]}"></span>${t} · ${ATLAS_TYPE_LABELS[t]}</div>`
  ).join('');
}

function atlasApplySearch() {
  const q = ($('atlas-search').value || '').trim().toLowerCase();
  const g = atlasState.graph || { nodes: {}, edges: [] };
  const svg = $('atlas-svg');
  if (!q) {
    svg.querySelectorAll('.atlas-node').forEach((n) => n.classList.remove('dim'));
    svg.querySelectorAll('.atlas-edge').forEach((n) => n.classList.remove('dim'));
    return;
  }
  const matches = new Set();
  for (const id of Object.keys(g.nodes)) {
    const n = g.nodes[id];
    if ((n.label + ' ' + (n.description || '') + ' ' + n.type).toLowerCase().includes(q)) matches.add(id);
  }
  svg.querySelectorAll('.atlas-node').forEach((el) => {
    el.classList.toggle('dim', !matches.has(el.getAttribute('data-node')));
  });
  svg.querySelectorAll('.atlas-edge').forEach((el) => {
    const e = g.edges.find((x) => x.id === el.getAttribute('data-edge'));
    const hit = e && (matches.has(e.from) || matches.has(e.to));
    el.classList.toggle('dim', !hit);
  });
}

function atlasShowDetail(id) {
  const g = atlasState.graph;
  const n = g.nodes[id];
  if (!n) return;
  atlasState.sel = id;
  const panel = $('atlas-detail');
  const rels = g.edges.filter((e) => e.from === id || e.to === id).map((e) => {
    const other = e.from === id ? e.to : e.from;
    const name = g.nodes[other] ? g.nodes[other].label : other;
    const dir = e.from === id ? '→' : '←';
    return `<div class="ad-rel"><span class="rel-type">${escapeHtml(e.type)}</span><span class="rel-name">${dir} ${escapeHtml(name)}</span></div>`;
  }).join('') || '<div class="muted small">暂无关系</div>';
  panel.innerHTML = `
    <div class="ad-title"><span style="width:10px;height:10px;border-radius:50%;background:${ATLAS_COLORS[n.type] || '#9aa3b2'}"></span>${escapeHtml(n.label)}</div>
    <div class="ad-type">${escapeHtml(n.type)} · ${ATLAS_TYPE_LABELS[n.type] || n.type}</div>
    ${n.description ? `<div class="ad-desc">${escapeHtml(n.description)}</div>` : ''}
    <div class="ad-row">连接数：<b>${n.degree || 0}</b></div>
    ${rels}
    <button class="mini-btn ad-recall" id="atlas-recall">回忆相关对话</button>
    <div id="atlas-recall-res" class="ad-recall-res"></div>
    <button class="mini-btn danger-text ad-del" id="atlas-del-node">删除该节点</button>`;
  panel.classList.remove('hidden');
  $('atlas-del-node').onclick = () => atlasRemoveNode(id);
  $('atlas-recall').onclick = () => atlasRecall(n.label);
  renderAtlas(); // refresh selection ring
}

async function atlasAddNode() {
  const type = $('atlas-type').value;
  const label = $('atlas-label').value.trim();
  const description = $('atlas-desc').value.trim();
  if (!label) { $('atlas-msg').textContent = '请填写名称。'; return; }
  $('atlas-msg').textContent = '添加中…';
  try {
    const r = await fetch('/api/atlas', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', type, label, description })
    }).then((x) => x.json());
    if (!r.ok) $('atlas-msg').textContent = '失败：' + (r.error || '');
    else { $('atlas-label').value = ''; $('atlas-desc').value = ''; $('atlas-msg').textContent = '已添加「' + label + '」。'; refreshAtlas(); }
  } catch (e) { $('atlas-msg').textContent = '失败：' + e.message; }
}

async function atlasRemoveNode(id) {
  try {
    await fetch('/api/atlas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove_node', id }) });
  } catch { /* ignore */ }
  atlasState.sel = null;
  $('atlas-detail').classList.add('hidden');
  refreshAtlas();
}

async function atlasReset() {
  if (!confirm('确定要清空整张记忆图谱吗？此操作不可撤销。')) return;
  try {
    await fetch('/api/atlas', { method: 'DELETE' });
  } catch { /* ignore */ }
  atlasState.sel = null;
  $('atlas-detail').classList.add('hidden');
  refreshAtlas();
}

async function atlasBuild() {
  const conv = conversations.find((c) => c.id === currentId);
  if (!conv || !conv.messages || !conv.messages.length) {
    $('atlas-msg').textContent = '当前没有对话内容可抽取。';
    return;
  }
  const text = conv.messages.slice(-40).map((m) => {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return `[${m.role}] ${c}`;
  }).join('\n').slice(-7000);
  $('atlas-msg').textContent = '模型抽取中（需要有效的模型与 API Key）…';
  $('atlas-build').disabled = true;
  try {
    const r = await fetch('/api/atlas/extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, config: Object.assign({}, config) })
    }).then((x) => x.json());
    if (!r.ok) $('atlas-msg').textContent = '抽取失败：' + (r.error || '');
    else {
      const a = r.applied || { added: 0, linked: 0 };
      $('atlas-msg').textContent = `已抽取：新增 ${a.added} 节点、建立 ${a.linked} 关系。`;
      refreshAtlas();
    }
  } catch (e) { $('atlas-msg').textContent = '抽取失败：' + e.message; }
  finally { $('atlas-build').disabled = false; }
}

// Export the current graph as a downloadable, hand-editable Markdown file.
async function atlasExport() {
  try {
    const r = await fetch('/api/atlas/markdown').then((x) => x.json());
    if (!r.ok) { $('atlas-msg').textContent = '导出失败：' + (r.error || ''); return; }
    const blob = new Blob([r.markdown || ''], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'atlas.md';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
    $('atlas-msg').textContent = '已导出 atlas.md（可手改后导入合并）。';
  } catch (e) { $('atlas-msg').textContent = '导出失败：' + e.message; }
}

// Import a (possibly hand-edited) Markdown file and merge it back into the graph.
async function atlasImportFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  $('atlas-msg').textContent = '导入中…';
  try {
    const md = await file.text();
    const r = await fetch('/api/atlas/markdown', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: md })
    }).then((x) => x.json());
    if (!r.ok) $('atlas-msg').textContent = '导入失败：' + (r.error || '');
    else {
      const a = r.applied || { added: 0, linked: 0 };
      $('atlas-msg').textContent = `已合并：新增 ${a.added} 节点、${a.linked} 关系。`;
      refreshAtlas();
    }
  } catch (err) { $('atlas-msg').textContent = '导入失败：' + err.message; }
  finally { e.target.value = ''; }
}

// Recall where this entity appeared across past conversations.
async function atlasRecall(label) {
  const box = $('atlas-recall-res');
  if (!box) return;
  box.innerHTML = '<div class="muted small">检索历史对话中…</div>';
  try {
    const r = await fetch('/api/atlas/recall?label=' + encodeURIComponent(label)).then((x) => x.json());
    const ms = r.matches || [];
    if (!ms.length) { box.innerHTML = '<div class="muted small">历史对话中没有找到相关片段。</div>'; return; }
    box.innerHTML = ms.map((m) => {
      const date = m.updatedAt ? new Date(m.updatedAt).toLocaleDateString() : '';
      return `<div class="ad-snip"><div class="ad-snip-meta">${escapeHtml(m.title || '会话')} · ${escapeHtml(m.role || '')} · ${date}</div><div class="ad-snip-text">${escapeHtml(m.snippet || '')}</div></div>`;
    }).join('');
  } catch (err) { box.innerHTML = '<div class="muted small">检索失败：' + err.message + '</div>'; }
}

// Landing: if the graph already has content, open Atlas automatically so the
// user lands on their living memory rather than an empty chat box.
async function maybeOpenAtlasOnBoot() {
  if (config.atlasAutoOpen === false) return;
  try {
    const r = await fetch('/api/atlas').then((x) => x.json());
    if (r && r.stats && r.stats.nodes > 0) setTimeout(openAtlas, 350);
  } catch { /* ignore — atlas stays closed */ }
}

// --- interactions (attached once) ---
let atlasEventsBound = false;
function atlasInitEvents() {
  const svg = $('atlas-svg');
  if (atlasEventsBound) return;
  atlasEventsBound = true;

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const wx = (mx - atlasState.tx) / atlasState.k;
    const wy = (my - atlasState.ty) / atlasState.k;
    const nk = Math.min(3, Math.max(0.25, atlasState.k * (e.deltaY < 0 ? 1.12 : 0.89)));
    atlasState.k = nk;
    atlasState.tx = mx - wx * nk;
    atlasState.ty = my - wy * nk;
    atlasApplyTransform();
  }, { passive: false });

  svg.addEventListener('pointerdown', (e) => {
    const nodeEl = e.target.closest('.atlas-node');
    if (nodeEl) {
      const id = nodeEl.getAttribute('data-node');
      atlasState.drag = { id, sx: e.clientX, sy: e.clientY, moved: false, ox: atlasState.pos[id].x, oy: atlasState.pos[id].y };
    } else {
      atlasState.pan = { sx: e.clientX, sy: e.clientY, tx: atlasState.tx, ty: atlasState.ty };
      svg.classList.add('grabbing');
    }
    svg.setPointerCapture(e.pointerId);
  });

  svg.addEventListener('pointermove', (e) => {
    if (atlasState.drag) {
      const d = atlasState.drag;
      const dx = (e.clientX - d.sx) / atlasState.k;
      const dy = (e.clientY - d.sy) / atlasState.k;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) d.moved = true;
      const p = atlasState.pos[d.id];
      p.x = d.ox + dx; p.y = d.oy + dy;
      const el = svg.querySelector(`.atlas-node[data-node="${d.id}"]`);
      if (el) el.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      const g = atlasState.graph;
      for (const ed of g.edges) {
        if (ed.from !== d.id && ed.to !== d.id) continue;
        const line = svg.querySelector(`.atlas-edge[data-edge="${ed.id}"]`);
        if (!line) continue;
        const a = atlasState.pos[ed.from], b = atlasState.pos[ed.to];
        line.setAttribute('x1', a.x.toFixed(1)); line.setAttribute('y1', a.y.toFixed(1));
        line.setAttribute('x2', b.x.toFixed(1)); line.setAttribute('y2', b.y.toFixed(1));
      }
    } else if (atlasState.pan) {
      atlasState.tx = atlasState.pan.tx + (e.clientX - atlasState.pan.sx);
      atlasState.ty = atlasState.pan.ty + (e.clientY - atlasState.pan.sy);
      atlasApplyTransform();
    }
  });

  const endDrag = (e) => {
    if (atlasState.drag) {
      if (!atlasState.drag.moved) atlasShowDetail(atlasState.drag.id);
      atlasState.drag = null;
    }
    if (atlasState.pan) { atlasState.pan = null; svg.classList.remove('grabbing'); }
    try { svg.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
}

// --- Agenite Run Trace (agent observability) ---
// The panel renders a live trace during a run (fed by the same SSE stream the
// chat uses) and replays past runs fetched from /api/traces. This is the
// "decision evidence chain": model turns, tool-call spans, sub-agent handoffs
// and context compactions — so a healthy-looking 200 can still be audited.
let liveTrace = null;
let traceTurnId = null;
let traceSubId = null;
let historyTrace = null; // non-null => viewing a past run instead of live

const TRACE_ICON = {
  turn: '🧠', tool: '🔧', subagent: '🤖', compact: '🗜️'
};
const TRACE_KIND_LABEL = { tool: '工具', memory: '记忆', mcp: 'MCP', subagent: '子智能体', compact: '压缩', turn: '推理' };

function traceClassify(name) {
  if (name && name.startsWith('memory_')) return 'memory';
  if (name && name.startsWith('mcp__')) return 'mcp';
  return 'tool';
}

function traceReset(title) {
  liveTrace = {
    runId: 'live_' + Date.now().toString(36),
    title: (title || '').slice(0, 80),
    steps: [],
    stats: { steps: 0, tools: 0, subagents: 0, errors: 0, compactions: 0, memoryOps: 0, totalMs: 0 },
    cost: 0, stopped: null, turns: 0, startedAt: null, finishedAt: null
  };
  traceTurnId = null;
  traceSubId = null;
}

function traceAdd(step) {
  const s = Object.assign(
    { id: 's' + (liveTrace.steps.length + 1), parentId: null, kind: 'turn', name: '', ts: Date.now(), ms: 0, status: 'ok', data: {}, children: [] },
    step
  );
  liveTrace.steps.push(s);
  if (s.parentId) {
    const p = liveTrace.steps.find((x) => x.id === s.parentId);
    if (p) p.children.push(s.id);
  }
  const st = liveTrace.stats;
  st.steps++;
  if (s.kind === 'tool') {
    st.tools++;
    if (s.status !== 'ok') st.errors++;
    if (traceClassify(s.name) === 'memory') st.memoryOps++;
  } else if (s.kind === 'subagent') st.subagents++;
  else if (s.kind === 'compact') st.compactions++;
  st.totalMs += s.ms || 0;
  return s;
}

function traceOnEvent(type, payload) {
  if (!liveTrace) return;
  if (type === 'assistant') {
    if (!liveTrace.startedAt) liveTrace.startedAt = Date.now();
    const s = traceAdd({ kind: 'turn', name: '推理 / 模型回复', parentId: traceSubId || null, data: { content: typeof payload?.content === 'string' ? payload.content : '', toolCalls: (payload?.tool_calls || []).length } });
    traceTurnId = s.id;
  } else if (type === 'tool') {
    traceAdd({ kind: 'tool', name: payload?.name || '', parentId: traceSubId || traceTurnId || null, ms: payload?.ms || 0, status: payload?.ok === false ? 'error' : 'ok', data: { args: payload?.args || {}, result: payload?.result, ok: payload?.ok, kind: traceClassify(payload?.name || '') } });
  } else if (type === 'compact') {
    traceAdd({ kind: 'compact', name: '上下文压缩', data: payload || {} });
  } else if (type === 'subagent') {
    const ev = payload?.event;
    if (ev === 'start') {
      const s = traceAdd({ kind: 'subagent', name: payload?.name || '子智能体', parentId: traceTurnId || null });
      traceSubId = s.id;
    } else if (ev === 'tool') {
      traceAdd({ kind: 'tool', name: payload?.name || '', parentId: traceSubId || null, ms: payload?.ms || 0, status: payload?.ok === false ? 'error' : 'ok', data: { args: payload?.args || {}, result: payload?.result, ok: payload?.ok, kind: traceClassify(payload?.name || ''), sub: true } });
    } else if (ev === 'done') {
      traceSubId = null;
    }
  } else if (type === 'usage') {
    if (payload?.cost != null) liveTrace.cost = payload.cost;
  } else if (type === 'done') {
    liveTrace.finishedAt = Date.now();
    liveTrace.stopped = payload?.stopped || null;
    liveTrace.turns = payload?.turns || 0;
  } else if (type === 'diagnosis') {
    liveTrace.diagnosis = payload || null;
  }
  // Re-render the timeline if the panel is open (skip the high-frequency deltas).
  if (type !== 'delta' && $('trace-modal') && !$('trace-modal').classList.contains('hidden') && !historyTrace) renderTrace();
}

function traceDepth(trace) {
  const map = {};
  const depthOf = (id) => {
    if (map[id] != null) return map[id];
    const s = trace.steps.find((x) => x.id === id);
    const d = !s || !s.parentId ? 0 : depthOf(s.parentId) + 1;
    map[id] = d;
    return d;
  };
  for (const s of trace.steps) depthOf(s.id);
  return map;
}

function traceConsecutive(trace, min = 3) {
  let best = null, cur = null;
  for (const s of trace.steps) {
    if (s.kind !== 'tool') { cur = null; continue; }
    const key = s.name + '|' + JSON.stringify(s.data.args || {});
    if (cur && cur.key === key) cur.count++;
    else cur = { key, name: s.name, count: 1 };
    if (!best || cur.count > best.count) best = { ...cur };
  }
  return best && best.count >= Math.max(2, min) ? best : null;
}

function fmtMs(ms) {
  if (ms == null) return '—';
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
}

function traceStepHtml(s, depth) {
  const icon = TRACE_ICON[s.kind] || '•';
  const kind = s.kind === 'tool' ? (s.data.kind || 'tool') : s.kind;
  const kindLabel = TRACE_KIND_LABEL[kind] || s.kind;
  const err = s.status === 'error' ? ' tstep-err' : '';
  const title = escapeHtml(s.name || kindLabel);
  let detail = '';
  if (s.kind === 'tool') {
    const args = s.data.args != null ? (typeof s.data.args === 'string' ? s.data.args : JSON.stringify(s.data.args)) : '';
    const res = s.data.result != null ? (typeof s.data.result === 'string' ? s.data.result : JSON.stringify(s.data.result)) : '';
    detail = `<details class="tstep-detail"><summary>参数 / 结果</summary>` +
      (args ? `<div class="tstep-kv"><b>参数</b><pre>${escapeHtml(String(args).slice(0, 1200))}</pre></div>` : '') +
      (res ? `<div class="tstep-kv"><b>结果</b><pre>${escapeHtml(String(res).slice(0, 1200))}</pre></div>` : '') +
      `</details>`;
  } else if (s.kind === 'turn') {
    const c = s.data.content || '';
    detail = c ? `<div class="tstep-content">${escapeHtml(c.slice(0, 1500))}</div>` : '';
  } else if (s.kind === 'compact') {
    const d = s.data || {};
    detail = `<div class="tstep-content muted small">上下文 ${fmtTok(d.before)} → ${fmtTok(d.after)}（丢弃 ${d.dropped || 0} 组）</div>`;
  }
  return `<div class="tstep${err}" style="margin-left:${(depth || 0) * 18}px">` +
    `<div class="tstep-head"><span class="tstep-ic">${icon}</span>` +
    `<span class="tstep-kind">${kindLabel}</span>` +
    `<span class="tstep-name">${title}</span>` +
    (s.ms ? `<span class="tstep-ms">${fmtMs(s.ms)}</span>` : '') +
    (s.status === 'error' ? '<span class="tstep-bad">失败</span>' : '') +
    `</div>${detail}</div>`;
}

function fmtTok(n) { return n == null ? '—' : (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)) + ' tok'; }

function stoppedLabel(s) {
  return s === 'done' ? '完成' : s === 'max_turns' ? '达步数上限' : s === 'error' ? '出错' : (s || '运行中');
}

function renderTrace() {
  const trace = historyTrace || liveTrace;
  const tl = $('trace-timeline');
  const chips = $('trace-chips');
  const loop = $('trace-loop');
  if (!trace) {
    tl.innerHTML = '<div class="atlas-empty"><p class="muted small">还没有运行记录。发一条消息即可开始追踪。</p></div>';
    chips.innerHTML = ''; loop.classList.add('hidden');
    return;
  }
  const st = trace.stats || { steps: 0, tools: 0, subagents: 0, errors: 0, compactions: 0, memoryOps: 0, totalMs: 0 };
  chips.innerHTML =
    chip('步数', st.steps) + chip('工具', st.tools) + chip('子智能体', st.subagents) +
    chip('错误', st.errors, st.errors ? 'chip-bad' : '') + chip('记忆', st.memoryOps) +
    chip('耗时', fmtMs(st.totalMs)) + chip('成本', '$' + (trace.cost || 0).toFixed(4)) +
    chip('轮次', trace.turns || 0) + chip('状态', stoppedLabel(trace.stopped));
  const consec = traceConsecutive(trace, 3);
  if (consec) {
    loop.classList.remove('hidden');
    loop.innerHTML = `⚠ 检测到 <b>${consec.count}</b> 次重复调用 <code>${escapeHtml(consec.name)}</code>（参数相同）—— 可能空转 / 死循环，已消耗预算却无进展。`;
  } else {
    loop.classList.add('hidden');
  }
  // Graded self-check (ok / warn / bad). Surfaced from the server's diagnoseTrace
  // so the user sees WHAT to worry about, not just that the run happened.
  const diagEl = $('trace-diagnosis');
  const diag = trace.diagnosis;
  if (diag && diag.severity && diag.severity !== 'ok') {
    diagEl.classList.remove('hidden');
    const sevCls = diag.severity === 'bad' ? 'sev-bad' : 'sev-warn';
    const sevIco = diag.severity === 'bad' ? '✕' : '⚠';
    const sevLabel = diag.severity === 'bad' ? '发现问题' : '需要关注';
    const items = (diag.findings || []).map((f) => {
      const fi = f.level === 'bad' ? '✕' : '⚠';
      return `<div class="td-item ${f.level === 'bad' ? 'fb' : 'fw'}"><span class="tdi-ico">${fi}</span>` +
        `<div><div class="tdi-title">${escapeHtml(f.title)}</div>` +
        (f.detail ? `<div class="tdi-detail">${escapeHtml(f.detail)}</div>` : '') + '</div></div>';
    }).join('');
    diagEl.className = 'trace-diagnosis ' + sevCls;
    diagEl.innerHTML = `<div class="td-head"><span class="td-ico">${sevIco}</span><span class="td-title">运行自检 · ${sevLabel}</span>` +
      `<span class="td-count">${diag.findings.length} 项</span></div>${items}`;
  } else if (diag && diag.severity === 'ok') {
    diagEl.classList.remove('hidden');
    diagEl.className = 'trace-diagnosis sev-ok';
    diagEl.innerHTML = `<div class="td-head"><span class="td-ico">✓</span><span class="td-title">运行自检 · 正常</span>` +
      `<span class="td-count">未检测到异常</span></div>`;
  } else {
    diagEl.classList.add('hidden');
  }
  const depths = traceDepth(trace);
  tl.innerHTML = trace.steps.length
    ? trace.steps.map((s) => traceStepHtml(s, depths[s.id])).join('')
    : '<div class="atlas-empty"><p class="muted small">本运行还没有步骤（可能已结束或尚未开始）。</p></div>';
}

function chip(label, val, cls = '') {
  return `<span class="tchip ${cls}"><b>${escapeHtml(String(val))}</b><i>${label}</i></span>`;
}

async function loadTraceHistory() {
  const box = $('trace-history');
  box.innerHTML = '<div class="muted small">加载中…</div>';
  try {
    const r = await fetch('/api/traces').then((x) => x.json());
    const list = (r && r.traces) || [];
    $('trace-hist-count').textContent = '(' + list.length + ')';
    if (!list.length) { box.innerHTML = '<div class="muted small">暂无历史运行。</div>'; return; }
    box.innerHTML = list.map((t) => {
      const loop = t.consecutiveLoop ? ' <span class="th-loop" title="检测到重复调用">⚠循环</span>' : '';
      const err = t.stats && t.stats.errors ? ' th-err' : '';
      return `<div class="th-item${err}" data-run="${escapeHtml(t.runId)}">` +
        `<div class="th-top"><span class="th-title">${escapeHtml(t.title || '(无标题)')}</span>${loop}</div>` +
        `<div class="th-meta muted small">${new Date(t.createdAt).toLocaleString()} · ${stoppedLabel(t.stopped)} · ${t.stats ? t.stats.steps : 0}步 / ${t.stats ? t.stats.tools : 0}工具 / $${(t.cost || 0).toFixed(4)}</div>` +
        `<button class="th-del mini-btn danger-text" data-run="${escapeHtml(t.runId)}" title="删除该轨迹">删除</button>` +
        `</div>`;
    }).join('');
    box.querySelectorAll('.th-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('th-del')) return;
        openHistoryTrace(el.getAttribute('data-run'));
      });
    });
    box.querySelectorAll('.th-del').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); deleteHistoryTrace(el.getAttribute('data-run')); });
    });
  } catch {
    box.innerHTML = '<div class="muted small">加载失败。</div>';
  }
}

async function openHistoryTrace(runId) {
  try {
    const r = await fetch('/api/traces/' + encodeURIComponent(runId)).then((x) => x.json());
    if (!r.ok) return;
    historyTrace = r.trace;
    historyTrace.diagnosis = r.diagnosis || null;
    $('trace-title').textContent = '回放：' + (r.trace.title || runId);
    renderTrace();
  } catch { /* ignore */ }
}

async function deleteHistoryTrace(runId) {
  try {
    await fetch('/api/traces/' + encodeURIComponent(runId), { method: 'DELETE' });
    if (historyTrace && historyTrace.runId === runId) { historyTrace = null; $('trace-title').textContent = '实时轨迹'; }
    await loadTraceHistory();
  } catch { /* ignore */ }
}

function openTrace() {
  $('trace-modal').classList.remove('hidden');
  historyTrace = null;
  $('trace-title').textContent = '实时轨迹';
  renderTrace();
  loadTraceHistory();
}

function closeTrace() {
  $('trace-modal').classList.add('hidden');
}

function refreshTrace() {
  renderTrace();
  loadTraceHistory();
}

// ---------- Eval (trace-driven local regression suite) ----------
// Turn the machine's own saved runs into a deterministic test set: freeze each
// run's tool results and replay against the model, so the model is the only
// variable. Each run is graded on CLASSic dimensions and compared to the
// previous run (baseline) to surface regressions. See src/core/eval.js.
let evalPolling = null;

function evalPct(x) { return Math.round((x || 0) * 100) + '%'; }
function evalFmtDate(ts) { try { return new Date(ts).toLocaleString(); } catch { return String(ts); } }

async function loadEvalTraces() {
  const box = $('eval-traces');
  try {
    const r = await fetch('/api/traces');
    const j = await r.json();
    const traces = (j.traces || []).slice(0, 80);
    if (!traces.length) {
      box.innerHTML = '<div class="muted small">还没有运行记录。先对话几次，轨迹会自动保存到本机 <code>~/.agenite/traces</code>。</div>';
      return;
    }
    box.innerHTML = traces.map((t) => `
      <label class="eval-trace-item">
        <input type="checkbox" class="eval-trace-cb" value="${escapeHtml(t.runId)}" />
        <span class="eti-main">
          <span class="eti-title">${escapeHtml(t.title || t.runId)}</span>
          <span class="eti-meta">${t.steps} 步 · ${escapeHtml(t.stopped || '—')} · ${evalFmtDate(t.createdAt)}</span>
        </span>
      </label>`).join('');
  } catch {
    box.innerHTML = '<div class="muted small">加载失败。</div>';
  }
}

async function loadEvalHistory() {
  const box = $('eval-history');
  try {
    const r = await fetch('/api/evals');
    const j = await r.json();
    const evals = j.evals || [];
    $('eval-hist-count').textContent = evals.length ? `(${evals.length})` : '';
    if (!evals.length) { box.innerHTML = '<div class="muted small">还没有评估运行。</div>'; return; }
    box.innerHTML = evals.map((e) => `
      <div class="th-item" data-evalid="${escapeHtml(e.evalId)}">
        <div class="th-top">
          <span class="th-title">${evalFmtDate(e.createdAt)}</span>
          <button class="th-del" data-del="${escapeHtml(e.evalId)}" title="删除">🗑</button>
        </div>
        <div class="th-meta">模型 ${escapeHtml(e.model || '—')} · ${e.cases} 用例 · 通过率 ${evalPct(e.summary.passRate)} · 均耗 $${Number(e.summary.avgCost || 0).toFixed(4)}</div>
        ${e.regressions ? `<div class="th-loop">⚠ ${e.regressions} 项回归</div>` : ''}
      </div>`).join('');
    box.querySelectorAll('.th-item').forEach((el) => el.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('th-del')) return;
      openEvalHistory(el.dataset.evalid);
    }));
    box.querySelectorAll('.th-del').forEach((b) => b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await fetch('/api/evals/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
      loadEvalHistory();
    }));
  } catch {
    box.innerHTML = '<div class="muted small">加载失败。</div>';
  }
}

async function openEvalHistory(evalId) {
  try {
    const r = await fetch('/api/evals/' + encodeURIComponent(evalId));
    const j = await r.json();
    if (j.status === 'running') { $('eval-status').classList.remove('hidden'); $('eval-status').textContent = '该评估仍在后台运行…'; return; }
    if (j.report) { $('eval-status').classList.add('hidden'); renderEvalReport(j.report); }
  } catch { /* ignore */ }
}

function renderEvalReport(report) {
  const box = $('eval-report');
  box.classList.remove('hidden');
  const s = report.summary || {};
  const reg = report.regressions || [];
  const chips = `
    <div class="eval-chips">
      <span class="echip"><b>${report.cases != null ? report.cases : s.cases}</b> 用例</span>
      <span class="echip ${s.passRate >= 0.999 ? 'ok' : 'bad'}">通过率 <b>${evalPct(s.passRate)}</b></span>
      <span class="echip">均耗 <b>$${Number(s.avgCost || 0).toFixed(4)}</b></span>
      <span class="echip">均轮 <b>${Number(s.avgTurns || 0).toFixed(1)}</b></span>
      <span class="echip">工具一致 <b>${evalPct(s.avgToolAdherence)}</b></span>
      <span class="echip">体检合格 <b>${evalPct(s.diagnosisOkRate)}</b></span>
    </div>`;
  const regHtml = reg.length
    ? `<div class="eval-reg">⚠ 检测到 ${reg.length} 项回归：${reg.map((r) => `<span class="eval-reg-item">${escapeHtml(r.metric)} ${r.before}→${r.after}</span>`).join('')}</div>`
    : (report.hasBaseline ? `<div class="eval-ok">✓ 相比上一次运行无回归</div>` : `<div class="muted small">这是首次运行，已设为基线。</div>`);
  const rows = (report.results || []).map((r) => `
    <tr class="${r.pass ? '' : 'erow-bad'}">
      <td class="ec-pass">${r.pass ? '✓' : '✗'}</td>
      <td>${escapeHtml(r.title || r.caseId)}</td>
      <td>${escapeHtml(r.stopped || '—')}</td>
      <td>${r.turns}</td>
      <td>$${Number(r.avgCost || 0).toFixed(4)}</td>
      <td class="${r.toolAdherence ? '' : 'ec-bad'}">${r.toolAdherence ? '一致' : '漂移'}</td>
      <td class="diag-${r.diagnosisWorst}">${r.diagnosisWorst}</td>
    </tr>`).join('');
  box.innerHTML = `
    <div class="eval-report-head">报告 · ${evalFmtDate(report.createdAt)} · 模型 ${escapeHtml(report.model || '—')} · ${report.trials} 次/用例</div>
    ${chips}
    ${regHtml}
    <table class="eval-table">
      <thead><tr><th></th><th>用例</th><th>状态</th><th>轮</th><th>成本</th><th>工具</th><th>体检</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function runEval() {
  const cbs = Array.from(document.querySelectorAll('.eval-trace-cb:checked'));
  const traceIds = cbs.map((c) => c.value);
  if (!traceIds.length) { alert('请至少选择一个历史运行作为评估用例。'); return; }
  const trials = Math.min(5, Math.max(1, Number($('eval-trials').value) || 1));
  $('eval-status').classList.remove('hidden');
  $('eval-status').textContent = '⏳ 评估已在后台启动（会真实调用模型并消耗额度）…';
  $('eval-report').classList.add('hidden');
  $('eval-run').disabled = true;
  try {
    const r = await fetch('/api/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, traceIds, trials })
    });
    const j = await r.json();
    if (!j.ok) { $('eval-status').textContent = '✗ ' + (j.error || '创建失败'); $('eval-run').disabled = false; return; }
    pollEval(j.evalId);
  } catch (e) {
    $('eval-status').textContent = '✗ ' + e.message;
    $('eval-run').disabled = false;
  }
}

function pollEval(evalId) {
  if (evalPolling) clearInterval(evalPolling);
  const tick = async () => {
    try {
      const r = await fetch('/api/evals/' + encodeURIComponent(evalId));
      const j = await r.json();
      if (j.status === 'running') return;
      if (j.status === 'error') { $('eval-status').textContent = '✗ 评估失败：' + (j.error || ''); $('eval-run').disabled = false; clearInterval(evalPolling); return; }
      if (j.report) {
        $('eval-status').classList.add('hidden');
        renderEvalReport(j.report);
        loadEvalHistory();
        $('eval-run').disabled = false;
        clearInterval(evalPolling);
      }
    } catch { /* keep polling */ }
  };
  evalPolling = setInterval(tick, 1500);
  tick();
}

function openEval() {
  $('eval-modal').classList.remove('hidden');
  $('eval-report').classList.add('hidden');
  $('eval-status').classList.add('hidden');
  $('eval-run').disabled = false;
  loadEvalTraces();
  loadEvalHistory();
}

function closeEval() {
  $('eval-modal').classList.add('hidden');
  if (evalPolling) { clearInterval(evalPolling); evalPolling = null; }
}

// ---------- Browser live preview ----------
// Mirrors the eval/trace panels: open the modal, pull the shared browser's
// live state (URL + screenshot) from /api/browser, and keep it fresh on a
// timer while the modal is open. The agent's browser_* tools write to the
// very same page, so this shows exactly what the model is looking at.
let browserPolling = null;
let browserShotSig = null; // last screenshot data URL, to skip needless re-renders

function openBrowserPanel() {
  $('browser-modal').classList.remove('hidden');
  refreshBrowserView();
  if (browserPolling) clearInterval(browserPolling);
  browserPolling = setInterval(refreshBrowserView, 4000);
}

function closeBrowserPanel() {
  $('browser-modal').classList.add('hidden');
  if (browserPolling) { clearInterval(browserPolling); browserPolling = null; }
}

async function refreshBrowserView() {
  if ($('browser-modal').classList.contains('hidden')) return;
  const box = $('browser-view');
  const urlEl = $('browser-url');
  try {
    const r = await fetch('/api/browser');
    const j = await r.json();
    if (!j.available) {
      urlEl.textContent = '浏览器不可用';
      box.innerHTML = `<div class="muted small">${escapeHtml(j.error || '本机未检测到 Chrome 或 puppeteer-core。可在「设置 → MCP 工具」用 Playwright 替代；或安装 Chrome 后重试。')}</div>`;
      return;
    }
    if (!j.open) {
      urlEl.textContent = '尚未打开页面';
      box.innerHTML = '<div class="muted small">还没有打开的页面。发一条「打开 https://…」的消息，Agent 会自动导航，这里会实时显示截图。</div>';
      renderBrowserLog([]);
      return;
    }
    urlEl.textContent = (j.title ? j.title + ' · ' : '') + j.url;
    if (j.screenshot && j.screenshot !== browserShotSig) {
      browserShotSig = j.screenshot;
      box.innerHTML = `<div class="browser-stage"><img class="browser-shot" src="${j.screenshot}" alt="页面截图" /><div class="browser-overlay" id="browser-overlay"></div></div>`;
      const img = box.querySelector('.browser-shot');
      if (img && img.complete) positionOverlay(j, img);
      else if (img) img.onload = () => positionOverlay(j, img);
    } else if (j.screenshot) {
      positionOverlay(j, box.querySelector('.browser-shot'));
    } else {
      box.innerHTML = '<div class="muted small">无法截图当前页面（可能仍在加载）。</div>';
      browserShotSig = null;
    }
    renderBrowserLog(j.actions || []);
  } catch {
    /* keep previous content; transient network hiccup */
  }
}

function renderBrowserLog(actions) {
  const el = $('browser-log');
  if (!el) return;
  if (!actions || !actions.length) {
    el.innerHTML = '<li class="muted">（暂无操作记录）</li>';
    return;
  }
  el.innerHTML = actions.slice().reverse().map((a) =>
    `<li><code>${escapeHtml(a.action)}</code> ${escapeHtml(a.target)}${a.detail ? ' <span class="muted">· ' + escapeHtml(a.detail) + '</span>' : ''}</li>`
  ).join('');
}

// Lay interactive-element markers over the live screenshot. Coordinates come
// from the controller's bounding boxes (viewport space); we scale them to the
// rendered image size so the badges sit exactly on top of the real controls.
function positionOverlay(j, img) {
  const ov = document.getElementById('browser-overlay');
  if (!ov || !img) return;
  const els = (j && j.elements) || [];
  if (!els.length) { ov.innerHTML = ''; return; }
  const vw = (j.viewport && j.viewport.width) || img.naturalWidth || 1;
  const scale = (img.clientWidth || img.naturalWidth || 1) / vw;
  ov.innerHTML = els.map((el) => {
    const r = el.rect || { x: 0, y: 0, width: 0, height: 0 };
    const left = r.x * scale;
    const top = r.y * scale;
    const w = r.width * scale;
    const h = r.height * scale;
    const title = `@${el.ref} ${el.tag}${el.name ? ' “' + el.name + '”' : ''}${el.href ? ' → ' + el.href : ''}`;
    return `<button class="ref-marker" data-ref="@${el.ref}" title="${escapeHtml(title)}" style="left:${left}px;top:${top}px;min-width:${Math.max(16, w)}px;min-height:${Math.max(16, h)}px">@${el.ref}</button>`;
  }).join('');
  ov.querySelectorAll('.ref-marker').forEach((b) => {
    b.addEventListener('click', () => insertRefIntoInput(b.getAttribute('data-ref')));
  });
}

// Clicking a marker drops its @ref into the composer so the user can tell the
// agent exactly which element to act on — turning passive watching into a
// precise instruction without copy-paste.
function insertRefIntoInput(ref) {
  const inp = document.getElementById('input');
  if (!inp) return;
  inp.value = insertSnippetInto(inp.value, ref);
  inp.focus();
  if (inp.dispatchEvent) inp.dispatchEvent(new Event('input'));
}

// Briefly pulse the overlay marker for the element the agent just acted on.
// The ref is only meaningful against the current snapshot's markers, so if the
// ref no longer exists (DOM changed since) we simply no-op.
function flashOverlayMark(ref) {
  const ov = document.getElementById('browser-overlay');
  if (!ov) return;
  const mark = ov.querySelector(`.ref-marker[data-ref="${ref}"]`);
  if (!mark) return;
  mark.classList.remove('flash');
  // force reflow so the animation restarts on repeated hits
  void mark.offsetWidth;
  mark.classList.add('flash');
  setTimeout(() => mark.classList.remove('flash'), 1200);
}

async function closeBrowserEngine() {
  try {
    await fetch('/api/browser/close', { method: 'POST' });
    toast('已关闭本地浏览器');
    refreshBrowserView();
  } catch { /* ignore */ }
}

// ---------- 指令库 (reusable prompt snippets, local-first) ----------
function openSnippets() {
  $('snippets-modal').classList.remove('hidden');
  renderSnippetList();
}
function closeSnippets() {
  $('snippets-modal').classList.add('hidden');
}

// ── 知识库面板（本地 RAG） ────────────────────────────────────────────────
function openKb() {
  $('kb-modal').classList.remove('hidden');
  $('kb-enabled').checked = config.kbEnabled === true;
  refreshKb();
}
function closeKb() { $('kb-modal').classList.add('hidden'); }
async function refreshKb() {
  const list = $('kb-list');
  const stats = $('kb-stats');
  try {
    const r = await fetch('/api/kb/list');
    const j = await r.json();
    if (stats) stats.textContent = j.stats ? `${j.stats.docs} 份资料 · ${j.stats.chunks} 个片段` : '';
    if (!list) return;
    if (!j.docs || !j.docs.length) {
      list.innerHTML = '<div class="muted small">还没有资料。粘贴文本或从文件导入，开始构建你的本地知识库。</div>';
      return;
    }
    list.innerHTML = j.docs.map((d) => `
      <div class="kb-item" data-id="${d.id}">
        <div class="kb-item-main">
          <span class="kb-item-title">${escapeHtml(d.title)}</span>
          <span class="kb-item-meta">${escapeHtml(d.kind || 'text')} · ${d.chunk_count} 片段</span>
        </div>
        <button class="mini-btn danger-text kb-del" data-id="${d.id}">删除</button>
      </div>`).join('');
    list.querySelectorAll('.kb-del').forEach((b) => { b.onclick = () => removeKb(Number(b.dataset.id)); });
  } catch { if (list) list.innerHTML = '<div class="muted small">读取知识库失败</div>'; }
}
async function addKbText() {
  const text = ($('kb-text').value || '').trim();
  const title = ($('kb-title').value || '').trim();
  const msg = $('kb-msg');
  if (!text) { msg.textContent = '请先粘贴文本内容。'; return; }
  msg.textContent = '入库中…';
  try {
    const r = await fetch('/api/kb/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, title }) });
    const j = await r.json();
    if (!r.ok) { msg.textContent = '失败：' + (j.error || r.status); return; }
    $('kb-text').value = ''; $('kb-title').value = '';
    msg.textContent = `✅ 已加入《${j.doc.title}》（${j.doc.chunks} 片段）`;
    refreshKb();
  } catch (e) { msg.textContent = '失败：' + e.message; }
}
async function addKbFile() {
  const path = ($('kb-path').value || '').trim();
  const msg = $('kb-msg');
  if (!path) { msg.textContent = '请填写文件路径。'; return; }
  msg.textContent = '读取中…';
  try {
    const r = await fetch('/api/kb/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    const j = await r.json();
    if (!r.ok) { msg.textContent = '失败：' + (j.error || r.status); return; }
    $('kb-path').value = '';
    msg.textContent = `✅ 已导入《${j.doc.title}》（${j.doc.chunks} 片段）`;
    refreshKb();
  } catch (e) { msg.textContent = '失败：' + e.message; }
}
async function removeKb(id) {
  try { await fetch('/api/kb/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); refreshKb(); } catch { /* ignore */ }
}
async function clearKb() {
  if (!confirm('确定清空整个本地知识库？此操作不可恢复。')) return;
  try { await fetch('/api/kb/clear', { method: 'POST' }); refreshKb(); toast('已清空知识库'); } catch { /* ignore */ }
}

// ── 智能体画廊 ───────────────────────────────────────────────────────────
let _agentsCache = null;
function openAgents() {
  $('agents-modal').classList.remove('hidden');
  closeAgentEditor();
  $('agents-current').textContent = config.persona && config.persona !== 'default' ? config.persona : '默认';
  renderAgents();
}
function closeAgents() { $('agents-modal').classList.add('hidden'); }
function refreshAgents() { _agentsCache = null; return renderAgents(); }
async function renderAgents() {
  const grid = $('agents-grid');
  if (!grid) return;
  if (!_agentsCache) {
    try { const r = await fetch('/api/agents'); const j = await r.json(); _agentsCache = j.agents || []; } catch { _agentsCache = []; }
  }
  if (!_agentsCache.length) { grid.innerHTML = '<div class="muted small">暂无预置智能体。</div>'; return; }
  const builtins = _agentsCache.filter((a) => !a.custom);
  const customs = _agentsCache.filter((a) => a.custom);
  const card = (a) => `
    <div class="agent-card" data-name="${escapeHtml(a.name)}" title="${escapeHtml(a.tagline || a.description || '')}">
      ${a.custom ? `<button class="agent-del" data-slug="${escapeHtml(a.slug || a.name)}" title="删除该智能体">✕</button>` : ''}
      <div class="agent-ico">${a.icon || '🤖'}</div>
      <div class="agent-name">${escapeHtml(a.name)}</div>
      <div class="agent-tag">${escapeHtml(a.tagline || (a.custom ? '自定义智能体' : ''))}</div>
    </div>`;
  let html = '';
  if (customs.length) {
    html += '<div class="agent-section-label">我的智能体</div>' + customs.map(card).join('');
  }
  html += '<div class="agent-section-label">预置智能体</div>' + builtins.map(card).join('');
  grid.innerHTML = html;
  grid.querySelectorAll('.agent-card').forEach((c) => { c.onclick = (e) => { if (e.target.closest('.agent-del')) return; applyAgent(c.dataset.name); }; });
  grid.querySelectorAll('.agent-del').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); deleteCustomAgent(b.dataset.slug); }; });
}
async function applyAgent(name) {
  const a = (_agentsCache || []).find((x) => x.name === name);
  if (!a) return;
  config.persona = name;
  config.systemPrompt = a.system_prompt || '';
  saveConfig();
  $('agents-current').textContent = name;
  if ($('set-persona')) $('set-persona').value = name;
  if ($('set-systemPrompt')) $('set-systemPrompt').value = config.systemPrompt;
  closeAgents();
  toast('已切换到智能体：' + name);
}

// ── 自定义智能体（新建 / 删除，落盘到 ~/.agenite/memory/personas/）──
function openAgentEditor() {
  $('agent-editor').classList.remove('hidden');
  $('agent-msg').textContent = '';
  $('new-agent').classList.add('hidden');
  $('agent-name').value = ''; $('agent-icon').value = '🧠'; $('agent-tagline').value = ''; $('agent-prompt').value = '';
  setTimeout(() => $('agent-name').focus(), 30);
}
function closeAgentEditor() {
  $('agent-editor').classList.add('hidden');
  $('new-agent').classList.remove('hidden');
}
async function saveCustomAgent(e) {
  if (e) e.preventDefault();
  const name = ($('agent-name').value || '').trim();
  const system_prompt = ($('agent-prompt').value || '').trim();
  const msg = $('agent-msg');
  if (!name || !system_prompt) { msg.textContent = '名称和系统提示词都不能为空。'; return; }
  msg.textContent = '保存中…';
  try {
    const r = await fetch('/api/personas', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: ($('agent-tagline').value || '').trim(), system_prompt, icon: ($('agent-icon').value || '').trim() })
    });
    const j = await r.json();
    if (!r.ok) { msg.textContent = '失败：' + (j.error || r.status); return; }
    closeAgentEditor();
    await refreshAgents();
    toast('已保存智能体：' + name);
  } catch (err) { msg.textContent = '失败：' + err.message; }
}
async function deleteCustomAgent(slug) {
  if (!confirm('删除这个自定义智能体？该操作不可恢复。')) return;
  try {
    const r = await fetch('/api/personas/' + encodeURIComponent(slug), { method: 'DELETE' });
    if (!r.ok) { const j = await r.json().catch(() => ({})); toast('删除失败：' + (j.error || r.status)); return; }
    await refreshAgents();
    toast('已删除智能体');
  } catch (err) { toast('删除失败：' + err.message); }
}
function renderSnippetList() {
  const list = $('snippet-list');
  if (!list) return;
  const items = listSnippets();
  if (!items.length) {
    list.innerHTML = '<div class="muted small">还没有保存的片段。在上方填写名称与内容后点「添加片段」。</div>';
    return;
  }
  list.innerHTML = items.map((s) => `
    <div class="snippet-item" data-id="${escapeHtml(s.id)}">
      <div class="snippet-meta"><span class="snippet-name">${escapeHtml(s.name)}</span></div>
      <pre class="snippet-body-text">${escapeHtml(s.body)}</pre>
      <div class="snippet-actions">
        <button class="mini-btn snippet-insert" data-id="${escapeHtml(s.id)}">插入</button>
        <button class="mini-btn danger-text snippet-del" data-id="${escapeHtml(s.id)}">删除</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('.snippet-insert').forEach((b) => {
    b.addEventListener('click', () => {
      const s = getSnippet(b.getAttribute('data-id'));
      if (s) {
        const inp = document.getElementById('input');
        if (inp) { inp.value = insertSnippetInto(inp.value, s.body); inp.focus(); inp.dispatchEvent(new Event('input')); }
        closeSnippets();
        toast('已插入片段：' + s.name);
      }
    });
  });
  list.querySelectorAll('.snippet-del').forEach((b) => {
    b.addEventListener('click', () => {
      removeSnippet(b.getAttribute('data-id'));
      renderSnippetList();
    });
  });
}
function addSnippetFromForm() {
  const nameEl = $('snippet-name');
  const bodyEl = $('snippet-body');
  const r = addSnippet(nameEl.value, bodyEl.value);
  if (!r.ok) { toast(r.error); return; }
  nameEl.value = '';
  bodyEl.value = '';
  renderSnippetList();
  toast('已添加片段');
}

function wire() {
  $('new-chat').onclick = () => newConv();
  $('open-settings').onclick = () => openSettings();
  $('open-goals').onclick = openGoals;
  $('open-atlas').onclick = openAtlas;
  $('close-atlas').onclick = closeAtlas;
  $('open-trace').onclick = openTrace;
  $('close-trace').onclick = closeTrace;
  $('trace-refresh').onclick = refreshTrace;
  $('open-eval').onclick = openEval;
  $('close-eval').onclick = closeEval;
  $('eval-run').onclick = runEval;
  $('open-browser').onclick = openBrowserPanel;
  $('close-browser').onclick = closeBrowserPanel;
  $('browser-refresh').onclick = refreshBrowserView;
  $('browser-close').onclick = closeBrowserEngine;
  $('open-snippets').onclick = openSnippets;
  $('close-snippets').onclick = closeSnippets;
  $('open-kb').onclick = openKb;
  $('close-kb').onclick = closeKb;
  $('kb-add-text').onclick = addKbText;
  $('kb-add-file').onclick = addKbFile;
  $('kb-clear').onclick = clearKb;
  $('kb-enabled').onchange = (e) => {
    config.kbEnabled = e.target.checked;
    saveConfig();
    toast('知识库引用：' + (config.kbEnabled ? '开' : '关'));
  };
  $('open-agents').onclick = openAgents;
  $('close-agents').onclick = closeAgents;
  $('new-agent').onclick = openAgentEditor;
  $('agent-cancel').onclick = closeAgentEditor;
  $('agent-editor').addEventListener('submit', saveCustomAgent);
  $('snippet-add').onclick = addSnippetFromForm;
  $('atlas-add').onclick = atlasAddNode;
  $('atlas-build').onclick = atlasBuild;
  $('atlas-reset').onclick = atlasReset;
  $('atlas-fit').onclick = atlasFit;
  $('atlas-export').onclick = atlasExport;
  $('atlas-import').onclick = () => $('atlas-import-file').click();
  $('atlas-import-file').onchange = atlasImportFile;
  $('atlas-search').addEventListener('input', atlasApplySearch);
  $('close-goals').onclick = closeGoals;
  $('goal-assign').onclick = assignGoal;
  $('close-settings').onclick = closeSettings;
  $('save-settings').onclick = saveSettings;
  $('persona-save').onclick = saveNewPersona;
  $('test-conn').onclick = testConnection;
  // Sidebar conversation search: filter by title + message content live.
  $('conv-search').addEventListener('input', (e) => { convQuery = e.target.value; renderConvList(); });
  // Command palette: input behaviour + backdrop-to-close.
  $('palette-input').addEventListener('input', (e) => renderPalette(e.target.value));
  $('palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteState.index); }
  });
  $('palette-modal').addEventListener('click', (e) => { if (e.target === $('palette-modal')) closePalette(); });
  // Per-conversation export menu (Markdown / JSON / plain text).
  $('export-menu-btn').onclick = (e) => { e.stopPropagation(); $('export-menu').classList.toggle('hidden'); };
  document.addEventListener('click', (e) => {
    if (!$('export-menu').classList.contains('hidden') && e.target !== $('export-menu-btn') && !$('export-menu').contains(e.target)) {
      $('export-menu').classList.add('hidden');
    }
  });
  $('export-md').onclick = () => { $('export-menu').classList.add('hidden'); exportCurrentMarkdown(); };
  $('export-json').onclick = () => { $('export-menu').classList.add('hidden'); exportCurrentJson(); };
  $('export-txt').onclick = () => { $('export-menu').classList.add('hidden'); exportCurrentText(); };
  $('set-provider').onchange = onProviderChange;
  $('set-model').addEventListener('input', updateModelCtxBadge);
  $('ollama-refresh').onclick = refreshOllamaModels;
  $('set-temperature').oninput = (e) => { $('temp-val').textContent = e.target.value; };
  $('theme-toggle').onclick = toggleTheme;
  $('perm-chip').onclick = cyclePerm;
  $('workspace-chip').onclick = () => openSettings('power');
  $('model-chip').onclick = () => openSettings('model');
  $('agent-toggle').onclick = () => {
    config.agentEnabled = config.agentEnabled === false;
    saveConfig();
    renderAgentChip();
    toast('Agent 工具调用：' + (config.agentEnabled ? '开' : '关'));
  };
  $('plan-toggle').onclick = () => {
    config.planMode = config.planMode !== true;
    saveConfig();
    renderPlanChip();
    toast('计划模式：' + (config.planMode ? '开（先出方案，批准后执行）' : '关'));
  };
  $('mcp-chip').onclick = () => openSettings('mcp');

  // MCP quick-add + manual add
  document.querySelectorAll('[data-quick]').forEach((b) => {
    b.onclick = () => {
      const p = MCP_PRESETS[b.dataset.quick];
      if (!p) return;
      const list = getMcpServers();
      const existing = list.find((x) => x.id === p.id);
      if (existing) existing.enabled = true;
      else list.push({ ...p });
      saveMcpServers(list);
      refreshMcp();
      toast('已添加并连接：' + p.id);
    };
  });
  $('mcp-transport').onchange = () => {
    const remote = $('mcp-transport').value !== 'stdio';
    $('mcp-stdio-fields').classList.toggle('hidden', remote);
    $('mcp-remote-fields').classList.toggle('hidden', !remote);
  };
  $('mcp-add').onclick = () => {
    const id = $('mcp-id').value.trim();
    if (!id) return toast('请填写标识 (id)');
    const transport = $('mcp-transport').value || 'stdio';
    let srv;
    if (transport === 'stdio') {
      srv = {
        id, transport,
        command: $('mcp-command').value.trim() || 'npx',
        args: parseMcpArgs($('mcp-args').value),
        env: parseMcpEnv($('mcp-env').value),
        enabled: true
      };
    } else {
      const url = $('mcp-url').value.trim();
      if (!url) return toast('请填写服务器地址 (url)');
      srv = { id, transport, url, headers: parseMcpEnv($('mcp-headers').value), enabled: true };
    }
    upsertMcpServer(srv);
    ['mcp-id', 'mcp-command', 'mcp-args', 'mcp-env', 'mcp-url', 'mcp-headers'].forEach((k) => { $(k).value = ''; });
    refreshMcp();
    toast('已添加：' + id);
  };

  // Import an existing mcp.json instead of retyping every server by hand.
  $('mcp-import-file-btn').onclick = () => $('mcp-import-file').click();
  $('mcp-import-file').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { $('mcp-import-text').value = String(reader.result); };
    reader.readAsText(f);
    e.target.value = '';
  };
  $('mcp-import').onclick = async () => {
    const text = $('mcp-import-text').value.trim();
    if (!text) return toast('先粘贴 mcp.json 的内容');
    try {
      const r = await fetch('/api/mcp/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '解析失败');
      const found = j.servers || [];
      if (!found.length) return toast('没解析出任何服务器');
      for (const s of found) upsertMcpServer(s);
      $('mcp-import-text').value = '';
      refreshMcp();
      toast(`已导入 ${found.length} 个服务器：` + found.map((s) => s.id).join('、'));
    } catch (err) {
      toast('导入失败：' + err.message);
    }
  };
  $('clear-chat').onclick = () => clearCurrent();
  $('send').onclick = () => sendMessage();
  $('stop').onclick = () => { if (abortCtrl) abortCtrl.abort(); };
  $('attach-file').onclick = () => {
    const ta = $('input');
    const caret = ta.selectionStart;
    const needSpace = caret > 0 && !/\s$/.test(ta.value.slice(0, caret));
    ta.value = ta.value.slice(0, caret) + (needSpace ? ' @' : '@') + ta.value.slice(caret);
    const pos = caret + (needSpace ? 2 : 1);
    ta.selectionStart = ta.selectionEnd = pos;
    ta.focus();
    autoGrow();
    updateAc();
  };
  $('chat-title').ondblclick = () => renameCurrent();
  $('close-keys').onclick = closeKeys;
  $('keys-modal').addEventListener('mousedown', (e) => { if (e.target === $('keys-modal')) closeKeys(); });

  $('input').addEventListener('input', () => { autoGrow(); updateAc(); });
  $('input').addEventListener('blur', () => setTimeout(closeAc, 120));
  $('input').addEventListener('keydown', (e) => {
    // The autocomplete popup owns the arrow keys / Enter / Tab while it is open.
    if (acState && acState.items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return moveAc(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return moveAc(-1); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return applyAc(); }
      if (e.key === 'Escape') { e.preventDefault(); return closeAc(); }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
    // Backspace on an empty composer pops the last attached file
    if (e.key === 'Backspace' && !$('input').value && refs.length) {
      e.preventDefault();
      removeRef(refs[refs.length - 1]);
    }
  });

  $('approval-allow').onclick = () => resolveApproval(true);
  $('approval-deny').onclick = () => resolveApproval(false);
  $('approval-always').onclick = () => approveAlways();

  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });
  $('export-data').onclick = exportData;
  $('import-data').onclick = () => $('import-file').click();
  $('import-file').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };
  $('restore-sessions').onclick = () => restoreSessions().then(refreshSessionsInfo);
  $('reset-all').onclick = resetAll;
  $('usage-chip').onclick = () => openSettings('advanced');

  $('sidebar-open').onclick = () => document.body.classList.add('side-open');
  $('sidebar-close').onclick = () => document.body.classList.remove('side-open');
  $('scrim').onclick = () => document.body.classList.remove('side-open');

  // click-outside to dismiss overlays
  $('settings-modal').addEventListener('mousedown', (e) => { if (e.target === $('settings-modal')) closeSettings(); });
  $('goals-modal').addEventListener('mousedown', (e) => { if (e.target === $('goals-modal')) closeGoals(); });
  $('atlas-modal').addEventListener('mousedown', (e) => { if (e.target === $('atlas-modal')) closeAtlas(); });
  $('trace-modal').addEventListener('mousedown', (e) => { if (e.target === $('trace-modal')) closeTrace(); });
  $('eval-modal').addEventListener('mousedown', (e) => { if (e.target === $('eval-modal')) closeEval(); });
  $('browser-modal').addEventListener('mousedown', (e) => { if (e.target === $('browser-modal')) closeBrowserPanel(); });
  $('snippets-modal').addEventListener('mousedown', (e) => { if (e.target === $('snippets-modal')) closeSnippets(); });

  $('messages').addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.copy-btn');
    if (copyBtn) {
      const code = copyBtn.parentElement.querySelector('code');
      if (code) {
        navigator.clipboard.writeText(code.textContent);
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1400);
      }
      return;
    }
    const atab = e.target.closest('.atab');
    if (atab) {
      const art = atab.closest('.artifact');
      if (!art) return;
      const view = atab.dataset.view;
      art.querySelectorAll('.atab').forEach((b) => b.classList.toggle('on', b === atab));
      art.querySelector('.artifact-view.preview').classList.toggle('hidden', view !== 'preview');
      art.querySelector('.artifact-view.code').classList.toggle('hidden', view !== 'code');
      return;
    }
    if (e.target.closest('.continue-btn')) { continueRun(); return; }
    const fu = e.target.closest('.fu-chip');
    if (fu) { sendMessage(fu.textContent); return; }
    const er = e.target.closest('.err-retry');
    if (er) {
      const msgEl = er.closest('.msg');
      const idx = msgEl ? Number(msgEl.dataset.idx) : -1;
      if (idx >= 0) regenerateFrom(idx);
      return;
    }
    const ec = e.target.closest('.err-copy');
    if (ec) {
      const msgEl = ec.closest('.msg');
      copyText(msgEl ? msgEl.querySelector('.err-msg').textContent : '');
      return;
    }
    const act = e.target.closest('.msg-act');
    if (!act) return;
    if (act.classList.contains('act-plan')) { approvePlan(); return; }
    const conv = currentConv();
    if (!conv) return;
    const idx = Number(act.dataset.idx);
    const msg = conv.messages[idx];
    if (!msg) return;
    if (act.classList.contains('act-copy')) copyText(msg.display || msg.content || '');
    else if (act.classList.contains('act-edit')) editUserMessage(idx);
    else if (act.classList.contains('act-redo')) regenerateFrom(idx);
  });

  // Undo a file mutation from its diff card.
  $('messages').addEventListener('click', (e) => {
    const ub = e.target.closest('.undo-btn');
    if (!ub) return;
    const token = ub.dataset.token;
    ub.disabled = true;
    ub.textContent = '撤销中…';
    fetch('/api/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) { ub.textContent = '✓ 已撤销'; ub.classList.add('done'); toast('已撤销改动'); }
        else { ub.disabled = false; ub.textContent = '↩ 撤销失败'; toast(j.error || '撤销失败'); }
      })
      .catch(() => { ub.disabled = false; ub.textContent = '↩ 撤销失败'; toast('撤销请求失败'); });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Confirmation-free stop: abort the in-flight run before any modal close.
      if (abortCtrl) { abortCtrl.abort(); return; }
      if (acState) closeAc();
      else if (pendingApprovalId) resolveApproval(false);
      else if (!$('palette-modal').classList.contains('hidden')) closePalette();
      else if (!$('keys-modal').classList.contains('hidden')) closeKeys();
      else if (!$('goals-modal').classList.contains('hidden')) closeGoals();
      else if (!$('atlas-modal').classList.contains('hidden')) closeAtlas();
      else if (!$('trace-modal').classList.contains('hidden')) closeTrace();
      else if (!$('eval-modal').classList.contains('hidden')) closeEval();
      else if (!$('browser-modal').classList.contains('hidden')) closeBrowserPanel();
      else if (!$('snippets-modal').classList.contains('hidden')) closeSnippets();
      else closeSettings();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openPalette(); }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openSettings(); }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); openKeys(); }
  });
}

function init() {
  applyTheme(getInitialTheme());
  wire();
  renderConvList();
  renderMessages();
  updateTitle();
  renderPermChip();
  renderAgentChip();
  renderPlanChip();
  renderModelChip();
  renderUsageChip();
  renderRefs();
  autoGrow();
  pingHealth();
  refreshMcp();
  // Fresh browser but the machine already has history? Offer it back silently.
  if (!conversations.length && config.syncSessions !== false) {
    restoreSessions({ silent: true }).then((n) => {
      if (n) toast('已从本机恢复 ' + n + ' 个历史会话');
    });
  }
  setInterval(pingHealth, 30000);
  maybeOpenAtlasOnBoot();
}

init();
