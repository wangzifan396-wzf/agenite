// Tool definitions + execution — this is where Agenite actually touches the
// machine. Everything dangerous goes through two gates:
//   1. workspace sandbox  (paths are pinned under a root directory)
//   2. approval hook      (a human clicks allow/deny before it runs)
// All side effects are injectable so the whole file stays testable under node:test.
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, sep, join, relative } from 'node:path';
import os from 'node:os';
import { sanitizeUrl } from './util.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const MAX_OUTPUT = 8000;
const CMD_TIMEOUT = 60_000;

// Canonical tool catalog. `danger` tools require explicit opt-in + approval.
export const TOOL_DEFS = [
  {
    name: 'calculator',
    description: 'Evaluate a math expression safely (supports + - * / % ^ and sqrt, pow, abs, floor, ceil, round, sin, cos, tan, log, min, max). Example: "3 * (4 + 5) ^ 2".',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'The math expression to evaluate.' } },
      required: ['expression']
    },
    danger: false
  },
  {
    name: 'current_datetime',
    description: 'Return the current date and time (UTC and local).',
    parameters: { type: 'object', properties: {} },
    danger: false
  },
  {
    name: 'system_info',
    description: "Report the local machine's OS, CPU, memory, hostname, Node version and the current workspace directory.",
    parameters: { type: 'object', properties: {} },
    danger: false
  },
  {
    name: 'web_fetch',
    description: 'Fetch a public URL and return its readable text content (HTML tags stripped, truncated). Use to read web pages or JSON APIs.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The absolute http(s) URL to fetch.' },
        max_chars: { type: 'number', description: 'Optional max characters to return (default 8000).' }
      },
      required: ['url']
    },
    danger: false
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the local filesystem, relative to the workspace root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to the workspace root.' },
        max_chars: { type: 'number', description: 'Optional max characters to return (default 20000).' }
      },
      required: ['path']
    },
    danger: false
  },
  {
    name: 'list_dir',
    description: 'List entries of a directory in the workspace, with sizes. Use "." for the workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path (default ".").' } },
      required: []
    },
    danger: false
  },
  {
    name: 'find_files',
    description: 'Recursively find files under the workspace whose name matches a glob-like pattern (* and ? supported), e.g. "*.md" or "src/**". Skips node_modules and .git.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Filename pattern, e.g. "*.js".' },
        path: { type: 'string', description: 'Directory to search in (default ".").' },
        limit: { type: 'number', description: 'Max results (default 100).' }
      },
      required: ['pattern']
    },
    danger: false
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file in the workspace. Requires user approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write, relative to the workspace root.' },
        content: { type: 'string', description: 'Full file content to write.' }
      },
      required: ['path', 'content']
    },
    danger: true
  },
  {
    name: 'edit_file',
    description: 'Replace an exact substring inside an existing file. Safer than write_file for small edits — fails if the old text is missing or ambiguous. Requires user approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to edit, relative to the workspace root.' },
        old_text: { type: 'string', description: 'Exact text to find (must appear exactly once).' },
        new_text: { type: 'string', description: 'Replacement text.' }
      },
      required: ['path', 'old_text', 'new_text']
    },
    danger: true
  },
  {
    name: 'make_dir',
    description: 'Create a directory (recursively) in the workspace. Requires user approval.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path to create.' } },
      required: ['path']
    },
    danger: true
  },
  {
    name: 'run_command',
    description: 'Run a command on the local machine and return stdout/stderr. Pass a full command line in "command" (shell features like pipes work), or pass "command" plus an "args" array to run without a shell. Requires user approval.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command line to execute, e.g. "git status" or "node -v".' },
        args: { type: 'array', items: { type: 'string' }, description: 'Optional argument list — when given, no shell is used.' },
        cwd: { type: 'string', description: 'Working directory relative to the workspace root (default ".").' }
      },
      required: ['command']
    },
    danger: true
  },
  {
    name: 'open_path',
    description: "Open a file, folder or URL with the operating system's default application (Explorer / Finder / browser). Requires user approval.",
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', description: 'A workspace path or an http(s) URL.' } },
      required: ['target']
    },
    danger: true
  }
];

export const DANGER_TOOLS = TOOL_DEFS.filter((t) => t.danger).map((t) => t.name);

// Only return tools the current config allows.
export function activeTools(config) {
  const allowDanger = !!(config && config.dangerTools) && config.approvalMode !== 'deny';
  return TOOL_DEFS.filter((t) => !t.danger || allowDanger);
}

// ---- sandbox ----

/**
 * Pin a user/model supplied path inside the workspace root.
 * When no workspace is configured (tests, library use) the path passes through.
 */
