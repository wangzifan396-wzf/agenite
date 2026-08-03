// Tool definitions + execution — this is where Agenite actually touches the
// machine. Everything dangerous goes through two gates:
//   1. workspace sandbox  (paths are pinned under a root directory)
//   2. approval hook      (a human clicks allow/deny before it runs)
// All side effects are injectable so the whole file stays testable under node:test.
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, sep, join, relative, extname } from 'node:path';
import os from 'node:os';
import { sanitizeUrl } from './util.js';
import { recall as memRecall, saveMemory, logDaily, saveSkill, readSkill } from './memory.js';

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
    name: 'web_search',
    description: 'Search the public web (DuckDuckGo, no API key needed) and return the top result titles, URLs and snippets. Use this to look up current information, facts, docs or recent news before answering.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query, e.g. "node child_process spawn options".' },
        limit: { type: 'number', description: 'Max results to return (default 6).' }
      },
      required: ['query']
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
  },
  {
    name: 'grep_files',
    description: 'Search file CONTENTS in the workspace for a regular expression (case-insensitive by default). Returns matching "file:line: text" hits. Use to locate code or text across the project.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for, e.g. "function handleChat" or "TODO".' },
        path: { type: 'string', description: 'Directory to search in (default ".").' },
        flags: { type: 'string', description: 'Optional regex flags, e.g. "g" or "" for case-sensitive.' },
        limit: { type: 'number', description: 'Max hits (default 50).' }
      },
      required: ['pattern']
    },
    danger: false
  },
  {
    name: 'codebase_search',
    description: 'Semantic + keyword search over the WHOLE workspace (your project files), completely local — no code leaves the machine. Use it whenever the question is about THIS codebase/repo: "where is X implemented", "find code that does Y", "what does this module do". Returns the most relevant file paths with ranked snippets. Falls back to keyword ranking when no local embedding model (Ollama) is available.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, in natural language or keywords.' },
        top_k: { type: 'number', description: 'How many results to return (default 6, max 12).' },
        path: { type: 'string', description: 'Sub-directory to limit the search to (default: whole workspace).' }
      },
      required: ['query']
    },
    danger: false
  },
  {
    name: 'apply_patch',
    description: 'Apply a unified diff (patch) to one or more workspace files in a single call. Each file block uses "--- a/path" and "+++ b/path" followed by "@@ -s,c +s,c @@" hunks. Safer than many write_file calls for multi-file edits. Requires user approval.',
    parameters: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'The full unified diff text covering one or more files.' }
      },
      required: ['patch']
    },
    danger: true
  },
  {
    name: 'memory_recall',
    description: "Search the agent's long-term memory (file-based, persists across sessions) for facts about the user, projects, preferences or past decisions. Query with keywords.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search, e.g. "preferred language" or "project decision".' },
        limit: { type: 'number', description: 'Max hits (default 12).' }
      },
      required: ['query']
    },
    danger: false
  },
  {
    name: 'memory_save',
    description: 'Save a durable fact to long-term memory so it survives future sessions. Use it to remember user preferences, project context, or decisions. Category groups related facts (e.g. "Preferences", "Projects", "Decisions").',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Section name, e.g. "Preferences".' },
        key: { type: 'string', description: 'Short identifier for the fact.' },
        value: { type: 'string', description: 'The fact to remember.' }
      },
      required: ['category', 'key', 'value']
    },
    danger: false
  },
  {
    name: 'memory_log',
    description: "Append a dated note to today's memory log. Use it to record progress, what was tried, or open questions for next time.",
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Short heading, e.g. "Progress" or "Blockers".' },
        content: { type: 'string', description: 'The note to record.' }
      },
      required: ['section', 'content']
    },
    danger: false
  },
  {
    name: 'plan',
    description: 'Record a structured, inspectable plan as a numbered list of steps. Call this (especially in plan mode) before doing the work so the human can review the approach. Steps are surfaced in the UI as a checklist.',
    parameters: {
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'string' }, description: 'Ordered plan steps, e.g. ["Read config.js", "Add the endpoint", "Test it"].' },
        text: { type: 'string', description: 'Optional free-form plan text if you prefer not to use steps.' }
      },
      required: []
    },
    danger: false
  },
  {
    name: 'delegate',
    description: "Spawn an isolated sub-agent to handle a focused side task in its own fresh context window, then return only its final summary. Use it to keep the main conversation clean or to parallelize independent work (e.g. \"research X\", \"investigate the failing tests\"). Pass persona to specialize it, tool_scope to limit which tools it may use, max_turns to cap its steps.",
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'A self-contained description of the sub-agent\'s task. Include all context it needs — it does not see this conversation.' },
        persona: { type: 'string', description: 'Optional specialty, e.g. "researcher", "code reviewer", "debugger".' },
        tool_scope: { type: 'array', items: { type: 'string' }, description: 'Optional list of tool names the sub-agent is allowed to use (least privilege).' },
        max_turns: { type: 'number', description: 'Optional step cap for the sub-agent (default 10).' }
      },
      required: ['goal']
    },
    danger: false
  },
  {
    name: 'fanout',
    description: "并行派出多个隔离子代理，同时处理一批相互独立、彼此无依赖的子任务，最后一次性聚合所有子代理的摘要返回。当一条请求能拆成多个角度（如分别调研 A/B/C、分别处理多个文件批次、并行排查若干独立问题）时，用 fanout 比反复串行调用 delegate 快得多。每个子任务的参数与 delegate 完全相同（goal / persona / tool_scope / max_turns）。最多 8 个。注意：子任务之间不能有依赖（某个子任务需要另一个的输出），有依赖时请改用串行 delegate。",
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              goal: { type: 'string', description: '该子任务的完整、自包含描述（子代理看不到主对话，必须包含全部上下文）。' },
              persona: { type: 'string', description: '可选，专业方向，如 "researcher"、"code reviewer"、"debugger"。' },
              tool_scope: { type: 'array', items: { type: 'string' }, description: '可选，限定该子代理可用工具（最小权限）。' },
              max_turns: { type: 'number', description: '可选，该子代理步数上限（默认 10）。' }
            },
            required: ['goal']
          },
          description: '要并行执行的子任务列表，每个元素是一个独立的子代理目标。'
        }
      },
      required: ['tasks']
    },
    danger: false
  },
  {
    name: 'save_skill',
    description: 'Crystallize a successful workflow into a reusable local skill file (SKILL.md) so future sessions can reuse it — the agent "gets smarter" over time. Call this after you have nailed a non-trivial, repeatable procedure. The skill catalog is auto-injected into future system prompts; the body is fetched on demand via skill_recall.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short skill name, e.g. "deploy-to-staging".' },
        description: { type: 'string', description: 'One-line summary of what the skill does.' },
        when_to_use: { type: 'string', description: 'When to apply this skill, e.g. "after tests pass and before merge".' },
        body: { type: 'string', description: 'The full playbook: steps, commands, gotchas. Plain markdown.' }
      },
      required: ['name', 'description', 'body']
    },
    danger: false
  },
  {
    name: 'skill_recall',
    description: 'Read the full body of a previously saved skill by name or slug, so you can follow its playbook. Use it when a skill from the catalog matches the current task.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name or slug, e.g. "deploy-to-staging".' }
      },
      required: ['name']
    },
    danger: false
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
  // The user pressed "始终允许" for this tool at some point.
  if (Array.isArray(opts.toolAllowlist) && opts.toolAllowlist.includes(def.name)) return null;
  // 'ask' — needs a human. Without a hook (CLI/tests) we fall through rather
  // than deadlock, since dangerTools already had to be explicitly enabled.
  if (typeof opts.requestApproval !== 'function') return null;
  const verdict = await opts.requestApproval({
    name: def.name, args, description: def.description, readOnly: false
  });
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
      case 'grep_files':
        return grepFiles(args, opts);
      case 'codebase_search':
        return codebaseSearch(args, opts);
      case 'apply_patch':
        return applyPatchTool(args, opts);
      case 'web_search':
        return webSearch(args, opts);
      case 'memory_recall':
        return memoryRecall(args, opts);
      case 'memory_save':
        return memorySave(args, opts);
      case 'memory_log':
        return memoryLog(args, opts);
      case 'plan':
        return planTool(args, opts);
      case 'delegate':
        if (typeof opts.runSubAgent !== 'function') {
          return { ok: false, error: '子代理执行器未配置（需要服务端 runSubAgent）。' };
        }
        return opts.runSubAgent(args, opts);
      case 'fanout':
        if (typeof opts.runFanout !== 'function') {
          return { ok: false, error: '并行委派执行器未配置（需要服务端 runFanout）。' };
        }
        return opts.runFanout(args, opts);
      case 'save_skill':
        return skillSave(args, opts);
      case 'skill_recall':
        return skillRecall(args, opts);
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
  // Optional 1-based line range: offset/limit slice by lines (handy for big files)
  const off = Number(opts?.args?.offset);
  const lim = Number(opts?.args?.limit);
  const lineBased = Number.isFinite(off) && off > 0;
  if (lineBased) {
    const lines = buf.split('\n');
    const start = off - 1;
    const end = Number.isFinite(lim) && lim > 0 ? start + lim : lines.length;
    const slice = lines.slice(start, end).join('\n');
    const note = `\n\n[行 ${off}${Number.isFinite(lim) && lim > 0 ? '-' + end : ''} / 共 ${lines.length} 行]`;
    return { ok: true, content: slice + note };
  }
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
  const snap = snapshotBefore(abs, opts);
  await writeFile(abs, text, 'utf8');
  const diff = snap.before == null ? null : unifiedDiff(snap.before, text);
  return {
    ok: true,
    content: `已写入 ${displayPath(abs, opts)}（${text.length} 字符）`,
    diff,
    undoToken: snap.token
  };
}

