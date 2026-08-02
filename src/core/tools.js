// Tool definitions + execution. Pure-ish: uses Node builtins (fs, child_process,
// fetch) but everything is injectable so it stays testable under node:test.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizeUrl } from './util.js';

const execFileAsync = promisify(execFile);

// Canonical tool catalog. `danger` tools require explicit opt-in.
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
    name: 'web_fetch',
    description: 'Fetch a public URL and return its text content (truncated). Use to read web pages or APIs.',
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
    description: 'Read a UTF-8 text file from the local filesystem. Provide an absolute or relative path.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file.' } },
      required: ['path']
    },
    danger: false
  },
  {
    name: 'list_dir',
    description: 'List entries of a directory on the local filesystem.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path (default ".").' } },
      required: []
    },
    danger: false
  },
  {
    name: 'write_file',
    description: 'Write text content to a local file. SECURITY: overwrites existing files. Requires danger mode.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write.' },
        content: { type: 'string', description: 'Content to write.' }
      },
      required: ['path', 'content']
    },
    danger: true
  },
  {
    name: 'run_command',
    description: 'Run a shell command locally and return stdout/stderr. SECURITY: arbitrary execution. Requires danger mode.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute (no shell pipe chains; pass args separately).' },
        args: { type: 'array', items: { type: 'string' }, description: 'Optional argument list.' },
        cwd: { type: 'string', description: 'Optional working directory.' }
      },
      required: ['command']
    },
    danger: true
  }
];

// Only return tools the current config allows.
export function activeTools(config) {
  const allowDanger = !!(config && config.dangerTools);
  return TOOL_DEFS.filter((t) => !t.danger || allowDanger);
}

export async function executeTool(name, args = {}, opts = {}) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) return { ok: false, error: `未知工具: ${name}` };
  if (def.danger && !opts.dangerTools) {
    return { ok: false, error: `工具 ${name} 需要开启「高级工具」(danger mode)。` };
  }
  try {
    switch (name) {
      case 'calculator':
        return evalMath(args.expression);
      case 'current_datetime':
        return { ok: true, content: `UTC: ${new Date().toISOString()}\nLocal: ${new Date().toString()}` };
      case 'web_fetch':
        return webFetch(args.url, args.max_chars, opts);
      case 'read_file':
        return readLocalFile(args.path);
      case 'list_dir':
        return listLocalDir(args.path || '.');
      case 'write_file':
        return writeLocalFile(args.path, args.content);
      case 'run_command':
        return runCmd(args, opts);
      default:
        return { ok: false, error: `未实现的工具: ${name}` };
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
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
    } else     if ('+-*/%^(),'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
    } else {
      throw new Error('非法字符: ' + c);
    }
  }
  return tokens;
}

async function webFetch(url, maxChars = 8000, opts = {}) {
  const safe = sanitizeUrl(url);
  if (!/^https?:\/\//.test(safe)) return { ok: false, error: '仅支持 http(s) 链接' };
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!fetchImpl) return { ok: false, error: '运行环境不支持 fetch' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetchImpl(safe, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    let text = await res.text();
    text = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n');
    if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(已截断)';
    return { ok: true, content: `Fetched ${safe} (${text.length} chars):\n\n${text}` };
  } catch (e) {
    return { ok: false, error: '抓取失败: ' + (e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

async function readLocalFile(path) {
  const buf = await readFile(path, 'utf8');
  return { ok: true, content: buf };
}

async function listLocalDir(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const list = entries
    .map((e) => `${e.isDirectory() ? 'd' : '-'}  ${e.name}${e.isDirectory() ? '/' : ''}`)
    .join('\n');
  return { ok: true, content: list || '(空目录)' };
}

async function writeLocalFile(path, content) {
  await writeFile(path, String(content), 'utf8');
  return { ok: true, content: `已写入 ${path} (${String(content).length} 字节)` };
}

async function runCmd(args, opts = {}) {
  const cmd = args.command;
  const cmdArgs = Array.isArray(args.args) ? args.args : [];
  const cwd = args.cwd || opts.cwd;
  const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
    cwd,
    timeout: 20000,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  const out = [stdout, stderr].filter(Boolean).join('\n').slice(0, 8000);
  return { ok: true, content: out || '(无输出)' };
}