export function resolveSafePath(p, opts = {}) {
  const root = opts.workspace ? resolve(opts.workspace) : null;
  const target = resolve(root || process.cwd(), p == null || p === '' ? '.' : String(p));
  if (!root || opts.allowOutsideWorkspace) return target;
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(
      `路径越界：${target} 不在工作区 ${root} 内。` +
      '如需访问外部路径，请在设置中开启「允许访问工作区之外」。'
    );
  }
  return target;
}

function displayPath(abs, opts) {
  if (!opts.workspace) return abs;
  const rel = relative(resolve(opts.workspace), abs);
  return rel === '' ? '.' : rel.startsWith('..') ? abs : rel;
}

// ---- approval gate ----

async function ensureApproval(def, args, opts) {
  if (!def.danger) return null;
  const mode = opts.approvalMode || 'ask';
  if (mode === 'deny') {
    return { ok: false, error: `当前为「只读模式」，已拒绝执行 ${def.name}。` };
  }
  if (mode === 'auto') return null;
  // 'ask' — needs a human. Without a hook (CLI/tests) we fall through rather
  // than deadlock, since dangerTools already had to be explicitly enabled.
  if (typeof opts.requestApproval !== 'function') return null;
  const verdict = await opts.requestApproval({ name: def.name, args, description: def.description });
  if (verdict && verdict.approved) return null;
  return { ok: false, error: (verdict && verdict.reason) || '用户拒绝了这次操作。' };
}

export async function executeTool(name, args = {}, opts = {}) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) return { ok: false, error: `未知工具: ${name}` };
  if (def.danger && !opts.dangerTools) {
    return { ok: false, error: `工具 ${name} 需要在设置中开启「电脑操作权限」。` };
  }
  const denied = await ensureApproval(def, args, opts);
  if (denied) return denied;

  try {
    // NOTE: `await` matters here — without it a rejected promise would escape
    // this try/catch and blow up the agent loop instead of becoming an error.
    return await dispatch(name, args, opts);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

async function dispatch(name, args, opts) {
  switch (name) {
      case 'calculator':
        return evalMath(args.expression);
      case 'current_datetime':
        return { ok: true, content: `UTC: ${new Date().toISOString()}\nLocal: ${new Date().toString()}` };
      case 'system_info':
        return systemInfo(opts);
      case 'web_fetch':
        return webFetch(args.url, args.max_chars, opts);
      case 'read_file':
        return readLocalFile(args.path, args.max_chars, opts);
      case 'list_dir':
        return listLocalDir(args.path || '.', opts);
      case 'find_files':
        return findFiles(args, opts);
      case 'write_file':
        return writeLocalFile(args.path, args.content, opts);
      case 'edit_file':
        return editLocalFile(args, opts);
      case 'make_dir':
        return makeLocalDir(args.path, opts);
      case 'run_command':
        return runCmd(args, opts);
      case 'open_path':
        return openPath(args.target, opts);
    default:
      return { ok: false, error: `未实现的工具: ${name}` };
  }
}

// ---- implementations ----

function evalMath(expr) {
  if (typeof expr !== 'string' || expr.trim() === '') {
    return { ok: false, error: '空表达式' };
  }
  let result;
  try {
    result = parseArithmetic(expr);
  } catch (e) {
    return { ok: false, error: '无法解析表达式: ' + e.message };
  }
  return { ok: true, content: String(result) };
}

// Tiny safe arithmetic parser (recursive descent). No eval, no arbitrary code.
const MATH_FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  round: Math.round, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  log: Math.log, exp: Math.exp, pow: Math.pow, min: Math.min, max: Math.max
};

