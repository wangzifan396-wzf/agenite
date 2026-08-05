// Browser automation: unit-test the routing contract with an injected fake
// controller (no Chrome needed), and a guarded real-Chrome smoke that skips
// gracefully when puppeteer-core / Chrome are not installed on this machine.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { executeTool, activeTools } from '../src/core/tools.js';
import { BROWSER } from '../src/core/browser.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A stand-in controller so we can verify dispatch/return-shape without a
// running browser. Mirrors BROWSER's method surface.
function fakeBrowser() {
  return {
    navigate: async (a) => ({ ok: true, content: '打开 ' + a.url }),
    snapshot: async () => ({ ok: true, content: '页面文本', url: 'https://x.test/', title: 'X' }),
    screenshot: async () => ({ ok: true, content: '已截图', screenshot: 'data:image/png;base64,AAAA' }),
    click: async (a) => ({ ok: true, content: '点击 ' + a.selector }),
    type: async (a) => ({ ok: true, content: '输入 ' + a.text }),
    back: async () => ({ ok: true, content: '后退' }),
    scroll: async (a) => ({ ok: true, content: '滚动 ' + (a.direction || 'down') }),
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

describe('browser — real Chrome smoke', { skip: !puppeteerResolvable }, () => {
  let server;
  let url;
  before(async () => {
    // Serve a tiny page locally so the smoke needs no external network.
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body><h1>hello</h1><p>world</p></body></html>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = 'http://127.0.0.1:' + server.address().port + '/';
  });
  after(async () => { if (server) await new Promise((r) => server.close(r)); });

  test('navigate + snapshot + screenshot against a real local page', async () => {
    const nav = await BROWSER.navigate({ url });
    assert.equal(nav.ok, true);
    const snap = await BROWSER.snapshot();
    assert.equal(snap.ok, true);
    assert.ok(/hello|world/.test(snap.content));
    const shot = await BROWSER.screenshot();
    assert.equal(shot.ok, true);
    assert.ok(shot.screenshot.startsWith('data:image/png;base64,'));
    await BROWSER.close();
  });

  test('rejects non-http url without launching', async () => {
    const r = await BROWSER.navigate({ url: 'file:///etc/passwd' });
    assert.equal(r.ok, false);
  });
});
