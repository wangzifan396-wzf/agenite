# Agenite 功能详解

## 1. 支持的供应商（预设）

| 供应商 | 协议 | 默认 Base URL | 默认模型 |
| --- | --- | --- | --- |
| OpenAI | openai | https://api.openai.com/v1 | gpt-4o-mini |
| DeepSeek | openai | https://api.deepseek.com/v1 | deepseek-chat |
| Moonshot (Kimi) | openai | https://api.moonshot.cn/v1 | moonshot-v1-8k |
| 通义千问 (Qwen) | openai | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-plus |
| 智谱 (GLM) | openai | https://open.bigmodel.cn/api/paas/v4 | glm-4-flash |
| Groq | openai | https://api.groq.com/openai/v1 | llama-3.1-8b-instant |
| Ollama (本地) | openai | http://localhost:11434/v1 | llama3.1 |
| OpenRouter | openai | https://openrouter.ai/api/v1 | openai/gpt-4o-mini |
| Anthropic (Claude) | anthropic | https://api.anthropic.com | claude-3-5-sonnet-latest |
| 自定义 | openai | （手动填） | （手动填） |

> 任何兼容 OpenAI `/v1/chat/completions` 的接口都能用「自定义」接入。

## 2. 工具说明

内置 25 个工具，分「安全（默认开启）」与「高危（需开启高级工具 + 审批）」两类（下表列出基础文件 / 命令 / 搜索类，另外还有联网搜索、记忆、计划、委派、并行委派、技能、语义代码检索、代码解释器共 11 个工作流类工具，见第 8 节）。除此之外，你还可以通过 MCP 接入任意数量的外部工具（见第 4 节）。

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `calculator` | ✅ 安全 | 安全数学表达式（递归下降解析，不支持任意代码执行）|
| `current_datetime` | ✅ 安全 | 返回 UTC 与本地时间 |
| `system_info` | ✅ 安全 | 报告操作系统、CPU、内存、主机名、Node 版本、当前工作区 |
| `web_fetch` | ✅ 安全 | 抓取 http(s) 链接，截断到 8000 字符，15s 超时 |
| `read_file` | ✅ 安全 | 读取本地文本文件（支持 `offset` / `limit` 按行切片，默认截断到 20000 字符）|
| `list_dir` | ✅ 安全 | 列出本地目录及大小 |
| `find_files` | ✅ 安全 | 按 `* / ?` 通配递归查找文件，跳过 node_modules / .git |
| `grep_files` | ✅ 安全 | 在文件**内容**里按正则搜索，返回 `文件:行号: 文本`，适合跨项目定位代码 |
| `write_file` | ⚠️ 高危 | 写文件，需开启「高级工具」并通过审批；返回改动 diff + 可撤销令牌 |
| `edit_file` | ⚠️ 高危 | 精确替换文件中的一段文本，需开启「高级工具」并通过审批；返回 diff + 撤销令牌 |
| `make_dir` | ⚠️ 高危 | 递归创建目录，需开启「高级工具」并通过审批 |
| `run_command` | ⚠️ 高危 | 执行本地命令（支持 shell / 无 shell 两种模式），需开启「高级工具」并通过审批 |
| `open_path` | ⚠️ 高危 | 用系统默认程序打开文件 / 文件夹 / URL，需开启「高级工具」并通过审批 |
| `apply_patch` | ⚠️ 高危 | 一次性应用 unified diff 补丁到多个文件，需开启「高级工具」并通过审批 |

> `write_file` / `edit_file` / `apply_patch` 三个写入类工具会在工具卡片里展示 **改动预览 (diff)**，并带一个 **↩ 撤销此改动** 按钮：点击后服务端用保存的快照恢复原内容（令牌随服务重启失效）。

## 3. 计划模式（Plan Mode）

点顶部 **Plan** 芯片即可开启。开启后：

1. 你发第一条消息时，模型**只输出分步方案、不调用任何工具**；
2. 助手消息下方出现 **✓ 批准并执行** 按钮；
3. 你点批准，模型才真正开始执行（此时不再处于计划态）。

适合「改很多文件 / 风险高 / 想先看思路」的任务。关闭 Plan 则恢复即时执行。

## 4. MCP 工具生态

Agenite 内置 **MCP（Model Context Protocol）客户端**，位于 `src/core/mcp.js`（纯服务端模块，不会被打进单文件前端）。它让 Agenite 从"只会用自带 14 个工具"变成"能用整个 MCP 开源生态"，这也是它够格叫智能体的关键。

### 4.1 工作原理

```
浏览器（设置 → MCP 工具，配置存 localStorage）
  → 每次 /api/chat 请求带上 mcpServers 列表
    → 服务端 McpManager.reconcile()：新增的连、删掉的杀、没变的复用
      → 对每台服务器 spawn 子进程，用 stdio 跑 JSON-RPC
        → initialize → tools/list → 得到工具清单
          → 转成 OpenAI function 格式，与内置工具合并后交给模型
            → 模型调用 mcp__<服务器>__<工具> → 路由回 tools/call → 结果喂回循环
```

- **传输**：stdio（`spawn` + 换行分隔 JSON-RPC），因此任何 `npx` 一行能起的 MCP 服务器都能直接用。
- **命名**：工具统一加前缀 `mcp__<服务器 id>__<工具名>`，避免和内置工具、不同服务器之间重名。
- **连接复用**：同一台服务器只在配置变化（command/args/env）时才重连，聊天期间保持长连接。
- **失败隔离**：某台服务器连不上只会标红显示错误，不影响其他服务器和内置工具。

### 4.2 快速接入（设置 → MCP 工具）

