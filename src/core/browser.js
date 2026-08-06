// Built-in browser automation — a local, headless Chrome driven by
// puppeteer-core, so Agenite can actually *browse the web* as a first-class
// native tool (no MCP server, no extra setup). This is what turns the agent
// from "talks about the web" into "opens the page, clicks, reads it".
//
// Design notes:
//   - puppeteer-core is imported lazily and only when a tool actually needs it,
//     so the module loads fine even when puppeteer-core / Chrome are missing
//     (the server stays up; the tools just return a helpful error). Tests can
//     inject a fake controller via opts.browser and never touch Chrome.
//   - One shared browser + one page process-wide. Local-first, single-user, so
//     a singleton is the simplest correct model; the live preview panel reads
//     exactly what the agent is looking at.
//   - Deterministic element handles (v0.21): browser_snapshot injects a
//     temporary data-agenite-ref="@eN" attribute on every visible interactive
//     element and returns them as a stable, clickable list. click/type take a
//     ref instead of brittle CSS selectors or coordinates — this is the single
//     biggest reliability win over vision/coordinate-driven browsing, and it
//     needs no cloud at all (local-first by construction).
//   - Action audit trail (v0.21): every navigate/click/type/back/scroll is
//     recorded with a timestamp + target so the user (and the model) can review
//     exactly what the agent did — answering the 2026 "agentic browsing needs
//     auditable traces" requirement without leaving the machine.
//   - Every method returns { ok, content, ... } like the rest of the tools.
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessSync, constants, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

// Candidate Chrome/Chromium executables, most-specific first. Override with
// AGENITE_CHROME. Keeps the experience zero-config on the common platforms.
const CHROME_CANDIDATES = [
  process.env.AGENITE_CHROME,
  join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(homedir(), 'AppData', 'Local', 'Chromium', 'Application', 'chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      // Existence check. (Windows ignores X_OK, so this is effectively F_OK —
      // fine, we only need the binary to exist; puppeteer-core validates it.)
      accessSync(p, constants.X_OK);
      return p;
    } catch { /* try next */ }
  }
  return null;
}

// Selector for the interactive elements we surface as clickable refs.
const INTERACTIVE_SEL = [
  'a[href]', 'button', 'input', 'select', 'textarea',
  '[role="button"]', '[role="link"]', '[tabindex]', '[contenteditable="true"]'
].join(',');

