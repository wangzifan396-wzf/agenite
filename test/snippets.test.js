// Snippets (指令库) core logic — pure, DOM-free, uses in-memory fallback when
// localStorage is unavailable (as in node:test), so it runs anywhere.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { listSnippets, addSnippet, removeSnippet, getSnippet, insertSnippetInto } from '../src/core/snippets.js';

describe('snippets core', () => {
  test('add returns an id and the list contains it', () => {
    const r = addSnippet('总结网页要点', '用三句话总结当前页面要点');
    assert.equal(r.ok, true);
    assert.ok(r.id);
    const found = listSnippets().find((s) => s.id === r.id);
    assert.ok(found);
    assert.equal(found.name, '总结网页要点');
    removeSnippet(r.id);
  });

  test('rejects empty name or body', () => {
    assert.equal(addSnippet('', 'x').ok, false);
    assert.equal(addSnippet('x', '').ok, false);
    assert.equal(addSnippet('   ', '  ').ok, false);
  });

  test('remove deletes by id', () => {
    const r = addSnippet('临时片段', 'body');
    removeSnippet(r.id);
    assert.ok(!listSnippets().find((s) => s.id === r.id));
  });

  test('getSnippet returns the matching item or null', () => {
    const r = addSnippet('查找', 'find');
    assert.equal(getSnippet(r.id).name, '查找');
    assert.equal(getSnippet('nope'), null);
    removeSnippet(r.id);
  });

  test('insertSnippetInto merges with a sensible separator', () => {
    assert.equal(insertSnippetInto('', 'hello'), 'hello');
    assert.equal(insertSnippetInto('a', 'b'), 'a\nb');
    assert.equal(insertSnippetInto('a ', 'b'), 'a b');
    assert.equal(insertSnippetInto('a\n', 'b'), 'a\nb');
  });
});
