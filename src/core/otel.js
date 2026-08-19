// Agenite → OpenTelemetry GenAI semantic conventions (2026).
//
// Agenite already has a local, private flight-recorder (see trace.js) that
// captures every run as a tree of typed steps. This module is NOT a second
// recorder — it is the INTEROPERABILITY layer that maps a finished trace onto
// standard OpenTelemetry (OTLP/HTTP JSON) spans following the GenAI semantic
// conventions, so any OTel Collector / Jaeger / Tempo / Langfuse can ingest an
// Agenite run out of the box.
//
// Design rules (kept deliberately minimal & faithful to the spec):
//   * Pure module — no DOM, no fs, no network. `exportOtlp` takes an injected
//     `fetch` so it is unit-testable and never reaches for globals.
//   * Deterministic ids — traceId/spanId are derived from runId+stepId via
//     FNV-1a, so the same run always yields the same ids (and they are NEVER
//     all-zero). This makes traces reproducible / diff-able across exports.
//   * Spec-correct attribute names. Where the 2026 spec renamed something
//     (gen_ai.system → gen_ai.provider.name; prompt_tokens/completion_tokens →
//     usage.input_tokens/output_tokens) we use the NEW names. There is NO
//     gen_ai.latency.ms — latency is the span duration (end - start).
//   * Content fields (gen_ai.input.messages / gen_ai.output.messages /
//     gen_ai.tool.call.arguments / gen_ai.tool.call.result) are OPT-IN only
//     (captureContent), matching OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT.

// --- SpanKind (OTel enum) ---
export const SPAN_KIND = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5
};

// --- Status code (OTel enum) ---
export const STATUS_CODE_UNSET = 0;
export const STATUS_CODE_OK = 1;
export const STATUS_CODE_ERROR = 2;

// Canonical provider names where the spec defines one; otherwise we emit the
// literal lowercased provider id (the conventions are pre-1.0 and explicitly
// allow vendor strings). We do NOT emit the deprecated `gen_ai.system`.
const KNOWN_PROVIDERS = {
  openai: 'openai',
  anthropic: 'anthropic',
  ollama: 'ollama',
  deepseek: 'deepseek',
  gemini: 'gemini',
  siliconflow: 'siliconflow',
  moonshot: 'moonshot',
  qwen: 'qwen',
  zhipu: 'zhipu',
  groq: 'groq',
  openrouter: 'openrouter',
  custom: 'custom'
};

export function otelProviderName(provider) {
  const k = String(provider || '').toLowerCase();
  return KNOWN_PROVIDERS[k] || k || 'unknown';
}

// --- Deterministic id derivation (FNV-1a) ---
// OTel requires 16-byte traceId / 8-byte spanId as lowercase hex; all-zero is
// reserved/invalid, so we guarantee a non-zero high nibble.
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hexSeq(seed, len) {
  let out = '';
  let salt = 0;
  while (out.length < len) {
    out += fnv1a(seed + ':' + salt).toString(16).padStart(8, '0');
    salt++;
  }
  return out.slice(0, len);
}

function nonZeroHex(str) {
  return /^0+$/.test(str) ? '1' + str.slice(1) : str;
}

export function deriveTraceId(runId) {
  return nonZeroHex(hexSeq('trc:' + runId, 32));
}

export function deriveSpanId(runId, stepId) {
  return nonZeroHex(hexSeq('spn:' + runId + ':' + stepId, 16));
}

// --- Timestamps: OTLP/JSON emits uint64 nanos as JSON strings (proto3 JSON) ---
function nanoFromMs(ms) {
  const n = BigInt(Math.round(Number(ms) || 0));
  return (n * 1000000n).toString();
}

// --- anyValue coercion (OTLP AnyValue) ---
export function anyValue(v) {
  if (v === null || v === undefined) return { nullValue: 0 };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    if (Number.isFinite(v) && Number.isInteger(v)) return { intValue: String(v) };
    return { doubleValue: Number.isFinite(v) ? v : 0 };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  if (typeof v === 'object') {
    return {
      kvlistValue: {
        values: Object.keys(v).map((k) => ({ key: k, value: anyValue(v[k]) }))
      }
    };
  }
  return { stringValue: String(v) };
}

