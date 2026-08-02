// Sub-agent delegation: isolation, scoping, summary-only return, event streaming.
import assert from 'node:assert';
import test from 'node:test';
import {
  scopeTools,
  buildSubAgentSystemPrompt,
  extractSubAgentSummary,
  createSubAgentRunner
} from '../src/core/subagent.js';

const TOOLS = [
  { name: 'delegate' },
  { name: 'calculator' },
  { name: 'web_fetch' },
  { name: 'run_command' }
];

test('scopeTools strips delegate (no nesting) and honors tool_scope', () => {
  assert.deepEqual(
    scopeTools(TOOLS, null).map((t) => t.name),
    ['calculator', 'web_fetch', 'run_command']
  );
  assert.deepEqual(scopeTools(TOOLS, ['web_fetch']).map((t) => t.name), ['web_fetch']);
  assert.deepEqual(scopeTools(TOOLS, ['nope']).map((t) => t.name), []);
});

test('buildSubAgentSystemPrompt includes goal, persona and memory', () => {
  const p = buildSubAgentSystemPrompt({ persona: 'researcher', goal: 'find X', memoryBlock: '记住：Y' });
  assert.match(p, /find X/);
  assert.match(p, /researcher/);
  assert.match(p, /记住：Y/);
  const bare = buildSubAgentSystemPrompt({ goal: 'do it' });
  assert.match(bare, /do it/);
  assert.ok(!/记住/.test(bare));
});

test('extractSubAgentSummary returns the last assistant text', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'goal' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'final answer' }
  ];
  assert.equal(extractSubAgentSummary(msgs), 'final answer');
  assert.equal(extractSubAgentSummary([{ role: 'user', content: 'x' }]), '');
});

test('createSubAgentRunner runs an isolated loop and returns only the summary', async () => {
  let modelCalls = 0;
  const callModel = async (msgs) => {
    modelCalls++;
    if (modelCalls === 1) {
      return { content: '', toolCalls: [{ id: 't1', name: 'calculator', args: { expression: '1+1' } }] };
    }
    return { content: '结果是 2', toolCalls: [] };
  };
  const executeTool = async (name) => ({ ok: true, content: name === 'calculator' ? '2' : 'ok' });

  const events = [];
  const runSubAgent = createSubAgentRunner({
    callModel,
    executeTool,
    baseConfig: { maxTurns: 5 },
    tools: TOOLS,
    injectMemory: null,
    onSubEvent: (id, name, type, payload) => events.push({ id, name, type, payload }),
    requestApproval: null,
    platform: 'linux'
  });

  const r = await runSubAgent({ goal: 'compute 1+1', persona: 'math' });
  assert.equal(r.ok, true);
  assert.match(r.content, /结果是 2/);
  assert.equal(r.turns, 2);
  assert.ok(events.some((e) => e.type === 'tool' && e.payload.name === 'calculator'), 'tool event streamed');
  assert.ok(events.some((e) => e.type === 'done'), 'done event streamed');
});

test('createSubAgentRunner requires a goal and refuses empty tool set', async () => {
  const runSubAgent = createSubAgentRunner({
    callModel: async () => ({ content: '', toolCalls: [] }),
    executeTool: async () => ({ ok: true, content: '' }),
    baseConfig: {},
    tools: TOOLS,
    onSubEvent: null
  });
  const noGoal = await runSubAgent({});
  assert.equal(noGoal.ok, false);
  const noTools = await runSubAgent({ goal: 'x', tool_scope: ['nonexistent'] });
  assert.equal(noTools.ok, false);
});
