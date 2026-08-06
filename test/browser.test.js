// Browser automation: unit-test the routing contract with an injected fake
// controller (no Chrome needed), and a guarded real-Chrome smoke that skips
// gracefully when puppeteer-core / Chrome are not installed on this machine.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { executeTool, activeTools } from '../src/core/tools.js';
import { BROWSER } from '../src/core/browser.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A stand-in controller so we can verify dispatch/return-shape without a
// running browser. Mirrors BROWSER's method surface. Records calls so we can
// assert session save/restore routed to the right method.
function fakeBrowser() {
  const calls = [];
  return {
    __calls: calls,
    navigate: async (a) => ({ ok: true, content: '打开 ' + a.url }),
    snapshot: async () => ({ ok: true, content: '页面文本', url: 'https://x.test/', title: 'X', elements: [{ ref: 'e1', tag: 'a', name: 'go' }] }),
    screenshot: async () => ({ ok: true, content: '已截图', screenshot: 'data:image/png;base64,AAAA' }),
    click: async (a) => ({ ok: true, content: '点击 ' + (a.selector || a.ref), ref: a.ref || undefined }),
    type: async (a) => ({ ok: true, content: '输入 ' + a.text, ref: a.ref || undefined }),
    back: async () => ({ ok: true, content: '后退' }),
    scroll: async (a) => ({ ok: true, content: '滚动 ' + (a.direction || 'down') }),
    log: async () => ({ ok: true, content: 'log', actions: [] }),
    saveSession: async (a) => { calls.push({ op: 'save', a }); return { ok: true, content: 'saved ' + (a.name || 'default') + ' dir=' + a.dir }; },
    restoreSession: async (a) => { calls.push({ op: 'restore', a }); return { ok: true, content: 'restored ' + (a.name || 'default') + ' dir=' + a.dir }; },
    close: async () => ({ ok: true, content: '关闭' }),
    status: async () => ({ ok: true, available: true, open: true, url: 'u', title: 't' })
  };
}

describe('browser tools — routing & contract (injected fake)', () => {
  const fake = fakeBrowser();
  const cases = [
    ['browser_navigate', { url: 'https://example.com' }, '打开 https://example.com'],
    ['browser_snapshot', {}, '页面文本'],
    ['browser_screenshot', {}, '已截图'],
    ['browser_click', { selector: 'a#go' }, '点击 a#go'],
    ['browser_type', { selector: '#q', text: 'hi' }, '输入 hi'],
    ['browser_back', {}, '后退'],
    ['browser_scroll', { direction: 'up' }, '滚动 up']
  ];
  for (const [name, args, expectSub] of cases) {
    test(name + ' routes to controller and returns ok', async () => {
      // danger tools (click/type) require dangerTools like write_file does.
      const r = await executeTool(name, args, { browser: fake, dangerTools: true });
      assert.equal(r.ok, true);
      assert.ok(r.content.includes(expectSub), 'content=' + r.content);
    });
  }

  test('browser_click accepts a snapshot ref (deterministic handle)', async () => {
    const r = await executeTool('browser_click', { ref: 'e3' }, { browser: fake, dangerTools: true });
    assert.equal(r.ok, true);
    assert.ok(r.content.includes('e3'));
  });

  test('browser_log routes to controller and returns ok', async () => {
    const r = await executeTool('browser_log', {}, { browser: fake });
    assert.equal(r.ok, true);
  });

  test('browser_save_session / browser_restore_session route and infer dir from workspace', async () => {
    const r = await executeTool('browser_save_session', { name: 'gh' }, { browser: fake, workspace: '/tmp/ws' });
    assert.equal(r.ok, true);
    const save = fake.__calls.find((c) => c.op === 'save' && c.a.name === 'gh');
    assert.ok(save, 'saveSession should have been called');
    assert.ok(save.a.dir.replace(/\\/g, '/').includes('/tmp/ws/.agenite/browser-sessions'), 'dir=' + save.a.dir);
    const r2 = await executeTool('browser_restore_session', { name: 'gh' }, { browser: fake, workspace: '/tmp/ws' });
    assert.equal(r2.ok, true);
    assert.ok(fake.__calls.some((c) => c.op === 'restore'));
  });

  test('browser_save_session passes an explicit dir through', async () => {
    const r = await executeTool('browser_save_session', { name: 'x', dir: '/custom/dir' }, { browser: fake });
    assert.equal(r.ok, true);
    const save = fake.__calls.find((c) => c.op === 'save' && c.a.name === 'x');
    assert.ok(save.a.dir.replace(/\\/g, '/').endsWith('/custom/dir'), 'dir=' + save.a.dir);
  });

  test('click/type echo back the snapshot ref for UI flashing', async () => {
    const c = await executeTool('browser_click', { ref: 'e3' }, { browser: fake, dangerTools: true });
    assert.equal(c.ok, true);
    assert.equal(c.ref, 'e3');
    const t = await executeTool('browser_type', { ref: 'e3', text: 'hi' }, { browser: fake, dangerTools: true });
    assert.equal(t.ok, true);
    assert.equal(t.ref, 'e3');
  });

  test('falls back to the shared BROWSER singleton when opts.browser absent', async () => {
    // BROWSER has all methods; should not be treated as "unavailable".
    const r = await BROWSER.status();
    assert.ok('available' in r);
  });

  test('returns a helpful error when the controller lacks the method', async () => {
    const r = await executeTool('browser_navigate', { url: 'https://x' }, { browser: {}, dangerTools: true });
    assert.equal(r.ok, false);
    assert.ok(/不可用/.test(r.error));
  });

  test('rejects danger tools unless dangerTools enabled (safety gate)', async () => {
    const r = await executeTool('browser_click', { selector: 'a' }, { browser: fake });
    assert.equal(r.ok, false);
    assert.ok(/电脑操作权限/.test(r.error));
  });

  test('read-only browser_log is available without dangerTools', async () => {
    const names = activeTools({}).map((t) => t.name);
    assert.ok(names.includes('browser_log'));
  });
});

