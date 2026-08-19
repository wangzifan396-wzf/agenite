// Action-level blast-radius gate (v0.71.0 — "Governance track").
//
// Evaluated BEFORE a tool executes. This is the gateway-level enforcement the
// 2026 agentic-governance playbooks call for (FutureAGI, Atlan, the Five-Eyes
// "Careful Adoption of Agentic AI" guidance): the guardrail is a hard check at
// the tool boundary, not a polite prompt suggestion. It complements — and sits
// in front of — the harness's own approval UI.
//
// Hard safety floor (never overridden by approvalMode):
//   • secret  → a tool call whose args reference a credential/secret is ALWAYS denied
//   • denyList → explicit operator blocklist is always denied
//   • network rate cap → a bounded number of network calls per run is denied past the cap
//   • allowList → when set, ONLY listed tools may run (blocklist takes precedence via the floor)
//
// Everything else is routed by approvalMode:
//   • auto → allow (unless caught by a hard floor above)
//   • ask  → mutating / exec / network / destructive require a human gate;
//            benign reads & unknowns auto-pass
//   • deny → block everything (the floor already does this, kept explicit)

const SECRET_PATTERNS = [
  /\.env\b/i,
  /credential/i,
  /api[_-]?key/i,
  /\bsecret\b/i,
  /private[_-]?key/i,
  /\bpassword\b/i,
  /\btoken\b/i,
  /\.pem\b/i,
  /\.key\b(?!\w)/i
];

// Irreversible / high-blast commands that must be flagged even inside an exec.
const DESTRUCTIVE_PATTERNS = [
  /rm\s+-rf/i,
  /rm\s+-fr/i,
  /\brm\s+-r\s+-f\b/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdrop\s+table\b/i,
  /\bdrop\s+database\b/i,
  /\btruncate\s+/i,
  />\s*\/dev\/(sd|hd|nvm|xvd)/i,
  /:\s*\(/ // accidental ":" redirect to a device in some shells
];

const READ_TOOLS = new Set([
  'read_file', 'list_dir', 'find_files', 'grep_files', 'codebase_search',
  'memory_recall', 'context_retrieve'
]);
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'make_dir', 'apply_patch']);
const EXEC_TOOLS = new Set(['run_command', 'run_code']);
const NETWORK_TOOLS = new Set(['web_fetch', 'web_search']);

export const GUARDRAIL_CATEGORIES = ['read', 'write', 'exec', 'network', 'destructive', 'secret', 'unknown'];

/**
 * Classify a tool call into a risk category from the tool name and its args.
 * Order matters: secret (args look like a credential) and destructive
 * (exec args contain an irreversible command) win over the plain tool bucket.
 */
export function classifyTool(tool, args = {}) {
  const argStr = typeof args === 'string' ? args : JSON.stringify(args || {});
  if (SECRET_PATTERNS.some((re) => re.test(argStr))) return 'secret';
  if (EXEC_TOOLS.has(tool) && DESTRUCTIVE_PATTERNS.some((re) => re.test(argStr))) return 'destructive';
  if (READ_TOOLS.has(tool)) return 'read';
  if (WRITE_TOOLS.has(tool)) return 'write';
  if (EXEC_TOOLS.has(tool)) return 'exec';
  if (NETWORK_TOOLS.has(tool)) return 'network';
  return 'unknown';
}

/**
 * Normalize an operator-supplied approval mode into the canonical triad.
 * Missing / unknown input defaults to 'ask' — fail toward a human gate, never
 * toward silent execution.
 */
export function resolveMode(approvalMode) {
  const m = String(approvalMode == null ? '' : approvalMode).toLowerCase().trim();
  if (m === 'auto' || m === 'allow' || m === 'yolo') return 'auto';
  if (m === 'deny' || m === 'block' || m === 'never' || m === 'off') return 'deny';
  return 'ask';
}

/**
 * Evaluate the blast-radius gate for a single tool call.
 *
 * @param {object}   opts
 * @param {string}   opts.tool      tool name (e.g. 'write_file')
 * @param {object}   [opts.args]    tool arguments (inspected for secret/destructive)
 * @param {object}   [opts.policy]  { mode, denyList, allowList, networkCap }
 *                                  - mode: raw approvalMode string (resolved internally)
 *                                  - networkCap: max network calls per run, -1 = unlimited
 * @param {object}   [opts.stats]   { netCount } running network-call count for this run
 * @returns {{decision:'allow'|'ask'|'deny', category:string, reason:string}}
 */
export function evaluateGuardrail({ tool, args = {}, policy = {}, stats = {} } = {}) {
  const category = classifyTool(tool, args);

  // 1) Hard safety floor — secret access is never permitted, full stop.
  if (category === 'secret') {
    return { decision: 'deny', category, reason: 'secret-access-blocked' };
  }

  // 2) Explicit operator blocklist — always denied.
  const denyList = Array.isArray(policy.denyList) ? policy.denyList : [];
  if (denyList.includes(tool)) {
    return { decision: 'deny', category, reason: 'deny-list' };
  }

  // 3) Network rate cap — bounded blast radius for outbound calls.
  if (category === 'network' && Number.isFinite(Number(policy.networkCap))) {
    const cap = Number(policy.networkCap);
    const used = Number(stats.netCount || 0);
    if (cap >= 0 && used >= cap) {
      return { decision: 'deny', category, reason: 'network-rate-limit' };
    }
  }

  // 4) Allow-list — when set, ONLY listed tools may run (defense in depth).
  const allowList = Array.isArray(policy.allowList) ? policy.allowList : [];
  if (allowList.length > 0 && !allowList.includes(tool)) {
    return { decision: 'deny', category, reason: 'not-in-allow-list' };
  }

  // 5) Approval mode routing for everything that survived the floor.
  const mode = resolveMode(policy.mode);
  if (mode === 'deny') {
    return { decision: 'deny', category, reason: 'mode-deny' };
  }
  if (mode === 'ask') {
    // Risk classes that need a human gate; benign reads/unknowns auto-pass.
    if (category === 'write' || category === 'exec' || category === 'network' || category === 'destructive') {
      return { decision: 'ask', category, reason: 'requires-approval' };
    }
    return { decision: 'allow', category, reason: 'readonly' };
  }
  // auto: allow unless caught by a hard floor above.
  return { decision: 'allow', category, reason: 'mode-auto' };
}
