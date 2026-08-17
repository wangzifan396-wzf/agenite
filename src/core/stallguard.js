// Runtime Resilience v2 — Stall Detection + Graceful Degradation (v0.65)
//
// The 2026 production-agent literature (devstarsj, spicyadvisory, icmd,
// agentpatterns) is unanimous that the single most common failure mode is the
// *runaway / stuck agent*: it never throws, it just burns the whole turn budget
// doing nothing useful. Agenite already has an exact-repeat loop breaker
// (`loopStreak` in agent.js) and a cost guardrail, but those miss the
// *semantic* stall — an agent that thrashes with DIFFERENT actions yet makes
// zero progress (re-reading files, retrying variants that all fail, thinking
// in circles). This module is the deterministic, model-free decision core for
// catching that, so it is fully unit-testable.
//
// Progress model (deliberately conservative to avoid false positives):
//   a turn "made progress" iff at least one tool call SUCCEEDED (res.ok) OR the
//   live todo checklist advanced. Pure thinking turns (no tool) or turns whose
//   only tool calls failed do NOT count as progress. A legitimate long task
//   always produces at least one successful tool result per turn, so this only
//   flags genuine no-progress runs.

/**
 * Did this turn make any real progress?
 * @param {object} o
 * @param {Array<{res?:{ok?:boolean}}>} [o.toolResults] results of this turn's tool calls
 * @param {boolean} [o.todoTouched] whether the todo checklist advanced this turn
 * @returns {boolean}
 */
export function turnMadeProgress({ toolResults, todoTouched } = {}) {
  if (todoTouched) return true;
  if (Array.isArray(toolResults)) {
    for (const r of toolResults) {
      if (r && r.res && r.res.ok) return true;
    }
  }
  return false;
}

/**
 * Classify how stalled the run is, given how many consecutive turns have made
 * no progress.
 * @param {object} o
 * @param {number} o.turnsSinceProgress consecutive no-progress turns
 * @param {number} o.stallTurns soft threshold (nudge)
 * @param {number} o.stallHardTurns hard threshold (graceful stop)
 * @returns {'none'|'soft'|'hard'}
 */
export function detectStall({ turnsSinceProgress = 0, stallTurns = 6, stallHardTurns = 12 } = {}) {
  const t = Number.isFinite(Number(turnsSinceProgress)) ? Number(turnsSinceProgress) : 0;
  const soft = Number.isFinite(Number(stallTurns)) ? Number(stallTurns) : 6;
  const hard = Math.max(soft, Number.isFinite(Number(stallHardTurns)) ? Number(stallHardTurns) : 12);
  if (t >= hard) return 'hard';
  if (t >= soft) return 'soft';
  return 'none';
}
