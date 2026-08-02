// Agenite browser controller: settings, streaming chat with tool visualization,
// multi-conversation management, theme. Talks to the local /api/chat proxy.
import { renderMarkdown } from './core/markdown.js';
import { uid, escapeHtml } from './core/util.js';
import { defaultConfig, PROVIDER_PRESETS } from './core/config.js';

const $ = (id) => document.getElementById(id);
const LS = { config: 'agenite:config', convs: 'agenite:conversations', cur: 'agenite:current', theme: 'agenite:theme' };

let config = loadConfig();
let conversations = loadConvs();
let currentId = localStorage.getItem(LS.cur) || (conversations[0] && conversations[0].id) || null;
let agentEnabled = config.agentEnabled !== false;
let abortCtrl = null;

function loadConfig() {
  try { return { ...defaultConfig(), ...JSON.parse(localStorage.getItem(LS.config) || '{}') }; }
  catch { return defaultConfig(); }
}
function saveConfig() { localStorage.setItem(LS.config, JSON.stringify(config)); }
function loadConvs() { try { return JSON.parse(localStorage.getItem(LS.convs) || '[]'); } catch { return []; } }
function saveConvs() { localStorage.setItem(LS.convs, JSON.stringify(conversations)); }
function currentConv() { return conversations.find((c) => c.id === currentId) || null; }

// ---------- theme ----------
function getInitialTheme() {
  const t = localStorage.getItem(LS.theme);
  if (t) return t;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('theme-toggle').textContent = theme === 'dark' ? '☀' : '🌙';
  localStorage.setItem(LS.theme, theme);
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
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
  return c;
}
function selectConv(id) {
  currentId = id;
  localStorage.setItem(LS.cur, currentId);
  renderConvList();
  renderMessages();
  updateTitle();
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
  for (const c of conversations) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === currentId ? ' active' : '');
    const t = document.createElement('div');
    t.className = 'conv-title';
    t.textContent = c.title || '新对话';
    const del = document.createElement('button');
    del.className = 'conv-del';
    del.textContent = '🗑';
    del.title = '删除';
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

// ---------- rendering messages ----------
function renderMessages() {
  const box = $('messages');
  box.innerHTML = '';
  const c = currentConv();
  if (!c || c.messages.length === 0) {
    box.innerHTML = '<div class="msg assistant"><div class="avatar">🤖</div><div class="bubble"><div class="md">👋 你好，我是 Agenite。在右上角 ⚙ 设置里填入你的模型 API Key，就可以开始对话了。开启 🛠 Agent 后，我可以联网查资料、读文件、做计算等。</div></div></div>';
    return;
  }
  for (const m of c.messages) {
    if (m.role === 'tool') continue;
    box.appendChild(buildMessageEl(m));
  }
  scrollBottom();
}

function buildMessageEl(m) {
  if (m.role === 'user') {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = `<div class="avatar">你</div><div class="bubble"></div>`;
    el.querySelector('.bubble').textContent = m.content || '';
    return el;
  }
  // assistant
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `<div class="avatar">🤖</div><div class="bubble"><div class="md"></div><div class="tools"></div></div>`;
  el.querySelector('.md').innerHTML = renderMarkdown(m.content || '') || '<span class="thinking">思考中…</span>';
  if (Array.isArray(m.toolCalls)) {
    for (const t of m.toolCalls) addToolCard(el, t);
  }
  return el;
}

function addToolCard(el, t) {
  const c = document.createElement('div');
  c.className = 'tool-card' + (t.ok ? '' : ' open');
  const args = escapeHtml(JSON.stringify(t.args || {}, null, 2));
  const res = escapeHtml(String(t.result == null ? '' : t.result));
  c.innerHTML = `<div class="tool-head"><span>🛠</span><span class="tname">${escapeHtml(t.name)}</span><span class="tstatus ${t.ok ? '' : 'err'}">${t.ok ? '完成' : '失败'}</span></div><div class="tool-body"><div><b>参数</b><pre>${args}</pre></div><div><b>结果</b><pre>${res}</pre></div></div>`;
  c.querySelector('.tool-head').onclick = () => c.classList.toggle('open');
  el.querySelector('.tools').appendChild(c);
}

function scrollBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

// ---------- streaming chat ----------
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
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { pendingEv = null; continue; }
      if (line.startsWith('event:')) { pendingEv = line.slice(6).trim(); }
      else if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        let obj;
        try { obj = JSON.parse(data); } catch { continue; }
        onEvent(pendingEv || 'message', obj);
      }
    }
  }
}