| 预设 | 能力 | 启动命令 |
| --- | --- | --- |
| 🌐 浏览器控制 | 打开网页、点击、填表、截屏、抓取 | `npx -y @playwright/mcp@latest` |
| 🖥️ 桌面控制 | 鼠标点击、键盘输入、截屏、窗口管理 | `npx -y windows-computer-use-mcp` |
| ✋ 桌面 + 浏览器 | 原生桌面操作 + CDP 浏览器控制 | `npx -y screenhand` |

也可以「手动添加服务器」，填 `id` / `command` / `args` / `env`（args 支持空格分隔或 JSON 数组）。首次连接会由 `npx` 联网拉包，稍等片刻工具数量就会出现。

### 4.3 相关接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/mcp/status` | 返回所有服务器状态（连接中 / 已连接 / 出错）与工具清单 |
| `POST /api/mcp/servers` | 提交服务器配置并 reconcile，返回最新状态 |
| `POST /api/mcp/disconnect` | 按 `id` 断开并杀掉子进程 |

### 4.4 安全边界

MCP 服务器是**在你电脑上真实运行的子进程**，桌面控制类服务器可以操作鼠标键盘。因此：

- 只接入你信任的服务器；
- MCP 工具调用**同样经过审批门控**（`ask` / `auto` / `deny`），默认 `ask` 会逐次弹窗；
- 服务器进程随 Agenite 退出而终止，也可在界面上「停用 / 删除」随时断开。

### 4.5 远程 MCP（HTTP / SSE）与 mcp.json 导入（v0.6.0）

除了本地 stdio，MCP 客户端现在支持两种**远程传输**（写在 `src/core/mcp.js` 的 `HttpTransport` / `SseTransport`，零依赖手写，用 `fetch` 实现）：

- **HTTP（Streamable HTTP）**：连 `https://.../mcp`，自动处理 `Mcp-Session-Id` 会话头，请求失败时（如 502）明确报错而非挂起；
- **SSE（legacy）**：兼容老式 `type: 'sse'` 服务器。

「手动添加」里把传输切到 HTTP/SSE 并填 `url` + `headers` 即可。此外支持**一键导入**其它客户端的配置：

- 在设置 → MCP 工具底部，粘贴 Claude Desktop / Cursor / Cherry Studio 的 `mcp.json` 内容，或选文件上传，点「导入」即可；
- 解析兼容三种形态：带 `mcpServers` 包裹、裸服务器 map、以及已 parsed 的对象；远程条目自动识别为 http/sse，`disabled:true` 的只导入不连；空对象会给出可读报错而非静默导入 0 台服务器。

新增接口：

| 接口 | 说明 |
| --- | --- |
| `POST /api/mcp/import` | 提交 `mcp.json` 文本，返回解析后的服务器列表 |

### 4.6 只读工具免审与工具白名单（v0.6.0）

- **只读自动放行**：`looksReadOnly(name)` 命中 `get_` / `list_` / `search_` / `read_` / `query_` / `screenshot` 等只读动词的 MCP 工具，可在「⚙ 工作区 / 权限」开启 `mcpAutoApproveReadonly` 后免审直行；`write_` / `delete_` / `create_` / `run_` / `execute_` 等一律仍走审批。模糊名称默认按「需审批」（安全方向）。
- **工具白名单**：审批弹窗里点「始终允许」，该工具名（含 `mcp__…`）写入 `config.toolAllowlist`，之后永久免审；设置里「⚙ 工作区 / 权限」的 chip 列表可随时移除。白名单优先级低于 `deny`（只读模式仍会拦下一切）。
- 审批裁决统一走 `approvalDecision(fullName, opts)`，返回 `deny` / `ask` / `allow` 三态。

## 5. 工作区沙箱与审批模式

- **工作区沙箱**：所有文件工具的路径都解析并锚定在「工作区根目录」下（`list_dir` 的 `.` 即根目录）。越界开关 `allowOutsideWorkspace` 默认关闭，仅在用户明确开启时生效。
- **三种审批模式**（`approvalMode`，在设置 → 工作区 / 权限 中切换）：
  - `ask`（每次询问，默认）：每次写文件 / 执行命令前弹窗确认，可勾选「记住本次选择」。
  - `auto`（自动放行）：沙箱内不再询问，速度最快，风险自负。
  - `deny`（只读模式）：直接拒绝一切高危工具。
- 危险工具还需在设置里勾选「高级工具」才会进入工具列表。

## 6. 交互增强

- **`@` 文件引用**：在输入框输入 `@` 打开文件浮层，模糊搜索工作区文件，选中后以 chip 形式附带；发送时文件路径会注入消息正文，让智能体知道要读哪些文件。
- **斜杠命令**：行首输入 `/` 打开命令面板 —— `/new`（新对话）、`/clear`（清空消息）、`/rename`（重命名）、`/export`（导出 Markdown）、`/model`（模型设置）、`/workspace`（工作区与权限）、`/help`（快捷键速查）。
- **消息级操作**：悬停消息出现操作条 —— 助手消息可「复制 / 重新生成」（重新生成会截断该消息之后的历史并重跑）；用户消息可「复制 / 编辑重发」（编辑后截断并重跑）。
- **重命名 / 导出**：双击对话标题重命名；`/export` 或标题栏菜单导出可读的 `.md` 对话记录（区别于设置里的完整 JSON 备份）。
- **快捷键**：Enter 发送、Shift+Enter 换行、`@` / `/` 触发浮层、Ctrl+K 新对话、Ctrl+, 打开设置、Ctrl+/ 打开快捷键速查、Esc 依次关闭浮层 / 审批框 / 快捷键面板 / 设置。

## 7. Agent 循环

