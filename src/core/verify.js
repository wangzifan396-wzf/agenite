// Verification engine — the "Verify" half of Plan → Execute → Verify → Rollback.
//
// An agent that edits files but never checks its work is a liability: the 2026
// reviews are unanimous that the reliability ceiling is set by the harness, not
// the model. Aider runs your test command after each edit; Claude Code grew a
// separate verification model. This module is Agenite's version, with two
// design rules that matter:
//
//   1. Zero config by default. We *detect* the project's own check command
//      (npm test / cargo test / go test / pytest / make test) instead of
//      demanding the user configure one.
//   2. Never dump raw output into the context. A failing test suite can emit
//      thousands of lines; `summarizeFailure` compresses that into the handful
//      of lines the model actually needs to fix the bug. Context is the scarce
//      resource, not compute.
//
// Dependency-free on purpose (child_process + fs only), so it works in the
// single-file build and in tests without fixtures.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, extname, basename, delimiter } from 'node:path';

// The level list lives in config.js (the browser bundle imports that module and
// must not pull in child_process); re-exported here so callers of the engine
// don't need to know that.
export { VERIFY_LEVELS } from './config.js';

const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT = 200_000;

// npm writes this into `scripts.test` on `npm init`. Running it always fails
// with exit 1 and tells us nothing, so treat it as "no test script".
const NPM_TEST_PLACEHOLDER = /no test specified/i;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Figure out how this project checks itself.
 * @returns {{cmd:string,args:string[],kind:string,source:string,label:string}|null}
 */
export function detectVerify(dir) {
  if (!dir || !existsSync(dir)) return null;

  // --- Node ---
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    const scripts = (pkg && pkg.scripts) || {};
    const runner = detectNodeRunner(dir);
    // Prefer an explicit test script; fall back to a check/lint script so a
    // library without tests still gets *some* verification.
    for (const name of ['test', 'check', 'typecheck', 'lint']) {
      const body = scripts[name];
      if (typeof body !== 'string' || !body.trim()) continue;
      if (name === 'test' && NPM_TEST_PLACEHOLDER.test(body)) continue;
      return {
        cmd: runner,
        args: runner === 'npm' ? ['run', '--silent', name] : ['run', name],
        kind: name === 'test' ? 'test' : 'lint',
        source: `package.json scripts.${name}`,
        label: `${runner} run ${name}`
      };
    }
  }

  // --- Rust ---
  if (existsSync(join(dir, 'Cargo.toml'))) {
    return { cmd: 'cargo', args: ['test', '--quiet'], kind: 'test', source: 'Cargo.toml', label: 'cargo test' };
  }

  // --- Go ---
  if (existsSync(join(dir, 'go.mod'))) {
    return { cmd: 'go', args: ['test', './...'], kind: 'test', source: 'go.mod', label: 'go test ./...' };
  }

  // --- Python ---
  if (hasPythonTests(dir)) {
    return { cmd: 'pytest', args: ['-q'], kind: 'test', source: 'pytest project layout', label: 'pytest -q' };
  }

  // --- Make ---
  const mk = ['Makefile', 'makefile', 'GNUmakefile'].map((f) => join(dir, f)).find((p) => existsSync(p));
  if (mk && /^test\s*:/m.test(safeRead(mk))) {
    return { cmd: 'make', args: ['test'], kind: 'test', source: basename(mk), label: 'make test' };
  }

  return null;
}

