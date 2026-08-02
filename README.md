# Agenite 🤖

**A local-first, multi-provider AI agent client.** Plug in your own model API key and chat. With the Agent toggle on, it can **browse the web, read/write local files, do math, and run commands** by calling tools in a loop until it reaches a final answer.

Zero dependencies, fully offline, data stays in your browser. In the spirit of LobeChat / Open WebUI / LibreChat — but smaller, transparent, and fully auditable.

> 💡 Because it calls external model APIs (browsers block cross-origin requests), Agenite needs a **tiny local proxy** to forward requests — the same as LibreChat / Open WebUI. This project has **no third-party dependencies**: no `npm install`, just `node server.js` and open the browser.

---

## ✨ Features

- **Multi-model / multi-provider**: OpenAI, DeepSeek, Qwen, Moonshot (Kimi), Zhipu (GLM), Groq, Ollama (local), OpenRouter, any OpenAI-compatible endpoint, plus Anthropic (Claude).
- **MCP tool ecosystem (new in v0.5.0)**: a built-in **MCP (Model Context Protocol) client** connects to any MCP server over stdio, turning the whole open-source tool ecosystem into callable tools — **browser automation, desktop/computer control, databases, GitHub** and more. One click in Settings → MCP:
  - 🌐 **Browser control** — Playwright MCP (`npx -y @playwright/mcp@latest`)
  - 🖥️ **Desktop control** — windows-computer-use-mcp (click, type, screenshot)
  - ✋ **Desktop + browser** — ScreenHand
  - Or add any server manually with `command` / `args` / `env`. MCP tools appear as `mcp__<server>__<tool>` and go through **the same approval gate** as built-in danger tools.
  - 🔌 **Remote MCP (new in v0.6.0)**: besides local stdio, Agenite now speaks **HTTP (Streamable HTTP)** and **SSE** transports, so it can reach tool servers hosted in the cloud. It also **imports a Claude Desktop / Cursor / Cherry Studio `mcp.json` in one click** — paste or pick the file, no retyping.
  - 🔓 **Read-only tools auto-approved (v0.6.0)**: MCP tools whose names match read-only verbs (`get_` / `list_` / `search_` / `read_` …) can run without a prompt; state-changing tools still ask. In ⚙ Workspace / Permissions you can also keep a **tool allowlist** — click "始终允许" to permanently skip a tool, removable anytime.
- **Context auto-compaction (v0.6.0)**: as a conversation approaches the model's context window, the server **compacts automatically** — it trims the oldest tool outputs first, then summarizes and drops the earliest turns, injecting a summary so the model does not silently lose context (or suddenly 400). A subtle notice appears when it happens.
- **Cost & token tracking (v0.6.0)**: a top-right chip shows a **context-fill ring + cumulative tokens (in/out) + estimated cost** (from a built-in price table; local models cost ¥0, unknown prices track tokens only). Each assistant reply also shows its own token use and turn count. Override the price table in ⚙ Advanced with your real billing rates.
- **Configurable max turns + continue (v0.6.0)**: the agent-loop ceiling `maxTurns` defaults to 20 and is settable 1–100 in ⚙ Advanced. If a task stops only because it hit the ceiling, an **▶ 继续执行 (continue)** button appears under the reply — one click resumes from where it left off.
- **Tool-use agent loop**: the model decides when to call a tool; the server executes it and feeds the result back, repeating until a final answer (SSE streaming). 14 built-in tools (plus whatever MCP servers you connect):
  - *Safe (always on)*: `calculator`, `current_datetime`, `system_info`, `web_fetch`, `read_file` (with line ranges), `list_dir`, `find_files`, `grep_files` (search file contents)
  - *Danger (opt-in + approval)*: `write_file`, `edit_file`, `make_dir`, `run_command`, `open_path`, `apply_patch` (multi-file unified diff)