```
用户消息
  → 模型 (带工具定义)
    → 若返回 tool_calls：服务端 executeTool → 结果作为 tool 消息追加
    → 再次调用模型（带工具结果）
    → 直到模型不再请求工具 → 最终回答
```

`maxTurns` **默认 20 轮**（v0.6.0 起可在「⚙ 高级」里设 1–100，防失控也防任务半途而废）。每一步以 SSE 事件推送给前端：
- `start`：上下文窗口 / 预算 / maxTurns / 单价
- `delta`：助手文本增量
- `tool`：工具调用（名称 / 参数 / 结果 / 是否成功 / diff / undoToken）
- `compact`：上下文被压缩时推送（`before` / `after` / `dropped` 轮数），前端给出提示而非悄悄丢上下文
- `usage`：本次请求的**累计** token 与成本（`prompt` / `completion` / `total` / `cost`）
- `done`（`canContinue`）：若只因撞到 `maxTurns` 而终止，`canContinue: true`，前端显示「▶ 继续执行」
- `end`：结束（`stopped` / `turns` / `historyTokens` / `budget`）

> **续跑**：点「继续执行」只是再发起一轮 `runTurn`，历史里已经带着上一轮的工具结果，因此从断点无缝继续，不必重头。

### 7.1 上下文自动压缩（v0.6.0）

位于 `src/core/context.js`（仅服务端）。每轮开始前估算历史 token（CJK 约 1 token/字、拉丁约 3.6 字 1 token），对照模型上下文窗口（内置规则表，如 `deepseek-chat → 65536`）算预算：

1. **分组**（`groupMessages`）：system 头固定置顶，每个 `assistant + 紧随的 tool 结果` 绑成一个原子组（绝不拆散工具配对，否则会 400）；
2. **先裁剪工具输出**：把最旧的工具结果截断到保留首尾，省出空间；
3. **还不够则归纳丢弃**：从最老的组开始，用机械摘要或一次廉价模型调用生成摘要并注入 system 区；摘要本身会**缓存**（`summaryCache`，上限 60）避免对相同文本重复请求；
4. **降级**：摘要模型调用失败时退回机械摘要，保证压缩一定能完成。

前端 `sanitizeHistory()` 会在发送前修复「assistant 有 tool_calls 但少了对应 tool 结果 / 反之」的孤儿配对（中途 Stop 或关标签页导致），同样防止 400。

### 7.2 成本与 Token 统计（v0.6.0）

位于 `src/core/pricing.js`（仅服务端）。内置 `PRICE_RULES` 价格表按模型名匹配单价（本地模型如 Ollama 算 ¥0、标记 `known:false`），支持在「⚙ 高级」里用 `priceIn` / `priceOut` / `priceCurrency` 覆盖。`normalizeUsage()` 把 OpenAI / Anthropic 两种用量格式统一成 `{prompt, completion, total}`；未知供应商点 `cost.known=false`，前端只显示 token 不显示金额。

## 8. 会话本机镜像（v0.6.0）

位于 `src/core/sessions.js`（仅服务端）。除了浏览器 `localStorage`，活跃对话会以防抖 1.5s 镜像到 `~/.agenite/sessions/<safeId>.json`：

- `safeSessionId()` 过滤非法字符、防目录逃逸（不信任 `../`）、过长 id 截断，避免被恶意会话名写穿目录；
- 超大对话在写入时截断近尾，避免单文件失控；损坏 / 缺 id 的记录在读取时跳过；
- 相关接口：

| 接口 | 说明 |
| --- | --- |
| `GET /api/sessions` | 列出本机已有会话（倒序），返回目录与数量 |
| `POST /api/sessions` | 保存当前对话镜像 |
| `GET /api/sessions/:id` | 读取单个会话详情 |

换浏览器或清缓存后，设置里点「从本机恢复」即可把历史会话拉回（新浏览器无本地数据时也会静默尝试恢复）。

## 8.5 长期记忆 / 联网搜索 / 本地模型（v0.7.0）

这一版把 Agenite 从「能聊能干活」推向「记得你、会研究、跑本地」——直接对标 2026 年通用智能体竞争报告里的「工作台与记忆」「环境控制能力」两个维度。

### 8.5.1 长期记忆（文件式，零依赖）

位于 `src/core/memory.js`（仅服务端）。记忆全部落在 `~/.agenite/memory/` 这一个专属目录，**刻意与用户的项目文件隔离**——agent 只能往自己的「厨房」写，绝不会碰到你的代码。

- `MEMORY.md`：策展式长期知识，按 `## 分类` 组织（偏好 / 项目 / 决策 / 人物…）；`memory_save` 写入时按 `key` 去重更新；
- `YYYY-MM-DD.md`：每日日志，`memory_log` 追加当日进展；
- `injectMemory()`：每次请求开始时读取 `MEMORY.md`，截断后注入系统提示词，让模型「默认就知道你是谁、项目在干嘛」；
- `recall()`：跨 `MEMORY.md` + 最近 7 天日志做关键词检索，供 `memory_recall` 工具调用；
- 三个工具：`memory_recall`（检索）、`memory_save`（存事实）、`memory_log`（记今日），均为 `danger:false`（只写记忆目录）；
- 可在「⚙ 工作区 / 权限」关闭「长期记忆」，关闭后工具列表与系统提示词都不再包含记忆相关项。

### 8.5.2 联网搜索 `web_search`（免 key）

位于 `tools.js` 的 `webSearch()`。免 API key，走 DuckDuckGo 的 HTML 端点（`https://html.duckduckgo.com/html/?q=`），解析 `result__a` / `result__snippet` 并还原 `uddg` 重定向真实链接，返回 Top N 标题 / URL / 摘要。`danger:false`，超时 15s 容错，搜不到时友好提示改用 `web_fetch` 直抓。这让 Agent 能主动调研，对标 Web Agent。

