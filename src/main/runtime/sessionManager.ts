import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { rawViewToViewNode, sendChatMessage, type ChatResult } from "./chatEngine.js";
import { runCommand } from "./shell.js";
import type {
  ActionInvocation,
  ChatMessage,
  DataSourceSpec,
  DebugLogEntry,
  RunResult,
  SessionSnapshot,
  TaskPlan,
  TaskSession,
  ViewNode
} from "./types.js";
import type { AppSettings, ProviderType } from "../settings/types.js";

type SessionListener = (snapshot: SessionSnapshot) => void;
type DebugLogger = (entry: Omit<DebugLogEntry, "id" | "at">) => void;

export class SessionManager {
  private readonly sessions = new Map<string, TaskSession>();
  private readonly pollers = new Map<string, NodeJS.Timeout[]>();
  private readonly listeners = new Set<SessionListener>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cwd: string,
    private readonly storePath: string,
    private readonly debugLog: DebugLogger = () => undefined
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.storePath, "utf8");
      const saved = JSON.parse(raw) as TaskSession[];
      for (const session of saved) {
        // Processes don't survive restarts — mark anything mid-flight as completed
        if (session.status === "running") session.status = "completed";
        session.liveViewIds = [];
        this.sessions.set(session.id, session);
      }
    } catch {
      // First launch or corrupt file — start fresh
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.persist();
    }, 150);
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(path.dirname(this.storePath), { recursive: true });
      const data = Array.from(this.sessions.values()).map(({ busyHint: _, ...s }) => s);
      await writeFile(this.storePath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      this.debugLog({ level: "warn", scope: "runtime", message: "Failed to persist sessions.", detail: String(err) });
    }
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());

    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): SessionSnapshot {
    return {
      sessions: Array.from(this.sessions.values()).sort((a, b) => b.createdAt - a.createdAt)
    };
  }

  async createSession(
    prompt: string,
    plan: TaskPlan,
    plannerSource: ProviderType | "mock" = "mock",
    sessionId = randomUUID()
  ): Promise<TaskSession> {
    const initialViews = structuredClone(plan.views);
    const session: TaskSession = {
      id: sessionId,
      prompt,
      title: plan.title,
      mode: plan.mode,
      summary: plan.summary,
      plannerSource,
      status: "running",
      createdAt: Date.now(),
      views: initialViews,
      liveViewIds: [],
      dataSources: structuredClone(plan.dataSources),
      messages: [
        { id: randomUUID(), role: "user", content: prompt, at: Date.now() },
        {
          id: randomUUID(),
          role: "assistant",
          content: "",
          at: Date.now(),
          viewIds: initialViews.map((v) => v.id)
        }
      ],
      eventLog: [{ at: Date.now(), message: `Planned ${plan.mode} task via ${plannerSource}.` }]
    };

    this.sessions.set(sessionId, session);
    this.debugLog({
      level: "info",
      scope: "runtime",
      sessionId,
      message: `Created session "${plan.title}" in ${plan.mode} mode.`,
      detail: `planner=${plannerSource}`
    });
    this.emit();

    if (plan.mode === "one-shot") {
      await this.runOneShot(session.id, plan.dataSources[0]);
      return this.sessions.get(sessionId)!;
    }

    if (plan.mode === "streaming") {
      this.startPollers(session.id, plan.dataSources);
      return this.sessions.get(sessionId)!;
    }

    if (plan.mode === "interactive") {
      await this.refreshInteractive(session.id, plan.dataSources);
      return this.sessions.get(sessionId)!;
    }

    return session;
  }

  async invokeAction(input: ActionInvocation): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return;
    }

    this.appendEvent(session.id, `Action: ${input.action.label}`);
    this.debugLog({
      level: "info",
      scope: "runtime",
      sessionId: session.id,
      message: `Running action "${input.action.label}"`,
      detail: input.action.command
    });
    const result = await runCommand(input.action.command, this.cwd);
    this.writeResultToView(session.id, input.action.targetViewId ?? "details", result, "raw");
    this.appendEvent(session.id, `Ran: ${input.action.command}`);
    this.debugLog({
      level: result.code && result.code !== 0 ? "warn" : "info",
      scope: "runtime",
      sessionId: session.id,
      message: `Action completed with exit code ${result.code ?? 0}`,
      detail: summarizeResult(result)
    });
    this.emit();
  }

  stopSession(sessionId: string): void {
    const handles = this.pollers.get(sessionId);
    if (handles) {
      for (const handle of handles) {
        clearInterval(handle);
      }
      this.pollers.delete(sessionId);
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.liveViewIds = [];
      session.status = "stopped";
      this.appendEvent(sessionId, "Stopped session.");
      this.emit();
    }
  }

  restartSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.mode !== "streaming" || session.dataSources.length === 0) return;

    this.startPollers(sessionId, session.dataSources);
    session.status = "running";
    this.appendEvent(sessionId, "Restarted session.");
    this.emit();
  }

  deleteSession(sessionId: string): void {
    this.stopSession(sessionId);
    this.sessions.delete(sessionId);
    this.emit();
  }

  async runDirect(sessionId: string | null, command: string): Promise<TaskSession> {
    let id = sessionId ?? randomUUID();
    let session = this.sessions.get(id);

    if (!session) {
      const firstWord = command.trim().split(/\s+/)[0] ?? "terminal";
      session = {
        id,
        prompt: command,
        title: firstWord,
        mode: "one-shot",
        summary: "",
        plannerSource: "mock",
        status: "running",
        createdAt: Date.now(),
        views: [],
        liveViewIds: [],
        dataSources: [],
        messages: [],
        eventLog: []
      };
      this.sessions.set(id, session);
    }

    const userMsg: ChatMessage = { id: randomUUID(), role: "user", content: command, at: Date.now() };
    session.messages.push(userMsg);
    this.emit();

    const result = await runCommand(command, this.cwd);
    const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n") || "(no output)";

    const viewId = `direct-${randomUUID().slice(0, 8)}`;
    session.views.push({ id: viewId, type: "log", title: command, content: output });

    const assistantMsg: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content: result.code !== 0 ? `exit ${result.code ?? "?"}` : "",
      at: Date.now(),
      viewIds: [viewId]
    };

    session.messages.push(assistantMsg);
    session.status = "completed";
    this.emit();
    return this.sessions.get(id)!;
  }

  async startChat(prompt: string, settings: AppSettings): Promise<TaskSession> {
    const id = randomUUID();
    const words = prompt.trim().split(/\s+/).slice(0, 6).join(" ");
    const title = words.length > 48 ? words.slice(0, 48) + "…" : words;

    const session: TaskSession = {
      id,
      prompt,
      title,
      mode: "interactive",
      summary: "",
      plannerSource: "mock",
      status: "running",
      createdAt: Date.now(),
      views: [],
      liveViewIds: [],
      dataSources: [],
      messages: [],
      eventLog: [{ at: Date.now(), message: "Started chat session." }]
    };

    this.sessions.set(id, session);
    this.emit();

    await this.chat(id, prompt, settings);
    return this.sessions.get(id)!;
  }

  async chat(sessionId: string, userText: string, settings: AppSettings): Promise<ChatMessage> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);

    const userMsg: ChatMessage = { id: randomUUID(), role: "user", content: userText, at: Date.now() };
    session.messages.push(userMsg);
    this.emit();

    this.debugLog({ level: "info", scope: "planner", sessionId, message: "Chat turn started.", detail: userText });

    session.busyHint = "Thinking…";
    this.emit();

    const MAX_ATTEMPTS = 3;
    let response: ChatResult | null = null;
    let lastError: unknown;

    const RETRY_HINTS: Record<string, string> = {
      empty:
        "IMPORTANT: Your previous response was empty. You MUST return a JSON object. " +
        'Minimum valid response: { "reply": "your message here" }',
      json:
        "IMPORTANT: Your previous response could not be parsed as JSON. " +
        "Return ONLY a raw JSON object — no markdown fences, no code blocks, no explanation outside the JSON."
    };

    let lastErrorKind: "empty" | "json" | "other" = "other";

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const retryHint = attempt > 0 ? RETRY_HINTS[lastErrorKind] ?? RETRY_HINTS.json : undefined;

      if (attempt > 0) {
        console.warn(`[sessionManager] chat attempt ${attempt} failed (${lastErrorKind}) — retrying.`);
        session.busyHint = "Retrying…";
        this.emit();
        await new Promise<void>((r) => setTimeout(r, 900));
      }
      try {
        response = await sendChatMessage(userText, session, settings, this.cwd, (entry) => {
          this.debugLog({ ...entry, scope: "planner", sessionId });
        }, retryHint, (hint) => {
          session.busyHint = hint;
          this.emit();
        });
        break;
      } catch (error: unknown) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        lastErrorKind = msg.includes("empty response") ? "empty" : msg.includes("not valid JSON") ? "json" : "other";
        const isRetryable = lastErrorKind === "empty" || lastErrorKind === "json";
        console.error(`[sessionManager] chat attempt ${attempt + 1} error (${lastErrorKind}):`, msg);
        this.debugLog({
          level: "warn", scope: "planner", sessionId,
          message: `Chat attempt ${attempt + 1} failed${isRetryable && attempt + 1 < MAX_ATTEMPTS ? " — retrying" : ""}.`,
          detail: msg
        });
        if (!isRetryable) break;
      }
    }

    if (!response) {
      session.busyHint = undefined;
      const errText = lastError instanceof Error ? lastError.message : "Chat request failed.";
      const errMsg: ChatMessage = { id: randomUUID(), role: "assistant", content: errText, at: Date.now() };
      session.messages.push(errMsg);
      this.emit();
      return errMsg;
    }

    let resolvedViewId: string | undefined;

    if (response.view) {
      const rawView = response.view;
      const viewId = rawView.id;
      resolvedViewId = viewId;

      // Detach this view from any previous message so it only renders once
      for (const msg of session.messages) {
        if (msg.viewIds?.includes(viewId)) {
          msg.viewIds = msg.viewIds.filter((id) => id !== viewId);
        }
      }

      // Build the fully typed ViewNode from the raw AI response
      const viewNode = rawViewToViewNode(rawView);

      const existingIdx = session.views.findIndex((v) => v.id === viewId);
      if (existingIdx >= 0) {
        session.views[existingIdx] = viewNode;
      } else {
        session.views.push(viewNode);
      }

      const isStaticContent =
        viewNode.type === "html" || viewNode.type === "markdown" || viewNode.type === "code" ||
        viewNode.type === "diff" || viewNode.type === "json-tree" || viewNode.type === "terminal" ||
        viewNode.type === "line-chart" || viewNode.type === "pie-chart" || viewNode.type === "gauge" ||
        viewNode.type === "timeline" || viewNode.type === "form" || viewNode.type === "progress" ||
        viewNode.type === "alert" || viewNode.type === "image" || viewNode.type === "kanban" ||
        viewNode.type === "file-tree" || viewNode.type === "metric" || viewNode.type === "card-grid" ||
        viewNode.type === "heatmap";

      if (!isStaticContent && response.command) {
        const { shell, parser, intervalMs } = response.command;

        session.busyHint = "Running command…";
        this.emit();

        this.debugLog({ level: "info", scope: "runtime", sessionId, message: `Chat command: ${shell}` });
        const result = await runCommand(shell, this.cwd);
        this.writeResultToView(sessionId, viewId, result, parser);
        this.appendEvent(sessionId, `Chat ran: ${shell}`);

        if (intervalMs) {
          const handle = setInterval(() => {
            void runCommand(shell, this.cwd).then((r) => {
              this.writeResultToView(sessionId, viewId, r, parser);
              this.emit();
            });
          }, intervalMs);

          const handles = this.pollers.get(sessionId) ?? [];
          handles.push(handle);
          this.pollers.set(sessionId, handles);
          session.liveViewIds = [...new Set([...session.liveViewIds, viewId])];
        }
      } else if (isStaticContent) {
        this.appendEvent(sessionId, `Rendered ${viewNode.type} view: ${viewId}`);
      }
    }

    session.busyHint = undefined;
    const prev = session.tokenUsage ?? { input: 0, output: 0 };
    session.tokenUsage = {
      input: prev.input + response._usage.input,
      output: prev.output + response._usage.output
    };

    const assistantMsg: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content: response.reply,
      at: Date.now(),
      viewIds: resolvedViewId ? [resolvedViewId] : undefined
    };

    session.messages.push(assistantMsg);
    this.emit();
    return assistantMsg;
  }

  private async runOneShot(sessionId: string, source?: DataSourceSpec): Promise<void> {
    if (!source) {
      this.debugLog({
        level: "warn",
        scope: "runtime",
        sessionId,
        message: "One-shot task had no data source."
      });
      this.markCompleted(sessionId);
      return;
    }

    this.debugLog({
      level: "info",
      scope: "runtime",
      sessionId,
      message: "Running one-shot data source",
      detail: source.command
    });
    const result = await runCommand(source.command, this.cwd);
    this.writeResultToView(sessionId, source.targetViewId, result, source.parser);
    this.appendEvent(sessionId, `Ran: ${source.command}`);
    this.debugLog({
      level: result.code && result.code !== 0 ? "warn" : "info",
      scope: "runtime",
      sessionId,
      message: `One-shot command completed with exit code ${result.code ?? 0}`,
      detail: summarizeResult(result)
    });
    this.markCompleted(sessionId);
  }

  private async refreshInteractive(sessionId: string, dataSources: DataSourceSpec[]): Promise<void> {
    for (const source of dataSources) {
      this.debugLog({
        level: "info",
        scope: "runtime",
        sessionId,
        message: "Loading interactive data source",
        detail: source.command
      });
      const result = await runCommand(source.command, this.cwd);
      this.writeResultToView(sessionId, source.targetViewId, result, source.parser);
      this.appendEvent(sessionId, `Loaded: ${source.command}`);
      this.debugLog({
        level: result.code && result.code !== 0 ? "warn" : "info",
        scope: "runtime",
        sessionId,
        message: `Interactive data source completed with exit code ${result.code ?? 0}`,
        detail: summarizeResult(result)
      });
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "completed";
      this.emit();
    }
  }

  private startPollers(sessionId: string, dataSources: DataSourceSpec[]): void {
    const handles: NodeJS.Timeout[] = [];

    for (const source of dataSources) {
      const run = async () => {
        this.debugLog({
          level: "info",
          scope: "runtime",
          sessionId,
          message: "Polling streaming data source",
          detail: source.command
        });
        const result = await runCommand(source.command, this.cwd);
        this.writeResultToView(sessionId, source.targetViewId, result, source.parser);
        this.appendEvent(sessionId, `Updated: ${source.command}`);
        this.debugLog({
          level: result.code && result.code !== 0 ? "warn" : "info",
          scope: "runtime",
          sessionId,
          message: `Streaming poll completed with exit code ${result.code ?? 0}`,
          detail: summarizeResult(result)
        });
        this.emit();
      };

      void run();

      const handle = setInterval(() => {
        void run();
      }, source.intervalMs ?? 2000);

      handles.push(handle);
    }

    this.pollers.set(sessionId, handles);

    const session = this.sessions.get(sessionId);
    if (session) {
      session.liveViewIds = dataSources.map((s) => s.targetViewId);
    }

    this.emit();
  }

  private writeResultToView(
    sessionId: string,
    targetViewId: string,
    result: RunResult,
    parser: DataSourceSpec["parser"]
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const view = session.views.find((item) => item.id === targetViewId);
    if (!view) {
      this.debugLog({
        level: "warn",
        scope: "runtime",
        sessionId,
        message: `Target view "${targetViewId}" not found for parser ${parser}.`
      });
      return;
    }

    if (view.type === "log" || view.type === "markdown" || view.type === "html") {
      const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n\n");
      view.content = combined || "";
      return;
    }

    if (view.type === "stats") {
      view.items = buildStats(result);
      return;
    }

    if (view.type === "table") {
      if (parser === "process-table") {
        view.rows = parseProcessTable(result.stdout);
      } else if (parser === "git-log") {
        view.rows = parseGitLogTable(result.stdout);
      } else if (parser === "du-table") {
        view.rows = parseDuTable(result.stdout);
      } else {
        view.rows = parseGenericTable(result.stdout, view.columns);
      }
      return;
    }

    if (view.type === "bar-chart") {
      view.items = parseDuChart(result.stdout);
      return;
    }
  }

  private markCompleted(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.status = "completed";
    this.debugLog({
      level: "info",
      scope: "runtime",
      sessionId,
      message: "Session completed."
    });
    this.emit();
  }

  private appendEvent(sessionId: string, message: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.eventLog.unshift({ at: Date.now(), message });
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    this.scheduleSave();
  }
}

