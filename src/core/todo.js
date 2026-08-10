// Live task checklist — the anti-drift mechanism.
//
// A long task without a written checklist drifts: by turn 15 the model has
// quietly forgotten what turn 1 was for. Keeping a structured, always-resent
// list in front of the model is the single cheapest fix — and unlike a one-shot
// plan, it is *stateful*, so the agent loop can nag when it goes stale.
//
// Design notes that matter:
//  - The model resends the FULL list every time. Patches invite drift and
//    partial updates; a whole-list replace is atomic and self-describing.
//  - Exactly one in_progress. Two "current" tasks means neither is current.
//  - Violations come back as SCHEMA_ERROR tool results, not silent fixes, so
//    the model reads the rule and corrects itself on the next call.
//
// Pure module: no I/O, no node builtins. Imported by both tools.js (the
// todo_write tool) and agent.js (the per-turn reminder), so neither pulls the
// other in.

export const TODO_STATUSES = ['pending', 'in_progress', 'completed'];
export const MAX_TODOS = 20;

/** Steps that count as "you actually checked your work". */
export const VERIFY_RE =
  /(test|verif|validat|check|review|lint|build|typecheck|测试|验证|校验|检查|复核|自测|跑一遍|回归|构建)/i;

/**
 * Validate + normalize a model-supplied todo list.
 * @returns {{ok:true, items:Array}|{ok:false, error:string}}
 */
export function normalizeTodos(input) {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'todos 参数非法：必须是一个任务数组，且每次都要传完整清单（不是增量补丁）。' };
  }
  if (input.length === 0) {
    return { ok: false, error: 'todos 参数非法：清单不能为空，至少要有 1 项任务。' };
  }
  if (input.length > MAX_TODOS) {
    return { ok: false, error: `todos 参数非法：最多 ${MAX_TODOS} 项，当前 ${input.length} 项。请把任务合并到更粗的粒度。` };
  }
  const items = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: `第 ${i + 1} 项非法：应为 { content, status } 对象。` };
    }
    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    if (!content) {
      return { ok: false, error: `第 ${i + 1} 项 content 非法：任务描述不能为空。` };
    }
    const status = typeof raw.status === 'string' ? raw.status.trim() : '';
    if (!TODO_STATUSES.includes(status)) {
      return {
        ok: false,
        error: `第 ${i + 1} 项 status 非法：「${status || '(空)'}」不是合法状态，必须是 ${TODO_STATUSES.join(' / ')} 之一。`
      };
    }
    const activeForm = typeof raw.activeForm === 'string' ? raw.activeForm.trim() : '';
    items.push(activeForm ? { content, status, activeForm } : { content, status });
  }
  const running = items.filter((t) => t.status === 'in_progress');
  if (running.length > 1) {
    const names = running.map((t) => `「${t.content}」`).join('、');
    return {
      ok: false,
      error:
        `任务清单非法：同一时刻最多只能有 1 项 in_progress，当前有 ${running.length} 项（${names}）。` +
        '请只保留你正在做的那一项为 in_progress，其余改回 pending。'
    };
  }
  return { ok: true, items };
}

/** Human-readable checklist — also what the model sees echoed back. */
export function renderTodos(items) {
  const mark = { completed: '✅', in_progress: '🔄', pending: '⬜' };
  return (items || [])
    .map((t, i) => {
      const label = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
      const tail = t.status === 'in_progress' ? '  ← 进行中' : '';
      return `${mark[t.status] || '⬜'} ${i + 1}. ${label}${tail}`;
    })
    .join('\n');
}

/** Compact one-line progress, e.g. "2/5 完成 · 进行中：写测试". */
export function todoProgress(items) {
  const list = items || [];
  const done = list.filter((t) => t.status === 'completed').length;
  const cur = list.find((t) => t.status === 'in_progress');
  const head = `${done}/${list.length} 完成`;
  return cur ? `${head} · 进行中：${cur.activeForm || cur.content}` : head;
}

export function emptyTodoState() {
  return { items: [], updates: 0, updatedAt: 0, hinted: false };
}

/**
 * The per-turn reminder injected right before the model call (and removed
 * right after, so it never pollutes history). Returns '' when there is
 * nothing worth saying — silence is cheaper than noise.
 *
 * @param {object|null} todo  the mutable todo state ({ items, hinted, ... })
 * @param {{turn?:number, turnsSinceTodo?:number, staleAfter?:number}} o
 */
export function todoReminder(todo, o = {}) {
  if (!todo || typeof todo !== 'object') return '';
  const turn = Number(o.turn) || 0;
  const since = Number(o.turnsSinceTodo) || 0;
  const staleAfter = Number(o.staleAfter) > 0 ? Number(o.staleAfter) : 3;
  const items = Array.isArray(todo.items) ? todo.items : [];

  // No list yet. Say it once, late enough that trivial one-shot questions are
  // never bothered, early enough to still matter.
  if (!items.length) {
    if (turn >= 2 && !todo.hinted) {
      todo.hinted = true;
      return (
        '提醒：这次任务已经进行了好几轮，但你还没有建立任务清单。' +
        '请立刻调用 todo_write 写下完整的待办清单（包含最后的验证步骤），再继续动手 —— 这能避免做到后面漏掉需求。'
      );
    }
    return '';
  }

  const remaining = items.filter((t) => t.status !== 'completed');
  const lines = ['【当前任务清单】（用户可见，以此为准，不要偏离）', renderTodos(items)];

  if (!remaining.length) {
    // Everything is ticked off. One question left: did you actually check?
    if (!items.some((t) => VERIFY_RE.test(t.content))) {
      lines.push(
        '',
        '所有任务都已标记完成，但清单里没有任何验证步骤。收尾前请先确认结果真的成立（跑测试 / 构建 / 复核输出），必要时用 todo_write 追加一项验证任务。'
      );
      return lines.join('\n');
    }
    return '';
  }

  const cur = items.find((t) => t.status === 'in_progress');
  lines.push(
    '',
    cur
      ? `下一步只做这一件事：「${cur.content}」。做完立刻用 todo_write 把它标为 completed，并把下一项设为 in_progress（每次传完整清单）。`
      : '当前没有 in_progress 的任务。请先用 todo_write 把你马上要做的那一项设为 in_progress，再动手。'
  );

  if (since >= staleAfter) {
    lines.push(
      '',
      `⚠️ 你已经连续 ${since} 轮没有更新任务清单了。请立刻用 todo_write 同步真实进度：` +
      '已经做完的标 completed，正在做的标 in_progress，中途新增的需求补进清单。'
    );
  }
  return lines.join('\n');
}
