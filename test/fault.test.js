// v0.68 — pure unit tests for the root-cause self-heal decision core (fault.js).
// No LLM, no disk: classifyError / decideSelfHeal / backoffMs / dominantCategory
// are all deterministic. backoffMs takes an injectable rng so we can assert exact
// values.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAULT_CATEGORIES, classifyError, decideSelfHeal, backoffMs, dominantCategory
} from '../src/core/fault.js';

describe('FAULT_CATEGORIES', () => {
  it('enumerates the six root-cause classes', () => {
    assert.deepEqual(FAULT_CATEGORIES, [
      'transient', 'structural', 'semantic', 'auth', 'budget', 'unknown'
    ]);
  });
});

describe('classifyError — errorClass mapping', () => {
  const transient = ['TRANSIENT', 'RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'SERVER'];
  const structural = ['PERMANENT', 'NOT_FOUND', 'EDIT_NO_MATCH', 'BISECT_FAILED', 'VERIFY_FAILED'];
  const semantic = ['SCHEMA_ERROR'];
  const auth = ['AUTH', 'PERMISSION_DENIED'];

  for (const ec of transient) {
    it(`${ec} → transient (retryable)`, () => {
      const r = classifyError({ errorClass: ec });
      assert.equal(r.category, 'transient');
      assert.equal(r.retryable, true);
    });
  }
  for (const ec of structural) {
    it(`${ec} → structural (replan)`, () => {
      const r = classifyError({ errorClass: ec });
      assert.equal(r.category, 'structural');
      assert.equal(r.replan, true);
    });
  }
  for (const ec of semantic) {
    it(`${ec} → semantic (fixable by re-reading)`, () => {
      const r = classifyError({ errorClass: ec });
      assert.equal(r.category, 'semantic');
    });
  }
  for (const ec of auth) {
    it(`${ec} → auth (escalate)`, () => {
      const r = classifyError({ errorClass: ec });
      assert.equal(r.category, 'auth');
      assert.equal(r.escalate, true);
    });
  }
  it('unknown / unmapped class → unknown', () => {
    const r = classifyError({ errorClass: 'UNKNOWN' });
    assert.equal(r.category, 'unknown');
  });
});

describe('classifyError — inference from text / status', () => {
  it('401/403 → auth', () => {
    assert.equal(classifyError(null, { status: 401 }).category, 'auth');
    assert.equal(classifyError(null, { status: 403 }).category, 'auth');
  });
  it('429 → transient', () => {
    assert.equal(classifyError(null, { status: 429 }).category, 'transient');
  });
  it('5xx → transient', () => {
    assert.equal(classifyError(null, { status: 503 }).category, 'transient');
  });
  it('404 → structural', () => {
    assert.equal(classifyError(null, { status: 404 }).category, 'structural');
  });
  it('400/422 → semantic', () => {
    assert.equal(classifyError(null, { status: 400 }).category, 'semantic');
    assert.equal(classifyError(null, { status: 422 }).category, 'semantic');
  });
  it('context-length text → budget', () => {
    assert.equal(classifyError(null, { text: 'maximum context length exceeded' }).category, 'budget');
  });
  it('network timeout text → transient', () => {
    assert.equal(classifyError(null, { text: 'fetch failed: ETIMEDOUT' }).category, 'transient');
  });
  it('permission-denied text → auth', () => {
    assert.equal(classifyError(null, { text: 'permission denied: 越界' }).category, 'auth');
  });
  it('uninformative text → unknown', () => {
    assert.equal(classifyError(null, { text: 'something weird happened' }).category, 'unknown');
  });
  it('explicit errorClass wins over inferable text', () => {
    const r = classifyError(null, { errorClass: 'SCHEMA_ERROR', text: 'network timeout' });
    assert.equal(r.category, 'semantic');
  });
});

describe('backoffMs', () => {
  it('exponential base with rng=0: 400, 800, 1600', () => {
    const rng = () => 0;
    assert.equal(backoffMs(0, { rng }), 400);
    assert.equal(backoffMs(1, { rng }), 800);
    assert.equal(backoffMs(2, { rng }), 1600);
  });
  it('honors custom base', () => {
    assert.equal(backoffMs(0, { base: 1000, rng: () => 0 }), 1000);
    assert.equal(backoffMs(1, { base: 1000, rng: () => 0 }), 2000);
  });
  it('jitter stays within [base*2^a, base*2^a+300)', () => {
    const rng = () => 0.999; // floor(0.999*300)=299
    const v = backoffMs(1, { rng });
    assert.ok(v >= 800 && v < 800 + 300);
  });
  it('respects the cap', () => {
    const v = backoffMs(20, { rng: () => 0 });
    assert.ok(v <= 30000);
  });
});

describe('dominantCategory', () => {
  it('empty / non-array → unknown', () => {
    assert.equal(dominantCategory([]), 'unknown');
    assert.equal(dominantCategory(null), 'unknown');
  });
  it('picks the most severe root cause (auth beats transient)', () => {
    assert.equal(dominantCategory(['transient', 'auth']), 'auth');
  });
  it('structural beats semantic', () => {
    assert.equal(dominantCategory(['semantic', 'structural']), 'structural');
  });
});

describe('decideSelfHeal — actions', () => {
  it('selfHeal:false → none', () => {
    const d = decideSelfHeal({ selfHeal: false, category: 'auth' });
    assert.equal(d.action, 'none');
    assert.equal(d.message, '');
  });
  it('auth → escalate (always)', () => {
    const d = decideSelfHeal({ category: 'auth', reflections: 0, cap: 3 });
    assert.equal(d.action, 'escalate');
    assert.equal(d.escalate, true);
  });
  it('budget → compress', () => {
    const d = decideSelfHeal({ category: 'budget', reflections: 0, cap: 3 });
    assert.equal(d.action, 'compress');
    assert.equal(d.escalate, false);
  });
  it('transient early attempt → retry with backoffMs', () => {
    const d = decideSelfHeal({ category: 'transient', attempt: 0, maxAttempts: 3, reflections: 0, cap: 3 });
    assert.equal(d.action, 'retry');
    assert.equal(typeof d.backoffMs, 'number');
    assert.ok(d.backoffMs >= 400);
    assert.equal(d.retryable, true);
  });
  it('transient exhausted → escalate', () => {
    const d = decideSelfHeal({ category: 'transient', attempt: 2, maxAttempts: 3, reflections: 0, cap: 3 });
    assert.equal(d.action, 'escalate');
  });
  it('structural first failure (no loop) → reflect', () => {
    const d = decideSelfHeal({ category: 'structural', loopStreak: 0, reflections: 0, cap: 3 });
    assert.equal(d.action, 'reflect');
    assert.match(d.message, /第 1\/3 次/);
  });
  it('structural + stuck loop (no cap) → replan', () => {
    const d = decideSelfHeal({ category: 'structural', loopStreak: 3, reflections: 1, cap: 3 });
    assert.equal(d.action, 'replan');
    assert.equal(d.replan, true);
  });
  it('structural + loop + cap reached → escalate', () => {
    const d = decideSelfHeal({ category: 'structural', loopStreak: 3, reflections: 3, cap: 3 });
    assert.equal(d.action, 'escalate');
  });
  it('semantic + stuck loop → replan', () => {
    const d = decideSelfHeal({ category: 'semantic', loopStreak: 2, reflections: 1, cap: 3 });
    assert.equal(d.action, 'replan');
  });
  it('replan carries structured reason + resetCounters signal (v0.69)', () => {
    const d = decideSelfHeal({ category: 'structural', loopStreak: 3, reflections: 1, cap: 3 });
    assert.equal(d.action, 'replan');
    assert.equal(d.replan, true);
    assert.equal(d.reason, 'looping');
    assert.equal(d.resetCounters, true);
    assert.equal(d.retryable, false);
  });
  it('reflect / retry / compress do NOT carry resetCounters', () => {
    const reflect = decideSelfHeal({ category: 'semantic', loopStreak: 0, reflections: 0, cap: 3 });
    assert.notEqual(reflect.action, 'replan');
    assert.ok(!reflect.resetCounters, 'reflect should not carry resetCounters');
    const retry = decideSelfHeal({ category: 'transient', attempt: 0, maxAttempts: 3, reflections: 0, cap: 3 });
    assert.notEqual(retry.action, 'replan');
    assert.ok(!retry.resetCounters, 'retry should not carry resetCounters');
  });
  it('unknown + loop + cap → escalate', () => {
    const d = decideSelfHeal({ category: 'unknown', loopStreak: 5, reflections: 3, cap: 3 });
    assert.equal(d.action, 'escalate');
  });
  it('unknown first failure → reflect', () => {
    const d = decideSelfHeal({ category: 'unknown', loopStreak: 0, reflections: 0, cap: 3 });
    assert.equal(d.action, 'reflect');
  });
});