function summarizeResult(result: RunResult): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const preview = [stdout, stderr].filter(Boolean).join("\n").slice(0, 240);
  return preview || "(no output)";
}

function buildStats(result: RunResult): Array<{ label: string; value: string }> {
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  const lines = output.split("\n").filter(Boolean);

  return [
    { label: "lines", value: String(lines.length) },
    { label: "exit code", value: String(result.code ?? 0) },
    { label: "bytes", value: String(output.length) }
  ];
}

function parseProcessTable(stdout: string): Array<Record<string, string>> {
  const lines = stdout.split("\n").filter(Boolean);
  const body = lines.slice(1, 13);

  return body.map((line) => {
    const parts = line.trim().split(/\s+/, 11);
    const command = parts.slice(10).join(" ");

    return {
      user: parts[0] ?? "",
      pid: parts[1] ?? "",
      cpu: parts[2] ?? "",
      mem: parts[3] ?? "",
      command
    };
  });
}

function parseGitLogTable(stdout: string): Array<Record<string, string>> {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, subject] = line.split("\t");
      return {
        hash: hash ?? "",
        author: author ?? "",
        date: date ?? "",
        subject: subject ?? ""
      };
    });
}

function parseDuTable(stdout: string): Array<Record<string, string>> {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [size, ...pathParts] = line.trim().split(/\s+/);
      return {
        size: size ?? "",
        path: pathParts.join(" ")
      };
    });
}

function parseDuChart(stdout: string): Array<{ label: string; value: string; bytes: number }> {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [size, ...pathParts] = line.trim().split(/\s+/);
      const label = pathParts.join(" ").replace(/^\.\//, "");
      const value = size ?? "0";
      return { label, value, bytes: parseHumanSize(value) };
    })
    .filter((item) => item.bytes > 0);
}

function parseHumanSize(value: string): number {
  if (!value) return 0;
  const num = parseFloat(value);
  if (isNaN(num)) return 0;
  const unit = value.slice(-1).toUpperCase();
  const multipliers: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return multipliers[unit] ? num * multipliers[unit] : num;
}

function parseGenericTable(stdout: string, columns: string[]): Array<Record<string, string>> {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const row: Record<string, string> = {};
      for (let index = 0; index < columns.length; index += 1) {
        row[columns[index]] = parts[index] ?? "";
      }
      return row;
    });
}
