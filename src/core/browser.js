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
//   - Every method returns { ok, content, ... } like the rest of the tools.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { accessSync, constants } from 'node:fs';

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

// The shared controller. Methods are arrow functions so they work regardless
// of how they're invoked (e.g. ctrl[name](args) inside the dispatch switch).
export const BROWSER = {
  _puppeteer: null,
  _browser: null,
  _page: null,
  _launchError: null,
  _chromePath: null,

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
    }
    return { ok: true, page: this._page };
  },

  // ---- tool-facing methods ----

  async navigate(args = {}) {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '仅支持 http(s) 链接' };
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    try {
      await pr.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const title = await pr.page.title();
      return { ok: true, content: `已打开 ${url}\n标题: ${title}` };
    } catch (e) {
      return { ok: false, error: '打开页面失败: ' + (e && e.message ? e.message : e) };
    }
  },

  async snapshot() {
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    try {
      const data = await pr.page.evaluate(() => ({
        title: document.title,
        url: location.href,
        text: document.body ? document.body.innerText : ''
      }));
      let text = String(data.text || '').replace(/\n{3,}/g, '\n\n').trim();
      if (text.length > 8000) text = text.slice(0, 8000) + '\n…(已截断)';
      return {
        ok: true,
        content: `页面: ${data.title}\n地址: ${data.url}\n\n可见内容:\n${text}`,
        url: data.url,
        title: data.title
      };
    } catch (e) {
      return { ok: false, error: '读取页面失败: ' + (e && e.message ? e.message : e) };
    }
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
    const selector = String(args.selector || '').trim();
    if (!selector) return { ok: false, error: 'selector 不能为空' };
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    try {
      await pr.page.click(selector);
      return { ok: true, content: `已点击 ${selector}` };
    } catch (e) {
      return { ok: false, error: '点击失败（元素可能不存在或不可见）: ' + (e && e.message ? e.message : e) };
    }
  },

  async type(args = {}) {
    const selector = String(args.selector || '').trim();
    const text = String(args.text == null ? '' : args.text);
    if (!selector) return { ok: false, error: 'selector 不能为空' };
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    try {
      await pr.page.type(selector, text);
      return { ok: true, content: `已在 ${selector} 输入文本（${text.length} 字符）` };
    } catch (e) {
      return { ok: false, error: '输入失败: ' + (e && e.message ? e.message : e) };
    }
  },

  async back() {
    const pr = await this._pageReady();
    if (!pr.ok) return pr;
    try {
      await pr.page.goBack({ waitUntil: 'domcontentloaded' });
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
      return { ok: true, content: `已向${direction === 'up' ? '上' : '下'}滚动 ${amount}px` };
    } catch (e) {
      return { ok: false, error: '滚动失败: ' + (e && e.message ? e.message : e) };
    }
  },

  async close() {
    if (this._browser) {
      try { await this._browser.close(); } catch { /* ignore */ }
    }
    this._browser = null;
    this._page = null;
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
      return { ok: true, available: true, open: false, url: null, title: null };
    }
    try {
      const info = await this._page.evaluate(() => ({ title: document.title, url: location.href }));
      let screenshot = null;
      try {
        const buf = await this._page.screenshot({ type: 'png', fullPage: false });
        screenshot = 'data:image/png;base64,' + buf.toString('base64');
      } catch { /* screenshot optional */ }
      return { ok: true, available: true, open: true, url: info.url, title: info.title, screenshot };
    } catch (e) {
      return { ok: true, available: true, open: false, url: null, title: null, error: e.message };
    }
  }
};

export default BROWSER;
