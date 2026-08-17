// v0.65 — pure unit tests for the stall-detection decision core.
// No LLM, no disk: turnMadeProgress + detectStall are deterministic.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { turnMadeProgress, detectStall } from '../src/core/stallguard.js';

const okTool = (name) => ({ tc: { name }, res: { ok: true } });
const badTool = (name) => ({ tc: { name }, res: { ok: false, error: 'x' } });

describe('turnMadeProgress', () => {
  it('true when a tool call succeeded', () => {
    assert.equal(turnMadeProgress({ toolResults: [badTool('a'), okTool('b')] }), true);
  });
  it('true when todo advanced', () => {
    assert.equal(turnMadeProgress({ toolResults: [badTool('a')], todoTouched: true }), true);
  });
  it('false when every tool failed and todo untouched', () => {
    assert.equal(turnMadeProgress({ toolResults: [badTool('a'), badTool('b')] }), false);
  });
  it('false when no tool results at all', () => {
    assert.equal(turnMadeProgress({ toolResults: [] }), false);
  });
  it('false on missing args', () => {
    assert.equal(turnMadeProgress(), false);
  });
});

describe('detectStall', () => {
  it('none below the soft threshold', () => {
    assert.equal(detectStall({ turnsSinceProgress: 0, stallTurns: 6, stallHardTurns: 12 }), 'none');
    assert.equal(detectStall({ turnsSinceProgress: 5, stallTurns: 6, stallHardTurns: 12 }), 'none');
  });
  it('soft at the soft threshold, below hard', () => {
    assert.equal(detectStall({ turnsSinceProgress: 6, stallTurns: 6, stallHardTurns: 12 }), 'soft');
    assert.equal(detectStall({ turnsSinceProgress: 11, stallTurns: 6, stallHardTurns: 12 }), 'soft');
  });
  it('hard at/after the hard threshold', () => {
    assert.equal(detectStall({ turnsSinceProgress: 12, stallTurns: 6, stallHardTurns: 12 }), 'hard');
    assert.equal(detectStall({ turnsSinceProgress: 40, stallTurns: 6, stallHardTurns: 12 }), 'hard');
  });
  it('honours custom thresholds', () => {
    assert.equal(detectStall({ turnsSinceProgress: 3, stallTurns: 3, stallHardTurns: 5 }), 'soft');
    assert.equal(detectStall({ turnsSinceProgress: 5, stallTurns: 3, stallHardTurns: 5 }), 'hard');
  });
  it('never flags hard below soft (hard floored to soft)', () => {
    assert.equal(detectStall({ turnsSinceProgress: 100, stallTurns: 10, stallHardTurns: 1 }), 'hard');
  });
  it('tolerates non-numeric input', () => {
    assert.equal(detectStall({}), 'none');
    assert.equal(detectStall({ turnsSinceProgress: 'abc', stallTurns: 6, stallHardTurns: 12 }), 'none');
  });
});