// The shared controller. Methods are arrow functions so they work regardless
// of how they're invoked (e.g. ctrl[name](args) inside the dispatch switch).
export const BROWSER = {
  _puppeteer: null,
  _browser: null,
  _page: null,
  _launchError: null,
  _chromePath: null,
  _refs: null,        // Map<ref, selector> from the latest snapshot
  _actions: null,     // ring buffer of audit entries
  _viewport: { width: 1280, height: 800 }, // fixed so screenshot px map to overlay
  _elementsValid: false, // refs currently valid for the open DOM
  _lastElements: null,   // last snapshot's interactive elements (with rects)

  // Lazily load puppeteer-core and locate Chrome. Caches any failure so we
  // don't spam the same error on every call.
  async _ensure() {
    if (this._browser) return { ok: true };
    if (this._launchError) return { ok: false, error: this._launchError };
    try {
      const mod = await import('puppeteer-core');
      this._puppeteer = mod.default || mod;
      this._chromePath = findChrome();
      const launchOpts = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      };
      if (this._chromePath) launchOpts.executablePath = this._chromePath;
      this._browser = await this._puppeteer.launch(launchOpts);
      this._browser.on('disconnected', () => { this._browser = null; this._page = null; });
      return { ok: true };
    } catch (e) {
      this._launchError = '无法启动浏览器：' + (e && e.message ? e.message : e) +
        '（需要本机 Chrome 与 puppeteer-core；可在设置用 MCP 接入 Playwright 替代）';
      return { ok: false, error: this._launchError };
    }
  },

  async _pageReady() {
    const ensured = await this._ensure();
    if (!ensured.ok) return ensured;
    if (!this._page || this._page.isClosed()) {
      this._page = await this._browser.newPage();
      try { await this._page.setViewport(this._viewport); } catch { /* ignore */ }
    }
    return { ok: true, page: this._page };
  },

  // Resolve a click/type target from either a snapshot ref or a raw selector.
  _resolveTarget(args = {}) {
    const ref = String(args.ref || '').trim();
    if (ref) {
      const sel = this._refs && this._refs.get(ref);
      if (!sel) {
        return { error: `找不到元素引用 ${ref} —— 请先调用 browser_snapshot 获取最新引用（页面变化后引用会失效）` };
      }
      return { selector: sel };
    }
    const selector = String(args.selector || '').trim();
    if (!selector) return { error: 'ref 或 selector 不能为空' };
    return { selector };
  },

  _record(kind, target, extra) {
    if (!this._actions) this._actions = [];
    this._actions.push({ t: Date.now(), kind, target, extra: extra || null });
    if (this._actions.length > 200) this._actions.shift();
  },

  _recentActions(n = 12) {
    if (!this._actions || !this._actions.length) return [];
    return this._actions.slice(-n).map((a) => ({
      time: new Date(a.t).toISOString(),
      action: a.kind,
      target: a.target,
      detail: a.extra ? JSON.stringify(a.extra) : null
    }));
  },

  // Briefly highlight an element on the live page before acting on it. This is
  // the single biggest click-accuracy win per 2026 browser-agent research
  // (bounding-box highlight lifts misclick rate to 90-95%): it both scrolls
  // the element into view so the click can't miss an off-screen node, and
  // gives the user a visible "what the agent is touching" pulse in the live
  // preview. Best-effort: any failure here must never break the real action.
  async _highlight(selector) {
    if (!this._page || this._page.isClosed()) return;
    try {
      await this._page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        try { el.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
        const prevOutline = el.style.outline;
        const prevOffset = el.style.outlineOffset;
        const prevShadow = el.style.boxShadow;
        el.style.outline = '3px solid #ff3b30';
        el.style.outlineOffset = '2px';
        el.style.transition = 'box-shadow .15s ease';
        let n = 0;
        const iv = setInterval(() => {
          el.style.boxShadow = (n % 2 === 0)
            ? '0 0 0 10px rgba(255,59,48,.18)'
            : '0 0 0 4px rgba(255,59,48,.45)';
          if (++n >= 4) {
            clearInterval(iv);
            el.style.outline = prevOutline;
            el.style.outlineOffset = prevOffset;
            el.style.boxShadow = prevShadow;
          }
        }, 170);
      }, selector);
    } catch { /* highlight is purely cosmetic */ }
  },

  // ---- tool-facing methods ----

  async navigate(args = {}) {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '仅支持 http(s) 链接' };
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    try {
      await pr.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      this._refs = null; // DOM changed; refs are stale now
      this._elementsValid = false;
      const title = await pr.page.title();
      this._record('navigate', url);
      return { ok: true, content: `已打开 ${url}\n标题: ${title}` };
    } catch (e) {
      return { ok: false, error: '打开页面失败: ' + (e && e.message ? e.message : e) };
    }
  },

  async snapshot() {
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    try {
      const data = await pr.page.evaluate((sel) => {
        const els = Array.from(document.querySelectorAll(sel));
        const out = [];
        let i = 0;
        for (const el of els) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue; // skip hidden
          const ref = 'e' + (++i);
          try { el.setAttribute('data-agenite-ref', ref); } catch { /* ignore */ }
          const tag = (el.tagName || '').toLowerCase();
          const role = el.getAttribute('role') || tag;
          const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '';
          let name = aria.trim();
          if (!name) {
            if (tag === 'input' || tag === 'textarea') name = el.getAttribute('placeholder') || (el.value || '').slice(0, 40);
            else name = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          }
          const href = tag === 'a' ? (el.getAttribute('href') || '') : '';
          const placeholder = (tag === 'input' || tag === 'textarea') ? (el.getAttribute('placeholder') || '') : '';
          const type = tag === 'input' ? (el.getAttribute('type') || 'text') : '';
          out.push({
            ref, tag, role, name: name.trim(), href, placeholder, type,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
          });
        }
        return {
          title: document.title,
          url: location.href,
          text: document.body ? document.body.innerText : '',
          elements: out
        };
      }, INTERACTIVE_SEL);

      // Persist ref -> selector so click/type can resolve deterministically.
      this._refs = new Map();
      for (const el of data.elements) {
        this._refs.set(el.ref, `[data-agenite-ref="${el.ref}"]`);
      }
      this._lastElements = data.elements;
      this._elementsValid = true;

      let text = String(data.text || '').replace(/\n{3,}/g, '\n\n').trim();
      if (text.length > 6000) text = text.slice(0, 6000) + '\n…(已截断)';

      const listed = data.elements.slice(0, 80).map((el) => {
        const tag = el.type ? `${el.tag} ${el.type}` : el.tag;
        const extra = el.href ? ` -> ${el.href}` : (el.placeholder ? ` placeholder="${el.placeholder}"` : '');
        return `@${el.ref} [${tag}] "${el.name}"${extra}`;
      }).join('\n');

      const content = [
        `页面: ${data.title}`,
        `地址: ${data.url}`,
        '',
        `【可交互元素 ${data.elements.length} 个（用 @引用 给 click/type）】`,
        listed || '（无可交互元素）',
        '',
        '【可见文本】',
        text || '（无文本）'
      ].join('\n');

      return {
        ok: true,
        content,
        url: data.url,
        title: data.title,
        elements: data.elements,
        viewport: this._viewport,
        actions: this._recentActions()
      };
    } catch (e) {
      return { ok: false, error: '读取页面失败: ' + (e && e.message ? e.message : e) };
    }
  },

  // Re-read interactive element rects from the live DOM using the refs already
  // stamped by snapshot(). Does NOT reassign refs, so element identities stay
  // stable between snapshots (important for clicks by ref). Used by the live
  // preview overlay so the markers track the real page as it scrolls.
  async _collectElements() {
    if (!this._page || this._page.isClosed()) return [];
    try {
      return await this._page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('[data-agenite-ref]'));
        const out = [];
        for (const el of els) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          const tag = (el.tagName || '').toLowerCase();
          const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '';
          let name = (aria || '').trim();
          if (!name) {
            if (tag === 'input' || tag === 'textarea') name = el.getAttribute('placeholder') || (el.value || '').slice(0, 40);
            else name = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          }
          out.push({
            ref: el.getAttribute('data-agenite-ref'),
            tag,
            role: el.getAttribute('role') || tag,
            name: name.trim(),
            href: tag === 'a' ? (el.getAttribute('href') || '') : '',
            placeholder: (tag === 'input' || tag === 'textarea') ? (el.getAttribute('placeholder') || '') : '',
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
          });
        }
        return out;
      });
    } catch { return []; }
  },

  async screenshot() {
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    try {
      const buf = await pr.page.screenshot({ type: 'png', fullPage: false });
      const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
      return { ok: true, content: '已截图当前页面。', screenshot: dataUrl };
    } catch (e) {
      return { ok: false, error: '截图失败: ' + (e && e.message ? e.message : e) };
    }
  },

  async click(args = {}) {
    const t = this._resolveTarget(args);
    if (t.error) return { ok: false, error: t.error };
    const ref = String(args.ref || '').trim();
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    await this._highlight(t.selector);
    try {
      await pr.page.click(t.selector);
      this._refs = null; // DOM likely changed after a click
      this._elementsValid = false;
      this._record('click', t.selector, ref ? { ref } : null);
      return { ok: true, content: `已点击 ${t.selector}`, ref: ref || undefined };
    } catch (e) {
      return { ok: false, error: '点击失败（元素可能不存在或不可见）: ' + (e && e.message ? e.message : e) };
    }
  },

  async type(args = {}) {
    const t = this._resolveTarget(args);
    if (t.error) return { ok: false, error: t.error };
    const ref = String(args.ref || '').trim();
    const text = String(args.text == null ? '' : args.text);
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    await this._highlight(t.selector);
    try {
      await pr.page.focus(t.selector);
      await pr.page.type(t.selector, text);
      this._record('type', t.selector, { text, ref: ref || undefined });
      return { ok: true, content: `已在 ${t.selector} 输入文本（${text.length} 字符）`, ref: ref || undefined };
    } catch (e) {
      return { ok: false, error: '输入失败: ' + (e && e.message ? e.message : e) };
    }
  },

  async back() {
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    try {
      await pr.page.goBack({ waitUntil: 'domcontentloaded' });
      this._refs = null;
      this._elementsValid = false;
      this._record('back', 'history');
      return { ok: true, content: '已后退到上一页' };
    } catch (e) {
      return { ok: false, error: '后退失败: ' + (e && e.message ? e.message : e) };
    }
  },

  async scroll(args = {}) {
    const direction = String(args.direction || 'down').trim().toLowerCase();
    const amount = Number(args.amount) || 600;
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    try {
      const delta = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
      await pr.page.evaluate((d) => window.scrollBy(0, d), delta);
      this._record('scroll', direction);
      return { ok: true, content: `已向${direction === 'up' ? '上' : '下'}滚动 ${amount}px` };
    } catch (e) {
      return { ok: false, error: '滚动失败: ' + (e && e.message ? e.message : e) };
    }
  },

  async log() {
    const actions = this._recentActions(50);
    const lines = actions.length
      ? actions.map((a) => `${a.time}  ${a.action}  ${a.target}${a.detail ? '  ' + a.detail : ''}`).join('\n')
      : '（暂无操作记录）';
    return { ok: true, content: '【操作审计轨迹】\n' + lines, actions };
  },

  // Persist the current login state (cookies + localStorage) to a local JSON
  // file so an agent can resume an authenticated session across runs without
  // re-logging-in every time. This directly answers the 2026 "session
  // persistence is the hardest browser-agent operational problem" gap. The
  // file lives under dir (default: workspace/.agenite/browser-sessions, or a
  // temp dir when no workspace is configured). Purely local — nothing leaves
  // the machine.
  async saveSession(args = {}) {
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    const name = (String(args.name || 'default').trim() || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
    const dir = String(args.dir || join(tmpdir(), 'agenite-browser-sessions')).trim();
    try { mkdirSync(dir, { recursive: true }); } catch { /* may already exist */ }
    const file = join(dir, name + '.json');
    let cookies = [];
    try { cookies = await pr.page.cookies(); } catch { /* ignore */ }
    let storage = {};
    try {
      storage = await pr.page.evaluate(() => {
        const out = {};
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k != null) out[k] = localStorage.getItem(k);
          }
        } catch { /* cross-origin/localStorage unavailable */ }
        return out;
      });
    } catch { /* ignore */ }
    const payload = { name, savedAt: new Date().toISOString(), url: pr.page.url(), cookies, storage };
    try {
      writeFileSync(file, JSON.stringify(payload, null, 2));
    } catch (e) {
      return { ok: false, error: '保存会话失败: ' + (e && e.message ? e.message : e) };
    }
    return {
      ok: true,
      content:
        `已保存浏览器会话 "${name}" 到 ${file}\n` +
        `Cookie: ${cookies.length} 项，localStorage: ${Object.keys(storage).length} 项。\n` +
        `恢复请用 browser_restore_session（name="${name}"）。`
    };
  },

  // Restore a previously saved session (cookies + localStorage). Cookies are
  // domain-scoped and re-applied by the browser; localStorage must be written
  // on the matching origin, so the caller should browser_navigate to the
  // target site first, then restore, then reload for the state to take effect.
  async restoreSession(args = {}) {
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    const name = (String(args.name || 'default').trim() || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
    const dir = String(args.dir || join(tmpdir(), 'agenite-browser-sessions')).trim();
    const file = join(dir, name + '.json');
    if (!existsSync(file)) return { ok: false, error: `找不到会话 "${name}"（${file}）` };
    let payload;
    try { payload = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { return { ok: false, error: '读取会话失败: ' + (e && e.message ? e.message : e) }; }
    try {
      if (Array.isArray(payload.cookies) && payload.cookies.length) {
        await pr.page.setCookie(...payload.cookies);
      }
    } catch { /* ignore cookie errors */ }
    let restored = 0;
    if (payload.storage && typeof payload.storage === 'object') {
      try {
        await pr.page.evaluate((store) => {
          for (const k of Object.keys(store)) {
            try { localStorage.setItem(k, store[k]); } catch { /* ignore */ }
          }
        }, payload.storage);
        restored = Object.keys(payload.storage).length;
      } catch { /* ignore */ }
    }
    this._refs = null;
    this._elementsValid = false;
    return {
      ok: true,
      content:
        `已恢复浏览器会话 "${name}"（Cookie ${payload.cookies ? payload.cookies.length : 0} 项，localStorage ${restored} 项）。\n` +
        `请调用 browser_navigate 重新打开 ${payload.url || '目标页面'}，登录态即可生效。`
    };
  },

  async close() {
    if (this._browser) {
      try { await this._browser.close(); } catch { /* ignore */ }
    }
    this._browser = null;
    this._page = null;
    this._refs = null;
    this._actions = null;
    return { ok: true, content: '已关闭浏览器。' };
  },

  // Status for the live preview panel + availability probe. Includes a fresh
  // screenshot when a page is open so the UI can show exactly what the agent
  // sees. Returns available:false with a reason instead of throwing.
  async status() {
    const ensured = await this._ensure();
    if (!ensured.ok) {
      return { ok: false, available: false, open: false, error: ensured.error };
    }
    if (!this._page || this._page.isClosed()) {
      return { ok: true, available: true, open: false, url: null, title: null, actions: this._recentActions() };
    }
    try {
      const info = await this._page.evaluate(() => ({ title: document.title, url: location.href }));
      let screenshot = null;
      try {
        const buf = await this._page.screenshot({ type: 'png', fullPage: false });
        screenshot = 'data:image/png;base64,' + buf.toString('base64');
      } catch { /* screenshot optional */ }
      // Only surface clickable refs when they're still valid for this DOM;
      // after navigate/click/back the stamped refs are stale, so the overlay
      // hides itself until the agent calls browser_snapshot again.
      let elements = null;
      if (this._elementsValid && this._refs) {
        try { elements = await this._collectElements(); } catch { elements = null; }
      }
      return {
        ok: true, available: true, open: true,
        url: info.url, title: info.title, screenshot,
        elements, viewport: this._viewport,
        actions: this._recentActions()
      };
    } catch (e) {
      return { ok: true, available: true, open: false, url: null, title: null, error: e.message };
    }
  }
};

export default BROWSER;
