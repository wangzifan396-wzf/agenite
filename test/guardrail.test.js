import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/core/agent.js';

// A two-turn model: first turn returns the supplied tool call, second turn a final
// answer with no tool calls. Keeps every test deterministic and short.
function twoTurnModel(firstToolCall) {
  let n = 0;
  return async () => {
    n++;
    if (n === 1) return { content: '', toolCalls: [firstToolCall], usage: { prompt_tokens: 10, completion_tokens: 10 } };
    return { content: 'done', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  };
}

const BASE = { model: 'gpt-4o-mini' };

test('deny mode blocks every tool and never executes it', async () => {
  let executed = 0;
  const events = [];
  const res = await runAgent({
    messages: [{ role: 'user', content: 'do it' }],
    callModel: twoTurnModel({ id: 't1', name: 'write_file', args: { path: 'a.txt', content: 'x' } }),
    executeTool: async () => { executed++; return { ok: true, content: 'ok' }; },
    onEvent: (t, p) => events.push([t, p]),
    config: { ...BASE, approvalMode: 'deny' },
    maxTurns: 5
  });
  assert.equal(executed, 0, 'tool must not execute under deny mode');
  assert.ok(events.some(([t, p]) => t === 'guardrail' && p.decision === 'deny' && p.tool === 'write_file'), 'should emit a deny guardrail event');
  assert.equal(res.stopped, 'done');
});

test('secret args are hard-denied even under auto mode', async () => {
  let executed = 0;
  const events = [];
  const res = await runAgent({
    messages: [{ role: 'user', content: 'read the secret' }],
    callModel: twoTurnModel({ id: 't1', name: 'read_file', args: { path: '.env' } }),
    executeTool: async () => { executed++; return { ok: true, content: 'x' }; },
    onEvent: (t, p) => events.push([t, p]),
    config: { ...BASE, approvalMode: 'auto' },
    maxTurns: 5
  });
  assert.equal(executed, 0, 'secret access must never reach executeTool');
  const denied = events.find(([t, p]) => t === 'guardrail' && p.decision === 'deny');
  assert.ok(denied, 'should emit a deny guardrail event');
  assert.equal(denied[1].reason, 'secret-access-blocked');
  assert.equal(res.stopped, 'done');
});

test('ask mode flags risky tools but still lets the harness execute them', async () => {
  let executed = 0;
  const events = [];
  const res = await runAgent({
    messages: [{ role: 'user', content: 'run it' }],
    callModel: twoTurnModel({ id: 't1', name: 'run_command', args: { command: 'ls' } }),
    executeTool: async () => { executed++; return { ok: true, content: 'ran' }; },
    onEvent: (t, p) => events.push([t, p]),
    config: { ...BASE, approvalMode: 'ask' },
    maxTurns: 5
  });
  assert.equal(executed, 1, 'ask-mode tools still execute (approval handled by harness)');
  assert.ok(events.some(([t, p]) => t === 'guardrail' && p.decision === 'ask' && p.tool === 'run_command'), 'should emit an ask guardrail event');
  assert.equal(res.stopped, 'done');
});

test('network rate cap allows up to the cap then denies the rest in one turn', async () => {
  let executed = 0;
  const events = [];
  let n = 0;
  const callModel = async () => {
    n++;
    if (n === 1) {
      return {
        content: '',
        toolCalls: [
          { id: 'a', name: 'web_fetch', args: { url: 'u1' } },
          { id: 'b', name: 'web_fetch', args: { url: 'u2' } }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 }
      };
    }
    return { content: 'done', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  };
  const res = await runAgent({
    messages: [{ role: 'user', content: 'fetch two urls' }],
    callModel,
    executeTool: async () => { executed++; return { ok: true, content: 'page' }; },
    onEvent: (t, p) => events.push([t, p]),
    config: { ...BASE, guardrails: { networkCap: 1 } },
    maxTurns: 5
  });
  assert.equal(executed, 1, 'only the first network call should execute (cap=1)');
  const denied = events.find(([t, p]) => t === 'guardrail' && p.decision === 'deny' && p.reason === 'network-rate-limit');
  assert.ok(denied, 'should deny the second network call via rate cap');
  assert.equal(res.stopped, 'done');
});

test('denyList blocks a specific tool even under auto mode', async () => {
  let executed = 0;
  const events = [];
  const res = await runAgent({
    messages: [{ role: 'user', content: 'x' }],
    callModel: twoTurnModel({ id: 't1', name: 'run_code', args: { code: '1+1' } }),
    executeTool: async () => { executed++; return { ok: true, content: '2' }; },
    onEvent: (t, p) => events.push([t, p]),
    config: { ...BASE, approvalMode: 'auto', guardrails: { denyList: ['run_code'] } },
    maxTurns: 5
  });
  assert.equal(executed, 0);
  assert.ok(events.some(([t, p]) => t === 'guardrail' && p.decision === 'deny' && p.reason === 'deny-list'));
  assert.equal(res.stopped, 'done');
});
