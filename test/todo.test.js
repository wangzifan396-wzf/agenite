// Live task checklist (todo_write) — the anti-drift mechanism.
//
// Three things must hold, and each one is a real failure mode we've seen in
// agents that skip them:
//   1. the list is validated, and violations come back as SCHEMA_ERROR tool
//      results so the model corrects ITSELF instead of us silently "fixing" it;
//   2. the current list is re-injected before every model call but never
//      persisted into history (otherwise the transcript fills with stale copies);
//   3. going quiet on the checklist gets nagged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTodos, renderTodos, todoProgress, todoReminder, emptyTodoState, MAX_TODOS
} from '../src/core/todo.js';
import { executeTool, activeTools } from '../src/core/tools.js';
import { runAgent } from '../src/core/agent.js';

// ---- validation ----

test('normalizeTodos accepts a well-formed list', () => {
  const r = normalizeTodos([
    { content: '读配置', status: 'completed' },
    { content: '加端点', status: 'in_progress', activeForm: '正在加端点' },
    { content: '跑测试', status: 'pending' }
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 3);
  assert.equal(r.items[1].activeForm, '正在加端点');
});

test('normalizeTodos rejects two in_progress items', () => {
  const r = normalizeTodos([
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'in_progress' }
  ]);
  assert.equal(r.ok, false);
  assert.match(r.error, /最多只能有 1 项 in_progress/);
});

test('normalizeTodos rejects unknown status, empty content, empty list and overflow', () => {
  assert.equal(normalizeTodos([{ content: 'a', status: 'done' }]).ok, false);
  assert.equal(normalizeTodos([{ content: '   ', status: 'pending' }]).ok, false);
  assert.equal(normalizeTodos([]).ok, false);
  assert.equal(normalizeTodos('nope').ok, false);
  const many = Array.from({ length: MAX_TODOS + 1 }, (_, i) => ({ content: 'task ' + i, status: 'pending' }));
  assert.equal(normalizeTodos(many).ok, false);
});

test('renderTodos / todoProgress surface the current item', () => {
  const items = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress', activeForm: '正在做 b' },
    { content: 'c', status: 'pending' }
  ];
  const out = renderTodos(items);
  assert.match(out, /✅ 1\. a/);
  assert.match(out, /🔄 2\. 正在做 b {2}← 进行中/);
  assert.match(out, /⬜ 3\. c/);
  assert.equal(todoProgress(items), '1/3 完成 · 进行中：正在做 b');
});

// ---- the tool itself ----

test('todo_write stores the list and echoes progress', async () => {
  const state = emptyTodoState();
  const res = await executeTool('todo_write', {
    todos: [
      { content: '读配置', status: 'completed' },
      { content: '加端点', status: 'in_progress' },
      { content: '跑测试', status: 'pending' }
    ]
  }, { todoState: state });
  assert.equal(res.ok, true);
  assert.equal(state.items.length, 3);
  assert.equal(state.updates, 1);
  assert.match(res.content, /1\/3 完成/);
});

test('todo_write violations come back as SCHEMA_ERROR so the model self-corrects', async () => {
  const state = emptyTodoState();
  const res = await executeTool('todo_write', {
    todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }]
  }, { todoState: state });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, 'SCHEMA_ERROR');
  // A rejected write must not half-apply.
  assert.equal(state.items.length, 0);
});

test('todo_write asks "did you verify?" when everything is done and nothing was checked', async () => {
  const state = emptyTodoState();
  const res = await executeTool('todo_write', {
    todos: [
      { content: '写模块', status: 'completed' },
      { content: '接线', status: 'completed' },
      { content: '更新文档', status: 'completed' }
    ]
  }, { todoState: state });
  assert.equal(res.ok, true);
  assert.match(res.content, /没有任何验证步骤/);
});

test('todo_write stays quiet when the list already verifies its own work', async () => {
  const state = emptyTodoState();
  const res = await executeTool('todo_write', {
    todos: [
      { content: '写模块', status: 'completed' },
      { content: '接线', status: 'completed' },
      { content: '跑测试验证', status: 'completed' }
    ]
  }, { todoState: state });
  assert.equal(res.ok, true);
  assert.doesNotMatch(res.content, /没有任何验证步骤/);
});

test('todo_write flags silently dropped unfinished tasks', async () => {
  const state = emptyTodoState();
  await executeTool('todo_write', {
    todos: [{ content: 'keep', status: 'in_progress' }, { content: 'drop me', status: 'pending' }]
  }, { todoState: state });
  const res = await executeTool('todo_write', {
    todos: [{ content: 'keep', status: 'in_progress' }]
  }, { todoState: state });
  assert.equal(res.ok, true);
  assert.match(res.content, /移除了 1 项未完成的任务/);
  assert.match(res.content, /drop me/);
});

test('todo_write without server state fails loudly instead of pretending', async () => {
  const res = await executeTool('todo_write', { todos: [{ content: 'a', status: 'pending' }] }, {});
  assert.equal(res.ok, false);
});

test('todo_write is a safe, always-available tool', () => {
  const names = activeTools({}).map((t) => t.name);
  assert.ok(names.includes('todo_write'));
});

// ---- the reminder ----