- **Plan Mode** — toggle `Plan` in the header: the agent first returns a step-by-step plan and waits for your **批准并执行** before touching anything. Ideal for risky or multi-step tasks.
- **Diff preview + one-click undo** — every file mutation (`write_file` / `edit_file` / `apply_patch`) shows a live `diff` in its tool card, with a **↩ 撤销** button that restores the previous content via a server-held snapshot.
- **Local computer control** — a **workspace sandbox** pins every file operation under one root directory, and a **3-mode approval gate** decides when a human must approve:
  - `ask` — prompt before every write / command (default, recommended)
  - `auto` — no prompts inside the sandbox (fast, use with care)
  - `deny` — read-only agent, refuses all danger tools
- **Streaming**: typewriter output with visualized tool calls (expandable args + results).
- **`@` file references**: type `@` in the composer to fuzzy-search the workspace and attach files; their paths are injected into the next message so the agent knows what to read.
- **Slash commands**: type `/` for a palette — `/new` `/clear` `/rename` `/export` `/model` `/workspace` `/help`.
- **Per-message actions**: hover a message to copy, regenerate (assistant), or edit-and-resend (user).
- **Conversation rename + Markdown export**: double-click the title to rename; `/export` downloads a readable `.md` transcript (separate from the full JSON backup).
- **Keyboard shortcuts**: Enter to send, Shift+Enter for newline, `@` / `/` triggers, Ctrl+K, Ctrl+, (settings), Ctrl+/ (shortcut cheatsheet), Esc to dismiss.
- **Multi-conversation**, **light / dark theme**, **XSS-safe Markdown** rendering, and an **installable PWA**.
- **On-disk session mirror (v0.6.0)**: besides `localStorage`, conversations are mirrored to `~/.agenite/sessions` (so a cache wipe does not lose them). After switching browsers or clearing storage, ⚙ → "从本机恢复" restores your history.
- **Single-file build**: `npm run build` → `dist/agenite.html`.

---

## 🚀 Quick start

Requires **Node.js 18+** (no npm packages needed).

```bash
cd agenite
node server.js
# open the printed URL, default http://localhost:4173
```

Then open ⚙ **Settings** (top-right): pick a provider, paste your API key, confirm the model, save, and start chatting.

```bash
npm test       # run core unit tests (150, via node:test)
npm run build  # build single-file dist/agenite.html
npm start      # alias for node server.js
PORT=8080 node server.js   # custom port
```

---

## 🧱 Architecture

```
server.js        # zero-dep HTTP: static + /api/chat proxy + agent loop (SSE)
build.js         # inline bundler -> dist/agenite.html
src/app.js       # browser controller
src/core/        # pure logic, DOM-free, Node-testable
  config / markdown / provider / client / tools / agent / util
  mcp.js         # MCP client: stdio / HTTP / SSE transports, multi-server manager (server-side only)
  context.js     # context estimation + auto-compaction (estimateTokens / compactMessages)
  pricing.js     # price table + cost estimation (normalizeUsage / priceFor)
  sessions.js    # on-disk session mirror (safeSessionId / read-write)
test/            # node:test unit tests (+ mcp-mock-server.mjs)
```

**Flow**: `app.js` → `POST /api/chat` (history + config) → `server.js` runs `runAgent` → calls model (SSE) → if the model requests tools, the server executes them → feeds results back → loops to final answer → streams `start`/`delta`/`tool`/`done`/`end` events to the UI.

---

## 🔒 Security

- API keys live only in your browser `localStorage` and are forwarded by the local proxy — never uploaded elsewhere.
- `write_file` / `edit_file` / `make_dir` / `run_command` / `open_path` are **danger tools**, off by default, enabled only via the "高级工具" setting and gated by the approval mode (`ask` / `auto` / `deny`).
- **Workspace sandbox**: every file path is resolved and pinned under a root directory; an escape hatch (`allowOutsideWorkspace`) is off by default.
- **MCP servers are local child processes**: connecting one spawns a process on your machine, and its reach is whatever that server implements (desktop-control servers can move your mouse and type). Only connect servers you trust — MCP calls are gated by the same `ask` / `auto` / `deny` approval mode, and `ask` (the default) prompts on every call.
- All Markdown is HTML-escaped; links are filtered against `javascript:` / `data:` schemes.

## 📄 License

[MIT](./LICENSE)
