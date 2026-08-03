// Integration test: the MAIN agent loop calls the `fanout` tool, which fans out
// into N isolated sub-agents that run concurrently, then the aggregated summary
// is fed back into the main loop. Exercises the real dispatch path
// (tools.executeTool -> opts.runFanout -> createFanoutRunner -> createSubAgentRunner
// -> runAgent) without any network or real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/core/agent.js';
import { createSubAgentRunner, createFanoutRunner } from '../src/core/subagent.js';
import { executeTool, TOOL_DEFS } from '../src/core/tools.js';

// Fake child model: echos whatever goal it was given as the final summary,
// and never asks for a tool — so each sub-agent finishes in exactly one turn.
function makeChildCallModel() {
  return async (msgs) => {
    const last = msgs[msgs.length - 1];
    const goal = last && last.content ? String(last.content) : '';
    return { content: 'SUMMARY: ' + goal, toolCalls: [], usage: null };
  };
}

test('main loop fanout tool runs N sub-agents in parallel and aggregates', async () => {
  const events = [];
  const subAgentEvents = []; // (id, persona, type, payload)

  const runSubAgent = createSubAgentRunner({
    callModel: makeChildCallModel(),
    executeTool: async () => ({ ok: true, content: '' }),
    baseConfig: {},
    tools: TOOL_DEFS,
    memoryBase: '',
    injectMemory: null,
    onSubEvent: (id, persona, type, payload) => subAgentEvents.push([id, persona, type, payload]),
    summarize: null,
    requestApproval: null,
    platform: 'linux'
  });
  const runFanout = createFanoutRunner(runSubAgent);

  const messages = [{ role: 'user', content: 'Research A, B and C in parallel.' }];

  let callCount = 0;
  const callModel = async (msgs, { onDelta }) => {
    callCount++;
    if (callCount === 1) {
      return {
        content: '',
        toolCalls: [
          {
            id: 'f1',
            name: 'fanout',
            args: {
              tasks: [
                { goal: 'A', persona: 'researcher' },
                { goal: 'B' },
                { goal: 'C', tool_scope: ['calculator'] }
              ]
            }
          }
        ],
        usage: null
      };
    }
    onDelta('All done.');
    return { content: 'All done.', toolCalls: [], usage: null };
  };

  const res = await runAgent({
    messages,
    callModel,
    executeTool,
    onEvent: (t, p) => events.push([t, p]),
    config: {},
    tools: TOOL_DEFS,
    toolContext: { runFanout, runSubAgent, platform: 'linux' }
  });

  // Main loop finished normally after the tool result came back.
  assert.equal(res.stopped, 'done');
  assert.equal(callCount, 2);

  // The fanout tool fired exactly once on the main loop.
  const fanoutEvents = events.filter(([t, p]) => t === 'tool' && p.name === 'fanout');
  assert.equal(fanoutEvents.length, 1);
  const resultText = fanoutEvents[0][1].result;

  // Aggregated content carries every child's summary (A / B / C echoed back).
  assert.ok(resultText.includes('A'), 'aggregated result should contain A');
  assert.ok(resultText.includes('B'), 'aggregated result should contain B');
  assert.ok(resultText.includes('C'), 'aggregated result should contain C');
  assert.ok(resultText.includes('SUMMARY'), 'should carry sub-agent summaries');
  assert.ok(/3\s*个独立子任务|3 成功|成功.*3|失败的?.*0/.test(resultText), 'should report 3 succeeded');

  // The aggregated result was appended as a tool message on the main loop.
  const toolMsg = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'f1');
  assert.ok(toolMsg, 'main loop should have a tool message for fanout');
  assert.ok(toolMsg.content.includes('A'));

  // Sub-agent streaming fired for 3 distinct child loops (UI renders N cards).
  const ids = [...new Set(subAgentEvents.map((e) => e[0]))];
  assert.equal(ids.length, 3, 'should have streamed 3 distinct sub-agent loops');
  assert.ok(subAgentEvents.some((e) => e[2] === 'done'), 'sub-agents should emit done events');
});
