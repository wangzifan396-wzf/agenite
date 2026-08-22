// v0.77.0 — Shared planning schema (single source of truth for the plan vocabulary)
// --------------------------------------------------------------------------
// v0.74 (gate), v0.75 (refine), v0.76 (decompose) and v0.77 (cohere) each
// needed a tiny slice of the *same* plan vocabulary — the canonical step
// kinds, per-kind counts, step normalization and CJK-aware tokenization. Each
// module had quietly re-implemented its own copy, so the four planning stages
// could (in principle) disagree about what a "plan" even is and about how CJK
// text is tokenized. This module extracts that shared vocabulary into ONE
// pure module and becomes the single source of truth for every planning stage.
//
// Design constraints (identical to the sibling planning modules):
//   * Pure, model-free, IO-free, network-free — trivially unit-testable.
//   * CJK-aware: every matcher/tokenizer treats CJK as single chars, never \b.
//   * Emoji-free data: per-kind icons live in PLAN_KIND_ICONS for the UI layer,
//     but this module carries no rendering concerns beyond that lookup table.

export const PLAN_SCHEMA_VERSION = '0.77.0';

// The three canonical plan step kinds. Every planning module agrees on this
// exact set, so a "kind" is always one of these three (never a free string).
export const STEP_KINDS = ['research', 'action', 'verify'];

// Human-readable Chinese labels per kind (shared by backend stats + frontend).
export const PLAN_KIND_LABELS = {
  research: '调研',
  action: '执行',
  verify: '验证'
};

// Per-kind icons for the UI trace/labels. Kept here (not inline in a render
// function) so backend stats and frontend rendering derive from one table.
export const PLAN_KIND_ICONS = {
  research: '🔍',
  action: '⚙️',
  verify: '✅'
};

// Count how many steps of each canonical kind are present. Unknown kinds are
// ignored (only the three canonical kinds are tallied), so callers always get
// a complete { research, action, verify } tally even on sparse / odd input.
export function countKinds(steps) {
  const out = { research: 0, action: 0, verify: 0 };
  if (!Array.isArray(steps)) return out;
  for (const s of steps) {
    const kind = s && s.kind;
    if (kind != null && out[kind] != null) out[kind]++;
  }
  return out;
}

// Normalize a plan input (either structured steps or raw newline text) into a
// flat array of non-empty step strings. Numbered prefixes ("1. ", "2、", "3)")
// are stripped so "1. do X" and "do X" normalize to the same string — crucial
// because the gate, decompose and coherence modules all consume the result.
export function normSteps(input) {
  if (Array.isArray(input)) return input.map(String).filter(Boolean);
  if (typeof input === 'string') {
    return input.split(/\n+/).map((s) => s.replace(/^\s*\d+[.、)]\s*/, '').trim()).filter(Boolean);
  }
  return [];
}

// CJK-aware tokenization: latin/digit/underscore runs + individual CJK chars.
// Used by the gate's goal-coverage check and the coherence module; the same
// tokenizer guarantees both stages agree on "what words are in this text".
export function tokenize(text) {
  return (text || '').toLowerCase().match(/[a-z0-9_]+|[一-龥]/g) || [];
}