function detectNodeRunner(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

function hasPythonTests(dir) {
  if (existsSync(join(dir, 'pytest.ini')) || existsSync(join(dir, 'tox.ini'))) return true;
  const pyproject = join(dir, 'pyproject.toml');
  if (existsSync(pyproject) && /\[tool\.pytest/.test(safeRead(pyproject))) return true;
  for (const d of ['tests', 'test']) {
    const p = join(dir, d);
    try {
      if (readdirSync(p).some((f) => /^test_.*\.py$/.test(f) || /_test\.py$/.test(f))) return true;
    } catch { /* not a directory */ }
  }
  return false;
}

/** Parse an explicit user-supplied command string into cmd + args (shell-lite). */
export function parseVerifyCmd(str) {
  const parts = String(str || '').trim().match(/"[^"]*"|'[^']*'|\S+/g);
  if (!parts || !parts.length) return null;
  const clean = parts.map((p) => p.replace(/^["']|["']$/g, ''));
  return {
    cmd: clean[0],
    args: clean.slice(1),
    kind: 'custom',
    source: 'verifyCmd 配置',
    label: clean.join(' ')
  };
}

// ---------------------------------------------------------------------------
// Syntax level — instant, per-file, no project setup required
// ---------------------------------------------------------------------------

const JS_EXT = new Set(['.js', '.mjs', '.cjs']);
const JSON_EXT = new Set(['.json']);
const PY_EXT = new Set(['.py']);

/** Files we can parse-check cheaply. Everything else is skipped, not failed. */
export function syntaxCheckable(file) {
  const e = extname(String(file || '')).toLowerCase();
  return JS_EXT.has(e) || JSON_EXT.has(e) || PY_EXT.has(e);
}

/**
 * Parse-check the files this turn touched. This is the default verification
 * level because it is effectively free (tens of ms) and catches the single
 * most common way an agent edit goes wrong: a broken brace or a truncated
 * string that turns a working file into an unparseable one.
 */
export async function quickSyntaxCheck(dir, files = [], { timeoutMs = 15_000 } = {}) {
  const targets = [...new Set(files.filter(syntaxCheckable))].slice(0, 40);
  const failures = [];
  for (const rel of targets) {
    const abs = isAbsolutePath(rel) ? rel : join(dir, rel);
    if (!existsSync(abs)) continue;
    const e = extname(abs).toLowerCase();
    if (JSON_EXT.has(e)) {
      try {
        JSON.parse(readFileSync(abs, 'utf8'));
      } catch (err) {
        failures.push({ file: rel, error: String(err && err.message || err) });
      }
      continue;
    }
    if (JS_EXT.has(e)) {
      const r = await checkJs(abs, timeoutMs);
      if (!r.ok) failures.push({ file: rel, error: r.error });
      continue;
    }
    if (PY_EXT.has(e)) {
      const r = await checkPy(abs, timeoutMs);
      if (r && !r.ok) failures.push({ file: rel, error: r.error });
    }
  }
  return { ok: failures.length === 0, checked: targets.length, failures };
}

async function checkJs(abs, timeoutMs) {
  const first = await spawnCapture(process.execPath, ['--check', abs], { timeoutMs });
  if (first.code === 0) return { ok: true };
  // Older Node parses a bare `.js` as CommonJS, so an ESM file trips a bogus
  // "Cannot use import statement outside a module". Re-check it as a module
  // through stdin before believing the failure.
  if (/import statement outside a module|Unexpected token 'export'|await is only valid/i.test(first.output)) {
    const src = safeRead(abs);
    const second = await spawnCapture(process.execPath, ['--input-type=module', '--check'], { timeoutMs, stdin: src });
    if (second.code === 0) return { ok: true };
    return { ok: false, error: firstSyntaxError(second.output) };
  }
  return { ok: false, error: firstSyntaxError(first.output) };
}

let pythonCmd; // memoized across calls: '' = looked and found nothing
async function checkPy(abs, timeoutMs) {
  if (pythonCmd === undefined) {
    for (const c of ['python3', 'python']) {
      const probe = await spawnCapture(c, ['--version'], { timeoutMs: 5000 });
      if (probe.code === 0) { pythonCmd = c; break; }
    }
    if (pythonCmd === undefined) pythonCmd = '';
  }
  if (!pythonCmd) return null; // no interpreter → skip rather than fail
  const r = await spawnCapture(pythonCmd, ['-m', 'py_compile', abs], { timeoutMs });
  return r.code === 0 ? { ok: true } : { ok: false, error: firstSyntaxError(r.output) };
}

/** Pull the meaningful line out of a node/python syntax dump. */
function firstSyntaxError(output) {
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /^(SyntaxError|IndentationError|TypeError|ReferenceError)\b/.test(l));
  if (hit) {
    const idx = lines.indexOf(hit);
    const where = lines.slice(0, idx).filter((l) => /:\d+/.test(l)).slice(-1)[0];
    return where ? `${hit}（${where}）` : hit;
  }
  return lines.slice(0, 3).join(' / ') || '语法检查失败（无输出）';
}

// ---------------------------------------------------------------------------
// Full level — run the project's own command
// ---------------------------------------------------------------------------

export async function runVerify(dir, spec, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  if (!spec || !spec.cmd) return { ok: false, code: null, output: '', ms: 0, missing: true };
  // Look the binary up on PATH *before* running it. Under a shell (which we
  // need on Windows, where npm/yarn are .cmd shims) a missing command comes
  // back as a plain exit 1 with a localized, code-page-mangled message — there
  // is no reliable way to tell "not installed" from "tests failed" after the
  // fact, and mistaking the two would spam the model with fake test failures.
  if (!commandExists(spec.cmd)) {
    return { ok: false, code: null, output: '', ms: 0, missing: true, label: spec.label };
  }
  const started = Date.now();
  const r = await spawnCapture(spec.cmd, spec.args || [], { cwd: dir, timeoutMs, shellOnWin: true });
  return {
    ok: r.code === 0,
    code: r.code,
    output: r.output,
    ms: Date.now() - started,
    timedOut: r.timedOut,
    missing: r.notFound,
    label: spec.label
  };
}

// ---------------------------------------------------------------------------
// Failure summarization — the part that protects the context window
// ---------------------------------------------------------------------------

const FRAMEWORKS = [
  {
    id: 'node:test',
    match: (o) => /^not ok \d+/m.test(o) || /^# (fail|pass) \d+/m.test(o),
    failures: (o) => matchAll(o, /^not ok \d+ - (.+)$/gm).map((m) => m[1].trim()),
    counts: (o) => ({ fail: intAfter(o, /^# fail (\d+)/m), pass: intAfter(o, /^# pass (\d+)/m) })
  },
  {
    id: 'jest/vitest',
    match: (o) => /^\s*(✕|×|●)\s/m.test(o) || /Tests:\s+\d+ failed/.test(o),
    failures: (o) => matchAll(o, /^\s*(?:✕|×)\s+(.+?)(?:\s+\(\d+\s*ms\))?$/gm).map((m) => m[1].trim()),
    counts: (o) => ({ fail: intAfter(o, /Tests:\s+(\d+) failed/), pass: intAfter(o, /(\d+) passed/) })
  },
  {
    id: 'pytest',
    match: (o) => /^FAILED /m.test(o) || /=+ .*\d+ failed/m.test(o),
    failures: (o) => matchAll(o, /^FAILED\s+(\S+)(?:\s+-\s+(.*))?$/gm).map((m) => m[2] ? `${m[1]} — ${m[2]}` : m[1]),
    counts: (o) => ({ fail: intAfter(o, /(\d+) failed/), pass: intAfter(o, /(\d+) passed/) })
  },
  {
    id: 'go test',
    match: (o) => /^--- FAIL: /m.test(o) || /^FAIL\s+\S+/m.test(o),
    failures: (o) => matchAll(o, /^--- FAIL: (\S+)/gm).map((m) => m[1]),
    counts: (o) => ({ fail: matchAll(o, /^--- FAIL: /gm).length, pass: matchAll(o, /^--- PASS: /gm).length })
  },
  {
    id: 'cargo test',
    match: (o) => /^test result: FAILED/m.test(o) || /^failures:$/m.test(o),
    failures: (o) => matchAll(o, /^\s{4}(\S+)$/gm).map((m) => m[1]).slice(0, 20),
    counts: (o) => ({ fail: intAfter(o, /(\d+) failed/), pass: intAfter(o, /(\d+) passed/) })
  },
  {
    id: 'tsc',
    match: (o) => /error TS\d+:/.test(o),
    failures: (o) => matchAll(o, /^(\S+\(\d+,\d+\)): (error TS\d+: .+)$/gm).map((m) => `${m[1]} ${m[2]}`),
    counts: (o) => ({ fail: matchAll(o, /error TS\d+:/g).length, pass: 0 })
  },
  {
    id: 'eslint',
    match: (o) => /\d+\s+problems?\s+\(\d+ errors?/.test(o),
    failures: (o) => matchAll(o, /^\s*(\d+:\d+)\s+error\s+(.+?)\s{2,}(\S+)$/gm).map((m) => `${m[1]} ${m[2]} (${m[3]})`),
    counts: (o) => ({ fail: intAfter(o, /\((\d+) errors?/), pass: 0 })
  }
];

/**
 * Turn a wall of test output into the few lines a model needs. Returns the
 * detected framework, the failing test names, and a compact text block.
 */
export function summarizeFailure(output, { maxFailures = 12, tailLines = 25 } = {}) {
  const raw = String(output || '');
  const fw = FRAMEWORKS.find((f) => { try { return f.match(raw); } catch { return false; } });

  if (!fw) {
    // Unknown tool: the tail is where the error almost always is.
    const tail = raw.split('\n').filter((l) => l.trim()).slice(-tailLines);
    return {
      framework: null,
      failures: [],
      counts: null,
      text: tail.join('\n').slice(0, 4000) || '（命令失败但没有输出）'
    };
  }

  let failures = [];
  let counts = null;
  try { failures = (fw.failures(raw) || []).filter(Boolean); } catch { failures = []; }
  try { counts = fw.counts(raw); } catch { counts = null; }

  const shown = failures.slice(0, maxFailures);
  const lines = [];
  const head = counts && (counts.fail || counts.pass)
    ? `${fw.id}：失败 ${counts.fail || 0}${counts.pass ? ` / 通过 ${counts.pass}` : ''}`
    : `${fw.id}：检测到失败`;
  lines.push(head);
  for (const f of shown) lines.push(`  ✗ ${f}`);
  if (failures.length > shown.length) lines.push(`  …另有 ${failures.length - shown.length} 项失败未列出`);

  // Always append a short tail: the assertion diff usually lives there and is
  // what actually tells the model *why* it failed.
  const tail = raw.split('\n').filter((l) => l.trim()).slice(-tailLines);
  if (tail.length) lines.push('', '--- 输出末尾 ---', ...tail);

  return { framework: fw.id, failures, counts, text: lines.join('\n').slice(0, 4000) };
}

// ---------------------------------------------------------------------------
// Top-level entry used by both the `verify` tool and the agent harness
// ---------------------------------------------------------------------------

/**
 * @param {string} dir workspace root
 * @param {object} o
 * @param {'off'|'syntax'|'full'} o.level
 * @param {string} [o.cmd] explicit override
 * @param {string[]} [o.changedFiles] paths touched this turn (syntax level)
 */
export async function verifyWorkspace(dir, {
  level = 'syntax',
  cmd = '',
  changedFiles = [],
  timeoutMs = DEFAULT_TIMEOUT
} = {}) {
  if (level === 'off') return { ran: false, ok: true, level, reason: '已关闭' };

  if (level === 'syntax') {
    const r = await quickSyntaxCheck(dir, changedFiles);
    if (!r.checked) return { ran: false, ok: true, level, reason: '本回合无可快检的文件' };
    return {
      ran: true,
      ok: r.ok,
      level,
      kind: 'syntax',
      label: `语法快检（${r.checked} 个文件）`,
      failures: r.failures,
      summary: r.ok
        ? `语法快检通过（${r.checked} 个文件）`
        : r.failures.map((f) => `✗ ${f.file}: ${f.error}`).join('\n')
    };
  }

  // full
  const spec = (cmd && parseVerifyCmd(cmd)) || detectVerify(dir);
  if (!spec) {
    // No project command? Don't silently do nothing — fall back to syntax.
    const fb = await verifyWorkspace(dir, { level: 'syntax', changedFiles });
    return { ...fb, level: 'full', reason: '未探测到项目校验命令，已降级为语法快检' };
  }
  const r = await runVerify(dir, spec, { timeoutMs });
  if (r.missing) {
    return { ran: false, ok: true, level, reason: `未找到命令 ${spec.cmd}（跳过验证）`, label: spec.label };
  }
  if (r.ok) {
    return { ran: true, ok: true, level, kind: spec.kind, label: spec.label, ms: r.ms, summary: `✓ ${spec.label} 通过（${r.ms}ms）` };
  }
  const s = summarizeFailure(r.output);
  return {
    ran: true,
    ok: false,
    level,
    kind: spec.kind,
    label: spec.label,
    ms: r.ms,
    code: r.code,
    timedOut: r.timedOut,
    framework: s.framework,
    failures: s.failures,
    summary: r.timedOut
      ? `✗ ${spec.label} 超时（>${Math.round(timeoutMs / 1000)}s）`
      : `✗ ${spec.label} 退出码 ${r.code}\n${s.text}`
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function spawnCapture(cmd, args, { cwd, timeoutMs = DEFAULT_TIMEOUT, stdin = null, shellOnWin = false } = {}) {
  return new Promise((resolve) => {
    // npm/yarn/pnpm are .cmd shims on Windows and are not directly executable.
    const useShell = shellOnWin && process.platform === 'win32';
    const child = execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true, shell: useShell },
      (err, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n');
        if (!err) return resolve({ code: 0, output, timedOut: false, notFound: false });
        resolve({
          code: typeof err.code === 'number' ? err.code : (err.code ? 1 : null),
          output: output || String(err.message || ''),
          timedOut: err.killed === true && err.signal != null,
          notFound: err.code === 'ENOENT'
        });
      }
    );
    if (stdin != null && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
  });
}

/** Pure-JS PATH lookup — no spawn, no locale, no encoding surprises. */
export function commandExists(cmd) {
  const name = String(cmd || '').trim();
  if (!name) return false;
  const exts = process.platform === 'win32'
    ? ['', ...String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  // An explicit path is checked as given, not searched for.
  if (/[\\/]/.test(name)) return exts.some((e) => existsSync(name + e));
  for (const d of String(process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const e of exts) {
      try { if (existsSync(join(d, name + e))) return true; } catch { /* unreadable PATH entry */ }
    }
  }
  return false;
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function safeRead(p) {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

function matchAll(str, re) {
  const out = [];
  let m;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = r.exec(str)) !== null) {
    out.push(m);
    if (m.index === r.lastIndex) r.lastIndex++;
    if (out.length > 500) break;
  }
  return out;
}

function intAfter(str, re) {
  const m = str.match(re);
  return m ? Number(m[1]) || 0 : 0;
}

function isAbsolutePath(p) {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(String(p));
}
