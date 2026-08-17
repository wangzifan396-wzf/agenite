import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toOtlpJson, exportOtlp, spanTimeline, anyValue,
  deriveTraceId, deriveSpanId, otelProviderName,
  SPAN_KIND, STATUS_CODE_OK, STATUS_CODE_ERROR
} from '../src/core/otel.js';

// A minimal but representative flight-recorder trace (shape mirrors trace.js).
function makeTrace() {
  const base = Date.now();
  return {
    version: 1,
    runId: 'run_abc123',
    title: '把 README 改为中文',
    input: '用户：把 README 改为中文',
    model: 'deepseek-chat',
    provider: 'deepseek',
    createdAt: base,
    startedAt: base,
    finishedAt: base + 5000,
    stopped: null,
    turns: 2,
    cost: 0.012,
    gitStart: null,
    gitEnd: null,
    steps: [
      {
        id: 's1', parentId: null, kind: 'turn', name: '推理 / 模型回复',
        ts: base + 100, ms: 900, status: 'ok',
        data: { content: '好的，我来修改 README。', toolCalls: 1, usage: { in: 120, out: 40 } }
      },
      {
        id: 's2', parentId: 's1', kind: 'tool', name: 'edit_file',
        ts: base + 1100, ms: 300, status: 'ok',
        data: { args: '{"path":"README.md"}', result: 'ok', ok: true, kind: 'tool' }
      },
      {
        id: 's3', parentId: null, kind: 'turn', name: '推理 / 模型回复',
        ts: base + 1500, ms: 800, status: 'ok',
        data: { content: '完成。', toolCalls: 0, usage: { in: 200, out: 60 } }
      },
      {
        id: 's4', parentId: null, kind: 'tool', name: 'mcp__fs_read',
        ts: base + 2400, ms: 250, status: 'error',
        data: { args: '{"path":"x"}', result: 'ENOENT', ok: false, kind: 'mcp', errorClass: 'not_found' }
      },
      {
        id: 's5', parentId: null, kind: 'subagent', name: '研究员',
        ts: base + 2700, ms: 1200, status: 'ok', data: {}
      },
      {
        id: 's6', parentId: 's5', kind: 'tool', name: 'web_search',
        ts: base + 2800, ms: 400, status: 'ok',
        data: { args: '{"q":"x"}', result: 'hits', ok: true, kind: 'tool' }
      },
      {
        id: 's7', parentId: null, kind: 'compact', name: '上下文压缩',
        ts: base + 4200, ms: 10, status: 'ok', data: {}
      },
      {
        id: 's8', parentId: null, kind: 'guardrail', name: '预算护栏触发',
        ts: base + 4400, ms: 0, status: 'error', data: { reason: 'over budget' }
      }
    ]
  };
}

test('deriveTraceId / deriveSpanId are deterministic and non-zero', () => {
  const a = deriveTraceId('run_x');
  const b = deriveTraceId('run_x');
  assert.equal(a, b);
  assert.equal(a.length, 32);
  assert.ok(!/^0+$/.test(a), 'traceId must never be all-zero');
  const s1 = deriveSpanId('run_x', 's1');
  const s2 = deriveSpanId('run_x', 's1');
  assert.equal(s1, s2);
  assert.equal(s1.length, 16);
  assert.ok(!/^0+$/.test(s1), 'spanId must never be all-zero');
  // different step ids -> different span ids
  assert.notEqual(deriveSpanId('run_x', 's1'), deriveSpanId('run_x', 's2'));
});

test('otelProviderName maps known providers, lowercases unknown', () => {
  assert.equal(otelProviderName('OpenAI'), 'openai');
  assert.equal(otelProviderName('ANTHROPIC'), 'anthropic');
  assert.equal(otelProviderName('my-custom'), 'my-custom');
  assert.equal(otelProviderName(''), 'unknown');
});

test('anyValue coerces types per OTLP AnyValue', () => {
  assert.deepEqual(anyValue('x'), { stringValue: 'x' });
  assert.deepEqual(anyValue(3), { intValue: '3' });
  assert.deepEqual(anyValue(2.5), { doubleValue: 2.5 });
  assert.deepEqual(anyValue(true), { boolValue: true });
  assert.deepEqual(anyValue(null), { nullValue: 0 });
  assert.deepEqual(anyValue([1, 'a']), { arrayValue: { values: [{ intValue: '1' }, { stringValue: 'a' }] } });
  assert.deepEqual(anyValue({ k: 1 }), { kvlistValue: { values: [{ key: 'k', value: { intValue: '1' } }] } });
});

