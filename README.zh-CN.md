# Agenite 🤖

**本地优先的多模型智能体（Agent）客户端。** 填入你自己的模型 API Key，就能聊天；开启 Agent 后，它可以**联网查资料、读写本地文件、做计算、执行命令**，通过工具调用自主完成任务。

零依赖、纯离线、数据只存在你本地浏览器。对标 LobeChat / Open WebUI / LibreChat 这类热门项目，但更小巧、更透明、可直接审计每一行代码。

> 💡 因为要调用外部模型的 API（浏览器有跨域限制），Agenite 需要一个**本地小代理服务**来转发请求——这点和 LibreChat / Open WebUI 一样。本项目**零第三方依赖**，不用 `npm install`，只需 `node server.js` 打开浏览器即可。

---

## ✨ 功能

- **多模型 / 多运营商**：OpenAI、DeepSeek、通义千问 (Qwen)、Kimi (Moonshot)、智谱 (GLM)、Groq、Ollama（本地）、OpenRouter，以及任意 OpenAI 兼容接口；也支持 Anthropic (Claude)。
- **工具调用 Agent 循环**：模型可以自己决定调用工具，服务端执行后把结果喂回模型，直到给出最终答案（SSE 流式）。
  - `calculator` 安全数学表达式计算（支持 `sqrt / pow / sin / max …`）
  - `web_fetch` 抓取网页 / API 内容
  - `read_file` / `list_dir` 读取本地文件与目录
  - `write_file` / `run_command` **高级工具**（需手动开启「高级工具」，有风险）
  - `current_datetime` 获取当前时间
- **流式输出**：打字机式实时显示，工具调用过程可视化（参数 + 结果可展开）。
- **多会话管理**：多个对话、重命名、删除，全部存在浏览器 `localStorage`。
- **明暗主题**：跟随系统，可一键切换。
- **Markdown 渲染**：代码块、表格、列表、链接（链接做了 XSS 防护）。
- **单文件构建**：`npm run build` 生成 `dist/agenite.html`，整站内联为一个文件。

---

## 🚀 快速开始

要求：已安装 **Node.js 18+**（无需安装任何 npm 包）。

```bash
cd agenite
node server.js
# 打开终端里打印的地址，默认 http://localhost:4173
```

然后在界面右上角 ⚙ **设置** 里：

1. 选择供应商（如 DeepSeek / 通义千问）
2. 填入你的 **API Key**
3. 确认模型名称（已按供应商预填默认值，可改）
4. 保存 → 在输入框里开始聊天

想体验 Agent：开启右上角 🛠 **Agent** 开关，然后问「帮我算一下 123 的阶乘大概多少位」或「用 web_fetch 看看 example.com 的标题」之类的问题。

### 其他命令

```bash
npm test       # 跑核心逻辑单元测试（40 个，node:test）
npm run build  # 生成单文件 dist/agenite.html
npm start      # 等价于 node server.js
PORT=8080 node server.js   # 自定义端口
```

---

## 🧱 架构

```
agenite/
├── server.js            # 零依赖 HTTP 服务：静态托管 + /api/chat 代理 + Agent 循环(SSE)
├── build.js             # 单文件内联打包 -> dist/agenite.html
├── index.html           # 应用外壳
├── src/
│   ├── app.js           # 浏览器控制器：设置 / 流式聊天 / 工具可视化 / 多会话 / 主题
│   ├── styles.css       # 明暗主题样式
│   └── core/            # 纯逻辑，无 DOM，可在 Node 下测试
│       ├── config.js     # 配置模型 + 供应商预设 + 校验
│       ├── markdown.js   # XSS 安全的 Markdown 渲染
│       ├── provider.js   # OpenAI ↔ Anthropic 消息/工具格式互转
│       ├── client.js     # 用 fetch 流式调用模型（可注入 mock 测试）
│       ├── tools.js      # 工具定义与执行
│       ├── agent.js      # 工具调用循环
│       └── util.js       # 工具函数
└── test/                # node:test 单元测试
```

**数据流**：浏览器 `app.js` → `POST /api/chat`（带对话历史 + 配置）→ `server.js` 运行 `runAgent` → 调用模型（SSE 流式）→ 若模型请求工具则服务端执行 `executeTool` → 结果喂回模型 → 循环至最终答案 → 全程以 SSE 事件 (`start`/`delta`/`tool`/`done`/`end`) 流式回传前端。

---

## 🔒 安全说明

- API Key 仅保存在**你本地浏览器** `localStorage`，并在本地代理中转发给对应运营商，**不会上传到任何第三方**。
- `write_file` 与 `run_command` 属于**高危工具**，默认关闭，必须在设置里手动勾选「高级工具」才会生效。请只在与可信模型对话时开启。
- 所有 Markdown 渲染都做了 HTML 转义，链接做了 `javascript:` / `data:` 协议过滤。

---

## 📄 许可证

[MIT](./LICENSE)
