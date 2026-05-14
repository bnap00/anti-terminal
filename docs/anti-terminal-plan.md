# Anti Terminal Plan

## Product Goal

`anti terminal` is an Electron desktop app that accepts natural language, plans shell-driven work, executes it safely, and renders the result in a dynamic UI that fits the task instead of defaulting to raw terminal text.

The MVP supports three runtime modes:

1. `one-shot`
2. `streaming`
3. `interactive`

## Core Principles

- Use structured task plans rather than free-form model output.
- Use schema-driven UI instead of arbitrary generated frontend code.
- Treat shell execution as a controlled runtime with policy and auditability.
- Prefer native structured views over embedding terminal TUIs when possible.

## Architecture

### Desktop Shell

- Electron main process for window lifecycle, IPC, command execution, and local persistence.
- Electron preload script for a narrow, typed renderer bridge.
- React renderer for chat, task history, and schema-driven views.

### Agent Runtime

- Intent/planner stage that converts user requests into structured task sessions.
- Executor stage that runs commands, polls data sources, and streams outputs.
- Presenter stage that emits a UI schema for the renderer.

### Execution + Presentation

- Shell runtime for one-shot commands, polling loops, and action-triggered follow-up commands.
- Dynamic view renderer for tables, stats, log panels, markdown summaries, and action buttons.

## Runtime Modes

### 1. One-Shot

- Run a command once.
- Parse the result.
- Render structured output or raw logs.

Examples:
- `git status`
- `recent git activity`
- `largest files in this repo`

### 2. Streaming

- Poll a command or stream a long-running process.
- Update the same view continuously.
- Support pause/stop and refresh intervals.

Examples:
- process monitoring
- tail-like log views
- repeated disk or network inspection

### 3. Interactive

- Render a structured view with buttons, filters, or inputs.
- User actions trigger additional shell commands.
- Results stream back into panels within the same session.

Examples:
- process table with `Inspect` and `Kill` actions
- repo dashboard with `Status`, `Recent Commits`, and `Diff Summary`
- file explorer with drill-down actions

## Safety Model

- Label commands by risk.
- Allow approval gates for risky actions.
- Keep command execution scoped to a chosen workspace.
- Preserve full command and output history in the session timeline.

## MVP Scope

### Included

- Electron + React + TypeScript app
- Chat textbox and send button
- Structured task session creation
- Three runtime modes end-to-end
- Shell command execution with streamed output
- Dynamic views for logs, tables, stats, and action panels
- Basic heuristic planner as a placeholder for future providers/models

### Deferred

- Real provider/model configuration UI
- Arbitrary generated frontend code
- Full PTY/TUI embedding
- Plugin marketplace
- Multi-workspace orchestration

## Build Order

1. Save plan and scaffold project.
2. Implement task/session contracts.
3. Implement shell runtime and IPC.
4. Implement renderer and schema-driven UI.
5. Add heuristic planner with all three runtime modes.
6. Run build validation.

## MVP Success Criteria

A user can:

- open `anti terminal`
- type a natural language request
- receive a planned task session
- see one-shot, streaming, or interactive execution depending on the task
- interact with generated buttons where supported
- inspect output in a task-appropriate view rather than raw terminal-only output