### 8.5.3 本地模型 Ollama（零成本护城河）

配置里本就有 `ollama` 预设（`baseURL: http://localhost:11434/v1`，`validateConfig` 允许空 key）；本版新增：

- `GET /api/ollama/models`：抓本机 `http://localhost:11434/api/tags`，列出已 `ollama pull` 的模型，4s 超时容错（Ollama 没装时返回 `{running:false, models:[]}`）；
- 前端 Provider 选 Ollama 时出现「🔄 刷新本地模型」按钮，自动填充 `<datalist>` 供模型名下拉，并显示「本地模型 · 零成本 · 数据不出本机」标识；
- 配合内置的零依赖 OpenAI 兼容调用路径，本地模型可直接用工具调用（取决于模型本身的支持度）。
- **语义记忆（v0.8.0）**：提供方为本地 Ollama 时，`recall()` 会改用 `ollamaEmbed()` 调用本机 `nomic-embed-text`（`POST /api/embeddings`）对查询与每条记忆做余弦相似度排序（完全离线、零成本）；嵌入失败或无模型时自动回退关键词检索，绝不报错。

## 8.6 子代理委派 `delegate`（v0.8.0）

从「单循环助手」迈向「真·智能体」的关键一跳（对标 Claude Code 的 Agent 工具 / "Deep Agents" 第二支柱）：

- 主 Agent 用 `delegate` 工具派发一个**隔离上下文**的子代理；子代理从干净的 `system + goal` 起步（**不继承主对话历史**），在自己的上下文窗口里独立跑工具循环，只把**最终摘要**回传主对话。
- 设计遵循调研结论（agentsurface.dev / Claude Code）：**子代理不嵌套**（`delegate` 从子代理工具列表里剥除，由主循环统一协调）；**最小权限**（可选 `tool_scope` 限定工具，危险工具若开启则在子代理内自动放行以避免卡在无人审批）；可选 `persona` 让子代理专业化（researcher / debugger / code-reviewer…）。
- 实现位于 `src/core/subagent.js` 的 `createSubAgentRunner` 工厂（纯函数、可用假模型单测）。子代理的每一步（delta / tool_start / tool / compact / done）通过新的 `subagent` SSE 事件流式回传，前端渲染成可折叠卡片。

## 8.7 自进化技能库 `save_skill` / `skill_recall`（v0.8.0）

借鉴 Hermes / GenericAgent 的「技能复利」——让 Agent **越用越聪明**：

- 完成任务后，Agent 调用 `save_skill` 把成功的工作流沉淀成本机 `skills/<slug>.md`（SKILL.md 风格 frontmatter：`name` / `description` / `when_to_use` + 正文）；
- 每次对话开始，`injectSkills()` 把技能**目录**（名称 + 描述，不含正文）注入系统提示词；匹配场景时 Agent 再用 `skill_recall` 读取完整步骤照做；
- 所有技能都是纯本地文件（`~/.agenite/memory/skills/`），你能读、能改、能删；设置里实时显示已沉淀数量（`GET /api/skills`）。

## 8.8 并行多智能体委派 `fanout`（v0.9.0）

把 v0.8.0 的串行 `delegate` 升级为**一次性并行派发多个隔离子代理**，是 Agenite 从「单智能体」走向「多智能体编排」的质变一跳（对标 Claude Code 的 subagents / OpenAI 的 swarm 思路）：

- 当一条请求能拆成若干**互不依赖**的子任务（分头调研 A/B/C 三个角度、并行处理多个文件批次、同时排查若干独立问题）时，主 Agent 用 `fanout` 一次传入 `tasks` 数组（每项与 `delegate` 同构：`goal` / `persona` / `tool_scope` / `max_turns`），服务端用 `Promise.all` **并发**跑 N 个独立上下文的子循环，最后把每个子代理的摘要聚合成一条结果一次性回传。
- **真并发**：子代理之间不共享可变状态，调度器让它们在同一事件循环批次里并行推进——3 个各耗时 40ms 的子任务，总耗时约 40ms 而非 120ms（测试里有专门的重叠时间线断言）。
- **失败隔离**：单个子代理抛错不会中断其他子代理，聚合结果里会明确标注「成功 N / 失败 M」并把失败原因列在对应子任务下，而非整体崩溃。
- **上限保护**：单次最多 8 个并行子代理，超出部分自动截断，避免失控。
- 实现位于 `src/core/subagent.js` 的 `createFanoutRunner(runSubAgent)` 工厂（薄调度层，建立在 `createSubAgentRunner` 之上），纯函数、可用假 runner 单测（并发 / 聚合 / 失败隔离 / 上限各有断言）。每个子代理仍通过 `subagent` SSE 事件（各自独立的 `subId`）流式回传，前端 `handleSubAgentEvent` 按 `subId` 区分，**同时渲染多张并行卡片**——无需任何前端改动即可复用。

> 何时用哪个：`fanout` 处理**独立**子任务（一次性并行、最快）；`delegate` 处理**单个**聚焦子任务，或子任务之间有**依赖**（后一个需要前一个的输出）时必须串行。

## 8.9 工作区语义检索 `codebase_search` + 技能自动沉淀（v0.10.0）

把 v0.10.0 的两项能力合在一节——它们共同把"本地优先 + 自进化"的护城河又向前推了一步：

### 8.9.1 工作区语义检索 `codebase_search`

**完全本地、代码不出机器**的语义 + 关键词代码检索，对标 Cursor / Cline 的"理解你的代码库"能力，但零依赖、零遥测：

