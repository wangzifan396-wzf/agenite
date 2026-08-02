// Sub-agent delegation — the "Deep Agents" second pillar and the single biggest
// gap between Agenite and Claude Code / the cloud agents. A sub-agent is an
// isolated child agent loop: the parent gives it a goal + (optionally) a persona
// and a tool scope, the child runs in its OWN fresh context window, and only
// its final summary is returned to the parent. Intermediate steps never clutter
// the main conversation.
//
// Design follows the research:
//   - Context isolation: child starts from a clean system+goal, not the parent's
//     transcript. (agentsurface.dev / Claude Code "Agent" tool.)
//   - No nesting: `delegate` is stripped from the child's tool list, so a
//     sub-agent cannot spawn sub-agents — the main loop coordinates everything.
//   - Least privilege: optional `tool_scope` restricts which tools the child may
//     use; dangerous tools (if enabled) auto-approve inside the child so it
//     never blocks waiting on a human who isn't watching.
//   - Completion: the child's final assistant message is the summary.
//
// `createSubAgentRunner` is a factory so the whole thing is unit-testable with
// fake `callModel` / `executeTool` — no real model or network required.
import { runAgent, clampTurns } from './agent.js';

// Remove `delegate` (no nesting) and optionally intersect with a tool scope.
export function scopeTools(tools, toolScope) {
  const base = (tools || []).filter((t) => t && t.name && t.name !== 'delegate');
  if (Array.isArray(toolScope) && toolScope.length) {
    const allowed = new Set(toolScope.map(String));
    return base.filter((t) => allowed.has(t.name));
  }
  return base;
}

export function buildSubAgentSystemPrompt({ persona, goal, memoryBlock = '' }) {
  const role = persona
    ? `你是一个专精于「${persona}」的子代理。`
    : '你是一个聚焦的子代理，负责独立完成一项具体任务。';
  const parts = [
    role,
    '你运行在隔离的上下文里：主助手只会收到你最终返回的摘要，看不到你的中间过程。',
    '请使用可用工具完成任务，并在最后用一段简洁、自包含的文字给出结论或成果（含关键文件路径、命令要点、重要结论与不确定项）。',
    '不要向用户提问；若信息不足，基于已有信息做到最好并明确写出你的假设。',
    `任务目标：\n${goal}`,
    '返回格式：先给 1-2 句结论，再给结构化要点。',
  ];
  if (memoryBlock) parts.push('--- 长期记忆 ---\n' + memoryBlock);
  return parts.join('\n\n');
}

// The child's final assistant text is what the parent receives.
export function extractSubAgentSummary(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && m.content) return String(m.content);
  }
  return '';
}

// Factory: returns an async `runSubAgent(args, opts)` suitable as a tool impl.
// `opts` here is the tool-context object the caller passes through (it may
// already carry requestApproval / memoryBase / platform).
export function createSubAgentRunner({
  callModel,
  executeTool,
  baseConfig = {},
  tools = [],
  memoryBase = '',
  injectMemory = null,
  onSubEvent = null,
  summarize = null,
  requestApproval = null,
  platform = process.platform
}) {
  return async function runSubAgent(args = {}, opts = {}) {
    const goal = String(args.goal || '').trim();
    if (!goal) return { ok: false, error: 'delegate 需要 goal 参数' };

    const persona = String(args.persona || args.role || '').trim();
    const childTools = scopeTools(tools, Array.isArray(args.tool_scope) ? args.tool_scope.map(String) : null);
    if (!childTools.length) return { ok: false, error: '子代理没有可用工具' };

    const maxTurns = clampTurns(
      args.max_turns != null ? args.max_turns : Math.min(10, baseConfig.maxTurns || 20)
    );

    const memoryBlock =
      baseConfig.memoryEnabled !== false && injectMemory && memoryBase
        ? await injectMemory(memoryBase)
        : '';

    const childMessages = [
      { role: 'system', content: buildSubAgentSystemPrompt({ persona, goal, memoryBlock }) },
      { role: 'user', content: goal }
    ];

    // Sub-agents run autonomously: if danger tools are enabled, auto-approve
    // inside the child so it never stalls on a human who isn't watching.
    const childConfig = {
      ...baseConfig,
      maxTurns,
      planMode: false,
      approvalMode: baseConfig.dangerTools ? 'auto' : baseConfig.approvalMode
    };

    const id = 'sa_' + Math.random().toString(36).slice(2, 8);

    const result = await runAgent({
      messages: childMessages,
      callModel,
      executeTool,
      onEvent: (type, payload) => {
        if (onSubEvent) onSubEvent(id, persona || 'sub-agent', type, payload);
      },
      config: childConfig,
      tools: childTools,
      summarize,
      toolContext: { requestApproval, platform, memoryBase }
    });

    const summary = extractSubAgentSummary(result.messages) || '(子代理未返回内容)';
    return {
      ok: true,
      content:
        `【子代理${persona ? ' · ' + persona : ''} · ${result.turns} 步 · 状态 ${result.stopped}】\n${summary}`,
      turns: result.turns,
      stopped: result.stopped
    };
  };
}