async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  let conv = currentConv();
  if (!conv) conv = newConv();
  conv.messages.push({ role: 'user', content: text });
  input.value = '';
  renderMessages();
  scrollBottom();

  abortCtrl = new AbortController();
  const aMsg = { role: 'assistant', content: '', tool_calls: [], toolCalls: [] };
  conv.messages.push(aMsg);
  const el = buildMessageEl(aMsg);
  $('messages').appendChild(el);
  aMsg._el = el;
  $('send').classList.add('hidden');
  $('stop').classList.remove('hidden');

  try {
    await postStream('/api/chat', {
      messages: conv.messages.map(stripForApi),
      config,
      agentEnabled
    }, (event, data) => {
      if (event === 'delta') {
        aMsg.content += data.content || '';
        const md = el.querySelector('.md');
        md.innerHTML = renderMarkdown(aMsg.content) || '<span class="thinking">思考中…</span>';
        scrollBottom();
      } else if (event === 'tool') {
        aMsg.tool_calls.push({ id: data.id, type: 'function', function: { name: data.name, arguments: JSON.stringify(data.args || {}) } });
        conv.messages.push({ role: 'tool', tool_call_id: data.id, name: data.name, content: data.ok ? data.result : 'Error: ' + data.result });
        aMsg.toolCalls.push(data);
        addToolCard(el, data);
        scrollBottom();
      } else if (event === 'error') {
        aMsg.content += '\n\n⚠️ ' + (data.message || '出错了');
        el.querySelector('.md').innerHTML = renderMarkdown(aMsg.content);
        scrollBottom();
      } else if (event === 'done' || event === 'end') {
        el.querySelector('.md').innerHTML = renderMarkdown(aMsg.content) || '<span class="thinking">（无内容）</span>';
      }
    }, abortCtrl.signal);
  } catch (e) {
    if (e.name !== 'AbortError') {
      aMsg.content += '\n\n⚠️ ' + (e.message || e);
      el.querySelector('.md').innerHTML = renderMarkdown(aMsg.content);
    }
  } finally {
    $('send').classList.remove('hidden');
    $('stop').classList.add('hidden');
    abortCtrl = null;
    if (conv.title === '新对话') {
      const firstUser = conv.messages.find((m) => m.role === 'user');
      if (firstUser) conv.title = firstUser.content.slice(0, 30) || '新对话';
      renderConvList();
      updateTitle();
    }
    conv.updatedAt = Date.now();
    saveConvs();
  }
}

// ---------- settings ----------
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
function fillSettingsFromConfig() {
  $('set-provider').value = config.provider || 'deepseek';
  $('set-baseURL').value = config.baseURL || '';
  $('set-apiKey').value = config.apiKey || '';
  $('set-model').value = config.model || '';
  $('set-temperature').value = config.temperature;
  $('temp-val').textContent = config.temperature;
  $('set-maxTokens').value = config.maxTokens;
  $('set-agentEnabled').checked = config.agentEnabled !== false;
  $('set-dangerTools').checked = !!config.dangerTools;
}
function openSettings() {
  populateProviders();
  fillSettingsFromConfig();
  $('settings-modal').classList.remove('hidden');
  $('settings-msg').textContent = '';
}
function closeSettings() { $('settings-modal').classList.add('hidden'); }

function onProviderChange() {
  const id = $('set-provider').value;
  const preset = PROVIDER_PRESETS.find((p) => p.id === id);
  if (preset) {
    if (preset.baseURL) $('set-baseURL').value = preset.baseURL;
    if (preset.defaultModel && !$('set-model').value) $('set-model').value = preset.defaultModel;
  }
}

function saveSettings() {
  const id = $('set-provider').value;
  const preset = PROVIDER_PRESETS.find((p) => p.id === id);
  config = {
    ...config,
    provider: id,
    protocol: preset ? preset.protocol : 'openai',
    baseURL: $('set-baseURL').value.trim(),
    apiKey: $('set-apiKey').value.trim(),
    model: $('set-model').value.trim(),
    temperature: Number($('set-temperature').value),
    maxTokens: Number($('set-maxTokens').value),
    agentEnabled: $('set-agentEnabled').checked,
    dangerTools: $('set-dangerTools').checked
  };
  saveConfig();
  agentEnabled = config.agentEnabled !== false;
  $('agent-toggle').classList.toggle('active', agentEnabled);
  $('model-label').textContent = config.model ? `${config.provider} · ${config.model}` : '';
  closeSettings();
}

async function testConnection() {
  const msgEl = $('settings-msg');
  msgEl.textContent = '检测中…';
  try {
    const res = await fetch('/api/health');
    if (res.ok) msgEl.textContent = '✅ 本地服务正常（Agenite 服务已启动）。';
    else msgEl.textContent = '⚠️ 本地服务返回异常。';
  } catch {
    msgEl.textContent = '❌ 无法连接本地服务，请确认 server.js 正在运行。';
  }
}

// ---------- wiring ----------
function wire() {
  $('new-chat').onclick = () => newConv();
  $('open-settings').onclick = openSettings;
  $('close-settings').onclick = closeSettings;
  $('save-settings').onclick = saveSettings;
  $('test-conn').onclick = testConnection;
  $('set-provider').onchange = onProviderChange;
  $('set-temperature').oninput = (e) => { $('temp-val').textContent = e.target.value; };
  $('theme-toggle').onclick = toggleTheme;
  $('agent-toggle').onclick = () => {
    agentEnabled = !agentEnabled;
    config.agentEnabled = agentEnabled;
    saveConfig();
    $('agent-toggle').classList.toggle('active', agentEnabled);
  };
  $('clear-chat').onclick = () => {
    const c = currentConv();
    if (c && c.messages.length) { c.messages = []; saveConvs(); renderMessages(); }
  };
  $('send').onclick = sendMessage;
  $('stop').onclick = () => { if (abortCtrl) abortCtrl.abort(); };
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  // copy buttons (event delegation)
  $('messages').addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const pre = btn.parentElement.querySelector('code');
    if (pre) navigator.clipboard.writeText(pre.textContent);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
  });
}

function updateConnDot() {
  const dot = $('conn-status');
  fetch('/api/health')
    .then((r) => { dot.className = 'dot ' + (r.ok ? 'ok' : 'err'); })
    .catch(() => { dot.className = 'dot err'; });
}

function init() {
  applyTheme(getInitialTheme());
  wire();
  renderConvList();
  renderMessages();
  updateTitle();
  $('agent-toggle').classList.toggle('active', agentEnabled);
  $('model-label').textContent = config.model ? `${config.provider} · ${config.model}` : '未配置模型';
  updateConnDot();
}

init();