// Session persistence exercises the real BROWSER methods (file I/O + cookie /
// localStorage extraction) without launching Chrome: we stub a minimal
// browser+page on the singleton so _ensure() short-circuits.
describe('browser — session persistence (injected fake page, no Chrome)', () => {
  const dir = path.join(os.tmpdir(), 'agenite-test-sessions-' + Date.now());
  const savedFile = path.join(dir, 'demo.json');
  before(() => {
    BROWSER._browser = { on() {} };
    BROWSER._page = {
      isClosed: () => false,
      url: () => 'https://x.test/page',
      cookies: async () => ([{ name: 'sid', value: 'abc', domain: 'x.test', path: '/' }]),
      evaluate: async () => ({ token: 't-123', theme: 'dark' }),
      setCookie: async () => {}
    };
  });
  after(() => {
    BROWSER._browser = null;
    BROWSER._page = null;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('saveSession writes cookies + localStorage to a JSON file', async () => {
    const r = await BROWSER.saveSession({ name: 'demo', dir });
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(savedFile), 'session file not written');
    const data = JSON.parse(fs.readFileSync(savedFile, 'utf8'));
    assert.equal(data.name, 'demo');
    assert.equal(data.url, 'https://x.test/page');
    assert.ok(Array.isArray(data.cookies) && data.cookies.length === 1);
    assert.equal(data.storage.token, 't-123');
  });

  test('restoreSession reads the file and applies cookies + storage', async () => {
    const r = await BROWSER.restoreSession({ name: 'demo', dir });
    assert.equal(r.ok, true);
    assert.ok(r.content.includes('demo'));
    assert.ok(r.content.includes('Cookie 1'));
  });

  test('restoreSession fails clearly when the file is missing', async () => {
    const r = await BROWSER.restoreSession({ name: 'nope', dir });
    assert.equal(r.ok, false);
    assert.ok(/找不到会话/.test(r.error));
  });
});

describe('browser tools — danger gating in activeTools', () => {
  test('read/observe tools are always available (danger:false)', () => {
    const names = activeTools({}).map((t) => t.name);
    for (const n of ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_back', 'browser_scroll']) {
      assert.ok(names.includes(n), 'missing ' + n);
    }
  });
  test('click/type require dangerTools (gated like write_file)', () => {
    const safe = activeTools({}).map((t) => t.name);
    assert.ok(!safe.includes('browser_click') && !safe.includes('browser_type'));
    const armed = activeTools({ dangerTools: true, approvalMode: 'ask' }).map((t) => t.name);
    assert.ok(armed.includes('browser_click') && armed.includes('browser_type'));
  });
});

// ---- guarded real smoke: only runs when puppeteer-core + Chrome exist ----
let puppeteerResolvable = false;
try {
  // Same resolution BROWSER will attempt (bare specifier from this package).
  require.resolve('puppeteer-core');
  puppeteerResolvable = true;
} catch { /* not installed — skip the real run */ }

describe('browser — real Chrome smoke', { skip: !puppeteerResolvable || process.env.AGENITE_SKIP_CHROME === '1' }, () => {
  let server;
  let url;
  before(async () => {
    // Serve a tiny page locally so the smoke needs no external network.
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body><h1>hello</h1><p>world</p><a href="/next">next</a><button>go</button></body></html>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = 'http://127.0.0.1:' + server.address().port + '/';
  });
  after(async () => { if (server) await new Promise((r) => server.close(r)); });

  test('navigate + snapshot (with @refs) + ref-based click + screenshot', async () => {
    const nav = await BROWSER.navigate({ url });
    assert.equal(nav.ok, true);
    const snap = await BROWSER.snapshot();
    assert.equal(snap.ok, true);
    assert.ok(/hello|world/.test(snap.content));
    // snapshot must expose deterministic element refs for click/type.
    assert.ok(Array.isArray(snap.elements) && snap.elements.length >= 2, 'elements=' + JSON.stringify(snap.elements));
    const firstRef = snap.elements[0].ref;
    assert.ok(/^e\d+$/.test(firstRef), 'ref format ' + firstRef);
    // each element carries a viewport-space rect so the UI can overlay markers.
    const el0 = snap.elements[0];
    assert.ok('rect' in el0 && typeof el0.rect.x === 'number' && typeof el0.rect.width === 'number', 'rect=' + JSON.stringify(el0.rect));
    // status() should surface the same elements (valid refs) + the fixed viewport.
    const st = await BROWSER.status();
    assert.equal(st.open, true);
    assert.ok(Array.isArray(st.elements) && st.elements.length >= 2, 'status elements');
    assert.ok(st.viewport && st.viewport.width === 1280 && st.viewport.height === 800);
    // click by ref resolves the injected selector deterministically.
    const clicked = await BROWSER.click({ ref: firstRef });
    assert.equal(clicked.ok, true);
    // after a mutate (click) the stamped refs are stale, so the overlay hides.
    const st2 = await BROWSER.status();
    assert.equal(st2.elements, null);
    const shot = await BROWSER.screenshot();
    assert.equal(shot.ok, true);
    assert.ok(shot.screenshot.startsWith('data:image/png;base64,'));
    await BROWSER.close();
  });

  test('click by unknown ref is rejected with a helpful error', async () => {
    const nav = await BROWSER.navigate({ url });
    assert.equal(nav.ok, true);
    await BROWSER.snapshot();
    const r = await BROWSER.click({ ref: 'e999' });
    assert.equal(r.ok, false);
    assert.ok(/找不到元素引用/.test(r.error));
    await BROWSER.close();
  });

  test('highlight flashes an element in-page and click returns its ref', async () => {
    const nav = await BROWSER.navigate({ url });
    assert.equal(nav.ok, true);
    const snap = await BROWSER.snapshot();
    assert.equal(snap.ok, true);
    const ref = snap.elements[0].ref;
    // _highlight must run on a real page without throwing.
    await BROWSER._highlight('[data-agenite-ref="' + ref + '"]');
    const clicked = await BROWSER.click({ ref });
    assert.equal(clicked.ok, true);
    assert.equal(clicked.ref, ref);
    await BROWSER.close();
  });

  test('rejects non-http url without launching', async () => {
    const r = await BROWSER.navigate({ url: 'file:///etc/passwd' });
    assert.equal(r.ok, false);
  });
});