function parseArithmetic(input) {
  const tokens = tokenize(input);
  let pos = 0;
  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }

  function parseExpr() {
    let v = parseTerm();
    while (peek() && (peek().value === '+' || peek().value === '-')) {
      const op = next().value;
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (peek() && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = next().value;
      const r = parseFactor();
      if (op === '*') v *= r;
      else if (op === '/') v /= r;
      else v %= r;
    }
    return v;
  }
  function parseFactor() {
    let v;
    if (peek() && peek().value === '-') { next(); v = -parseFactor(); }
    else if (peek() && peek().value === '+') { next(); v = parseFactor(); }
    else v = parsePower();
    return v;
  }
  function parsePower() {
    const base = parseUnary();
    if (peek() && peek().value === '^') {
      next();
      return Math.pow(base, parsePower());
    }
    return base;
  }
  function parseUnary() {
    const t = peek();
    if (t && t.type === 'num') { next(); return t.value; }
    if (t && t.type === 'func') {
      next();
      const open = next();
      if (!open || open.value !== '(') throw new Error('函数缺少左括号');
      const args = [];
      if (!(peek() && peek().value === ')')) {
        args.push(parseExpr());
        while (peek() && peek().value === ',') {
          next();
          args.push(parseExpr());
        }
      }
      const close = next();
      if (!close || close.value !== ')') throw new Error('函数缺少右括号');
      const fn = MATH_FUNCS[t.value];
      if (!fn) throw new Error('未知函数 ' + t.value);
      return fn.apply(null, args);
    }
    if (t && t.value === '(') {
      next();
      const v = parseExpr();
      const close = next();
      if (!close || close.value !== ')') throw new Error('括号不匹配');
      return v;
    }
    throw new Error('意外符号: ' + (t ? t.value : 'EOF'));
  }

  const value = parseExpr();
  if (pos < tokens.length) throw new Error('多余内容: ' + tokens[pos].value);
  if (!Number.isFinite(value)) throw new Error('计算结果非有限值');
  return value;
}

function tokenize(input) {
  const chars = input.replace(/\s+/g, '');
  const tokens = [];
  let i = 0;
  const numRe = /^\d+(\.\d+)?/;
  while (i < chars.length) {
    const c = chars[i];
    if (/[0-9.]/.test(c)) {
      const m = chars.slice(i).match(numRe);
      tokens.push({ type: 'num', value: parseFloat(m[0]) });
      i += m[0].length;
    } else if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < chars.length && /[a-zA-Z]/.test(chars[j])) j++;
      const name = chars.slice(i, j);
      if (MATH_FUNCS[name]) tokens.push({ type: 'func', value: name });
      else throw new Error('未知标识符: ' + name);
      i = j;
    } else if ('+-*/%^(),'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
    } else {
      throw new Error('非法字符: ' + c);
    }
  }
  return tokens;
}

function systemInfo(opts = {}) {
  const gb = (n) => (n / 1024 ** 3).toFixed(1) + ' GB';
  const cpus = os.cpus();
  const lines = [
    `操作系统: ${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
    `主机名:   ${os.hostname()}`,
    `用户:     ${os.userInfo().username}`,
    `CPU:      ${cpus.length ? cpus[0].model.trim() : '未知'} × ${cpus.length}`,
    `内存:     ${gb(os.totalmem() - os.freemem())} / ${gb(os.totalmem())} 已用`,
    `运行时长: ${(os.uptime() / 3600).toFixed(1)} 小时`,
    `Node:     ${process.version}`,
    `工作区:   ${opts.workspace ? resolve(opts.workspace) : process.cwd()}`,
    `沙箱:     ${opts.allowOutsideWorkspace ? '已放开（可访问全盘）' : '仅限工作区内'}`
  ];
  return { ok: true, content: lines.join('\n') };
}

// Turn an HTML document into something a model can actually read.
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function webFetch(url, maxChars = MAX_OUTPUT, opts = {}) {
  const safe = sanitizeUrl(url);
  if (!/^https?:\/\//.test(safe)) return { ok: false, error: '仅支持 http(s) 链接' };
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!fetchImpl) return { ok: false, error: '运行环境不支持 fetch' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetchImpl(safe, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Agenite/0.2 (+local agent)' }
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText || ''}`.trim() };
    const raw = await res.text();
    const looksHtml = /^\s*<(!doctype|html)/i.test(raw) || /<\/(html|body|div|p)>/i.test(raw);
    let text = looksHtml ? htmlToText(raw) : raw.replace(/\r\n/g, '\n');
    if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(已截断)';
    return { ok: true, content: `Fetched ${safe} (${text.length} chars):\n\n${text}` };
  } catch (e) {
    return { ok: false, error: '抓取失败: ' + (e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

async function readLocalFile(path, maxChars = 20000, opts = {}) {
  const abs = resolveSafePath(path, opts);
  let buf = await readFile(abs, 'utf8');
  const total = buf.length;
  if (total > maxChars) buf = buf.slice(0, maxChars) + `\n…(共 ${total} 字符，已截断)`;
  return { ok: true, content: buf };
}

async function listLocalDir(path, opts = {}) {
  const abs = resolveSafePath(path, opts);
  const entries = await readdir(abs, { withFileTypes: true });
  const rows = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      rows.push(`d  ${e.name}/`);
    } else {
      let size = '';
      try {
        const st = await stat(join(abs, e.name));
        size = st.size < 1024 ? `${st.size} B` : `${(st.size / 1024).toFixed(1)} KB`;
      } catch { /* ignore */ }
      rows.push(`-  ${e.name}${size ? '  (' + size + ')' : ''}`);
    }
  }
  rows.sort();
  return { ok: true, content: `${displayPath(abs, opts)}:\n` + (rows.join('\n') || '(空目录)') };
}

// Very small glob: * matches any run of chars, ? matches one, no path semantics.
export function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', '.cache', '.next', 'coverage']);

async function findFiles(args, opts = {}) {
  const limit = Math.min(Number(args.limit) || 100, 500);
  const rootAbs = resolveSafePath(args.path || '.', opts);
  const re = globToRegExp(args.pattern || '*');
  const found = [];
  async function walk(dir, depth) {
    if (found.length >= limit || depth > 8) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= limit) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (re.test(e.name) || re.test(relative(rootAbs, full).split(sep).join('/'))) {
        found.push(relative(rootAbs, full).split(sep).join('/'));
      }
    }
  }
  await walk(rootAbs, 0);
  if (!found.length) return { ok: true, content: `没有匹配 "${args.pattern}" 的文件。` };
  return { ok: true, content: `匹配 ${found.length} 个文件：\n` + found.join('\n') };
}

