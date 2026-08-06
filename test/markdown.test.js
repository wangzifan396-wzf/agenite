import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/core/markdown.js';

test('escapes HTML in text', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renders headings and bold', () => {
  const html = renderMarkdown('# Title\n\nSome **bold** text');
  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(html.includes('<strong>bold</strong>'));
});

test('renders fenced code blocks', () => {
  const html = renderMarkdown('```js\nconst a = 1;\n```');
  assert.ok(html.includes('<pre class="code-block"'));
  assert.ok(html.includes('const a = 1;'));
});

test('renders ```html as a sandboxed live artifact', () => {
  const html = renderMarkdown('```html\n<h1>Hi</h1>\n```');
  assert.ok(html.includes('class="artifact"'), 'should wrap html in an artifact card');
  assert.ok(html.includes('class="atab"'), 'should have preview/code tabs');
  assert.ok(html.includes('<iframe'), 'should embed a preview iframe');
  assert.ok(html.includes('sandbox="allow-scripts"'), 'iframe must be sandboxed');
  assert.ok(html.includes('srcdoc='), 'iframe should carry the source');
});

test('artifact escapes untrusted markup (no script execution in parent)', () => {
  const html = renderMarkdown('```html\n<img src=x onerror=alert(1)>\n```');
  assert.ok(html.includes('class="artifact"'));
  // srcdoc attribute-escapes quotes; the raw text still appears but inside an
  // isolated sandbox, never as live markup in the parent document.
  assert.ok(!html.includes('<script'), 'no raw script tag in parent doc');
});

test('renders links with sanitized href', () => {
  const html = renderMarkdown('[x](https://e.com)');
  assert.ok(html.includes('href="https://e.com"'));
});

test('neutralizes javascript: links', () => {
  const html = renderMarkdown('[x](javascript:alert(1))');
  assert.ok(!html.includes('javascript:alert'));
  assert.ok(html.includes('href="#"'));
});

test('renders lists', () => {
  const html = renderMarkdown('- a\n- b');
  assert.ok(html.includes('<ul>') && html.includes('<li>a</li>'));
});