test('todoReminder is silent with no list until the run is clearly multi-step', () => {
  const st = emptyTodoState();
  assert.equal(todoReminder(st, { turn: 0 }), '');
  assert.equal(todoReminder(st, { turn: 1 }), '');
  const hint = todoReminder(st, { turn: 2 });
  assert.match(hint, /还没有建立任务清单/);
  // Once said, never repeated — nagging about the same thing is noise.
  assert.equal(todoReminder(st, { turn: 3 }), '');
});

test('todoReminder pins the current item and nags when the list goes stale', () => {
  const st = emptyTodoState();
  st.items = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' }
  ];
  const fresh = todoReminder(st, { turn: 5, turnsSinceTodo: 1 });
  assert.match(fresh, /当前任务清单/);
  assert.match(fresh, /下一步只做这一件事：「b」/);
  assert.doesNotMatch(fresh, /连续/);

  const stale = todoReminder(st, { turn: 9, turnsSinceTodo: 3 });
  assert.match(stale, /连续 3 轮没有更新任务清单/);
});

test('todoReminder pushes back when nothing is in_progress', () => {
  const st = emptyTodoState();
  st.items = [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }];
  assert.match(todoReminder(st, { turn: 3 }), /没有 in_progress 的任务/);
});

test('todoReminder asks for verification once every task is ticked off', () => {
  const st = emptyTodoState();
  st.items = [{ content: '写代码', status: 'completed' }, { content: '接线', status: 'completed' }];
  assert.match(todoReminder(st, { turn: 4 }), /没有任何验证步骤/);

  st.items = [{ content: '写代码', status: 'completed' }, { content: '跑测试', status: 'completed' }];
  assert.equal(todoReminder(st, { turn: 4 }), '');
});

// ---- integration with the agent loop ----

function scriptedModel(script) {
  let n = 0;
  return async (messages) => {
    const step = script[Math.min(n, script.length - 1)];
    n++;
    if (typeof step === 'function') return step(messages);
    return step;
  };
}

test('the loop injects the checklist before each call and never persists it', async () => {
  const todoState = emptyTodoState();
  todoState.items = [{ content: '改 server.js', status: 'in_progress' }];

  const seen = [];
  const callModel = scriptedModel([
    (messages) => {
      seen.push(messages.map((m) => m.role + ':' + String(m.content).slice(0, 24)));
      return { content: '', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a' } }], usage: null };
    },
    (messages) => {
      seen.push(messages.map((m) => m.role + ':' + String(m.content).slice(0, 24)));
      return { content: 'ok', toolCalls: [], usage: null };
    }
  ]);

  const messages = [{ role: 'user', content: 'go' }];
  await runAgent({
    messages,
    callModel,
    executeTool: async () => ({ ok: true, content: 'file body' }),
    config: {},
    toolContext: { todoState }
  });

  // The reminder was visible to the model...
  assert.ok(seen[0].some((s) => s.startsWith('system:【当前任务清单】')));
  assert.ok(seen[1].some((s) => s.startsWith('system:【当前任务清单】')));
  // ...but is gone from the transcript we keep.
  assert.equal(messages.filter((m) => m.role === 'system').length, 0);
});

test('the loop emits a todo event whenever the checklist actually changes', async () => {
  const todoState = emptyTodoState();
  const events = [];
  const callModel = scriptedModel([
    { content: '', toolCalls: [{ id: 't1', name: 'todo_write', args: { todos: [{ content: 'a', status: 'in_progress' }] } }], usage: null },
    { content: 'done', toolCalls: [], usage: null }
  ]);

  await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    callModel,
    executeTool: (name, args, opts) => executeTool(name, args, opts),
    onEvent: (type, payload) => { if (type === 'todo') events.push(payload); },
    config: {},
    toolContext: { todoState }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].items[0].content, 'a');
  assert.equal(events[0].progress, '0/1 完成 · 进行中：a');
});

test('a failed todo_write emits nothing and leaves the panel untouched', async () => {
  const todoState = emptyTodoState();
  const events = [];
  const callModel = scriptedModel([
    { content: '', toolCalls: [{ id: 't1', name: 'todo_write', args: { todos: [] } }], usage: null },
    { content: 'done', toolCalls: [], usage: null }
  ]);

  const messages = [{ role: 'user', content: 'go' }];
  await runAgent({
    messages,
    callModel,
    executeTool: (name, args, opts) => executeTool(name, args, opts),
    onEvent: (type, payload) => { if (type === 'todo') events.push(payload); },
    config: {},
    toolContext: { todoState }
  });

  assert.equal(events.length, 0);
  // The model is told exactly what it did wrong, so it can retry correctly.
  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /SCHEMA_ERROR/);
});

test('config.todoReminders=false turns the injection off entirely', async () => {
  const todoState = emptyTodoState();
  todoState.items = [{ content: 'a', status: 'in_progress' }];
  let saw = false;
  const callModel = async (messages) => {
    saw = saw || messages.some((m) => m.role === 'system' && /当前任务清单/.test(m.content || ''));
    return { content: 'done', toolCalls: [], usage: null };
  };
  await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    callModel,
    executeTool: async () => ({ ok: true, content: '' }),
    config: { todoReminders: false },
    toolContext: { todoState }
  });
  assert.equal(saw, false);
});