- 当问题是关于**本项目**时（"X 在哪里实现"、"找做 Y 的代码"、"这个模块干嘛的"），Agent 调用 `codebase_search` 扫描整个工作区（自动跳过 `node_modules` / `.git` / `dist` / `.cache` 等，且严格限定在 workspace 沙箱内），把源码切成 ~900 字符、带 150 重叠的块；
- **混合排序**：先按 CJK 感知的词频打分（`csTokenize` 把拉丁词与每个汉字都拆成 token，`lexicalScore` 累计命中数并轻微按长度归一）做廉价预筛；若本机有 Ollama 嵌入模型（`nomic-embed-text`，即 `embed` 注入），再用向量余弦**对词频 top-60 重排**得到更准的语义结果（嵌入失败自动回退词频）；
- **防爆**：单次最多索引 600 个文件 / ~3MB 源码，超大仓库会截取前若干个文件并在结果里明示，避免卡死；纯函数 `csTokenize` / `chunkText` / `lexicalScore` 均可独立单测。

### 8.9.2 技能自动沉淀（真正自进化）

把 v0.8.0 的**手工** `save_skill` 升级成**自动**：

- 任务跑完且 `result.stopped === 'done'` 时，若本次确实够复杂（`isComplexEnough`：工具调用 ≥3 或用了 ≥2 种工具），服务端会用一次 **tool-free** 的反思调用（`tools: []`，避免模型再调工具）把精简后的对话抄本（`compactTranscript`，脱敏、截到 6KB）交给模型，要求它返回结构化 JSON 决定是否值得沉淀成 `SKILL.md`；
- `parseSkillDecision` 鲁棒解析（兼容 ```json 围栏与尾部噪声，任何解析失败都归入 `save:false`，绝不打断对话）；`save:true` 时调用 `saveSkill` 写入 `~/.agenite/memory/skills/<slug>.md`，并通过 `skill_auto` SSE 实时推给前端弹出"💡 自动沉淀技能"提示；
- 设置里「技能自动沉淀」开关可开/关（默认关，因为每次会多一次模型调用）；**每一步失败都静默跳过**，保证聊天永不被技能抽取搞崩；
- 纯函数（`countToolActivity` / `isComplexEnough` / `compactTranscript` / `buildSkillReflectionMessages` / `parseSkillDecision`）与编排函数 `autoSaveSkill` 全部可单测（保存 / 跳过 / 复杂度不足不调模型 / 模型失败 各有断言）。

### 8.9.3 本地代码解释器 `run_code`（v0.11.0）

把 Agent 从"顾问"升级成"执行者"——在工作区沙箱里**执行一段代码**并取回输出（算数、数据处理、验证算法、生成文件、解析日志）。这是"本地优先、真正动手"叙事里最实在的一跃。

- 支持 `language="node"`（本机 Node，**零依赖**直接可用，按 ESM `.mjs` 运行，支持 `import/export`）与 `language="python"`（自动探测 `python3` → `python`，本机未装则友好报错）；
- 实现（`tools.js` 的 `runCode`）：代码写入工作区 `.agenite-code/` 下的临时文件，用 `execFile` 在 workspace root 下执行（`timeout: 30s`、`maxBuffer: 8MB`），捕获 stdout/stderr/退出码/耗时；**退出码非 0 视为信息而非崩溃**——把输出原样回传让模型自行修正；临时文件无论成败都尽力清理；
- 高危工具（`danger: true`），走既有的「电脑操作权限 + 审批」双闸门，复用 `execFileAsync` 与 `resolveSafePath` 沙箱；
- 纯函数友好，已单测：非法语言 / 空代码 / node 真实计算 / ESM `import` / 退出码信息返回 / 危险门闸拦截 / Python 可用性守卫。

### 8.9.4 角色人格库 `persona`（v0.11.0）

一键切换 Agent 的说话与思维方式，是整个"自进化"叙事里的**创意支点**：

- 内置 `default` / `strict-reviewer`（严厉代码审查员）/ `warm-writer`（温柔写作助手）/ `researcher`（严谨研究员），也能把当前「系统提示词」**另存为自定义角色**反复复用；
- 存储（`memory.js` 的 `savePersona` / `listPersonas` / `readPersona` / `deletePersona`，镜像技能）：自定义角色存于 `~/.agenite/memory/personas/<slug>.md`（frontmatter + 指令正文）；
- 接线：`config.persona` 经 `body.config` 透传到服务端（`normalizeConfig` 规范化）→ `resolvePersonaText` 解析（内置名直接取、自定义名读文件）→ `buildSystemPrompt` 注入 `ROLE / 角色设定` 块；系统提示词还会主动提示模型"若任务适合某角色，建议用户切换"；前端设置里有下拉 + "另存为角色"表单（`GET`/`POST`/`DELETE /api/personas`）；
- 子代理已支持 `persona` 参数，主 Agent 的人格可与委派链协同。

### 8.9.5 自治目标委派 + 自验证 · 任务看板（v0.12.0）

这是把 Agenite 从「陪你写代码的聊天 Agent」升级成「**你能交办整个目标、它自治执行并自验证、你随时回来验收**」的关键一跃，直接对齐 OpenHands / Hermes / Codex 后台 Agent 的「交办即走」范式——也是补齐与头部开源 Agent 竞争力落差的主线能力。

- **与既有委派的区别**：`delegate` / `fanout` 是在**一次聊天请求内同步跑完**的子循环；「目标」是一个**独立、长生命周期的自治会话**，脱离单个 HTTP 请求，跑完整个目标后才回报，且刷新浏览器 / 重启服务都不丢。
- 三阶段：`① 规划`（tool-free 生成计划）→ `② 自治执行`（跑一个独立的 `runAgent` 循环，复用全部内置工具——`run_code` 跑测试、`codebase_search` 找代码、`fanout` 并行子代理；沙箱内 `approvalMode:'auto'` **自动批准**，不再逐步问你）→ `③ 自验证`（系统提示词强制「改完必须跑测试/构建/lint，**不过验证不宣布完成**」，阶段末再做一次验收总结）→ `④ 写报告`。
- 持久化：每目标一个 `~/.agenite/memory/goals/<id>.json`，记录 `plan` / `log`（每步进度、工具调用、花费）/ `report` / `usage`；启动时会把上次遗留的 `running`/`queued` 标成 `interrupted`（暂不支持断点续跑）。
- 并发闸门：最多同时运行 **3** 个（`createGoal` 超限返回错误），避免多个自治循环同时打爆 API。
- 前端「目标任务」看板（侧栏入口 `#open-goals`）：派发表单 + 状态徽章（排队/执行中/已完成/失败/已停止/已中断）+ 展开看计划·日志·报告 + 一键停止；打开时每 1.5s 轮询活动目标。
- 端点：`POST /api/goals`（派发）、`GET /api/goals`（列表）、`GET /api/goals/:id`（详情）、`POST /api/goals/:id/stop`（停止）、`DELETE /api/goals/:id`（删除）。

