# anti terminal

A desktop AI assistant that responds to natural language with **live, interactive UI views** — not chat bubbles. Ask it about your system, your codebase, or your data, and it renders the answer as charts, tables, forms, timelines, and more, directly inside the app.

Built on Electron + React + Vercel AI SDK. Works with any OpenAI-compatible provider (OpenRouter, OpenAI, Ollama, LM Studio, OpenCode).

---
This is inspired by listening to [@theo](https://www.youtube.com/@t3dotgg) on one of his live streams. 


## What it does

Type a question or command. The AI decides whether to run a shell command, what component to render the output in, and whether to keep it live-updating. You get a proper UI view, not a wall of text.

```
"show me the largest files in this repo"
→ renders a bar chart, sorted by size, live

"what's the git history for this week"
→ renders a table with hash, author, date, message

"deploy to staging"
→ renders a form with environment selector + tag input, runs the command on submit

"monitor cpu usage"
→ renders a live gauge, refreshes every 2 seconds
```

Shell commands you already know (`ls`, `pwd`, `df`, `ps`, etc.) run directly without going through the AI.

---

## Features

- **Natural language → UI** — AI maps your prompt to the right component automatically
- **20 built-in view types** — charts, tables, forms, code, diff, kanban, and more
- **Component discovery protocol** — AI requests full docs for a component on demand; only pays token cost when it needs it
- ~~**Multi-step queries** — AI can run intermediate shell commands to discover filenames, PIDs, and paths before generating the final view~~
- **Live views** — any view can auto-refresh on an interval
- **Unified command pipeline** — direct commands, AI commands, actions, forms, and HTML widgets use the same streamed runtime
- **Approval gates** — read-only commands run immediately; write, destructive, install/network, and unknown commands show an inline approval card
- **Multi-provider** — OpenRouter, OpenAI, Ollama, LM Studio, OpenCode; switch at any time
- **Session persistence** — conversations, views, command history, approvals, failures, and stopped commands survive restarts
- **Editable system prompt** — override the AI's behavior from settings
- **Traces panel** — inspect every AI call, shell command, and parse result

---
## Alpha software 
This is an alpha software, do not use in production yet. Some things that I would like to add is truly multi threading, multi query system, working on multiple chats simultaneously, better UI / UX / DX. 
This system is running into timeouts sometimes. 



## Supported components

The AI picks from 20 built-in view types. It can also request full schema documentation for any component on demand before generating output.

### Data visualization

| Component | Description |
|-----------|-------------|
| `bar-chart` | Horizontal bars, best for comparing sizes and counts |
| `line-chart` | Time series or continuous data; supports multiple series |
| `pie-chart` | Proportional slices with legend; `donut` variant available |
| `gauge` | Single numeric value on a radial fill gauge; color-coded at 80%/90% |
| `heatmap` | 2D grid colored by intensity, like a contribution graph |

### Tables & structured data

| Component | Description |
|-----------|-------------|
| `table` | Tabular data with named columns |
| `stats` | Key → value label pairs |
| `metric` | Single large number with label, trend arrow, and change indicator |
| `card-grid` | Grid of accent-bordered summary cards with tags and footer |

### Text & code

| Component | Description |
|-----------|-------------|
| `markdown` | Formatted markdown with GFM support |
| `code` | Syntax-highlighted source code with language badge |
| `diff` | Unified diff with green/red/purple line coloring |
| `json-tree` | Collapsible, type-colored interactive JSON explorer |
| `log` | Raw verbatim text output |
| `terminal` | Dark terminal-style output with green monospace text |

### Interactive

| Component | Description |
|-----------|-------------|
| `form` | Labeled input fields that run a shell command on submit; supports text, number, select, checkbox, textarea |
| `actions` | Button group where each button runs a shell command |
| `kanban` | Board with columns and cards |
| `file-tree` | Collapsible directory and file tree |

### Status & layout

| Component | Description |
|-----------|-------------|
| `timeline` | Ordered events with timestamps and status dots (info/success/warn/error) |
| `progress` | Step-by-step pipeline tracker or percentage bar |
| `alert` | Info, success, warning, or error banner |
| `image` | Render an image by file path or data URI |
| `html` | Escape hatch — full custom HTML/CSS/JS rendered directly in the app |

### Shell parsers (used with live/one-shot commands)

| Parser | Description |
|--------|-------------|
| `raw` | Plain text → log view |
| `git-log` | Tab-separated git log → table |
| `process-table` | `ps aux` output → table |
| `du-table` | `du` output → size+path table |
| `du-chart` | `du` output → bar chart |

---

## Component discovery protocol

The AI doesn't load all 20 component schemas on every turn (that would waste tokens and degrade output quality). Instead:

1. Every system prompt includes a one-liner index of all components.
2. When the AI wants to use a specific component, it can reply with `load_components: ["line-chart", "form"]`.
3. The engine detects this, injects the full schema + example + tips for those components, and re-prompts.
4. The AI then generates the actual view with complete documentation.

One extra round-trip, paid only when needed. The `html` component is always available without loading docs.

---

~~## Multi-step queries~~

~~For queries that require discovering something before rendering (e.g. "diff the largest file"), the AI can use a `run` field to execute an intermediate shell command and receive its output before producing the final response. Up to 4 chained steps are supported.~~

---

## Providers

 * OpenRouter
 * OpenAI
 * OpenCode
 * Ollama
 * LM Studio 
 
Switch provider and model from **Settings (⌘,)**. Changes take effect immediately and persist across restarts.

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `↵ Enter` | Send message |
| `⇧↵ Shift+Enter` | New line in composer |
| `⌘,` | Open Settings |
| `⌘K` | Focus search |

---

## Direct command mode

Inputs that look like shell commands bypass the AI and run directly:

- **Path-based**: anything starting with `./`, `/`, or `~/`
- **Shell syntax**: anything containing `|`, `>`, `<`, `;`, or `&`
- **Known single-word commands**: `ls`, `pwd`, `df`, `du`, `uptime`, `whoami`, `ps`, `top`, `env`, `printenv`, `uname`, `hostname`, `date`, `id`, `free`, `htop`, `cal`

Everything else goes to the AI, which can choose to run a command and render the output in a view.

Read-only commands run immediately. Commands classified as `write`, `destructive`, `network/install`, or `unknown` require inline approval before execution.

This v1 runtime uses Node `child_process.spawn` through `/bin/zsh`. It supports streamed output, exit codes, cancellation, and timeouts, but it is not a full PTY: interactive TUI programs that require raw terminal control are not supported yet.

---

## HTML widget scripting

`html` views are injected directly into the DOM (not an iframe), so they inherit the app's dark theme and CSS variables. Scripts have access to the shell:

```js
const result = await window.antiTerminal.runShell("git log --oneline -5");
console.log(result.stdout); // { stdout, stderr, code, status, commandId }
```

Write commands are allowed inside `html` views only after the runtime displays an approval card and the user approves them. The session ID is available as `window.__atSessionId`.

**CSS variables available in html views:**
```css
--text: #f2f2ee
--accent: #4cc2ff
--muted: #8f918d
--bg: #0a0a0b
--border: rgba(255,255,255,0.08)
--success: #3dd68c
--warn: #e4b349
--danger: #ff6057
```

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Shell | Electron (main process) |
| UI | React 18, no component library |
| AI | Vercel AI SDK v6 (`generateText`) |
| Schema validation | Zod |
| Bundler | Vite + esbuild |
| Language | TypeScript, strict mode |

No external chart library. All visualizations (line, pie, gauge, heatmap) are rendered with inline SVG.

---

## Development

```bash
npm install
npm run dev        # starts Vite + tsc watch + Electron concurrently
npm run build      # production build
npm run typecheck  # type check without emit
```

Settings and sessions are stored in Electron's `userData` directory:
- macOS: `~/Library/Application Support/anti-terminal/`
- Windows: `%APPDATA%\anti-terminal\`
- Linux: `~/.config/anti-terminal/`

---

## Architecture

```
src/
├── main/
│   ├── main.ts                  # Electron main process, IPC handlers
│   ├── aiProvider.ts            # OpenAI-compatible provider factory
│   ├── components/
│   │   └── registry.ts          # Component docs for load-on-demand protocol
│   ├── runtime/
│   │   ├── types.ts             # All shared types (ViewNode, TaskSession, …)
│   │   ├── chatEngine.ts        # AI call, load_components protocol, response parsing
│   │   └── sessionManager.ts   # Session lifecycle, polling, persistence
│   ├── settings/
│   │   ├── types.ts             # AppSettings, default system prompt
│   │   └── settingsManager.ts  # Read/write settings.json
│   └── planner/                 # Task planner (one-shot / streaming / interactive)
├── renderer/
│   ├── App.tsx                  # Main UI: nav, composer, all view renderers
│   ├── SettingsPage.tsx         # Settings window
│   ├── styles.css               # All styles, dark theme, component CSS
│   └── settings.css             # Settings window styles
└── preload.ts                   # contextBridge — exposes antiTerminal API to renderer
```
