// Loop Engineering / self-healing:
//   1. edit_file returns Aider-style "Did you mean these actual lines?" when the
//      SEARCH block doesn't match, so the model self-corrects instead of looping.
//   2. The agent loop runs a *root-cause* self-heal (v0.68, fault.js): a failed
//      mutating tool or a stuck loop is classified into a fault category, and
//      decideSelfHeal picks the right remedy — reflect / replan / retry /
//      compress / escalate — bounded by maxReflections, escalating exactly once
//      when the cap is hit. See test/fault.test.js for the pure-decision suite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeTool } from '../src/core/tools.js';
import { runAgent } from '../src/core/agent.js';

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agenite-sh-'));
  return d;
}
const opt = (d) => ({ workspace: d, dangerTools: true });

test('edit_file: no-match surfaces nearby real lines (Did you mean?)', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'code.txt'), 'function add(a, b) {\n  return a + b;\n}\n');
  const r = await executeTool(
    'edit_file',
    { path: 'code.txt', old_text: 'return a + c', new_text: 'return a + b;' },
    opt(dir)
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /你是不是想匹配这些实际行/);
  assert.match(r.error, /return a \+ b/);
  assert.match(r.error, /相似度/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('edit_file: ambiguous match tells which lines and asks for a longer span', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'dup.txt'), 'x = 1\nx = 1\n');
  const r = await executeTool(
    'edit_file',
    { path: 'dup.txt', old_text: 'x = 1', new_text: 'y = 2' },
    opt(dir)
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /出现 2 次/);
  assert.match(r.error, /不唯一/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent loop: root-cause self-heal is bounded then escalates once', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'f.txt'), 'hello\n');
  const messages = [{ role: 'user', content: 'edit f.txt' }];
  let callCount = 0;
  // The model keeps emitting a broken edit (wrong old_text) every turn.
  const callModel = async () => {
    callCount++;
    return {
      content: '',
      toolCalls: [
        { id: 'e' + callCount, name: 'edit_file', args: { path: 'f.txt', old_text: 'NOPE', new_text: 'world' } }
      ],
      usage: null
    };
  };
  const executeTool = async () => ({ ok: false, error: '找不到要替换的文本', errorClass: 'SCHEMA_ERROR' });
  const res = await runAgent({
    messages,
    callModel,
    executeTool,
    config: { selfHeal: true, maxReflections: 3, workspace: dir },
    maxTurns: 10
  });
  assert.equal(res.stopped, 'max_turns');
  // Three bounded nudges (reflect → reflect → replan), then exactly one escalate.
  const nudges = messages.filter((m) => m.role === 'user' && /自检（第/.test(m.content));
  assert.equal(nudges.length, 3);
  assert.match(nudges[0].content, /第 1\/3 次/);
  assert.match(nudges[2].content, /第 3\/3 次/);
  const escalations = messages.filter((m) => m.role === 'user' && /已尝试 3\/3 次仍失败/.test(m.content));
  assert.equal(escalations.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent loop: selfHeal:false suppresses self-heal entirely', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'f.txt'), 'hello\n');
  const messages = [{ role: 'user', content: 'edit f.txt' }];
  const callModel = async () => ({
    content: '',
    toolCalls: [{ id: 'e', name: 'edit_file', args: { path: 'f.txt', old_text: 'NOPE', new_text: 'x' } }],
    usage: null
  });
  const executeTool = async () => ({ ok: false, error: 'no' });
  await runAgent({
    messages,
    callModel,
    executeTool,
    config: { selfHeal: false, workspace: dir },
    maxTurns: 5
  });
  const nudges = messages.filter((m) => m.role === 'user' && /自检|重规划|重试|已尝试/.test(m.content));
  assert.equal(nudges.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent loop: autoGit checkpoint fires once after a successful mutation', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'f.txt'), 'hello\n');
  const messages = [{ role: 'user', content: 'edit f.txt' }];
  let callCount = 0;
  const callModel = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        content: '',
        toolCalls: [{ id: 'e', name: 'edit_file', args: { path: 'f.txt', old_text: 'hello', new_text: 'hi' } }],
        usage: null
      };
    }
    return { content: 'done', toolCalls: [], usage: null };
  };
  const executeTool = async () => ({ ok: true, content: 'edited', diff: '...' });
  let checkpointed = 0;
  const autoGit = async () => { checkpointed++; };
  await runAgent({
    messages,
    callModel,
    executeTool,
    config: { workspace: dir },
    toolContext: { autoGit },
    maxTurns: 5
  });
  // Edit succeeded on turn 1 → exactly one checkpoint (the final answer turn is not a mutation).
  assert.equal(checkpointed, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