### 8.9.6 目标护栏 + 自愈重试（v0.13.0）

让「交办即走」真正**可靠**、不会跑飞——对标 OpenHands / Hermes「自治且可控」的核心体验。

- **三层预算护栏**：每个目标带 `budget = { maxTurns, maxCostUSD, timeoutMs, retries }`，未配置时用安全默认值（步数 60 / 成本 $1.00 / 时长 10min / 重试 2 次）。派发表单里可调（最大步数 / 成本上限 $ / 自愈重试次数）。执行中累计步数与成本，任一触顶即停并标记 `failed`，错误写明「超出步数上限 / 成本上限 / 时长上限」。
- **自愈重试循环**：`② 执行 → ③ 自验证` 包在一个 `while`（上限 `retries + 1` 次）里。若验收结论是「未完成 / 部分完成」，把该结论回灌成一条 system 消息，让 Agent **复盘、修正、重新跑验证**，直到 `verdictDone`（含「已完成」）或达重试上限。多次尝试的 `messages` 上下文连续保留，步数 / 成本跨尝试**累加计入预算**。验收结论模糊（含验证器自身报错）按「通过」处理，避免无限重试。
- 状态新增字段：`attempt`（已执行次数）、`verdict`（最终验收结论）、`budget`；看板卡片脚注显示「尝试 N」，详情展开可见「验收结论」。
- 健壮性：沿用 v0.12.0 的 flush 串行化 + 原子写 + 单调 `createdAt` + `finalized` 契约，`deleteGoal` 等待 `done` 再 unlink。

### 8.9.7 Agenite Atlas · 记忆知识图谱 + Studio 暗色（v0.14.0）

一次「改头换面」级的形态升级（对标 BrainFlow / tldraw 的可视化与 Lenny's Memory / Graphiti / MemGraph 的图谱记忆），把 Agenite 从「聊天框」变成「**会记住你、并把记忆画成活的本地知识图谱的智能体工作台**」——直接补齐 OpenHands / Devin 仍停留在「聊天框 + 日志」形态时缺的那块**可视化记忆**。

#### 8.9.7.1 本地零依赖记忆图谱引擎 `atlas.js`

位于 `src/core/atlas.js`（纯逻辑、无 DOM、可单测）。刻意做到**零依赖 + 可注入目录**，与 `memory.js` 同为记忆基础设施，但图谱记录的是「关系」而非「流水账」：

- **数据模型**：`graph = { meta, nodes[], edges[] }`；节点 `{id, type, label, description, provenance, createdAt, updatedAt, degree}`，边 `{id, from, to, type, label, createdAt}`；
- **去重**：dedup key = `type + '--' + slug(label)`，同名同类型只更新不重复；`slug()` 小写去标点、中文保留；
- **解析**：`resolveId(graph, ref)` 同时支持按 `id` 或 `label` 定位节点，连边时容忍「用名字而非 id」；
- **校验**：`linkNodes` 拒绝自连（`from === to`）与指向不存在的节点，返回 `{ok:false, error}` 而非抛错；
- **检索**：`searchAtlas(graph, query, {limit})` 大小写不敏感子串匹配 label/description/type，按命中权重排序；
- **统计**：`atlasStats(graph)` 返回节点数 / 边数 / 类型分布 / 孤立节点数；
- **抽取**：`parseAtlasExtraction(text)` 鲁棒解析模型返回的图谱（容忍 ```json 围栏、前导 prose、{nodes,edges} 或裸数组），`applyExtraction(graph, ext)` 把抽取结果 merge 进现有图谱（复用 addNode/linkNodes 的全部去重与校验）；
- **持久化**：`saveAtlas(graph, dir)` 写 `atlas.json.tmp` 再 `rename` 原子落盘；`loadAtlas(dir)` 解析失败回退 `emptyGraph()` 并重算 degree，损坏文件不会让服务崩；
- 全部核心函数（除 load/save 走 IO）为纯函数，已用假数据单测覆盖 add / dedup / link 校验 / resolveId / search / remove / stats / parse / apply / save+load 往返（含损坏文件回退）。

#### 8.9.7.2 `atlas` 工具（Agent 可调）

`tools.js` 的 `TOOL_DEFS` 新增 `atlas`（`danger:false`，只写记忆目录），`dispatch` 路由到 `atlasTool(args, opts)`：

- 四个 action：`add`（增实体节点）、`link`（连两个已有节点，参数 `edge_type` / `edge_label`）、`note`（记一条事实并可选挂到某实体）、`remove`（删节点及其相连边）；
- 复用 `opts.memoryBase`（= MEMORY_DIR，由 `toolContext` 注入）决定图谱落盘目录；未配置时返回 `{ok:false, error:'记忆目录未配置'}`；
- 每次写后 `saveAtlas` 原子落盘，返回带统计的可读结果。

#### 8.9.7.3 图谱端点与「从对话构建」

`server.js` 在 goals 路由后新增四条 `/api/atlas` 路由（无 key 时返回 400 友好提示）：

| 接口 | 说明 |
| --- | --- |
| `GET /api/atlas` | 读取图谱 + `atlasStats` |
| `POST /api/atlas` | action: `add` / `link` / `note` / `remove_node` / `remove_edge` |
| `POST /api/atlas/extract` | 把最近一段对话交给模型抽取实体/关系，复用 `normalizeConfig` + `validateConfig` 校验与 `callModelStream` 流式调用，落盘用 `parseAtlasExtraction` + `applyExtraction` |
| `DELETE /api/atlas` | 清空 nodes/edges 保留 meta（重置） |

前端 `#atlas-modal` 面板：`atlasLayout`（轻量力导向，N>140 时 120 迭代否则 260）渲染 SVG；滚轮缩放、pointer 拖拽节点 / 平移画布、一键适配；侧栏表单手动加节点 / 连边；搜索框实时高亮；「从对话构建」按钮调 `/api/atlas/extract`（取当前对话最近 40 条消息）。

