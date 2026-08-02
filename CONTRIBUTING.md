# 参与贡献 Contributing

感谢你对 Agenite 感兴趣！这是一个零依赖、本地优先的小项目，欢迎各种改进。

## 开发环境

只需要 Node.js 18+（无需安装任何依赖）。

```bash
node server.js        # 启动本地服务
npm test              # 运行单元测试
npm run build         # 生成单文件 dist/agenite.html
```

## 提交流程

1. Fork 并创建分支：`git checkout -b feat/your-feature`
2. 保持代码风格：2 空格缩进、LF 换行（见 `.editorconfig`）。
3. **核心逻辑改动请同步更新 `test/` 下的单元测试**，并保持全部通过：
   ```bash
   npm test
   ```
4. 提交信息清晰说明「做了什么 / 为什么」。
5. 发起 Pull Request，描述改动与测试情况。

## 代码结构约定

- `src/core/*` 必须是**纯逻辑、无 DOM 依赖**，这样才能在 Node 下测试。
  - 新增网络/工具能力时，把可注入 `fetchImpl` / `executeTool` 的逻辑抽到 `core/`，便于测试。
- 浏览器相关代码放在 `src/app.js` 与 `src/styles.css`。
- 服务端代理与 Agent 循环在 `server.js`。

## 新增工具

在 `src/core/tools.js` 的 `TOOL_DEFS` 增加定义，并实现对应 `case`，同时补一个测试。标记为 `danger: true` 的工具默认关闭，需用户开启「高级工具」。

## 行为准则

- 不要引入运行时第三方依赖（保持零依赖）。
- 不要默认开启危险工具，也不要在客户端硬编码任何密钥。
- 保持 API Key 仅存本地浏览器、仅经本地代理转发。

## 报告问题

请使用仓库的 Issue 模板（Bug / Feature），尽量附上复现步骤与配置（**不要贴出真实 API Key**）。
