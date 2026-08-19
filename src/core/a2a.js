// A2A Task / Artifact protocol (v0.73.0 — multi-agent interoperability,
// aligned to Google A2A v1.0). A2A models a unit of work as a Task that a
// client ("client agent") submits to a remote agent ("remote agent"). The
// remote agent returns Artifacts (the work product) and progresses the Task
// through a lifecycle: submitted → working → completed | failed.
//
// Agenite's existing delegate/fanout engine already runs a child agent in an
// isolated context and returns its summary. This module wraps that engine in
// the A2A Task/Artifact lifecycle so a delegation is observable as a real
// A2A exchange, and emits `a2a` events the UI / governance / context-economy
// / OTel stacks can consume without changes.
//
// Reference: https://github.com/google/A2A (A2A v1.0, March 2026)
//
// Why wrap instead of rewrite: the recursive runAgent engine already gives us
// context isolation, least-privilege tool scoping and failure isolation. The
// A2A value-add is INTEROPERABILITY + OBSERVABILITY, not a new execution model
// — so we layer a Task/Artifact protocol over the proven engine.

let TASK_SEQ = 0;
function nextId(prefix) {
  TASK_SEQ = (TASK_SEQ + 1) % 1e9;
  return prefix + '_' + Date.now().toString(36) + '_' + TASK_SEQ.toString(36);
}

/**
 * Create a new A2A Task in the `submitted` state.
 * @param {object} opts
 * @param {string} opts.message      The task instruction / prompt
 * @param {string} [opts.contextId]  Conversation/session id linking related tasks
 * @param {object} [opts.metadata]   Free-form metadata (e.g. peer card, persona)
 */
export function createTask({ message, contextId = null, metadata = {} } = {}) {
  return {
    id: nextId('task'),
    contextId,
    status: 'submitted',
    message: typeof message === 'string' ? message : '',
    artifacts: [],
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    createdAt: Date.now()
  };
}

/**
 * Append artifacts to a task and mark it completed.
 * @param {object} task
 * @param {Array}  artifacts  [{ name, mimeType, data }]
 */
export function completeTask(task, artifacts = []) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  task.artifacts = task.artifacts.concat(list);
  task.status = 'completed';
  task.completedAt = Date.now();
  return task;
}

/**
 * Mark a task failed, optionally attaching an error string.
 */
export function failTask(task, error = null) {
  task.status = 'failed';
  task.error = error != null ? String(error) : 'unknown';
  task.completedAt = Date.now();
  return task;
}

/**
 * Wrap a delegation as an A2A exchange. `runPeer` is the underlying Agenite
 * runner (runSubAgent); `onEvent(phase, payload)` is the A2A event sink.
 *
 * Emits a full A2A event stream:
 *   - 'peer_card'       the remote (sub-)agent's A2A Agent Card
 *   - 'task_submitted'  the Task object handed to the peer
 *   - 'task_completed'  the Task after completion, with artifacts
 *   - 'task_failed'     the Task after failure (terminal state)
 *
 * Returns the runner's result. Pure / testable: pass fakes for runPeer/onEvent.
 *
 * @param {object} opts
 * @param {Function} opts.runPeer        async (args, ctx) => result
 * @param {Function} opts.onEvent        (phase, payload) => void
 * @param {object}   [opts.peerCard]     A2A Agent Card of the peer (from cardFromConfig)
 * @param {object}   [opts.args]         original delegation args
 * @param {string}   [opts.contextId]    links tasks across a conversation
 */
export async function wrapDelegation({ runPeer, onEvent = () => {}, peerCard = null, args = {}, contextId = null } = {}) {
  const emit = (phase, payload) => {
    try { onEvent(phase, payload); } catch { /* event sink is best-effort */ }
  };

  // 1) advertise the remote agent's card (A2A agent discovery / handshake)
  if (peerCard) emit('peer_card', { card: peerCard, contextId });

  // 2) open the Task in the `submitted` state
  const task = createTask({
    message: String((args && (args.goal || args.message)) || ''),
    contextId,
    metadata: { persona: (args && args.persona) || null, peer: peerCard ? peerCard.name : null }
  });
  // Emit a snapshot so each event carries the Task state AT THAT MOMENT — a
  // later mutation (submitted → completed) must not corrupt an earlier event.
  emit('task_submitted', { task: { ...task }, contextId });

  // 3) hand the work to the peer (the existing Agenite sub-agent engine)
  try {
    const result = await runPeer(args, { contextId, taskId: task.id });
    // 4) the peer's final summary is the primary Artifact of the Task
    const artifact = {
      name: 'summary',
      mimeType: 'text/plain',
      data: (result && result.content) || ''
    };
    completeTask(task, [artifact]);
    emit('task_completed', {
      task: { ...task },
      contextId,
      artifactCount: task.artifacts.length,
      ok: !!(result && result.ok !== false)
    });
    return result;
  } catch (e) {
    // 5) failure is a first-class A2A terminal state
    failTask(task, e && e.message ? e.message : e);
    emit('task_failed', { task: { ...task }, contextId, error: task.error });
    throw e;
  }
}
