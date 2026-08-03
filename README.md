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
- **Long-term memory (v0.7.0)**: Agenite now **remembers you across sessions** — it writes your preferences, projects and decisions into a local `~/.agenite/memory/MEMORY.md` (plus a daily log), injects that into the system prompt at the start of every chat, and ships three tools — `memory_recall` (search), `memory_save` (persist a fact), `memory_log` (note today) — so the model accumulates and reuses knowledge. Toggle it off in ⚙ Workspace / Permissions.
- **Local models via Ollama (v0.7.0)**: pick the Ollama provider to run **fully local, zero-cost, data-never-leaves-your-machine** models. In settings, click "🔄 刷新本地模型" to auto-list the models you've already `ollama pull`ed; the API key can stay empty.
- **Web search — `web_search` (v0.7.0)**: a key-less search tool (DuckDuckGo) so the agent can **research the web on its own** — look up docs, news, or verify facts without you pasting links first.
- **Sub-agent delegation — `delegate` (v0.8.0)**: the leap from "single-loop assistant" to "real agent". The main agent can spin up an **isolated-context sub-agent** for a focused side task (e.g. "research X", "investigate the failing tests"); the child runs its own tool loop and returns only a **final summary** — the main thread never gets spammed by intermediate steps, and independent tasks can be fanned out in parallel. Sub-agents don't nest, honor a least-privilege `tool_scope`, and accept a `persona` to specialize. The UI renders each sub-agent's steps as a collapsible card.
- **Self-evolving skills (v0.8.0)**: borrowed from Hermes / GenericAgent's "skill compounding" — the agent **crystallizes a solved workflow into a reusable local skill file** (`skills/*.md`, SKILL.md-style frontmatter); future sessions auto-inject the skill catalog into the system prompt, and `skill_recall` pulls the full playbook on demand. The more you use it, the smarter it gets, and every skill is a plain local file you can read and edit.
- **Semantic memory (v0.8.0)**: when the provider is local Ollama, `memory_recall` calls your on-device `nomic-embed-text` for **vector semantic retrieval** (fully offline, zero cost), falling back to keyword search when no embed model is present.
- **Parallel multi-agent fan-out — `fanout` (v0.9.0)**: upgrades the serial `delegate` from v0.8.0 into **one-shot parallel dispatch of multiple isolated sub-agents**. When a request decomposes into several independent sub-tasks (research several angles at once, process multiple file batches, investigate several unrelated bugs in parallel), `fanout` runs N independent-context child loops concurrently and hands back **all summaries at once** — far faster than calling `delegate` serially. Each child stays isolated, non-nesting, and least-privilege via `tool_scope`; one child failing never sinks the others (failure isolation). Every child streams back over the `subagent` SSE, and the UI renders multiple live cards simultaneously. Capped at 8 in parallel; for dependent sub-tasks use serial `delegate` instead.
- **Workspace semantic search — `codebase_search` (v0.10.0)**: a **fully local, code-never-leaves-the-machine** semantic + keyword search over your whole project. When the question is about THIS codebase ("where is X implemented", "find code that does Y"), the agent scans the entire workspace (auto-skipping node_modules/.git/dist…), ranks by CJK-aware keyword score first, then — if a local Ollama embed model (`nomic-embed-text`) is available — **rerankes by cosine similarity** for truer semantic results (falls back to keyword ranking otherwise). Large repos are indexed up to a capped file/byte budget, with a note.
- **Automatic skill precipitation (v0.10.0)**: turns the manual `save_skill` from v0.8.0 into **real self-evolution** — after a run that was genuinely complex (≥3 tool calls or ≥2 distinct tools), the agent **automatically** runs one tool-free reflection to decide whether the workflow is worth crystallizing into a reusable skill; if so it writes `skills/*.md` immediately, which auto-enters the catalog next session (the UI pops a "💡 auto-saved skill" toast). Toggle it in Settings. Any failure is silently skipped and never interrupts the chat.
- **Tool-use agent loop**: the model decides when to call a tool; the server executes it and feeds the result back, repeating until a final answer (SSE streaming). 24 built-in tools (plus whatever MCP servers you connect):
  - *Safe (always on)*: `calculator`, `current_datetime`, `system_info`, `web_fetch`, `web_search`, `read_file` (with line ranges), `list_dir`, `find_files`, `grep_files` (search file contents), `codebase_search` (semantic search the project), `memory_recall`, `memory_save`, `memory_log`, `plan`, `delegate`, `fanout`, `save_skill`, `skill_recall`
  - *Danger (opt-in + approval)*: `write_file`, `edit_file`, `make_dir`, `run_command`, `open_path`, `apply_patch` (multi-file unified diff)
- **Plan Mode** — toggle `Plan` in the header: the agent first returns a step-by-step plan (recorded as an inspectable checklist via the `plan` tool) and waits for your **批准并执行** before touching anything. Ideal for risky or multi-step tasks.
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
npm test       # run core unit tests (170, via node:test)
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