// Build an attributes array, dropping undefined/null values.
function attrs(map) {
  const out = [];
  for (const k of Object.keys(map)) {
    const val = map[k];
    if (val === undefined || val === null) continue;
    out.push({ key: k, value: anyValue(val) });
  }
  return out;
}

function statusRecord(code, message) {
  if (code === STATUS_CODE_ERROR) return { code, message: message || 'error' };
  if (code === STATUS_CODE_OK) return { code, message: message || '' };
  return { code: STATUS_CODE_UNSET, message: message || '' };
}

// --- Per-turn token usage (optional, stored by server.js on turn steps) ---
function stepUsage(step) {
  const u = step && step.data && step.data.usage;
  if (!u) return null;
  const inT = Number(u.in) || 0;
  const outT = Number(u.out) || 0;
  if (inT === 0 && outT === 0) return null;
  return { in: inT, out: outT };
}

// --- The converter ---
// opts: { serviceName='agenite', version='0.66.0', captureContent=false }
export function toOtlpJson(trace, opts = {}) {
  if (!trace || !Array.isArray(trace.steps)) throw new Error('invalid trace');
  const serviceName = opts.serviceName || 'agenite';
  const version = opts.version || '0.66.0';
  const capture = !!opts.captureContent;
  const provider = otelProviderName(trace.provider);
  const model = trace.model || '';
  const runId = trace.runId || 'unknown-run';

  const traceId = deriveTraceId(runId);
  const rootId = deriveSpanId(runId, 'root');

  const stepIds = new Set(trace.steps.map((s) => s.id));
  // Fallback time window when startedAt/finishedAt are missing.
  const tsList = trace.steps.map((s) => s.ts || 0).filter(Boolean);
  const rootStart = trace.startedAt || (tsList.length ? Math.min(...tsList) : Date.now());
  const rootEnd = trace.finishedAt || (tsList.length ? Math.max(...tsList) : rootStart);

  const spans = [];

  // 1) Root agent span: invoke_agent {agent.name}
  spans.push({
    traceId,
    spanId: rootId,
    parentSpanId: undefined,
    name: `invoke_agent ${serviceName}`,
    kind: SPAN_KIND.INTERNAL,
    startTimeUnixNano: nanoFromMs(rootStart),
    endTimeUnixNano: nanoFromMs(rootEnd),
    attributes: attrs({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': serviceName,
      'gen_ai.agent.id': runId,
      'gen_ai.agent.version': version,
      'gen_ai.conversation.id': runId,
      'agenite.operation': 'agent_run',
      'agenite.run.title': trace.title || undefined,
      'agenite.run.stopped': trace.stopped || undefined,
      'agenite.run.turns': trace.turns || 0,
      'agenite.run.cost': traceCost(trace)
    }),
    status: statusRecord(trace.stopped === 'error' ? STATUS_CODE_ERROR : STATUS_CODE_OK),
    events: [],
    links: []
  });

  for (const step of trace.steps) {
    const sid = deriveSpanId(runId, step.id);
    const parentId = step.parentId && stepIds.has(step.parentId)
      ? deriveSpanId(runId, step.parentId)
      : rootId;
    const start = step.ts || rootStart;
    const end = (step.ts || rootStart) + (step.ms || 0);

    if (step.kind === 'turn') {
      const u = stepUsage(step);
      const a = {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': provider,
        'gen_ai.request.model': model,
        'gen_ai.response.model': model,
        'gen_ai.conversation.id': runId
      };
      if (u) {
        a['gen_ai.usage.input_tokens'] = u.in;
        a['gen_ai.usage.output_tokens'] = u.out;
      }
      if (capture) {
        const content = step.data && step.data.content;
        if (content) a['gen_ai.output.messages'] = JSON.stringify([{ role: 'assistant', content }]);
      }
      spans.push({
        traceId, spanId: sid, parentSpanId: parentId,
        name: `chat ${model}`,
        kind: SPAN_KIND.CLIENT,
        startTimeUnixNano: nanoFromMs(start),
        endTimeUnixNano: nanoFromMs(end),
        attributes: attrs(a),
        status: statusRecord(STATUS_CODE_OK),
        events: [], links: []
      });
    } else if (step.kind === 'tool') {
      const name = step.name || '';
      const ok = step.status !== 'error';
      const isMcp = (step.data && step.data.kind) === 'mcp';
      const a = {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': name,
        'gen_ai.tool.call.id': step.id,
        'agenite.tool.class': (step.data && step.data.kind) || 'tool'
      };
      // v0.72: a context_retrieve answer closes the reversible-compression
      // loop — tag the hit so telemetry can chart cache effectiveness.
      if (name === 'context_retrieve') {
        a['agenite.context_retrieve.hit'] = ok;
      }
      if (capture) {
        if (step.data && step.data.args) a['gen_ai.tool.call.arguments'] = step.data.args;
        if (step.data && step.data.result) a['gen_ai.tool.call.result'] = step.data.result;
      }
      if (!ok) a['error.type'] = (step.data && step.data.errorClass) || 'tool_failure';
      spans.push({
        traceId, spanId: sid, parentSpanId: parentId,
        name: `execute_tool ${name}`,
        kind: isMcp ? SPAN_KIND.CLIENT : SPAN_KIND.INTERNAL,
        startTimeUnixNano: nanoFromMs(start),
        endTimeUnixNano: nanoFromMs(end),
        attributes: attrs(a),
        status: statusRecord(ok ? STATUS_CODE_OK : STATUS_CODE_ERROR, ok ? '' : 'tool call failed'),
        events: [], links: []
      });
    } else if (step.kind === 'subagent') {
      const name = step.name || 'subagent';
      spans.push({
        traceId, spanId: sid, parentSpanId: parentId,
        name: `invoke_agent ${name}`,
        kind: SPAN_KIND.INTERNAL,
        startTimeUnixNano: nanoFromMs(start),
        endTimeUnixNano: nanoFromMs(end),
        attributes: attrs({
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.agent.name': name,
          'gen_ai.agent.id': step.id,
          'gen_ai.conversation.id': runId
        }),
        status: statusRecord(STATUS_CODE_OK),
        events: [], links: []
      });
    } else if (step.kind === 'compact') {
      // v0.72: a compaction step carries the savings when it was a single
      // tool-result shrink (method/savedTokens); a history compaction carries
      // only before/after. We tag both so telemetry can chart token savings.
      const d = step.data || {};
      const subkind = d.method ? 'shrink' : 'history';
      const a = { 'agenite.operation': 'compact', 'agenite.compact.subkind': subkind };
      if (d.method) a['agenite.compact.method'] = String(d.method);
      if (typeof d.savedTokens === 'number') a['agenite.compact.saved_tokens'] = d.savedTokens;
      if (typeof d.before === 'number') a['agenite.compact.before_tokens'] = d.before;
      if (typeof d.after === 'number') a['agenite.compact.after_tokens'] = d.after;
      spans.push({
        traceId, spanId: sid, parentSpanId: parentId,
        name: 'compact',
        kind: SPAN_KIND.INTERNAL,
        startTimeUnixNano: nanoFromMs(start),
        endTimeUnixNano: nanoFromMs(end),
        attributes: attrs(a),
        status: statusRecord(STATUS_CODE_OK),
        events: [], links: []
      });
    } else if (step.kind === 'guardrail') {
      // v0.71: the audit event now carries decision / category / reason for both
      // the budget cap and the action-level blast-radius gate. We keep span
      // name='guardrail' so existing telemetry dashboards/otel.test.js keep
      // working, and extend the attributes instead of replacing them.
      const dec = (step.data && step.data.decision) || 'cost';
      const isError = dec === 'deny' || dec === 'cost';
      spans.push({
        traceId, spanId: sid, parentSpanId: parentId,
        name: 'guardrail',
        kind: SPAN_KIND.INTERNAL,
        startTimeUnixNano: nanoFromMs(start),
        endTimeUnixNano: nanoFromMs(end),
        attributes: attrs({
          'agenite.operation': 'guardrail',
          'agenite.guardrail.decision': dec,
          'agenite.guardrail.category': (step.data && step.data.category) || '',
          'agenite.guardrail.reason': (step.data && step.data.reason) || ''
        }),
        status: statusRecord(isError ? STATUS_CODE_ERROR : STATUS_CODE_OK, isError ? 'guardrail blocked' : 'guardrail allowed'),
        events: [], links: []
      });
    } else if (step.kind === 'self_heal') {
      // v0.68: root-cause self-heal step becomes its own span so telemetry
      // backends can chart recovery rates per fault category/action.
      const action = (step.data && step.data.action) || 'reflect';
      const escalate = !!(step.data && step.data.escalate);
      spans.push({
        traceId, spanId: sid, parentSpanId: parentId,
        name: 'self_heal ' + action,
        kind: SPAN_KIND.INTERNAL,
        startTimeUnixNano: nanoFromMs(start),
        endTimeUnixNano: nanoFromMs(end),
        attributes: attrs({
          'agenite.operation': 'self_heal',
          'agenite.self_heal.category': (step.data && step.data.category) || 'unknown',
          'agenite.self_heal.action': action,
          'agenite.self_heal.reason': (step.data && step.data.reason) || '',
          'agenite.self_heal.reset_counters': !!(step.data && step.data.resetCounters),
          'agenite.self_heal.flap': !!(step.data && step.data.flap),
          ...(escalate ? { 'error.type': 'self_heal_escalated' } : {})
        }),
        status: statusRecord(escalate ? STATUS_CODE_ERROR : STATUS_CODE_OK, escalate ? 'self-heal escalated to human' : 'self-heal applied'),
        events: [], links: []
      });
    } else if (step.kind === 'a2a') {
      // v0.73.0: a multi-agent A2A exchange step (peer_card / task lifecycle).
      // We keep span name='a2a' so existing telemetry dashboards/otel.test.js
      // keep working, and extend the attributes instead of replacing them.
      const d = step.data || {};
      const phase = d.phase || 'unknown';
      const isError = phase === 'task_failed';
      spans.push({
        traceId, spanId: sid, parentSpanId: parentId,
        name: 'a2a',
        kind: SPAN_KIND.INTERNAL,
        startTimeUnixNano: nanoFromMs(start),
        endTimeUnixNano: nanoFromMs(end),
        attributes: attrs({
          'agenite.operation': 'a2a',
          'agenite.a2a.phase': phase,
          'agenite.a2a.peer': d.peer || '',
          'agenite.a2a.task_status': d.taskStatus || ''
        }),
        status: statusRecord(isError ? STATUS_CODE_ERROR : STATUS_CODE_OK, isError ? 'A2A task failed' : 'A2A exchange'),
        events: [], links: []
      });
    } else {
      // Unknown step kind: represent it as a neutral internal span.
      spans.push({
        traceId, spanId: sid, parentSpanId: parentId,
        name: step.kind || 'step',
        kind: SPAN_KIND.INTERNAL,
        startTimeUnixNano: nanoFromMs(start),
        endTimeUnixNano: nanoFromMs(end),
        attributes: attrs({ 'agenite.operation': step.kind || 'step' }),
        status: statusRecord(STATUS_CODE_OK),
        events: [], links: []
      });
    }
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: attrs({
            'service.name': serviceName,
            'service.version': version,
            'agenite.run.id': runId,
            'gen_ai.provider.name': provider
          })
        },
        scopeSpans: [
          {
            scope: { name: 'agenite', version },
            spans
          }
        ]
      }
    ]
  };
}

