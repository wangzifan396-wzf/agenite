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

共 12 个工具，分「安全（默认开启）」与「高危（需开启高级工具 + 审批）」两类。

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `calculator` | ✅ 安全 | 安全数学表达式（递归下降解析，不支持任意代码执行）|
| `current_datetime` | ✅ 安全 | 返回 UTC 与本地时间 |
| `system_info` | ✅ 安全 | 报告操作系统、CPU、内存、主机名、Node 版本、当前工作区 |
| `web_fetch` | ✅ 安全 | 抓取 http(s) 链接，截断到 8000 字符，15s 超时 |
| `read_file` | ✅ 安全 | 读取本地文本文件（截断到 20000 字符）|
| `list_dir` | ✅ 安全 | 列出本地目录及大小 |
| `find_files` | ✅ 安全 | 按 `* / ?` 通配递归查找文件，跳过 node_modules / .git |
| `write_file` | ⚠️ 高危 | 写文件，需开启「高级工具」并通过审批 |
| `edit_file` | ⚠️ 高危 | 精确替换文件中的一段文本，需开启「高级工具」并通过审批 |
| `make_dir` | ⚠️ 高危 | 递归创建目录，需开启「高级工具」并通过审批 |
| `run_command` | ⚠️ 高危 | 执行本地命令（支持 shell / 无 shell 两种模式），需开启「高级工具」并通过审批 |
| `open_path` | ⚠️ 高危 | 用系统默认程序打开文件 / 文件夹 / URL，需开启「高级工具」并通过审批 |

## 3. 工作区沙箱与审批模式

- **工作区沙箱**：所有文件工具的路径都解析并锚定在「工作区根目录」下（`list_dir` 的 `.` 即根目录）。越界开关 `allowOutsideWorkspace` 默认关闭，仅在用户明确开启时生效。
- **三种审批模式**（`approvalMode`，在设置 → 工作区 / 权限 中切换）：
  - `ask`（每次询问，默认）：每次写文件 / 执行命令前弹窗确认，可勾选「记住本次选择」。
  - `auto`（自动放行）：沙箱内不再询问，速度最快，风险自负。
  - `deny`（只读模式）：直接拒绝一切高危工具。
- 危险工具还需在设置里勾选「高级工具」才会进入工具列表。

## 4. 交互增强

- **`@` 文件引用**：在输入框输入 `@` 打开文件浮层，模糊搜索工作区文件，选中后以 chip 形式附带；发送时文件路径会注入消息正文，让智能体知道要读哪些文件。
- **斜杠命令**：行首输入 `/` 打开命令面板 —— `/new`（新对话）、`/clear`（清空消息）、`/rename`（重命名）、`/export`（导出 Markdown）、`/model`（模型设置）、`/workspace`（工作区与权限）、`/help`（快捷键速查）。
- **消息级操作**：悬停消息出现操作条 —— 助手消息可「复制 / 重新生成」（重新生成会截断该消息之后的历史并重跑）；用户消息可「复制 / 编辑重发」（编辑后截断并重跑）。
- **重命名 / 导出**：双击对话标题重命名；`/export` 或标题栏菜单导出可读的 `.md` 对话记录（区别于设置里的完整 JSON 备份）。
- **快捷键**：Enter 发送、Shift+Enter 换行、`@` / `/` 触发浮层、Ctrl+K 新对话、Ctrl+, 打开设置、Ctrl+/ 打开快捷键速查、Esc 依次关闭浮层 / 审批框 / 快捷键面板 / 设置。

## 5. Agent 循环

```
用户消息
  → 模型 (带工具定义)
    → 若返回 tool_calls：服务端 executeTool → 结果作为 tool 消息追加
    → 再次调用模型（带工具结果）
    → 直到模型不再请求工具 → 最终回答
```

最多 10 轮（防失控）。每一步以 SSE 事件推送给前端：
- `start`：模型 / Agent 状态
- `delta`：助手文本增量
- `tool`：工具调用（名称 / 参数 / 结果 / 是否成功）
- `done` / `end`：结束

## 6. 设计原则

- **零依赖**：仅用 Node 内置模块（`http` / `fs` / `crypto` / `fetch`）。
- **可测试**：核心逻辑（`config` / `markdown` / `provider` / `client` / `tools` / `agent` / `util`）无 DOM，79 个单元测试覆盖。
- **本地优先**：无账号、无遥测、无外部网络请求（除你配置的模型 API）。
- **安全**：Markdown 全转义；危险工具默认关闭；`calculator` 不使用 `eval`。
