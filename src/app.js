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
  theme: 'agenite:theme'
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
function loadConvs() { try { return JSON.parse(localStorage.getItem(LS.convs) || '[]'); } catch { return []; } }
function saveConvs() { localStorage.setItem(LS.convs, JSON.stringify(conversations)); }
function currentConv() { return conversations.find((c) => c.id === currentId) || null; }

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
  const c = { id: uid('conv'), title: '新对话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  conversations.unshift(c);
  currentId = c.id;
  localStorage.setItem(LS.cur, currentId);
  saveConvs();
  renderConvList();
  renderMessages();
  updateTitle();
  $('input').focus();
  return c;
}
function selectConv(id) {
  currentId = id;
  localStorage.setItem(LS.cur, currentId);
  renderConvList();
  renderMessages();
  updateTitle();
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
  el.innerHTML = '<div class="avatar">A</div><div class="bubble"><div class="tools"></div><div class="md"></div></div>';
  el.querySelector('.md').innerHTML = renderMarkdown(m.content || '') || '';
  if (Array.isArray(m.toolCalls)) for (const t of m.toolCalls) upsertToolCard(el, t);
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
function upsertToolCard(el, t) {
  const holder = el.querySelector('.tools');
  let card = holder.querySelector(`[data-tid="${CSS.escape(String(t.id))}"]`);
  const running = t.ok === undefined;
  if (!card) {
    card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.tid = String(t.id);
    card.innerHTML =
      '<div class="tool-head">' +
      `<span class="tool-ico">${escapeHtml(TOOL_ICONS[t.name] || '⚙')}</span>` +
      `<span class="tname">${escapeHtml(t.name)}</span>` +
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
  const aMsg = { role: 'assistant', content: '', tool_calls: [], toolCalls: [] };
  conv.messages.push(aMsg);
  const el = buildMessageEl(aMsg);
  el.querySelector('.md').innerHTML = THINKING;
  $('messages').appendChild(el);
  scrollBottom();
  setBusy(true);

  const md = el.querySelector('.md');
  try {
    await postStream('/api/chat', {
      messages: conv.messages.filter((m) => m !== aMsg).map(stripForApi),
      config,
      agentEnabled: config.agentEnabled,
      planning
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
      } else if (event === 'error') {
        aMsg.content += (aMsg.content ? '\n\n' : '') + '⚠️ ' + (data.message || '出错了');
        md.innerHTML = renderMarkdown(aMsg.content);
      } else if (event === 'done' || event === 'end') {
        md.innerHTML = renderMarkdown(aMsg.content) || '<span class="muted small">（没有文本输出）</span>';
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
    conv.updatedAt = Date.now();
    saveConvs();
  }
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

function handleApprovalRequest(data) {
  if (sessionAutoApprove) return answerApproval(data.id, true);
  pendingApprovalId = data.id;
  $('approval-title').innerHTML = `执行 <code>${escapeHtml(data.name)}</code>`;
  $('approval-desc').textContent = data.description || '';
  $('approval-args').textContent = JSON.stringify(data.args || {}, null, 2);
  $('approval-remember').checked = false;
  $('approval-modal').classList.remove('hidden');
  $('approval-allow').focus();
}

function closeApproval() {
  pendingApprovalId = null;
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
  $('ws-path').textContent = workspacePath || '（未连接本地服务）';
  renderApprovalModes();
}
function openSettings(tab) {
  populateProviders();
  fillSettings();
  if (tab) switchTab(tab);
  $('settings-modal').classList.remove('hidden');
  $('settings-msg').textContent = '';
}
function closeSettings() { $('settings-modal').classList.add('hidden'); }

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
}

function onProviderChange() {
  const preset = PROVIDER_PRESETS.find((p) => p.id === $('set-provider').value);
  if (!preset) return;
  if (preset.baseURL) $('set-baseURL').value = preset.baseURL;
  if (preset.defaultModel) $('set-model').value = preset.defaultModel;
  $('set-apiKey').placeholder = preset.apiKeyPlaceholder || 'your-api-key';
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
    systemPrompt: $('set-systemPrompt').value
  };
  saveConfig();
  renderPermChip();
  renderAgentChip();
  renderModelChip();
  closeSettings();
  toast('已保存');
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
  $('test-conn').onclick = testConnection;
  $('set-provider').onchange = onProviderChange;
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

  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });
  $('export-data').onclick = exportData;
  $('import-data').onclick = () => $('import-file').click();
  $('import-file').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };
  $('reset-all').onclick = resetAll;

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
  renderRefs();
  autoGrow();
  pingHealth();
  setInterval(pingHealth, 30000);
}

init();