// --- Lightweight timeline for the UI (no OTLP nesting) ---
const KIND_NAME = {
  [SPAN_KIND.INTERNAL]: 'INTERNAL',
  [SPAN_KIND.CLIENT]: 'CLIENT',
  [SPAN_KIND.SERVER]: 'SERVER',
  [SPAN_KIND.PRODUCER]: 'PRODUCER',
  [SPAN_KIND.CONSUMER]: 'CONSUMER'
};

export function spanTimeline(trace, opts = {}) {
  if (!trace || !Array.isArray(trace.steps)) return [];
  const serviceName = opts.serviceName || 'agenite';
  const runId = trace.runId || 'unknown-run';
  const traceId = deriveTraceId(runId);
  const rootId = deriveSpanId(runId, 'root');
  const stepIds = new Set(trace.steps.map((s) => s.id));
  const tsList = trace.steps.map((s) => s.ts || 0).filter(Boolean);
  const rootStart = trace.startedAt || (tsList.length ? Math.min(...tsList) : Date.now());
  const rootEnd = trace.finishedAt || (tsList.length ? Math.max(...tsList) : rootStart);

  const rows = [
    {
      spanId: rootId, parentSpanId: null, name: `invoke_agent ${serviceName}`,
      opName: 'invoke_agent', kind: SPAN_KIND.INTERNAL, kindName: 'INTERNAL',
      startMs: rootStart, ms: Math.max(0, rootEnd - rootStart), endMs: rootEnd,
      status: trace.stopped === 'error' ? STATUS_CODE_ERROR : STATUS_CODE_OK,
      statusName: trace.stopped === 'error' ? 'ERROR' : 'OK', errorType: null
    }
  ];
  for (const step of trace.steps) {
    const sid = deriveSpanId(runId, step.id);
    const parentId = step.parentId && stepIds.has(step.parentId) ? deriveSpanId(runId, step.parentId) : rootId;
    const start = step.ts || rootStart;
    const ms = step.ms || 0;
    let name = step.kind;
    let opName = step.kind;
    let kind = SPAN_KIND.INTERNAL;
    if (step.kind === 'turn') { name = `chat ${trace.model || ''}`; opName = 'chat'; kind = SPAN_KIND.CLIENT; }
    else if (step.kind === 'tool') { name = `execute_tool ${step.name || ''}`; opName = 'execute_tool'; kind = (step.data && step.data.kind) === 'mcp' ? SPAN_KIND.CLIENT : SPAN_KIND.INTERNAL; }
    else if (step.kind === 'subagent') { name = `invoke_agent ${step.name || 'subagent'}`; opName = 'invoke_agent'; }
    const ok = step.status !== 'error';
    rows.push({
      spanId: sid, parentSpanId: parentId, name, opName,
      kind, kindName: KIND_NAME[kind] || 'INTERNAL',
      startMs: start, ms, endMs: start + ms,
      status: ok ? STATUS_CODE_OK : STATUS_CODE_ERROR,
      statusName: ok ? 'OK' : 'ERROR',
      errorType: ok ? null : (step.data && step.data.errorClass) || 'tool_failure'
    });
  }
  return rows;
}

