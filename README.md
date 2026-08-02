# Agenite 🤖

**A local-first, multi-provider AI agent client.** Plug in your own model API key and chat. With the Agent toggle on, it can **browse the web, read/write local files, do math, and run commands** by calling tools in a loop until it reaches a final answer.

Zero dependencies, fully offline, data stays in your browser. In the spirit of LobeChat / Open WebUI / LibreChat — but smaller, transparent, and fully auditable.

> 💡 Because it calls external model APIs (browsers block cross-origin requests), Agenite needs a **tiny local proxy** to forward requests — the same as LibreChat / Open WebUI. This project has **no third-party dependencies**: no `npm install`, just `node server.js` and open the browser.

---

## ✨ Features

- **Multi-model / multi-provider**: OpenAI, DeepSeek, Qwen, Moonshot (Kimi), Zhipu (GLM), Groq, Ollama (local), OpenRouter, any OpenAI-compatible endpoint, plus Anthropic (Claude).
- **Tool-use agent loop**: the model decides when to call a tool; the server executes it and feeds the result back, repeating until a final answer (SSE streaming).
  - `calculator` — safe arithmetic (supports `sqrt / pow / sin / max …`)
  - `web_fetch` — fetch a URL / API
  - `read_file` / `list_dir` — read local files / directories
  - `write_file` / `run_command` — **danger tools** (opt-in only)
  - `current_datetime` — current time
- **Streaming**: typewriter output with visualized tool calls (expandable args + results).
- **Multi-conversation**: rename / delete, persisted in `localStorage`.
- **Light / dark theme**, **XSS-safe Markdown** rendering.
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
npm test       # run core unit tests (40, via node:test)
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
- `write_file` / `run_command` are **danger tools**, off by default, enabled only via the "高级工具" setting.
- All Markdown is HTML-escaped; links are filtered against `javascript:` / `data:` schemes.

## 📄 License

[MIT](./LICENSE)