// ---- undo support ----
// An injected key/value store (set by the server) holds { path, before } so a
// write/edit can later be reverted with a single token. Keeps tools.js pure
// (no module-global surprises) while still enabling the UI to offer "undo".
let _undoStore = null;
export function setUndoStore(store) { _undoStore = store; }

function snapshotBefore(abs, opts) {
  try {
    const before = readFileSync(abs, 'utf8');
    const token = 'undo_' + Math.random().toString(36).slice(2, 10);
    if (_undoStore) _undoStore.set(token, { path: abs, before });
    else if (opts && opts.undoStore) opts.undoStore.set(token, { path: abs, before });
    return { before, token };
  } catch {
    return { before: null, token: null };
  }
}

// Revert a previous write/edit identified by its undo token.
export function applyUndo(token, store) {
  const s = (store || _undoStore) && (store || _undoStore).get(token);
  if (!s) return { ok: false, error: '撤销令牌已失效（服务可能已重启）。' };
  try {
    writeFileSync(s.path, s.before, 'utf8');
    (store || _undoStore).delete(token);
    return { ok: true, content: `已撤销对 ${s.path} 的修改` };
  } catch (e) {
    return { ok: false, error: '撤销失败: ' + (e && e.message ? e.message : e) };
  }
}

// Minimal line-based unified diff (LCS). Good enough for previewing edits.
export function unifiedDiff(before, after) {
  const a = String(before == null ? '' : before).split('\n');
  const b = String(after == null ? '' : after).split('\n');
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(' ' + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('-' + a[i]); i++; }
    else { out.push('+' + b[j]); j++; }
  }
  while (i < n) out.push('-' + a[i++]);
  while (j < m) out.push('+' + b[j++]);
  return out.join('\n');
}