// --- Helpers for the server / HTTP layer ---
function parseHeaders(headers) {
  if (!headers) return {};
  if (typeof headers === 'object') return { ...headers };
  if (typeof headers === 'string') {
    const out = {};
    for (const part of headers.split(/[,;]/)) {
      const eq = part.indexOf('=');
      if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
  }
  return {};
}

// Push an OTLP payload to a Collector. `fetchFn` is injected (so it is testable
// and works identically in Node and the browser). Best-effort by contract:
// returns { ok, status, error? } and never throws for transport errors.
export async function exportOtlp(payload, opts = {}) {
  const fetchFn = opts.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
  if (typeof fetchFn !== 'function') {
    return { ok: false, status: 0, error: 'no fetch implementation available' };
  }
  const endpoint = opts.endpoint;
  if (!endpoint || !/^https?:\/\//.test(endpoint)) {
    return { ok: false, status: 0, error: 'invalid otel endpoint' };
  }
  const headers = { 'Content-Type': 'application/json', ...parseHeaders(opts.headers) };
  let signal;
  if (opts.timeoutMs && typeof AbortController === 'function') {
    const ctrl = new AbortController();
    signal = ctrl.signal;
    setTimeout(() => ctrl.abort(), opts.timeoutMs).unref?.();
  }
  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      signal
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e && e.message ? e.message : String(e) };
  }
}

// Local cost helper (mirror of trace.js traceCost, kept inline to stay pure).
function traceCost(trace) {
  const c = trace && trace.cost;
  if (typeof c === 'number') return c;
  if (c && typeof c.amount === 'number') return c.amount;
  return 0;
}
