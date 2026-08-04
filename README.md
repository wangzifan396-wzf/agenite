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
- **Local code interpreter — `run_code` (v0.11.0)**: upgrades the agent from "giving advice" to "actually computing / running / verifying". It **executes a snippet in a workspace sandbox** and returns the output — great for arithmetic, data munging, algorithm checks, generating files, or parsing logs. Supports `language="node"` (your local Node, zero-config, runs as ESM) and `language="python"` (auto-detects python3 → python). 30s timeout, captures stdout/stderr/exit-code; a non-zero exit is returned as information (not a crash) so the model can fix its own code. Requires the "电脑操作权限" (machine control) toggle + approval.
- **Persona library — `persona` (v0.11.0)**: one-click switch of the agent's voice and thinking style — built-ins `default` / `strict-reviewer` (strict code reviewer) / `warm-writer` (gentle writing assistant) / `researcher` (rigorous researcher), plus you can **save the current "system prompt" as a custom persona** for reuse (stored under `~/.agenite/memory/personas/`). The persona is injected into the system prompt and can be handed down to sub-agents — the creative linchpin of the whole "self-evolving" story.
- **Autonomous goal delegation + self-verify · task board (v0.12.0)**: the leap that turns Agenite from "a chat agent that helps you code" into "**an agent you can hand a whole goal to and walk away from**" — directly matching the "fire-and-forget" pattern of OpenHands / Hermes / Codex background agents. Open "目标任务" (goals) in the sidebar, assign a goal (e.g. "add rate-limiting middleware to server.js and write tests"), and the agent runs **independently**: ① plan → ② autonomous execute (reusing every built-in tool — `run_code` to run tests, `codebase_search` to find code, `fanout` for parallel sub-agents — with sandbox-bounded operations **auto-approved**, no per-step prompts) → ③ **self-verify** (it must run the project's tests/build/lint and won't declare done until they pass or it documents why not) → ④ write a report. The whole run is **persisted** to `~/.agenite/memory/goals/` so a browser refresh or a server restart loses nothing; the board shows live plan, progress log, cost, and the final report, with a one-click stop. Up to 3 concurrent. This is the headline capability that closes our competitiveness gap.
- **Goal guardrails + self-heal retry (v0.13.0)**: makes "fire-and-forget" actually **reliable** and never run away. Every goal now carries **three budget rails** (max turns / max cost $ / max duration, all with safe defaults and adjustable in the dispatch form) → breach any one and the goal stops immediately and is marked failed. More importantly, **self-heal retry**: when self-verification judges the goal "not done / partially done", the agent is handed its own verdict, **automatically re-plans, fixes, and re-runs verification** until it passes or hits the retry cap (default 2), with turns and cost **accumulated across attempts** against the budget. This is the "autonomous yet controllable" experience that makes you trust it with bigger goals — it patches its own failures and can never burn unbounded time or money.
- **Agenite Atlas · memory graph + Studio dark (v0.14.0)**: a "head-to-tail" form-factor upgrade — it turns Agenite from "a chat agent that gets things done" into "**an agent that remembers you and paints that memory as a living local knowledge graph**", closing the **visualized-memory** gap that OpenHands / Devin still leave behind with their "chat box + log" form. Includes:
  - 🧠 **Local zero-dependency memory graph**: a new `atlas` tool lets the agent persist the people / projects / concepts / files / preferences / facts it untangles in a conversation as "nodes + typed edges" into `~/.agenite/memory/atlas.json` on your machine — surviving restarts, searchable, auto-deduped by `type+label`. It targets the graph-memory of Lenny's Memory / Graphiti / MemGraph but is fully local, dependency-free, and privacy-preserving (none of the cloud graphs are).
  - 🗺️ **Visual graph panel**: the sidebar "记忆图谱" (memory graph) opens a force-directed canvas — color-coded by entity type, wheel-zoom, drag nodes / pan the canvas, one-click fit. Click a node for details; the search box highlights matching entities and edges in real time.
  - ⚡ **Build from conversation**: feed the recent stretch of the current chat to the model and it auto-extracts entities and relations into the graph (friendly message instead of an error when no key is set); you can also add nodes / edges manually from the side form.
  - 🎨 **Studio dark visual language (default)**: a deeper ambient radial background + frosted-glass panels + a single accent (warm orange `#ff7a59` + auxiliary blue `#6ea8ff`), matching the "spatial, visual, visible reasoning" trend of BrainFlow / tldraw; the light theme gets the same upgrade. `<html>` ships dark by default to avoid a first-paint flash.
