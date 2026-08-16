// v0.62 — Multi-Model Intelligent Routing.
//
// Splits a goal into two tiers and routes each to a different model:
//   - 'reasoning' : planning, verification gate, outcome gate, skill
//                   distillation — high-value cognition where a strong model
//                   pays for itself and where an error is expensive.
//   - 'executor'  : the autonomous tool-calling loop + its final summary — the
//                   bulk of token spend, where a cheap/fast model is fine.
//
// Critical safety property: routing NEVER bypasses the v0.58 verify gate or
// the v0.59 outcome gate. Both gates run on the reasoning tier and read
// EXECUTION LOG FACTS (not the executor's self-report), so a weaker executor
// model cannot silently ship a wrong result. That is exactly the known 2026
// failure mode for multi-model agents — "silent degradation": a cheap model
// emits text that LOOKS right but is measurably worse. Agenite's dual gates are
// the structural defense, so routing is safe rather than risky.
//
// All behaviour is deps-injectable (routeModel) so goals.js stays unit-testable
// without a network.

// 'on' routes reasoning/executor tiers to separate models; 'off' uses config.model.
export function resolveRouterMode(config) {
  if (!config) return 'off';
  return config.modelRouter === 'on' ? 'on' : 'off';
}

// Resolve the concrete model string for a tier. Returns config.model when the
// router is off, or when the tier-specific model is empty (graceful fallback).
export function pickModel({ config, routerMode, tier }) {
  if (!config) return '';
  if (routerMode !== 'on') return config.model || '';
  if (tier === 'reasoning') {
    return (config.reasoningModel && config.reasoningModel.trim()) || config.model || '';
  }
  if (tier === 'executor') {
    return (config.executorModel && config.executorModel.trim()) || config.model || '';
  }
  return config.model || '';
}

// Build a callModel wrapper for one tier. The wrapper injects the resolved model
// string into the underlying cm's options so callModelStream / the test fake
// receive the right model. When deps.routeModel is supplied it overrides this.
export function routeModel({ config, routerMode, cm, tier, deps }) {
  if (deps && typeof deps.routeModel === 'function') {
    return deps.routeModel({ config, routerMode, cm, tier });
  }
  const model = pickModel({ config, routerMode, tier });
  return (msgs, o = {}) => cm(msgs, { ...(o || {}), model });
}

// Convenience: build both tier wrappers at once (used by goals.js).
// Returns { mode, reasoning, executor }.
export function buildRouters({ config, cm, deps }) {
  const routerMode = resolveRouterMode(config);
  return {
    mode: routerMode,
    reasoning: routeModel({ config, routerMode, cm, tier: 'reasoning', deps }),
    executor: routeModel({ config, routerMode, cm, tier: 'executor', deps })
  };
}