async function writeLocalFile(path, content, opts = {}) {
  const abs = resolveSafePath(path, opts);
  const text = String(content == null ? '' : content);
  await mkdir(resolve(abs, '..'), { recursive: true });
  await writeFile(abs, text, 'utf8');
  return { ok: true, content: `已写入 ${displayPath(abs, opts)}（${text.length} 字符）` };
}

async function editLocalFile(args, opts = {}) {
  const abs = resolveSafePath(args.path, opts);
  const oldText = String(args.old_text == null ? '' : args.old_text);
  if (!oldText) return { ok: false, error: 'old_text 不能为空' };
  const src = await readFile(abs, 'utf8');
  const first = src.indexOf(oldText);
  if (first === -1) return { ok: false, error: `在 ${displayPath(abs, opts)} 中找不到要替换的文本` };
  if (src.indexOf(oldText, first + oldText.length) !== -1) {
    return { ok: false, error: '要替换的文本出现多次，请提供更长的唯一片段' };
  }
  const newText = String(args.new_text == null ? '' : args.new_text);
  await writeFile(abs, src.slice(0, first) + newText + src.slice(first + oldText.length), 'utf8');
  return { ok: true, content: `已修改 ${displayPath(abs, opts)}（${oldText.length} → ${newText.length} 字符）` };
}

async function makeLocalDir(path, opts = {}) {
  const abs = resolveSafePath(path, opts);
  await mkdir(abs, { recursive: true });
  return { ok: true, content: `已创建目录 ${displayPath(abs, opts)}` };
}

async function runCmd(args, opts = {}) {
  const command = String(args.command || '').trim();
  if (!command) return { ok: false, error: '命令为空' };
  const cwd = resolveSafePath(args.cwd || '.', opts);
  const base = { cwd, timeout: CMD_TIMEOUT, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  try {
    if (Array.isArray(args.args) && args.args.length) {
      ({ stdout, stderr } = await execFileAsync(command, args.args.map(String), base));
    } else {
      ({ stdout, stderr } = await execAsync(command, base));
    }
  } catch (e) {
    // A non-zero exit is information, not a crash — hand the output back.
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
    return {
      ok: false,
      error: `命令退出码 ${e.code == null ? '?' : e.code}${out ? '\n' + out.slice(0, MAX_OUTPUT) : ''}`
    };
  }
  const out = [stdout, stderr].filter(Boolean).join('\n').trim();
  const ms = Date.now() - started;
  return { ok: true, content: (out || '(无输出)').slice(0, MAX_OUTPUT) + `\n\n[耗时 ${ms}ms · cwd ${displayPath(cwd, opts)}]` };
}

async function openPath(target, opts = {}) {
  const raw = String(target || '').trim();
  if (!raw) return { ok: false, error: '目标为空' };
  let what = raw;
  if (/^https?:\/\//i.test(raw)) {
    what = sanitizeUrl(raw);
    if (!/^https?:\/\//.test(what)) return { ok: false, error: '非法链接' };
  } else {
    what = resolveSafePath(raw, opts);
  }
  const platform = opts.platform || process.platform;
  try {
    if (platform === 'win32') await execFileAsync('cmd', ['/c', 'start', '', what], { windowsHide: true });
    else if (platform === 'darwin') await execFileAsync('open', [what]);
    else await execFileAsync('xdg-open', [what]);
  } catch (e) {
    return { ok: false, error: '打开失败: ' + (e && e.message ? e.message : e) };
  }
  return { ok: true, content: `已用系统默认程序打开 ${what}` };
}