// Apply a unified diff to file `content`. Parses `@@` hunks from `patch`
// (which may cover multiple files) and matches each hunk by its context lines.
export function applyUnifiedPatch(content, patch) {
  const fileLines = String(content == null ? '' : content).split('\n');
  const patchLines = String(patch == null ? '' : patch).split('\n');
  const hunks = [];
  let pendingTarget = null;
  let i = 0;
  while (i < patchLines.length) {
    const ln = patchLines[i];
    const fileHead = /^(\+\+\+)\s+(.+)$/.exec(ln);
    if (fileHead) { pendingTarget = fileHead[2].trim().replace(/^b\//, ''); i++; continue; }
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(ln);
    if (hm) {
      const start = parseInt(hm[1], 10);
      const search = [], replace = [];
      i++;
      while (i < patchLines.length && !patchLines[i].startsWith('@@')) {
        const raw = patchLines[i];
        const prefix = raw[0];
        if (prefix === '+') replace.push(raw.slice(1));
        else if (prefix === '-') search.push(raw.slice(1));
        else if (prefix === ' ') { search.push(raw.slice(1)); replace.push(raw.slice(1)); }
        else break;
        i++;
      }
      hunks.push({ target: pendingTarget, start, search, replace });
      continue;
    }
    i++;
  }
  for (const h of hunks) {
    const from = Math.max(0, h.start - 1 - 2);
    const to = Math.min(fileLines.length - h.search.length, h.start - 1 + 2);
    let found = -1;
    for (let k = from; k <= to; k++) {
      let okFull = true;
      for (let s = 0; s < h.search.length; s++) if (fileLines[k + s] !== h.search[s]) { okFull = false; break; }
      if (okFull) { found = k; break; }
    }
    if (found === -1) {
      for (let k = 0; k <= fileLines.length - h.search.length; k++) {
        let okFull = true;
        for (let s = 0; s < h.search.length; s++) if (fileLines[k + s] !== h.search[s]) { okFull = false; break; }
        if (okFull) { found = k; break; }
      }
    }
    if (found === -1) {
      throw new Error('无法匹配补丁片段：\n' + h.search.slice(0, 4).join('\n'));
    }
    fileLines.splice(found, h.search.length, ...h.replace);
  }
  return fileLines.join('\n');
}

// Recursively search file *contents* in the workspace (ripgrep-lite).
export async function grepFiles(args, opts = {}) {
  const pattern = String(args.pattern || '');
  if (!pattern) return { ok: false, error: 'pattern 不能为空' };
  let re;
  try {
    re = new RegExp(pattern, args.flags || 'i');
  } catch (e) {
    return { ok: false, error: '正则无效: ' + e.message };
  }
  const rootAbs = resolveSafePath(args.path || '.', opts);
  const limit = Math.min(Number(args.limit) || 50, 200);
  const hits = [];
  async function walk(dir, depth) {
    if (hits.length >= limit || depth > 8) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= limit) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (e.isFile() && /\.(txt|md|js|ts|jsx|tsx|mjs|cjs|json|html|css|csv|py|rb|go|rs|java|sh|yml|yaml|toml|xml|sql|log)$/i.test(e.name)) {
        let text;
        try { text = await readFile(full, 'utf8'); } catch { continue; }
        const rel = relative(rootAbs, full).split(sep).join('/');
        const linesArr = text.split('\n');
        for (let li = 0; li < linesArr.length; li++) {
          if (re.test(linesArr[li])) {
            hits.push(`${rel}:${li + 1}: ${linesArr[li].slice(0, 200)}`);
            if (hits.length >= limit) return;
          }
        }
      }
    }
  }
  await walk(rootAbs, 0);
  if (!hits.length) return { ok: true, content: `在 ${args.path || '.'} 中没有匹配 "${pattern}" 的内容。` };
  return { ok: true, content: `匹配 ${hits.length} 处（正则 /${pattern}/${args.flags || 'i'}）：\n` + hits.join('\n') };
}

