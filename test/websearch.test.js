// web_search: free, key-less search via DuckDuckGo HTML. We test the parser and
// the tool wrapper with an injected fetch so no network is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../src/core/tools.js';

// A tiny fake fetch that returns canned DDG HTML (with a redirect link).
function fakeFetch(html) {
  return async () => ({ ok: true, status: 200, text: async () => html });
}

const HTML = `
  <div class="result">
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi">Node.js v22 API</a>
    <a class="result__snippet">Official Node.js documentation for the child_process module.</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs">MDN Web Docs</a>
    <a class="result__snippet">Resources for developers by Mozilla.</a>
  </div>
`;

test('web_search parses results and resolves the real (uddg) URLs', async () => {
  const r = await executeTool('web_search', { query: 'nodejs child_process' }, { fetchImpl: fakeFetch(HTML) });
  assert.equal(r.ok, true);
  assert.match(r.content, /nodejs\.org\/api/);
  assert.match(r.content, /developer\.mozilla\.org/);
  assert.match(r.content, /child_process/);
});

test('web_search reports gracefully when there are no hits', async () => {
  const empty = `<html><body><div class="no-results">no results</div></body></html>`;
  const r = await executeTool('web_search', { query: 'zzzz' }, { fetchImpl: fakeFetch(empty) });
  assert.equal(r.ok, true);
  assert.match(r.content, /没有找到|没有/);
});

test('web_search requires a query', async () => {
  const r = await executeTool('web_search', {}, { fetchImpl: fakeFetch(HTML) });
  assert.equal(r.ok, false);
});