test('toOtlpJson envelopes a single resourceSpan with one scopeSpan', () => {
  const otlp = toOtlpJson(makeTrace());
  assert.ok(Array.isArray(otlp.resourceSpans));
  assert.equal(otlp.resourceSpans.length, 1);
  const rs = otlp.resourceSpans[0];
  assert.equal(rs.scopeSpans.length, 1);
  assert.equal(rs.scopeSpans[0].scope.name, 'agenite');
  // resource carries service.name
  const svc = rs.resource.attributes.find((a) => a.key === 'service.name');
  assert.equal(svc.value.stringValue, 'agenite');
});

test('toOtlpJson emits spec-correct span names + gen_ai.operation.name', () => {
  const otlp = toOtlpJson(makeTrace());
  const spans = otlp.resourceSpans[0].scopeSpans[0].spans.map((s) => s.name);
  assert.ok(spans.includes('invoke_agent agenite'), 'root invoke_agent span');
  assert.ok(spans.includes('chat deepseek-chat'), 'chat span');
  assert.ok(spans.includes('execute_tool edit_file'), 'tool span');
  assert.ok(spans.includes('execute_tool mcp__fs_read'), 'mcp tool span');
  assert.ok(spans.includes('invoke_agent 研究员'), 'subagent span');
  assert.ok(spans.includes('compact'), 'compact span');
  assert.ok(spans.includes('guardrail'), 'guardrail span');

  const byName = (n) => otlp.resourceSpans[0].scopeSpans[0].spans.find((s) => s.name === n);
  const chat = byName('chat deepseek-chat');
  const op = (s) => s.attributes.find((a) => a.key === 'gen_ai.operation.name')?.value.stringValue;
  assert.equal(op(chat), 'chat');
  assert.equal(byName('execute_tool edit_file') && op(byName('execute_tool edit_file')), 'execute_tool');
  assert.equal(op(byName('invoke_agent 研究员')), 'invoke_agent');
  assert.equal(op(byName('invoke_agent agenite')), 'invoke_agent');
});

test('toOtlpJson uses NEW semantic-convention attribute names (no deprecated ones)', () => {
  const otlp = toOtlpJson(makeTrace());
  const allKeys = otlp.resourceSpans[0].scopeSpans[0].spans.flatMap((s) => s.attributes.map((a) => a.key));
  assert.ok(allKeys.includes('gen_ai.provider.name'), 'has gen_ai.provider.name');
  assert.ok(allKeys.includes('gen_ai.request.model'));
  assert.ok(allKeys.includes('gen_ai.response.model'));
  assert.ok(allKeys.includes('gen_ai.usage.input_tokens'));
  assert.ok(allKeys.includes('gen_ai.usage.output_tokens'));
  assert.ok(allKeys.includes('gen_ai.tool.name'));
  assert.ok(allKeys.includes('gen_ai.tool.call.id'));
  // deprecated names must NOT appear
  assert.ok(!allKeys.includes('gen_ai.system'));
  assert.ok(!allKeys.includes('gen_ai.prompt_tokens'));
  assert.ok(!allKeys.includes('gen_ai.completion_tokens'));
  assert.ok(!allKeys.includes('gen_ai.latency.ms'));
});

test('toOtlpJson maps per-turn token usage onto chat spans', () => {
  const otlp = toOtlpJson(makeTrace());
  const spans = otlp.resourceSpans[0].scopeSpans[0].spans;
  const chatSpans = spans.filter((s) => s.name.startsWith('chat '));
  assert.equal(chatSpans.length, 2);
  const get = (s, k) => s.attributes.find((a) => a.key === k)?.value.intValue;
  // turns carried usage {in:120,out:40} and {in:200,out:60}
  const inVals = chatSpans.map((s) => Number(get(s, 'gen_ai.usage.input_tokens'))).sort((a, b) => a - b);
  const outVals = chatSpans.map((s) => Number(get(s, 'gen_ai.usage.output_tokens'))).sort((a, b) => a - b);
  assert.deepEqual(inVals, [120, 200]);
  assert.deepEqual(outVals, [40, 60]);
});

test('toOtlpJson marks failed tools with error.type + ERROR status, mcp spans are CLIENT', () => {
  const otlp = toOtlpJson(makeTrace());
  const spans = otlp.resourceSpans[0].scopeSpans[0].spans;
  const failed = spans.find((s) => s.name === 'execute_tool mcp__fs_read');
  assert.equal(failed.status.code, STATUS_CODE_ERROR);
  const et = failed.attributes.find((a) => a.key === 'error.type');
  assert.equal(et.value.stringValue, 'not_found');
  assert.equal(failed.kind, SPAN_KIND.CLIENT, 'mcp tools are remote -> CLIENT');
  const okTool = spans.find((s) => s.name === 'execute_tool edit_file');
  assert.equal(okTool.status.code, STATUS_CODE_OK);
  assert.equal(okTool.kind, SPAN_KIND.INTERNAL, 'in-process tools -> INTERNAL');
});