// Apply an uploaded unified diff to one or more workspace files.
export async function applyPatchTool(args, opts = {}) {
  const patch = String(args.patch || '');
  if (!patch.trim()) return { ok: false, error: 'patch 不能为空' };
  // Split into per-file sections.
  const fileBlocks = [];
  const reFile = /^(\+\+\+)\s+(.+)$/gm;
  let lastIdx = 0;
  const matches = [...patch.matchAll(reFile)];
  if (!matches.length) return { ok: false, error: '未在补丁中找到任何 +++ 文件标记。' };
  for (let k = 0; k < matches.length; k++) {
    const start = matches[k].index;
    const end = k + 1 < matches.length ? matches[k + 1].index : patch.length;
    fileBlocks.push(patch.slice(lastIdx, end));
    lastIdx = end;
  }
  const results = [];
  for (const block of fileBlocks) {
    const head = /^(\+\+\+)\s+(.+)$/m.exec(block);
    if (!head) continue;
    let target = head[2].trim().replace(/^b\//, '');
    const abs = resolveSafePath(target, opts);
    let before;
    try { before = await readFile(abs, 'utf8'); } catch { return { ok: false, error: `目标文件不存在: ${target}` }; }
    const snap = snapshotBefore(abs, opts);
    const after = applyUnifiedPatch(before, block);
    await mkdir(resolve(abs, '..'), { recursive: true });
    await writeFile(abs, after, 'utf8');
    results.push(`✅ ${target}\n${unifiedDiff(before, after)}`);
  }
  if (!results.length) return { ok: false, error: '没有可应用的文件块。' };
  return { ok: true, content: `已应用补丁：\n\n` + results.join('\n\n'), diff: results.join('\n'), undoToken: null };
}

// ---- web search (DuckDuckGo HTML, no API key) ----

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/');
}

function stripHtml(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// DDG result links go through a redirect (?uddg=<target>); pull the real URL.
function extractUrl(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
  } catch { /* not a redirect */ }
  return href;
}

function parseDdg(html) {
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 12) {
    const url = extractUrl(m[1]);
    const title = stripHtml(m[2]);
    const snippet = stripHtml(m[3]);
    if (title) out.push({ title, url, snippet });
  }
  return out;
}

