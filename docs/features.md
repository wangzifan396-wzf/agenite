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

最多 12 轮（防失控）。每一步以 SSE 事件推送给前端：
- `start`：模型 / Agent 状态
- `delta`：助手文本增量
- `tool`：工具调用（名称 / 参数 / 结果 / 是否成功 / diff / undoToken）
- `done` / `end`：结束

## 8. 设计原则

- **零依赖**：仅用 Node 内置模块（`http` / `fs` / `crypto` / `child_process` / `fetch`）——包括 MCP 客户端也是手写的 stdio JSON-RPC，没引任何 SDK。
- **可测试**：核心逻辑（`config` / `markdown` / `provider` / `client` / `tools` / `mcp` / `agent` / `util`）无 DOM，95 个单元测试覆盖（MCP 部分用 `test/mcp-mock-server.mjs` 真实 spawn 验证）。
- **本地优先**：无账号、无遥测、无外部网络请求（除你配置的模型 API）。
- **安全**：Markdown 全转义；危险工具默认关闭；`calculator` 不使用 `eval`。
