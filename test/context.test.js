// Context compaction is the difference between "the agent handled a 40-step
// task" and "the API returned 400 and everything was lost". These tests pin
// down the two invariants that matter: it must shrink, and it must never break
// the tool_calls/tool pairing that providers validate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens, messageTokens, totalTokens, toolsTokens,
  contextWindowFor, DEFAULT_CONTEXT_WINDOW, historyBudget,
  groupMessages, trimText, mechanicalDigest, compactMessages
} from '../src/core/context.js';

test('estimateTokens counts CJK heavier than latin', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  const cjk = estimateTokens('中文字符测试');       // 6 chars, ~1 token each
  const latin = estimateTokens('abcdef');           // 6 chars, ~3.6 per token
  assert.ok(cjk > latin, `CJK (${cjk}) should cost more than latin (${latin})`);
  assert.ok(cjk >= 6, 'roughly one token per CJK character');
});

test('messageTokens includes tool_calls arguments, not just content', () => {
  const plain = { role: 'assistant', content: 'hi' };
  const withCall = {
    role: 'assistant',
    content: 'hi',
    tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: JSON.stringify({ path: 'x'.repeat(400) }) } }]
  };
  assert.ok(messageTokens(withCall) > messageTokens(plain) + 50);
});

test('totalTokens and toolsTokens accumulate', () => {
  assert.equal(totalTokens([]), 0);
  const msgs = [{ role: 'user', content: 'hello world' }, { role: 'assistant', content: 'hi there' }];
  assert.ok(totalTokens(msgs) > 0);
  const tools = [{ name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: {} } }];
  assert.ok(toolsTokens(tools) > 0);
  assert.equal(toolsTokens([]), 0);
});

test('contextWindowFor knows common models and falls back safely', () => {
  assert.equal(contextWindowFor('gpt-4o-mini'), 128000);
  assert.equal(contextWindowFor('claude-3-5-sonnet-20241022'), 200000);
  assert.equal(contextWindowFor('deepseek-chat'), 65536);
  assert.equal(contextWindowFor('some-model-nobody-has-heard-of'), DEFAULT_CONTEXT_WINDOW);
  assert.equal(contextWindowFor(''), DEFAULT_CONTEXT_WINDOW);
});

test('historyBudget reserves room for the reply and the tool schemas', () => {
  const b = historyBudget({ contextWindow: 100000, maxTokens: 4000, toolTokens: 1000 });
  assert.ok(b < 100000 - 4000 - 1000 + 1, 'must leave room for reply + tools');
  assert.ok(b > 0);
  // A pathological config must not produce a negative or zero budget.
  const tiny = historyBudget({ contextWindow: 1000, maxTokens: 8000, toolTokens: 5000 });
  assert.ok(tiny > 0, 'budget stays positive even when over-reserved');
});

test('groupMessages keeps assistant+tool replies in one atomic group', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'f', content: 'result' },
    { role: 'assistant', content: 'done' }
  ];
  const groups = groupMessages(msgs);
  assert.equal(groups[0].pinned, true, 'system prompt is pinned');
  const withCall = groups.find((g) => g.items.some((m) => m.tool_calls));
  assert.ok(withCall, 'found the tool-calling group');
  assert.ok(
    withCall.items.some((m) => m.role === 'tool'),
    'the tool result lives in the same group as the call that produced it'
  );
});

test('trimText keeps both ends so head and tail survive', () => {
  const long = 'START' + 'x'.repeat(5000) + 'END';
  const t = trimText(long, 200);
  assert.ok(t.length < long.length);
  assert.ok(t.startsWith('START'));
  assert.ok(t.endsWith('END'));
  assert.equal(trimText('short', 200), 'short');
});

test('mechanicalDigest mentions the tools that ran', () => {
  const groups = groupMessages([
    { role: 'user', content: '读一下配置' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{"path":"a.json"}' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'read_file', content: '{...}' }
  ]);
  const d = mechanicalDigest(groups);
  assert.match(d, /read_file/);
});

test('compactMessages is a no-op when the history already fits', async () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' }
  ];
  const r = await compactMessages(msgs, { budget: 100000 });
  assert.equal(r.compacted, false);
  assert.deepEqual(r.messages, msgs);
});

test('compactMessages shrinks a bloated history below budget', async () => {
  const msgs = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: 'user', content: `第 ${i} 步，请继续处理这个很长的任务。` });
    msgs.push({
      role: 'assistant', content: '',
      tool_calls: [{ id: 't' + i, function: { name: 'read_file', arguments: JSON.stringify({ path: `f${i}.txt` }) } }]
    });
    msgs.push({ role: 'tool', tool_call_id: 't' + i, name: 'read_file', content: 'DATA'.repeat(800) });
  }
  const before = totalTokens(msgs);
  const budget = Math.floor(before / 6);
  const r = await compactMessages(msgs, { budget, keepRecentGroups: 2, toolTrimTo: 200 });
  assert.equal(r.compacted, true);
  assert.ok(r.after < r.before, `after (${r.after}) < before (${r.before})`);
  assert.ok(r.after <= budget * 1.1, `landed near the budget (${r.after} vs ${budget})`);
});

test('compaction never leaves an orphan tool_call or tool result', async () => {
  const msgs = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 25; i++) {
    msgs.push({ role: 'user', content: 'step ' + i });
    msgs.push({
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call' + i, function: { name: 'run_command', arguments: '{}' } }]
    });
    msgs.push({ role: 'tool', tool_call_id: 'call' + i, name: 'run_command', content: 'OUT'.repeat(1000) });
  }
  const r = await compactMessages(msgs, { budget: 900, keepRecentGroups: 1, toolTrimTo: 100 });

  const calls = new Set();
  for (const m of r.messages) {
    if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) calls.add(tc.id);
  }
  for (const m of r.messages) {
    if (m.role === 'tool') {
      assert.ok(calls.has(m.tool_call_id), `tool result ${m.tool_call_id} has a matching call`);
    }
  }
  const answered = new Set(r.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  for (const id of calls) assert.ok(answered.has(id), `call ${id} has a matching result`);
});

test('the system prompt always survives compaction', async () => {
  const msgs = [{ role: 'system', content: 'YOU ARE AGENITE' }];
  for (let i = 0; i < 40; i++) msgs.push({ role: 'user', content: 'x'.repeat(2000) });
  const r = await compactMessages(msgs, { budget: 500, keepRecentGroups: 1 });
  assert.equal(r.messages[0].role, 'system');
  assert.match(r.messages[0].content, /YOU ARE AGENITE/);
});

test('an injected summarizer replaces dropped turns with its recap', async () => {
  const msgs = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: 'user', content: 'x'.repeat(1500) });
    msgs.push({ role: 'assistant', content: 'y'.repeat(1500) });
  }
  let called = 0;
  const r = await compactMessages(msgs, {
    budget: 600,
    keepRecentGroups: 1,
    summarize: async () => { called++; return '【摘要】用户在做一个长任务。'; }
  });
  assert.equal(called, 1, 'summarizer is called exactly once');
  assert.ok(r.messages.some((m) => String(m.content).includes('【摘要】')), 'recap is injected into the history');
});

test('a failing summarizer degrades to the mechanical digest instead of throwing', async () => {
  const msgs = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 30; i++) msgs.push({ role: 'user', content: 'x'.repeat(1500) });
  const r = await compactMessages(msgs, {
    budget: 600,
    keepRecentGroups: 1,
    summarize: async () => { throw new Error('model is down'); }
  });
  assert.equal(r.compacted, true, 'compaction still happened');
  assert.ok(r.messages.length > 0);
});
