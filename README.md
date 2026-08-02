# Agenite 🤖

**A local-first, multi-provider AI agent client.** Plug in your own model API key and chat. With the Agent toggle on, it can **browse the web, read/write local files, do math, and run commands** by calling tools in a loop until it reaches a final answer.

Zero dependencies, fully offline, data stays in your browser. In the spirit of LobeChat / Open WebUI / LibreChat — but smaller, transparent, and fully auditable.

> 💡 Because it calls external model APIs (browsers block cross-origin requests), Agenite needs a **tiny local proxy** to forward requests — the same as LibreChat / Open WebUI. This project has **no third-party dependencies**: no `npm install`, just `node server.js` and open the browser.

---

## ✨ Features

- **Multi-model / multi-provider**: OpenAI, DeepSeek, Qwen, Moonshot (Kimi), Zhipu (GLM), Groq, Ollama (local), OpenRouter, any OpenAI-compatible endpoint, plus Anthropic (Claude).
- **Tool-use agent loop**: the model decides when to call a tool; the server executes it and feeds the result back, repeating until a final answer (SSE streaming). 12 built-in tools:
  - *Safe (always on)*: `calculator`, `current_datetime`, `system_info`, `web_fetch`, `read_file`, `list_dir`, `find_files`
  - *Danger (opt-in + approval)*: `write_file`, `edit_file`, `make_dir`, `run_command`, `open_path`
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
npm test       # run core unit tests (79, via node:test)
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
test/            # node:test unit tests
```

**Flow**: `app.js` → `POST /api/chat` (history + config) → `server.js` runs `runAgent` → calls model (SSE) → if the model requests tools, the server executes them → feeds results back → loops to final answer → streams `start`/`delta`/`tool`/`done`/`end` events to the UI.

---

## 🔒 Security

- API keys live only in your browser `localStorage` and are forwarded by the local proxy — never uploaded elsewhere.
- `write_file` / `edit_file` / `make_dir` / `run_command` / `open_path` are **danger tools**, off by default, enabled only via the "高级工具" setting and gated by the approval mode (`ask` / `auto` / `deny`).
- **Workspace sandbox**: every file path is resolved and pinned under a root directory; an escape hatch (`allowOutsideWorkspace`) is off by default.
- All Markdown is HTML-escaped; links are filtered against `javascript:` / `data:` schemes.

## 📄 License

[MIT](./LICENSE)
