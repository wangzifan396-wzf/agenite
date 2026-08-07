// Curated, reusable SKILL packs — the "Agent Skills" layer.
//
// Unlike the auto-precipitated skills (SKILL.md files the agent writes for
// itself into ~/.agenite/memory/skills/), these are hand-authored methodology
// packs shipped with Agenite. The user toggles the ones they want from the
// 🧩 技能 gallery; the active packs' `system_prompt` is injected into the
// system message so the agent actually follows the workflow, not just lists it.
//
// Inspired by the 2026 Agent-Skills ecosystem (mattpocock/skills,
// obra/superpowers, addyosmani/agent-skills): small, composable, professional
// engineering disciplines rather than one monolithic "do everything" prompt.

export const BUILTIN_SKILLS = [
  {
    name: 'spec-driven',
    icon: '📐',
    tagline: '先想清，再动手',
    description: '规范驱动开发：先写 spec（目标/范围/约束/验收），再 plan，再实现，最后 review + ship。',
    category: '方法论',
    system_prompt:
      '采用「规范驱动」工作流。动手前先产出一份简洁的 spec：目标、范围（含明确的非目标）、关键约束、验收标准。' +
      'spec 得到确认后再拆成可验证的步骤（plan），逐步实现并每步自检。' +
      '完成后对照验收标准逐条核对（review），确认达标才视为 ship。' +
      '遇到需求模糊或假设未验证时，先澄清再继续，不要替用户做过多隐式假设。'
  },
  {
    name: 'tdd',
    icon: '🧪',
    tagline: '红-绿-重构',
    description: '测试驱动开发：先写会失败的测试，再写最小实现让它通过，最后在安全网内重构。',
    category: '方法论',
    system_prompt:
      '采用测试驱动开发（TDD）。收到功能性需求时：先写一条会失败的测试（红），再写最小实现让它通过（绿），' +
      '最后在测试保护下重构以消除重复、改善结构（重构）。' +
      '每轮保持测试全绿；不要跳过测试先写实现。重构只改变结构、不改变外部行为，' +
      '改完必须重跑测试确认无回归。优先覆盖边界条件与错误路径。'
  },
  {
    name: 'code-review',
    icon: '🔍',
    tagline: '双轴评审',
    description: '代码评审：同时审视「代码质量」与「需求对齐」，给出可执行的修改建议与严重性分级。',
    category: '质量',
    system_prompt:
      '以资深审查者身份做「双轴」代码评审。第一轴「代码质量」：正确性、边界、错误处理、安全、性能、可维护性、命名与结构。' +
      '第二轴「需求对齐」：实现是否真正满足意图与验收标准，有没有遗漏或过度设计。' +
      '先给总体判断（LGTM / 需修改 / 阻塞），再逐条列出问题，每条标注位置、严重性（阻塞/建议/风格）与具体修复建议。' +
      '区分必须改与可改可不改，避免无谓吹毛求疵。'
  },
  {
    name: 'security-audit',
    icon: '🛡️',
    tagline: '默认不信任',
    description: '安全审计：OWASP Top 10、密钥管理、依赖与输入校验、最小权限、输出编码。',
    category: '安全',
    system_prompt:
      '以安全审计视角审视任何代码或设计。重点核查：注入（SQL/命令/模板）、认证与鉴权缺陷、敏感数据暴露、' +
      '不安全的依赖（已知 CVE、锁文件、可疑来源）、密钥与凭据是否硬编码或泄露、输入是否充分校验与规范化、' +
      '输出是否正确编码（防 XSS）、是否遵循最小权限。发现风险时给出具体修复与缓解，并提醒不要提交真实密钥。' +
      '对不可信输入与外部数据默认持不信任态度。'
  },
  {
    name: 'accessibility',
    icon: '♿',
    tagline: '对所有人可用',
    description: '可访问性：WCAG 2.2 AA——键盘可达、对比度、语义化、ARIA、屏幕阅读器兼容。',
    category: '可访问性',
    system_prompt:
      '在产出任何 UI 时遵循 WCAG 2.2 AA。确保：全部功能可用键盘操作且有清晰焦点态；文本与背景对比度达标；' +
      '使用语义化标签与正确的 ARIA 角色/状态；为图片提供替代文本、为图标按钮提供可访问名称；' +
      '尊重用户的 reduced-motion / 字体缩放偏好；表单有正确的 label 与错误信息关联。' +
      '交付前自查：仅用键盘能否完成核心流程？屏幕阅读器能否理解结构？对比度过关吗？'
  },
  {
    name: 'performance',
    icon: '⚡',
    tagline: '快且稳',
    description: '性能：Core Web Vitals、关键路径、减少重排、缓存与懒加载、避免无谓工作。',
    category: '性能',
    system_prompt:
      '在设计与实现时把性能当作一等公民。关注 Core Web Vitals（LCP / INP / CLS），' +
      '缩短关键渲染路径、减少阻塞资源、压缩与按需加载（懒加载、代码分割）。' +
      '避免主线程长任务与布局抖动（重排/重绘），用缓存与记忆化消除重复计算/请求。' +
      '优先做可测量的优化：先定位瓶颈（不要过早优化），改动后用数据验证确实更快。'
  },
  {
    name: 'debugging',
    icon: '🐞',
    tagline: '系统化定位',
    description: '调试方法论：复现 → 二分 → 假设 → 验证 → 根因 → 最小修复 → 回归。',
    category: '方法论',
    system_prompt:
      '遇到 bug 时采用系统化调试，不要盲改。步骤：1) 稳定复现并收集最小复现；2) 用二分/日志/断点缩小范围；' +
      '3) 提出可证伪的假设；4) 设计最小实验验证假设；5) 定位根因（而非只修表象）；' +
      '6) 做最小、针对性修复；7) 加回归测试或复现脚本防止复发。' +
      '一次只改一个变量；改动前后行为差异要可解释。把"为什么"写清楚，而非只给补丁。'
  },
  {
    name: 'refactor',
    icon: '🧹',
    tagline: '安全地变好',
    description: '安全重构：行为不变、小步提交、测试护航、改善命名与结构。',
    category: '质量',
    system_prompt:
      '重构时严守「行为不变」前提。在充足测试（或先补测试）的保护下进行，小步提交、每步可回退。' +
      '优先改善命名、消除重复、拆分过长函数/巨型类、理顺依赖方向，而非重写。' +
      '不借重构夹带功能改动；若必须改行为，单独成次提交。' +
      '重构后跑全量测试确认无回归，并确认可读性/结构确有提升，否则撤销。'
  },
  {
    name: 'doc-writer',
    icon: '📝',
    tagline: '写给人看',
    description: '文档写作：面向读者、结构清晰、示例充分、与代码同步、结论可操作。',
    category: '文档',
    system_prompt:
      '撰写文档时以读者为中心。先明确读者与目的，再定结构（概述→快速开始→概念→操作→排错）。' +
      '用准确术语但避免无谓 jargon，关键步骤配可复制的示例与预期结果。' +
      '结论要可操作：读完知道下一步做什么。保持与代码/接口同步，标注版本或「如与代码不符以代码为准」。' +
      '长文档用标题层级与小标题便于扫读；复杂流程用列表或图示。'
  },
  {
    name: 'root-cause',
    icon: '🔥',
    tagline: '复盘不甩锅',
    description: '故障复盘：时间线、影响面、5-why 根因、止损、预防与行动项（带负责人/时限）。',
    category: '方法论',
    system_prompt:
      '做故障复盘（incident review）时聚焦系统性改进而非追责。结构：1) 事实时间线；2) 影响面（范围/时长/用户）；' +
      '3) 触发与扩散路径；4) 用 5-why 追到根因（流程/防护缺失，而非个人失误）；5) 当时的止损动作；' +
      '6) 预防项（监控/护栏/流程），每条明确负责人与时限；7) 可复用的经验教训。' +
      '区分「发生了什么」与「为什么没拦住」，优先补「没拦住」的环节。'
  }
];

const MAX_BLOCK = 4000;

// Turn the user's active skill names into a system-prompt block. Returns ''
// when nothing is active so the caller can simply join it with other blocks.
export function resolveBuiltinSkills(activeNames) {
  if (!Array.isArray(activeNames) || !activeNames.length) return '';
  const chosen = BUILTIN_SKILLS.filter((s) => activeNames.includes(s.name));
  if (!chosen.length) return '';
  const parts = chosen.map(
    (s) => `### ${s.name}（${s.tagline || s.category || '技能包'}）\n${s.system_prompt}`
  );
  let body =
    '## 已启用的技能包（你应当遵循的复用工作流；多个包可叠加，冲突时以更具体的为准）\n' +
    parts.join('\n\n');
  if (body.length > MAX_BLOCK) body = body.slice(0, MAX_BLOCK) + '\n…(技能包内容已截断)';
  return body;
}

// Gallery metadata — never leaks the full system_prompt to the listing call.
export function listBuiltinSkills() {
  return BUILTIN_SKILLS.map(({ name, icon, tagline, description, category }) => ({
    name,
    icon,
    tagline,
    description,
    category
  }));
}
