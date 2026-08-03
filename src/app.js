// Agenite browser controller: settings, streaming chat with tool visualization
// and human-in-the-loop approvals, multi-conversation management, theme.
// Talks to the local server, which is the part that can actually touch the machine.
import { renderMarkdown } from './core/markdown.js';
import { uid, escapeHtml, fuzzyFilter, formatBytes } from './core/util.js';
import { defaultConfig, PROVIDER_PRESETS, APPROVAL_MODES } from './core/config.js';

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
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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
function renderConvList() {
  const el = $('conv-list');
  el.innerHTML = '';
  if (!conversations.length) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = '还没有对话';
    el.appendChild(empty);
    return;
  }
  for (const c of conversations) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === currentId ? ' active' : '');
    const t = document.createElement('div');
    t.className = 'conv-title';
    t.textContent = c.title || '新对话';
    const del = document.createElement('button');
    del.className = 'conv-del';
    del.title = '删除';
    del.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    del.onclick = (e) => { e.stopPropagation(); deleteConv(c.id); };
    item.append(t, del);
    item.onclick = () => selectConv(c.id);
    el.appendChild(item);
  }
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
  wrap.className = 'empty';
  const grid = STARTERS.map((s, i) =>
    `<button class="starter" data-i="${i}"><b>${escapeHtml(s.title)}</b><span>${escapeHtml(s.text)}</span></button>`
  ).join('');
  wrap.innerHTML =
    '<div class="empty-mark"></div>' +
    '<h1>今天想让它做点什么？</h1>' +
    '<p>Agenite 跑在你自己的电脑上，能读写文件、执行命令、联网查资料。</p>' +
    `<div class="starter-grid">${grid}</div>`;
  wrap.querySelectorAll('.starter').forEach((btn) => {
    btn.onclick = () => {
      const s = STARTERS[Number(btn.dataset.i)];
      $('input').value = s.text;
      autoGrow();
      $('input').focus();
    };
  });
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
  el.innerHTML = '<div class="avatar">A</div><div class="bubble"><div class="notices"></div><div class="tools"></div><div class="md"></div></div>';
  el.querySelector('.md').innerHTML = renderMarkdown(m.content || '') || '';
  if (Array.isArray(m.toolCalls)) for (const t of m.toolCalls) upsertToolCard(el, t);
  if (Array.isArray(m.notices)) for (const n of m.notices) addNotice(el, n);
  renderMsgUsage(el, m);
  if (m.canContinue) addContinueBar(el);
  if (typeof index === 'number') {
    const acts = document.createElement('div');
    acts.className = 'msg-acts';
    const c = currentConv();
    if (c && c.awaitingPlanApproval && c.planMsgIndex === index) {
      acts.innerHTML = actionBtn('act-copy', ICO_COPY, '复制', index) +
        '<button class="msg-act act-plan" data-plan="1" title="批准计划并开始执行"><span>✓ 批准并执行</span></button>';
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
  return card;
}

function scrollBottom() {
  const s = $('scroller');
  s.scrollTop = s.scrollHeight;
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

// The streaming turn itself, split out so "regenerate" can reuse it.
async function runTurn(conv, opts = {}) {
  const planning = !!opts.planning;
  abortCtrl = new AbortController();
  const aMsg = { role: 'assistant', content: '', tool_calls: [], toolCalls: [], notices: [] };
  conv.messages.push(aMsg);
  const el = buildMessageEl(aMsg);
  el.querySelector('.md').innerHTML = THINKING;
  $('messages').appendChild(el);
  scrollBottom();
  setBusy(true);

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
      const stick = nearBottom();
      if (event === 'delta') {
        aMsg.content += data.content || '';
        md.innerHTML = renderMarkdown(aMsg.content) || THINKING;
      } else if (event === 'approval') {
        handleApprovalRequest(data);
      } else if (event === 'tool_start') {
        upsertToolCard(el, data);
      } else if (event === 'tool') {
        aMsg.tool_calls.push({ id: data.id, type: 'function', function: { name: data.name, arguments: JSON.stringify(data.args || {}) } });
        conv.messages.push({ role: 'tool', tool_call_id: data.id, name: data.name, content: data.ok ? data.result : 'Error: ' + data.result });
        aMsg.toolCalls.push(data);
        upsertToolCard(el, data);
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
        aMsg.content += (aMsg.content ? '\n\n' : '') + '⚠️ ' + (data.message || '出错了');
        md.innerHTML = renderMarkdown(aMsg.content);
      } else if (event === 'done' || event === 'end') {
        md.innerHTML = renderMarkdown(aMsg.content) || '<span class="muted small">（没有文本输出）</span>';
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
        }
      }
      if (stick) scrollBottom();
    }, abortCtrl.signal);
  } catch (e) {
    if (e.name !== 'AbortError') {
      const hint = /Failed to fetch|NetworkError/i.test(e.message)
        ? '无法连接本地服务，请确认 Agenite 服务正在运行（start.cmd / node server.js）。'
        : e.message;
      aMsg.content += (aMsg.content ? '\n\n' : '') + '⚠️ ' + hint;
      md.innerHTML = renderMarkdown(aMsg.content);
    } else if (!aMsg.content) {
      md.innerHTML = '<span class="muted small">已停止</span>';
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

function openKeys() { $('keys-modal').classList.remove('hidden'); }
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
  $('model-label').textContent = config.model ? `${config.provider} · ${config.model}` : '未配置模型';
}

function populateProviders() {
  const sel = $('set-provider');
  sel.innerHTML = '';
  for (const p of PROVIDER_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
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
  $('set-autoCompact').checked = config.autoCompact !== false;
  $('set-smartCompact').checked = config.smartCompact !== false;
  $('set-maxTurns').value = config.maxTurns || 20;
  $('set-contextWindow').value = config.contextWindow || 0;
  $('set-priceIn').value = config.priceIn || 0;
  $('set-priceOut').value = config.priceOut || 0;
  $('set-priceCurrency').value = config.priceCurrency || 'CNY';
  $('set-syncSessions').checked = config.syncSessions !== false;
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
    persona: $('set-persona').value || 'default',
    autoCompact: $('set-autoCompact').checked,
    smartCompact: $('set-smartCompact').checked,
    maxTurns: clampNum($('set-maxTurns').value, 1, 100, 20),
    contextWindow: clampNum($('set-contextWindow').value, 0, 2000000, 0),
    priceIn: Math.max(0, Number($('set-priceIn').value) || 0),
    priceOut: Math.max(0, Number($('set-priceOut').value) || 0),
    priceCurrency: $('set-priceCurrency').value || 'CNY',
    syncSessions: $('set-syncSessions').checked
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
  msgEl.textContent = '检测中…';
  try {
    const res = await fetch('/api/health');
    const j = await res.json();
    if (res.ok && j.ok) {
      workspacePath = j.workspace || '';
      $('ws-path').textContent = workspacePath;
      updateWorkspaceChip(true);
      msgEl.textContent = '✅ 本地服务正常 · 工作区 ' + workspacePath;
    } else msgEl.textContent = '⚠️ 本地服务返回异常。';
  } catch {
    updateWorkspaceChip(false);
    msgEl.textContent = '❌ 连不上本地服务，请运行 start.cmd 或 node server.js。';
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

function wire() {
  $('new-chat').onclick = () => newConv();
  $('open-settings').onclick = () => openSettings();
  $('close-settings').onclick = closeSettings;
  $('save-settings').onclick = saveSettings;
  $('persona-save').onclick = saveNewPersona;
  $('test-conn').onclick = testConnection;
  $('set-provider').onchange = onProviderChange;
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
    if (e.target.closest('.continue-btn')) { continueRun(); return; }
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
      if (acState) closeAc();
      else if (pendingApprovalId) resolveApproval(false);
      else if (!$('keys-modal').classList.contains('hidden')) closeKeys();
      else closeSettings();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); newConv(); }
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
}

init();
