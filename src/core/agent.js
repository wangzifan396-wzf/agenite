// The agent loop: call the model, and if it requests tools, execute them and
// feed results back, repeating until the model produces a final answer.
// Pure: callModel and executeTool are injected, so the loop is fully testable.
//
// messages: mutable array of internal message objects (OpenAI-ish shape).
// callModel(messages, { onDelta }) -> Promise<{ content, toolCalls, usage }>
// toolContext: extra opts handed to executeTool (workspace, approval hook, ...)
// onEvent(type, payload):
//   'delta'      (text chunk, for streaming UI)
//   'assistant'  (full assistant message object)
//   'tool_start' ({ id, name, args })
//   'tool'       ({ id, name, args, result, ok, ms })
//   'done'       ({ usage, stopped })

export async function runAgent({
  messages,
  callModel,
  executeTool,
  onEvent = () => {},
  config = {},
  toolContext = {},
  maxTurns = 8
}) {
  const opts = {
    dangerTools: config.dangerTools,
    approvalMode: config.approvalMode,
    workspace: config.workspace,
    allowOutsideWorkspace: config.allowOutsideWorkspace,
    ...toolContext
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    const { content, toolCalls, usage } = await callModel(messages, {
      onDelta: (t) => onEvent('delta', t)
    });

    const assistantMsg = { role: 'assistant', content: content || '' };
    if (toolCalls && toolCalls.length) {
      assistantMsg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) }
      }));
    }
    messages.push(assistantMsg);
    onEvent('assistant', assistantMsg);

    if (!toolCalls || !toolCalls.length) {
      onEvent('done', { usage, stopped: 'done', turns: turn + 1 });
      return { messages, stopped: 'done', turns: turn + 1 };
    }

    for (const tc of toolCalls) {
      onEvent('tool_start', { id: tc.id, name: tc.name, args: tc.args || {} });
      const started = Date.now();
      const res = await executeTool(tc.name, tc.args || {}, opts);
      onEvent('tool', {
        id: tc.id,
        name: tc.name,
        args: tc.args,
        result: res.ok ? res.content : res.error,
        ok: res.ok,
        diff: res.diff,
        undoToken: res.undoToken,
        ms: Date.now() - started
      });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: res.ok ? res.content : `Error: ${res.error}`
      });
    }
  }
  onEvent('done', { stopped: 'max_turns', turns: maxTurns });
  return { messages, stopped: 'max_turns', turns: maxTurns };
}
