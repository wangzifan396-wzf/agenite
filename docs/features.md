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

内置 14 个工具，分「安全（默认开启）」与「高危（需开启高级工具 + 审批）」两类。除此之外，你还可以通过 MCP 接入任意数量的外部工具（见第 4 节）。

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

## 9. 设计原则

- **零依赖**：仅用 Node 内置模块（`http` / `fs` / `crypto` / `child_process` / `fetch`）——包括 MCP 客户端也是手写的 stdio / HTTP JSON-RPC，没引任何 SDK。
- **可测试**：核心逻辑（`config` / `markdown` / `provider` / `client` / `tools` / `mcp` / `agent` / `context` / `pricing` / `sessions` / `memory` / `subagent` / `util`）无 DOM，**170 个单元测试**覆盖（MCP 部分用 `test/mcp-mock-server.mjs` 真实 spawn 验证；远程 MCP / 压缩 / 定价 / 会话 / 记忆 / 搜索 / 子代理 / 技能各有独立测试文件）。
- **本地优先**：无账号、无遥测、无外部网络请求（除你配置的模型 API 与 `web_search` 的检索）。
- **安全**：Markdown 全转义；危险工具默认关闭；`calculator` 不使用 `eval`；MCP 进程树随服务退出而回收，目录逃逸在会话名层就被挡下；记忆与项目文件物理隔离。