async function webSearch(args, opts = {}) {
  const q = String(args.query || '').trim();
  if (!q) return { ok: false, error: 'query 不能为空' };
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!fetchImpl) return { ok: false, error: '运行环境不支持 fetch' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml'
      }
    });
    if (!res.ok) return { ok: false, error: `搜索请求失败 HTTP ${res.status}` };
    const html = await res.text();
    const results = parseDdg(html).slice(0, Math.min(Number(args.limit) || 6, 12));
    if (!results.length) {
      return { ok: true, content: `没有找到与「${q}」相关的结果（搜索引擎可能临时拦截了请求，可改用 web_fetch 直接抓取已知页面）。` };
    }
    const body = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
    return { ok: true, content: `关于「${q}」的搜索结果：\n\n${body}` };
  } catch (e) {
    return { ok: false, error: '搜索失败: ' + (e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---- long-term memory tools (writes are confined to the agent's memory dir) ----

async function memoryRecall(args, opts = {}) {
  if (!opts.memoryBase) return { ok: false, error: '记忆目录未配置' };
  return memRecall(opts.memoryBase, args.query, {
    limit: Number(args.limit) || 12,
    embed: typeof opts.embed === 'function' ? opts.embed : null
  });
}

async function memorySave(args, opts = {}) {
  if (!opts.memoryBase) return { ok: false, error: '记忆目录未配置' };
  return saveMemory(opts.memoryBase, args.category || 'General', args.key, args.value);
}

async function memoryLog(args, opts = {}) {
  if (!opts.memoryBase) return { ok: false, error: '记忆目录未配置' };
  return logDaily(opts.memoryBase, args.section || 'Notes', args.content);
}

async function planTool(args, opts = {}) {
  const steps = Array.isArray(args.steps) ? args.steps.map(String).filter(Boolean) : [];
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!steps.length && !text) return { ok: false, error: '请提供 steps 或 text' };
  const lines = steps.length ? steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : text;
  return { ok: true, content: `已记录计划：\n${lines}` };
}

// ---- self-evolving skills (file-based, under the agent's memory dir) ----

async function skillSave(args, opts = {}) {
  if (!opts.memoryBase) return { ok: false, error: '记忆目录未配置' };
  return saveSkill(opts.memoryBase, {
    name: args.name,
    description: args.description,
    whenToUse: args.when_to_use,
    body: args.body
  });
}

async function skillRecall(args, opts = {}) {
  if (!opts.memoryBase) return { ok: false, error: '记忆目录未配置' };
  return readSkill(opts.memoryBase, args.name);
}

// Flat index of the workspace, used by the UI's "@" file picker.
// Read-only, never leaves the sandbox, and hard-capped so huge repos stay snappy.
export async function scanWorkspaceFiles({ root, limit = 2000, maxDepth = 8 } = {}) {
  const rootAbs = resolve(root || '.');
  const out = [];
  async function walk(dir, depth) {
    if (out.length >= limit || depth > maxDepth) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        let size = 0;
        try { size = (await stat(full)).size; } catch { /* unreadable, still list it */ }
        out.push({ path: relative(rootAbs, full).split(sep).join('/'), size });
      }
    }
  }
  await walk(rootAbs, 0);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// ---- codebase semantic/keyword search (fully local, no code leaves machine) ----

// Split text into matchable tokens: latin/number words, plus each CJK char on
// its own (so "处理函数" matches "处理" / "函数" individually).
export function csTokenize(text) {
  const s = String(text || '');
  const out = [];
  const re = /[a-z0-9_À-ɏ]+|[一-鿿]/gi;
  let m;
  while ((m = re.exec(s))) out.push(m[0].toLowerCase());
  return out;
}

// Break text into overlapping chunks so a match near a boundary is still found.
export function chunkText(text, size = 900, overlap = 150) {
  const t = String(text || '');
  if (t.length <= size) return t ? [t] : [];
  const step = Math.max(1, size - overlap);
  const out = [];
  for (let i = 0; i < t.length; i += step) {
    out.push(t.slice(i, i + size));
    if (i + size >= t.length) break;
  }
  return out;
}

// Lexical relevance of a query to a chunk: total token occurrences, lightly
// normalized by chunk length so short dense hits still beat long sparse ones.
export function lexicalScore(query, chunk) {
  const qt = csTokenize(query);
  if (!qt.length) return 0;
  const low = String(chunk || '').toLowerCase();
  let score = 0;
  for (const tok of qt) {
    let idx = 0;
    let c = 0;
    while ((idx = low.indexOf(tok, idx)) !== -1) { c++; idx += tok.length; }
    score += c;
  }
  return score / Math.sqrt(low.length / 100 + 1);
}

const CODE_EXT = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.php', '.swift',
  '.kt', '.scala', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.html', '.htm',
  '.css', '.scss', '.less', '.json', '.yaml', '.yml', '.toml', '.md',
  '.txt', '.vue', '.svelte', '.xml', '.ini', '.cfg', '.env', '.graphql',
  '.r', '.m', '.pl', '.lua', '.dart', '.ex', '.exs', '.erl', '.hs'
]);