#### 8.9.7.4 Studio 暗色视觉语言（默认）

`styles.css` 的 `[data-theme="dark"]` 升级为 studio 调色板：更深的环境光径向背景（`body::before` fixed 层）、毛玻璃面板 `--glass: rgba(21,25,34,.62)`、单点点缀色 `--accent:#ff7a59` 与辅助蓝 `--accent-2:#6ea8ff`、发光阴影 `--glow` / `--glow-2`；明色主题同步补齐 `--accent-2` / `--glow` / `--glass`。`index.html` 的 `<html data-theme="dark">` 默认暗色，`getInitialTheme()` 仍尊重 localStorage 记忆与切换，避免首屏闪烁。

### 8.9.8 Atlas 自动记忆 + 图谱驱动推理（v0.15.0）

把 v0.14.0 的"手动图谱"升级成**真正在用的第二记忆层**。痛点：图谱是被动工具，模型几乎不会主动调 `atlas`，导致图谱基本靠手动点、等于花瓶。本版让图谱"活"起来且"被用上"，直接对标 Graphiti / MemGraph 的"持续记忆"卖点，但本地零依赖还能可视化。

#### 8.9.8.1 `graphToContext`（注入文本生成器）

`atlas.js` 新增纯函数 `graphToContext(graph, { maxNodes=140, maxEdges=90, maxDesc=80 })`：
- 空图返回 `''`（不污染系统提示词）；
- 节点按 `degree` 降序，连接度高的实体优先出现（最相关的先被模型看到）；
- 边只在「两端都在可见节点集」时才渲染，保证描述的连贯；
- 截断上限保护 token；末尾附「共 N 个实体、M 条关系（仅展示最相关的 K 个）」摘要；
- 纯函数、可单测（空图 / 列表 / 按 degree 排序 / 截断 / 边端点可见性 各有断言）。

#### 8.9.8.2 图谱注入推理

`server.js` 的 `buildSystemPrompt` 新增 `atlas` 段：当 `config.atlasInject !== false`（默认开）时，`handleChat` 在拼系统提示词前 `loadAtlas` → `graphToContext` 注入，模型从此"脑子里有这张地图"。与 `memory_*` 文件式记忆互补：MEMORY.md 是策展式散文，图谱是结构化关系，且可可视化。

#### 8.9.8.3 对话结束自动建图

- 抽取逻辑从 `handleAtlasExtract` 抽成可复用 `buildAtlasFromText(text, config)`（共享 `ATLAS_EXTRACT_SYSTEM` 提示词），手动「从对话构建」与自动建图共用，按 `type+label` 去重合并；
- `handleChat` 在 `finally` 里、对话 `stopped==='done'` 且开启 `config.atlasAutoBuild`（默认关）时，**fire-and-forget** 抽取最近 40 条用户/助手消息灌图：独立发起模型调用（不复用 `ac.signal`，避免连接断开时 abort），`res.end()` 后才在事件循环上跑，`catch` 静默吞错，绝不打断聊天；
- `config.js` 新增 `atlasInject`(默认 true) 与 `atlasAutoBuild`(默认 false)，`normalizeConfig` 做布尔归一；前端设置面板加两个开关（记忆图谱注入推理 / 对话结束自动建图），与「技能自动沉淀」同款安全策略。

### 8.9.9 Atlas 记忆工作台：双向同步 + 节点下钻 + 默认 landing（v0.16.0）

把图谱从「一个漂亮面板」做成**真正可用的第二大脑工作台**。质量（记忆可精修）+ 潜力（图谱成为导航入口）双收。

#### 8.9.9.1 双向 Markdown 同步

`atlas.js` 新增三个纯函数：
- `exportAtlasMarkdown(graph)`：节点按类型分组（`### type · 中文标签`），每个 `- [label] 说明`；关系区 `- A ->(type) （中文说明） B`；空图输出「（空）」标记。格式稳定、可被手改。
- `importAtlasMarkdown(text)`：容错解析——`###` 标题切换当前类型，`- [label] desc` 解析为节点，`- A ->(type) B` 解析为边（best-effort，忽略无法识别的行）。
- `mergeGraph(target, parsed)`：复用 `addNode` / `linkNodes` 去重合并；**新建**节点计入 `added`，**已存在且手改了非空说明**的计入 `updated`（手改覆盖旧说明），边按 `from/to/type` 去重计入 `linked`。返回 `{ added, linked, updated }`。