test('toOtlpJson: content fields are opt-in only', () => {
  const trace = makeTrace();
  const off = toOtlpJson(trace, { captureContent: false });
  const allKeys = off.resourceSpans[0].scopeSpans[0].spans.flatMap((s) => s.attributes.map((a) => a.key));
  assert.ok(!allKeys.includes('gen_ai.output.messages'));
  assert.ok(!allKeys.includes('gen_ai.tool.call.arguments'));
  assert.ok(!allKeys.includes('gen_ai.tool.call.result'));

  const on = toOtlpJson(trace, { captureContent: true });
  const onKeys = on.resourceSpans[0].scopeSpans[0].spans.flatMap((s) => s.attributes.map((a) => a.key));
  assert.ok(onKeys.includes('gen_ai.output.messages'));
  assert.ok(onKeys.includes('gen_ai.tool.call.arguments'));
  assert.ok(onKeys.includes('gen_ai.tool.call.result'));
});

test('toOtlpJson uses serviceName for agent name + span identity', () => {
  const otlp = toOtlpJson(makeTrace(), { serviceName: 'my-agent' });
  const root = otlp.resourceSpans[0].scopeSpans[0].spans.find((s) => s.name.startsWith('invoke_agent'));
  assert.equal(root.name, 'invoke_agent my-agent');
  const an = root.attributes.find((a) => a.key === 'gen_ai.agent.name');
  assert.equal(an.value.stringValue, 'my-agent');
  const svc = otlp.resourceSpans[0].resource.attributes.find((a) => a.key === 'service.name');
  assert.equal(svc.value.stringValue, 'my-agent');
});

test('toOtlpJson: timestamps are uint64-ns JSON strings (no precision loss)', () => {
  const otlp = toOtlpJson(makeTrace());
  const root = otlp.resourceSpans[0].scopeSpans[0].spans.find((s) => s.name.startsWith('invoke_agent'));
  assert.equal(typeof root.startTimeUnixNano, 'string');
  assert.equal(typeof root.endTimeUnixNano, 'string');
  // span duration 5000ms -> 5_000_000_000ns
  assert.equal(Number(root.endTimeUnixNano) - Number(root.startTimeUnixNano), 5_000_000_000);
});

test('spanTimeline returns a parent-linked, UI-friendly list', () => {
  const tl = spanTimeline(makeTrace());
  assert.ok(tl.length > 0);
  const root = tl.find((r) => r.opName === 'invoke_agent' && r.parentSpanId === null);
  assert.ok(root, 'root has no parent');
  const tool = tl.find((r) => r.opName === 'execute_tool' && r.name.includes('edit_file'));
  // In a real run tools nest under their parent turn (s1); here s2.parentId='s1'.
  assert.equal(tool.parentSpanId, deriveSpanId('run_abc123', 's1'), 'tool nests under its turn span');
  // failed tool carries error metadata
  const failed = tl.find((r) => r.errorType === 'not_found');
  assert.equal(failed.statusName, 'ERROR');
});

test('exportOtlp posts to the injected endpoint and reports status', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const payload = toOtlpJson(makeTrace());
  const out = await exportOtlp(payload, {
    endpoint: 'http://collector:4318/v1/traces',
    headers: 'Authorization=Bearer secret',
    fetch: fakeFetch
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://collector:4318/v1/traces');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers['Authorization'], 'Bearer secret');
  assert.equal(typeof calls[0].init.body, 'string');
});

test('exportOtlp rejects bad endpoints and missing fetch without throwing', async () => {
  const badEndpoint = await exportOtlp({}, { endpoint: 'not-a-url', fetch: async () => ({ ok: true }) });
  assert.equal(badEndpoint.ok, false);
  assert.match(badEndpoint.error, /invalid otel endpoint/);

  // Simulate an environment with no fetch implementation at all.
  const saved = globalThis.fetch;
  delete globalThis.fetch;
  try {
    const noFetch = await exportOtlp({}, { endpoint: 'http://x/v1/traces' });
    assert.equal(noFetch.ok, false);
    assert.match(noFetch.error, /no fetch/);
  } finally {
    globalThis.fetch = saved;
  }

  // transport error is swallowed into { ok:false }
  const boom = await exportOtlp({}, {
    endpoint: 'http://x/v1/traces',
    fetch: async () => { throw new Error('ECONNREFUSED'); }
  });
  assert.equal(boom.ok, false);
  assert.equal(boom.status, 0);
  assert.match(boom.error, /ECONNREFUSED/);
});