function cosineVec(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function codebaseSearch(args, opts = {}) {
  const query = String(args.query || '').trim();
  if (!query) return { ok: false, error: '请提供查询内容 query' };
  const topK = Math.min(Math.max(Number(args.top_k) || 6, 1), 12);
  const root = resolveSafePath(args.path || '.', opts);
  const embed = typeof opts.embed === 'function' ? opts.embed : null;

  const MAX_FILES = 600;
  const MAX_CHARS = 3_000_000; // ~3MB of source indexed per query
  const files = [];
  let totalChars = 0;
  let truncated = false;

  async function walk(dir, depth) {
    if (files.length >= MAX_FILES || depth > 8) { truncated = true; return; }
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= MAX_FILES) { truncated = true; return; }
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        if (!CODE_EXT.has(extname(e.name).toLowerCase())) continue;
        let size = 0;
        try { size = (await stat(full)).size; } catch { continue; }
        if (size > 400_000) continue; // skip huge generated files
        if (totalChars + size > MAX_CHARS) { truncated = true; continue; }
        totalChars += size;
        files.push({ full, rel: relative(root, full).split(sep).join('/') });
      }
    }
  }
  await walk(root, 0);

  if (!files.length) {
    return { ok: true, content: `工作区（${displayPath(root, opts)}）内没有可检索的源代码文件。` };
  }

  // Index chunks and rank lexically first (cheap, always available).
  const candidates = [];
  for (const f of files) {
    let text;
    try { text = await readFile(f.full, 'utf8'); } catch { continue; }
    const nameBoost = lexicalScore(query, f.rel.split('/').pop() || '') * 0.5;
    for (const ch of chunkText(text)) {
      const s = lexicalScore(query, ch);
      if (s > 0) candidates.push({ rel: f.rel, text: ch, score: s + nameBoost });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  let ranked = candidates.slice(0, topK);
  // Optional semantic rerank: embed the query + the lexical top-N, rerank by
  // cosine similarity. Only runs when a local embed fn (Ollama) is wired in.
  if (embed && candidates.length) {
    try {
      const pool = candidates.slice(0, Math.min(60, candidates.length));
      const qv = await embed(query);
      if (qv && qv.length) {
        const scored = [];
        for (const c of pool) {
          const cv = await embed(c.text);
          if (!cv || !cv.length) continue;
          scored.push({ ...c, score: cosineVec(qv, cv) });
        }
        scored.sort((a, b) => b.score - a.score);
        if (scored.length) ranked = scored.slice(0, topK);
      }
    } catch {
      // Embedding failed — keep lexical ranking.
    }
  }

  if (!ranked.length) {
    return { ok: true, content: `没有找到与「${query}」相关的代码（已扫描 ${files.length} 个文件）。` };
  }
  const sem = !!embed;
  const body = ranked
    .map((c, i) => {
      const snip = c.text.replace(/\s+/g, ' ').trim().slice(0, 320);
      const pct = sem ? Math.round(c.score * 100) + '%' : c.score.toFixed(1);
      return `${i + 1}. ${c.rel}  (相关度 ${pct})\n   ${snip}`;
    })
    .join('\n\n');
  const note = truncated
    ? `\n\n（注：仓库较大，已截取前 ${files.length} 个文件 / ${Math.round(totalChars / 1024)}KB 建立索引）`
    : '';
  return {
    ok: true,
    content: `在工作区检索「${query}」，命中 ${ranked.length} 处（共扫描 ${files.length} 个文件）：\n\n${body}${note}`,
    semantic: sem
  };
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
  const after = src.slice(0, first) + newText + src.slice(first + oldText.length);
  const snap = snapshotBefore(abs, opts);
  await writeFile(abs, after, 'utf8');
  const diff = snap.before == null ? null : unifiedDiff(snap.before, after);
  return {
    ok: true,
    content: `已修改 ${displayPath(abs, opts)}（${oldText.length} → ${newText.length} 字符）`,
    diff,
    undoToken: snap.token
  };
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