- **Atlas auto-memory + graph-driven reasoning (v0.15.0)**: upgrades v0.14.0's "manual graph" into a **genuinely-used second memory layer** — left manual, the model almost never draws the graph on its own, so it stays a showpiece. Includes:
  - 🔁 **Auto-build on conversation end**: when a chat finishes (toggle "对话结束自动建图", off by default, same safe policy as auto-skill), it silently feeds the last 40 user/assistant messages to the model to extract entities/relations into the graph — no manual clicking; any failure is swallowed so it never interrupts the chat.
  - 🧭 **Graph-driven reasoning**: before every agent run (toggle "记忆图谱注入推理", on by default), the graph is compressed into a compact text block (nodes ranked by degree, truncated to bound tokens, edges shown only when both endpoints are visible) and injected into the system prompt — the model now "has the map in its head" and can reference "that project / person you mentioned before" instead of re-asking.
  - 🔌 Reuses the existing `atlas` engine, the `/api/atlas/extract` extraction core, and the memory-injection pattern — **zero architectural debt**; manual "build from conversation" and auto-build share one extraction function (dedup-merged by `type+label`).
- **Atlas workbench: bidirectional sync + node drill-down + default landing (v0.16.0)**: turns the graph from "a pretty panel" into a **genuinely usable second-brain workbench** — quality (it is now editable) and potential (the graph becomes a navigation surface) together. Includes:
  - 🔗 **Bidirectional Markdown sync**: one click **exports** the graph to a human-readable, hand-editable `atlas.md` (grouped by type, entities with descriptions, relations as `A ->(type) B`); re-**import** merges back by `type+label` — and a hand-edited description overrides the old one. Memory is now both visualizable and editable as plain text.
  - 🔍 **Node drill-down + recall conversations**: click any node to see its detail (type, description, degree, neighbors), and a one-click "回忆相关对话" (recall related conversations) that fishes the real snippets where that entity appeared across past sessions (with title / role / date) — the graph becomes a **navigation entry**, not a dead end.
  - 🚪 **Default landing**: on launch, if the graph is non-empty, the "记忆图谱" panel auto-opens as the home (toggle "打开时自动展示记忆图谱", on by default, can be turned off) — you land on your living memory instead of a blank chat box. A more thorough "head-to-tail" makeover.
  - 🔌 Adds 4 atlas pure functions (`exportAtlasMarkdown` / `importAtlasMarkdown` / `mergeGraph` / reusing `graphToContext`) + `searchSessionsForLabel`, endpoints `GET/POST /api/atlas/markdown` and `GET /api/atlas/recall` — **zero architectural debt**.
- **Run Trace: agent observability + visible reasoning (v0.17.0)**: the 2026 release gate is *behavior-level tracing* — a healthy HTTP 200 can still hide a wrong tool call, a stale memory read, or a silent loop. Every run now becomes a **local, replayable evidence chain** mapped onto the four observability pillars. Includes:
  - 🧠 **Live + historical trace panel** (侧栏「执行轨迹」): a visual timeline of the current run, fed by the *same* SSE stream the chat uses (zero extra plumbing), plus a history list of past runs fetched from `/api/traces` that you can click to replay.
  - 🔍 **Typed spans**: model turns (reasoning), tool-call spans (name / args / result / latency / ok·error), sub-agent handoffs (nested), and context compactions (state transitions) — the four pillars from the Braintrust observability model.
  - ⚠️ **Loop detection**: automatically flags repeated identical tool calls (e.g. 5× `web_search` with the same args) — the classic "agent stuck burning budget" signal — and surfaces it as a warning chip.
  - 💾 **Local-first & private**: every run is persisted to `~/.agenite/traces/` (atomic write, capped at 200, pruned oldest-first), fully offline and auditable. Adds `src/core/trace.js` (pure capture + `detectLoops` / `detectConsecutiveLoops`) + `GET /api/traces`, `GET /api/traces/:id`, `DELETE /api/traces/:id` — **zero architectural debt**, and pairs with the Atlas graph and the local-first privacy stance that sets Agenite apart from cloud-only agents.
- **Tool-use agent loop**: the model decides when to call a tool; the server executes it and feeds the result back, repeating until a final answer (SSE streaming). 26 built-in tools (plus whatever MCP servers you connect):
  - *Safe (always on)*: `calculator`, `current_datetime`, `system_info`, `web_fetch`, `web_search`, `read_file` (with line ranges), `list_dir`, `find_files`, `grep_files` (search file contents), `codebase_search` (semantic search the project), `memory_recall`, `memory_save`, `memory_log`, `atlas` (memory graph), `plan`, `delegate`, `fanout`, `save_skill`, `skill_recall`
  - *Danger (opt-in + approval)*: `write_file`, `edit_file`, `make_dir`, `run_command`, `open_path`, `run_code` (local code interpreter), `apply_patch` (multi-file unified diff)
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
npm test       # run core unit tests (250, via node:test)
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
  config / markdown / provider / client / tools / atlas / agent / util
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
