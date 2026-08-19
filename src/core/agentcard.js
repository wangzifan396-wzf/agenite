// A2A Agent Card (v0.73.0 — multi-agent interoperability, aligned to
// Google A2A v1.0). An Agent Card is a JSON document that advertises an
// agent's identity, capabilities, supported I/O modalities, skills and
// security scheme so that OTHER agents (or A2A clients) can discover and
// invoke it over the A2A protocol.
//
// Agenite already has a mature multi-agent engine (delegate / fanout →
// subagent.js → runAgent). This module does NOT replace that engine; it
// adds a thin, non-breaking A2A-shaped layer on top: it derives an A2A
// Agent Card from a run's config + tool set, and documents the governance
// guardrails (v0.71) as an A2A "extension" so a peer can see that the
// blast-radius gate is enforced at the gateway.
//
// Reference: https://github.com/google/A2A (A2A v1.0, March 2026)
//
// Capability notes:
//   - A2A is COMPLEMENTARY to MCP, not a replacement. MCP is the vertical
//     agent-to-tool (function-calling) layer; A2A is the horizontal
//     agent-to-agent layer. Agenite keeps both: MCP tools + A2A peers.
//   - An Agent Card is the A2A discovery primitive; a peer fetches it from
//     the agent's well-known URL before sending a Task.

export const A2A_PROTOCOL_VERSION = '0.3.0'; // A2A v1.0 spec protocolVersion marker

// Tools that are orchestration primitives, not skills a peer would call
// directly. They are intentionally excluded from the skills list.
const NON_SKILL_TOOLS = new Set(['delegate', 'fanout', 'todo_write', 'plan', 'verify']);

/**
 * Build an A2A-shaped Agent Card.
 * @param {object} opts
 * @param {string} opts.name            Human-readable agent name
 * @param {string} opts.description     What the agent does
 * @param {string} opts.url             Base URL where the agent's A2A endpoint lives
 * @param {string} [opts.version]       Agent software version
 * @param {object} [opts.capabilities]  { streaming, pushNotifications, ... }
 * @param {Array}  [opts.skills]        Each: { id, name, description, tags?, examples?, inputModes?, outputModes? }
 * @param {Array}  [opts.defaultInputModes]   e.g. ['text/plain']
 * @param {Array}  [opts.defaultOutputModes]  e.g. ['text/plain']
 * @param {Array}  [opts.securitySchemes]     OpenAPI-style security schemes
 * @param {Array}  [opts.security]            Selected security requirement objects
 * @param {object} [opts.extensions]   Agenite-specific extensions (e.g. governance)
 * @returns {object} Agent Card
 */
export function buildAgentCard(opts = {}) {
  const card = {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: opts.name || 'Agenite Agent',
    description: opts.description || '',
    url: opts.url || '',
    version: opts.version || '0.0.0',
    capabilities: {
      streaming: !!(opts.capabilities && opts.capabilities.streaming),
      pushNotifications: !!(opts.capabilities && opts.capabilities.pushNotifications),
      ...(opts.capabilities || {})
    },
    skills: Array.isArray(opts.skills) ? opts.skills : [],
    defaultInputModes: Array.isArray(opts.defaultInputModes) && opts.defaultInputModes.length
      ? opts.defaultInputModes
      : ['text/plain'],
    defaultOutputModes: Array.isArray(opts.defaultOutputModes) && opts.defaultOutputModes.length
      ? opts.defaultOutputModes
      : ['text/plain']
  };
  if (Array.isArray(opts.securitySchemes) && opts.securitySchemes.length) card.securitySchemes = opts.securitySchemes;
  if (Array.isArray(opts.security) && opts.security.length) card.security = opts.security;
  if (opts.extensions && typeof opts.extensions === 'object') card.extensions = opts.extensions;
  return card;
}

/**
 * Validate an A2A Agent Card. Returns { ok, errors }.
 * Minimum A2A requires name / description / url / version / protocolVersion.
 */
export function validateAgentCard(card = {}) {
  const errors = [];
  if (!card || typeof card !== 'object') return { ok: false, errors: ['card must be an object'] };
  if (!card.name || typeof card.name !== 'string') errors.push('missing name');
  if (!card.description || typeof card.description !== 'string') errors.push('missing description');
  if (!card.url || typeof card.url !== 'string') errors.push('missing url');
  if (!card.version || typeof card.version !== 'string') errors.push('missing version');
  if (card.protocolVersion == null) errors.push('missing protocolVersion');
  if (card.skills != null && !Array.isArray(card.skills)) errors.push('skills must be an array');
  return { ok: errors.length === 0, errors };
}

/**
 * Derive an A2A Agent Card from an Agenite run config + tool set.
 * This is what lets a delegate/fanout peer (or an external A2A client)
 * discover THIS agent's shape without knowing Agenite internals.
 *
 * @param {object} config             Agenite config (name/version/guardrails/approvalMode/...)
 * @param {object} [info]
 * @param {Array}  [info.tools]       Tool definitions [{ name, description, ... }]
 * @param {string} [info.name]        Override display name
 * @param {string} [info.url]         A2A endpoint URL (defaults to 'local://agenite')
 * @param {string} [info.version]     Override version
 * @param {boolean}[info.isPeer]      True when this is a sub-agent card (scoped tools)
 */
export function cardFromConfig(config = {}, info = {}) {
  const tools = Array.isArray(info.tools) ? info.tools : [];
  const baseName = info.name || config.name || 'Agenite';
  const version = info.version || config.version || '0.0.0';
  const url = info.url || 'local://agenite';

  // Each Agenite tool becomes an A2A skill, minus orchestration primitives.
  const skills = tools
    .filter((t) => t && t.name && !NON_SKILL_TOOLS.has(t.name))
    .map((t) => ({
      id: t.name,
      name: t.name,
      description: typeof t.description === 'string' ? t.description : (t.name || ''),
      tags: Array.isArray(t.tags) ? t.tags : []
    }));

  // Governance extension: advertise that the v0.71 blast-radius gate is
  // enforced at the gateway, with the same policy every peer inherits. This is
  // a concrete, machine-readable proof of the 2026 governance posture — a peer
  // can see up front that delegation is gated, not wide-open.
  const g = config.guardrails && typeof config.guardrails === 'object' ? config.guardrails : {};
  const extensions = {
    'agenite.governance': {
      enforcedAtGateway: true,
      approvalMode: config.approvalMode || 'ask',
      denyList: Array.isArray(g.denyList) ? g.denyList : [],
      allowList: Array.isArray(g.allowList) ? g.allowList : [],
      networkCap: g.networkCap != null ? Number(g.networkCap) : -1
    }
  };

  return buildAgentCard({
    name: baseName + (info.isPeer ? ' · 子代理' : ''),
    description: info.isPeer
      ? 'Agenite 子代理：在隔离上下文中执行聚焦任务的派生子智能体。'
      : (config.description || 'Agenite 本地优先 AI 智能体：支持工具调用、多智能体协作（A2A Agent Card）与治理护栏。'),
    url,
    version,
    capabilities: { streaming: true, pushNotifications: false },
    skills,
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    extensions
  });
}
