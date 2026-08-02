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

| 工具 | 默认开启 | 说明 |
| --- | --- | --- |
| `calculator` | ✅ | 安全数学表达式（递归下降解析，不支持任意代码执行）|
| `current_datetime` | ✅ | 返回 UTC 与本地时间 |
| `web_fetch` | ✅ | 抓取 http(s) 链接，截断到 8000 字符，15s 超时 |
| `read_file` | ✅ | 读取本地文本文件 |
| `list_dir` | ✅ | 列出本地目录 |
| `write_file` | ⚠️ 高危 | 写文件，需开启「高级工具」 |
| `run_command` | ⚠️ 高危 | 执行本地命令，需开启「高级工具」 |

## 3. Agent 循环

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

## 4. 设计原则

- **零依赖**：仅用 Node 内置模块（`http` / `fs` / `crypto` / `fetch`）。
- **可测试**：核心逻辑（`config` / `markdown` / `provider` / `client` / `tools` / `agent`）无 DOM，40 个单元测试覆盖。
- **本地优先**：无账号、无遥测、无外部网络请求（除你配置的模型 API）。
- **安全**：Markdown 全转义；危险工具默认关闭；`calculator` 不使用 `eval`。