端点：`GET /api/atlas/markdown`（导出）、`POST /api/atlas/markdown`（导入合并，body `{markdown}`）；前端「导出 MD」触发浏览器下载 `atlas.md`，「导入 MD」用隐藏 `<input type=file>` 读本地文件后合并。

#### 8.9.9.2 节点下钻 + 回忆对话

- 点节点弹 `#atlas-detail`：类型、说明、连接数、邻居关系列表；
- 「回忆相关对话」按钮调 `GET /api/atlas/recall?label=X`，服务端 `searchSessionsForLabel(sessions, label)`（纯函数，定义在 `sessions.js`）扫描本机 `~/.agenite/sessions` 所有会话，返回该实体出现过的片段（含 `sessionId/title/updatedAt/role/snippet`，上下文字数 `ctx=60`，最多 12 条）；前端把结果渲染成带标题/角色/日期的片段卡。

#### 8.9.9.3 默认 landing

`config.atlasAutoOpen`(默认 true) + 设置开关「打开时自动展示记忆图谱」；`init()` 末尾 `maybeOpenAtlasOnBoot()`：若 `config.atlasAutoOpen !== false` 且 `/api/atlas` 返回 `stats.nodes > 0`，延迟 350ms 自动 `openAtlas()`——打开 Agenite 先看到活记忆，而非空白聊天框。

### 8.9.10 执行轨迹 Run Trace：Agent 可观测 + 可见推理（v0.17.0）

把每一次 Agent 运行变成**可回放、可审计的本地决策证据链**——这是 2026 年 Agent「发布门槛」从「服务健康」转向「行为级追踪」的直接回应：一个返回 200 的请求照样可能藏着调错工具、读过时记忆、或静默死循环。对应 Braintrust 可观测模型的四根支柱。

#### 8.9.10.1 捕获与落盘

`src/core/trace.js`（纯函数，可单测）：
- `newTrace(meta)` → 空 trace（`steps:[]` + `stats` + `cost/stopped/turns`）；
- `addStep(trace, step)` → 追加带 `parentId` 的 span，自动维护 `children[]` 与 `stats`（步数 / 工具 / 子智能体 / 错误 / 压缩 / 记忆操作 / 总耗时）；
- `classifyTool(name)` → `memory_` 归 memory、`mcp__` 归 mcp、其余 tool；
- `detectLoops(trace, threshold)` → 被大量复用的工具；`detectConsecutiveLoops(trace, min)` → **参数完全相同的连续重复调用**（真正的「空转」信号）；`traceSummary(trace)` 聚合两者；
- 持久化 `listTraces / loadTrace / saveTrace(原子 rename) / deleteTrace / pruneTraces(上限 200，删最旧)`，落盘 `~/.agenite/traces/<runId>.json`。

服务端 `handleChat` 内 `onEvent` 同时把 `assistant/tool/subagent/compact/usage/done` 落入 trace（含 parentId 树、cost 累计），`finally` 里 `saveTrace` + `pruneTraces`（廉价本地 I/O，断连也保留）。端点：`GET /api/traces`（按时间倒序摘要列表）、`GET /api/traces/:id`、`DELETE /api/traces/:id`。

#### 8.9.10.2 前端面板

侧栏「执行轨迹」打开 `#trace-modal`：标题 + 统计 chips（步数 / 工具 / 子智能体 / 错误 / 记忆 / 耗时 / 成本 / 轮次 / 状态）+ 循环警告条 + `#trace-timeline`（按 kind 图标、按 depth 缩进、工具步可展开参数/结果、推理步显示内容、压缩步显示 token 前后）+ 右侧 `#trace-history`（历史运行列表，点开回放、可删除）。**复用聊天同一路 SSE 事件流**在 `app.js` 内维护 `liveTrace`，零额外服务端接线；`runTurn` 开始时 `traceReset`，SSE 回调里 `traceOnEvent` 实时喂入并就地重渲染。

## 9. 设计原则

- **零依赖**：仅用 Node 内置模块（`http` / `fs` / `crypto` / `child_process` / `fetch`）——包括 MCP 客户端也是手写的 stdio / HTTP JSON-RPC，没引任何 SDK。
- **可测试**：核心逻辑（`config` / `markdown` / `provider` / `client` / `tools` / `atlas` / `trace` / `mcp` / `agent` / `context` / `pricing` / `sessions` / `memory` / `subagent` / `autoskill` / `goals` / `util`）无 DOM，**250 个单元测试**覆盖（MCP 部分用 `test/mcp-mock-server.mjs` 真实 spawn 验证；远程 MCP / 压缩 / 定价 / 会话 / 记忆 / 搜索 / 子代理 / 并行委派 / 语义代码检索 / 技能自动沉淀 / 代码解释器 / 角色人格 / 自治目标 / 目标护栏与自愈重试 / 记忆图谱 / 图谱注入 / 双向同步 / 会话召回 / 执行轨迹各有独立测试文件）。
- **本地优先**：无账号、无遥测、无外部网络请求（除你配置的模型 API 与 `web_search` 的检索）。
- **安全**：Markdown 全转义；危险工具默认关闭；`calculator` 不使用 `eval`；MCP 进程树随服务退出而回收，目录逃逸在会话名层就被挡下；记忆与项目文件物理隔离。
