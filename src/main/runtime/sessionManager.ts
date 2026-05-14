import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { rawViewToViewNode, sendChatMessage, type ChatResult } from "./chatEngine.js";
import { CommandRuntime } from "./commandRuntime.js";
import { appendChunkToView, applyResultToView, parseFixedWidthTable, summarizeResult } from "./parsers.js";
import type {
  ActionInvocation,
  ChatMessage,
  CommandExecution,
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
type CommandListener = (execution: CommandExecution) => void;
type DebugLogger = (entry: Omit<DebugLogEntry, "id" | "at">) => void;

export class SessionManager {
  private readonly sessions = new Map<string, TaskSession>();
  private readonly pollers = new Map<string, NodeJS.Timeout[]>();
  private readonly listeners = new Set<SessionListener>();
  private readonly commandListeners = new Set<CommandListener>();
  private readonly commandRuntime: CommandRuntime;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cwd: string,
    private readonly storePath: string,
    private readonly debugLog: DebugLogger = () => undefined
  ) {
    this.commandRuntime = new CommandRuntime({
      onCreate: (execution) => this.recordCommand(execution),
      onUpdate: (execution) => this.updateCommand(execution),
      onChunk: (execution, stream, chunk) => this.appendCommandChunk(execution, stream, chunk)
    });
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.storePath, "utf8");
      const saved = JSON.parse(raw) as TaskSession[];
      for (const session of saved) {
        // Processes don't survive restarts — mark anything mid-flight as completed
        if (session.status === "running") session.status = "completed";
        session.liveViewIds = [];
        session.commands = (session.commands ?? []).map((command) => {
          if (command.status === "running" || command.status === "pending-approval") {
            return { ...command, status: "stopped", endedAt: Date.now(), stderr: command.stderr || "Command stopped on app restart." };
          }
          return command;
        });
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

  subscribeCommands(listener: CommandListener): () => void {
    this.commandListeners.add(listener);
    return () => {
      this.commandListeners.delete(listener);
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
    const viewId = input.action.targetViewId ?? "details";
    this.ensureOutputView(session, viewId, input.action.label, "log");
    await this.runCommandForView(session.id, {
      command: input.action.command,
      targetViewId: viewId,
      parser: "raw",
      eventPrefix: "Action ran"
    });
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
      this.commandRuntime.stopSession(sessionId);
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

    const viewId = `direct-${randomUUID().slice(0, 8)}`;
    session.views.push({ id: viewId, type: "terminal", title: command, content: "" });
    const result = await this.runCommandForView(session.id, {
      command,
      targetViewId: viewId,
      parser: "raw",
      eventPrefix: "Direct command"
    });

    const assistantMsg: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content: result.status === "pending-approval"
        ? "Approval required before running this command."
        : result.code !== 0
        ? `exit ${result.code ?? "?"}`
        : "",
      at: Date.now(),
      viewIds: result.status === "pending-approval" && result.commandId ? [`approval-${result.commandId}`, viewId] : [viewId]
    };

    session.messages.push(assistantMsg);
    if (result.status !== "pending-approval") {
      session.status = "completed";
    }
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

    const localAnswer = await this.tryLocalChatAnswer(sessionId, userText);
    if (localAnswer) return localAnswer;

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

    if (!response.view && response.command) {
      response = {
        ...response,
        view: {
          id: `command-output-${randomUUID().slice(0, 8)}`,
          type: "log",
          title: response.command.shell,
          content: ""
        }
      };
    }

    let resolvedViewId: string | undefined;
    let resolvedViewIds: string[] | undefined;

    if (response.view) {
      let rawView = response.view;
      const viewId = this.nextChatViewId(session, rawView.id);
      resolvedViewId = viewId;
      rawView = this.repairStaticTableFromLatestOutput(session, userText, rawView);

      // Build the fully typed ViewNode from the raw AI response
      const viewNode = rawViewToViewNode({ ...rawView, id: viewId });

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

      if (response.command) {
        let shell = response.command.shell;
        let parser = response.command.parser;
        let intervalMs = response.command.intervalMs;

        session.busyHint = "Running command…";
        this.emit();
        this.debugLog({ level: "info", scope: "runtime", sessionId, message: `Chat command: ${shell}` });

        let cmdResult = await this.runCommandForView(sessionId, {
          command: shell,
          targetViewId: viewId,
          parser,
          intervalMs: intervalMs ?? undefined,
          eventPrefix: "Chat ran"
        });
        if (cmdResult.status === "pending-approval" && cmdResult.commandId) {
          resolvedViewIds = [`approval-${cmdResult.commandId}`, viewId];
        }

        const MAX_HEAL = 2;
        for (let heal = 0; heal < MAX_HEAL && cmdResult.status !== "pending-approval" && (cmdResult.code ?? 0) !== 0; heal++) {
          const errOut = [cmdResult.stderr.trim(), cmdResult.stdout.trim()]
            .filter(Boolean).join("\n").slice(0, 400);
          const healHint =
            `Your command failed with exit code ${cmdResult.code ?? "?"}:\n` +
            `  ${shell}\n` +
            `Output:\n${errOut || "(none)"}\n\n` +
            `Fix the command and return a corrected response.`;

          this.debugLog({ level: "warn", scope: "runtime", sessionId, message: `Command failed — self-healing (${heal + 1}/${MAX_HEAL}).`, detail: errOut.slice(0, 120) });
          session.busyHint = "Fixing error…";
          this.emit();

          let healed: ChatResult | null = null;
          try {
            healed = await sendChatMessage(userText, session, settings, this.cwd,
              (e) => this.debugLog({ ...e, scope: "planner", sessionId }),
              healHint,
              (h) => { session.busyHint = h; this.emit(); }
            );
          } catch { break; }

          if (!healed?.command) break;

          // Fold heal token cost into response so existing accounting picks it up
          response = {
            ...response,
            reply: healed.reply,
            _usage: { input: response._usage.input + healed._usage.input, output: response._usage.output + healed._usage.output }
          };

          if (healed.view) {
            const healedNode = rawViewToViewNode(healed.view);
            const idx = session.views.findIndex((v) => v.id === healedNode.id);
            if (idx >= 0) session.views[idx] = healedNode;
          }

          shell = healed.command.shell;
          parser = healed.command.parser;
          intervalMs = healed.command.intervalMs;

          session.busyHint = "Running fixed command…";
          this.emit();
          this.debugLog({ level: "info", scope: "runtime", sessionId, message: `Healed command: ${shell}` });
          cmdResult = await this.runCommandForView(sessionId, {
            command: shell,
            targetViewId: viewId,
            parser,
            intervalMs: intervalMs ?? undefined,
            eventPrefix: "Chat ran fixed command"
          });
          if (cmdResult.status === "pending-approval" && cmdResult.commandId) {
            resolvedViewIds = [`approval-${cmdResult.commandId}`, viewId];
          }
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
      viewIds: resolvedViewIds ?? (resolvedViewId ? [resolvedViewId] : undefined)
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
    const result = await this.runCommandForView(sessionId, {
      command: source.command,
      targetViewId: source.targetViewId,
      parser: source.parser,
      eventPrefix: "Ran"
    });
    if (result.status !== "pending-approval") this.markCompleted(sessionId);
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
      await this.runCommandForView(sessionId, {
        command: source.command,
        targetViewId: source.targetViewId,
        parser: source.parser,
        eventPrefix: "Loaded"
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
        await this.runCommandForView(sessionId, {
          command: source.command,
          targetViewId: source.targetViewId,
          parser: source.parser,
          eventPrefix: "Updated",
          suppressApproval: true
        });
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

    applyResultToView(view, result, parser);
  }

  private async runCommandForView(
    sessionId: string,
    input: {
      command: string;
      targetViewId: string;
      parser: DataSourceSpec["parser"];
      intervalMs?: number;
      eventPrefix: string;
      suppressApproval?: boolean;
    }
  ): Promise<RunResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);

    const view = session.views.find((item) => item.id === input.targetViewId);
    if (view && (view.type === "log" || view.type === "terminal")) {
      view.content = "";
    }

    session.status = "running";
    session.liveViewIds = [...new Set([...session.liveViewIds, input.targetViewId])];
    this.emit();

    const result = await this.commandRuntime.run({
      sessionId,
      viewId: input.targetViewId,
      command: input.command,
      cwd: this.cwd,
      parser: input.parser,
      requireApproval: input.suppressApproval ? false : undefined
    });

    if (result.status === "pending-approval") {
      session.status = "idle";
      session.liveViewIds = session.liveViewIds.filter((id) => id !== input.targetViewId);
      this.appendEvent(sessionId, `Approval required: ${input.command}`);
      this.emit();
      return result;
    }

    this.writeResultToView(sessionId, input.targetViewId, result, input.parser);
    this.appendEvent(sessionId, `${input.eventPrefix}: ${input.command}`);
    this.debugLog({
      level: result.code && result.code !== 0 ? "warn" : "info",
      scope: "runtime",
      sessionId,
      message: `Command completed with exit code ${result.code ?? 0}`,
      detail: summarizeResult(result)
    });

    if (input.intervalMs) {
      const handle = setInterval(() => {
        void this.runCommandForView(sessionId, { ...input, intervalMs: undefined, suppressApproval: true });
      }, input.intervalMs);

      const handles = this.pollers.get(sessionId) ?? [];
      handles.push(handle);
      this.pollers.set(sessionId, handles);
      session.liveViewIds = [...new Set([...session.liveViewIds, input.targetViewId])];
    } else {
      session.liveViewIds = session.liveViewIds.filter((id) => id !== input.targetViewId);
      if (session.status === "running") session.status = "completed";
    }

    this.emit();
    return result;
  }

  async approveCommand(commandId: string): Promise<RunResult> {
    const result = await this.commandRuntime.approve(commandId);
    const execution = this.findCommand(commandId);
    if (execution?.sessionId && execution.viewId) {
      this.writeResultToView(execution.sessionId, execution.viewId, result, execution.parser ?? "raw");
      this.appendEvent(execution.sessionId, `Approved and ran: ${execution.command}`);
      const session = this.sessions.get(execution.sessionId);
      if (session) {
        session.liveViewIds = session.liveViewIds.filter((id) => id !== execution.viewId);
        session.status = result.code === 0 ? "completed" : "error";
      }
      this.emit();
    }
    return result;
  }

  denyCommand(commandId: string): RunResult {
    const result = this.commandRuntime.deny(commandId);
    const execution = this.findCommand(commandId);
    if (execution?.sessionId) {
      this.appendEvent(execution.sessionId, `Denied: ${execution.command}`);
      const session = this.sessions.get(execution.sessionId);
      if (session) session.status = "idle";
      this.emit();
    }
    return result;
  }

  stopCommand(commandId: string): RunResult | undefined {
    const result = this.commandRuntime.stop(commandId);
    const execution = this.findCommand(commandId);
    if (execution?.sessionId) {
      this.appendEvent(execution.sessionId, `Stopped command: ${execution.command}`);
      const session = this.sessions.get(execution.sessionId);
      if (session) {
        session.liveViewIds = session.liveViewIds.filter((id) => id !== execution.viewId);
        session.status = "stopped";
      }
      this.emit();
    }
    return result;
  }

  async runShellFromRenderer(command: string, sessionId?: string): Promise<RunResult> {
    if (!sessionId) {
      return this.commandRuntime.run({ command, cwd: this.cwd, requireApproval: false });
    }

    const session = this.sessions.get(sessionId);
    if (!session) return this.commandRuntime.run({ command, cwd: this.cwd, requireApproval: false });

    const viewId = `shell-${randomUUID().slice(0, 8)}`;
    session.views.push({ id: viewId, type: "terminal", title: command, content: "" });
    session.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: "",
      at: Date.now(),
      viewIds: [viewId]
    });
    this.emit();

    const result = await this.runCommandForView(sessionId, {
      command,
      targetViewId: viewId,
      parser: "raw",
      eventPrefix: "Shell"
    });
    if (result.status === "pending-approval" && result.commandId) {
      const msg = session.messages[session.messages.length - 1];
      msg.viewIds = [`approval-${result.commandId}`, viewId];
      this.emit();
    }
    return result;
  }

  private recordCommand(execution: CommandExecution): void {
    if (!execution.sessionId) return;
    const session = this.sessions.get(execution.sessionId);
    if (!session) return;

    session.commands = [execution, ...(session.commands ?? []).filter((cmd) => cmd.commandId !== execution.commandId)];
    if (execution.status === "pending-approval") {
      const approvalView: ViewNode = {
        id: `approval-${execution.commandId}`,
        type: "approval",
        title: "Command approval",
        data: {
          commandId: execution.commandId,
          command: execution.command,
          risk: execution.risk,
          reason: execution.riskReason,
          status: execution.status
        }
      };
      session.views.push(approvalView);
    }
    this.emitCommand(execution);
    this.emit();
  }

  private updateCommand(execution: CommandExecution): void {
    if (!execution.sessionId) return;
    const session = this.sessions.get(execution.sessionId);
    if (!session) return;

    const commands = session.commands ?? [];
    const index = commands.findIndex((cmd) => cmd.commandId === execution.commandId);
    if (index >= 0) commands[index] = execution;
    else commands.unshift(execution);
    session.commands = commands;

    const approval = session.views.find((view): view is Extract<ViewNode, { type: "approval" }> =>
      view.type === "approval" && view.data.commandId === execution.commandId
    );
    if (approval) approval.data.status = execution.status;

    if (execution.viewId && execution.status !== "running") {
      session.liveViewIds = session.liveViewIds.filter((id) => id !== execution.viewId);
    }
    this.emitCommand(execution);
    this.emit();
  }

  private appendCommandChunk(execution: CommandExecution, stream: "stdout" | "stderr", chunk: string): void {
    if (!execution.sessionId || !execution.viewId) return;
    const session = this.sessions.get(execution.sessionId);
    const view = session?.views.find((item) => item.id === execution.viewId);
    if (!session || !view) return;

    appendChunkToView(view, chunk, stream);
    this.updateCommand(execution);
  }

  private findCommand(commandId: string): CommandExecution | undefined {
    for (const session of this.sessions.values()) {
      const command = session.commands?.find((item) => item.commandId === commandId);
      if (command) return command;
    }
    return undefined;
  }

  private ensureOutputView(session: TaskSession, viewId: string, title: string, type: "log" | "terminal"): void {
    if (session.views.some((view) => view.id === viewId)) return;
    session.views.push({ id: viewId, type, title, content: "" });
  }

  private async tryLocalChatAnswer(sessionId: string, userText: string): Promise<ChatMessage | null> {
    if (!/\b(app|project|repo|repository|codebase)\b/i.test(userText) || !/\b(structur|tree|files?|folders?|directories)\b/i.test(userText)) {
      return null;
    }

    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const viewId = `app-structure-${randomUUID().slice(0, 8)}`;
    session.views.push({ id: viewId, type: "terminal", title: "Project structure", content: "" });
    session.busyHint = "Inspecting project…";
    this.emit();

    await this.runCommandForView(sessionId, {
      command: "find . -maxdepth 3 \\( -path './node_modules' -o -path './.git' -o -path './dist-electron' -o -path './dist-renderer' \\) -prune -o -print 2>/dev/null | sed 's#^./##' | sort | head -n 180",
      targetViewId: viewId,
      parser: "raw",
      eventPrefix: "Inspected project structure"
    });

    session.busyHint = undefined;
    const assistantMsg: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content: "Here is the current project structure from the workspace.",
      at: Date.now(),
      viewIds: [viewId]
    };
    session.messages.push(assistantMsg);
    this.emit();
    return assistantMsg;
  }

  private nextChatViewId(session: TaskSession, requestedId: string): string {
    if (!session.views.some((view) => view.id === requestedId)) return requestedId;

    let index = 2;
    let candidate = `${requestedId}-${index}`;
    while (session.views.some((view) => view.id === candidate)) {
      index += 1;
      candidate = `${requestedId}-${index}`;
    }
    return candidate;
  }

  private repairStaticTableFromLatestOutput(session: TaskSession, userText: string, rawView: ChatResult["view"]): NonNullable<ChatResult["view"]> {
    if (!rawView || rawView.type !== "table") return rawView!;
    if (!/\b(table|tabular|columns?|rows?)\b/i.test(userText)) return rawView;

    const latestTextView = [...session.views].reverse().find((view) =>
      (view.type === "log" || view.type === "terminal") && view.content.trim()
    );
    if (!latestTextView || (latestTextView.type !== "log" && latestTextView.type !== "terminal")) return rawView;

    const parsed = parseFixedWidthTable(latestTextView.content);
    if (!parsed) return rawView;

    return {
      ...rawView,
      columns: parsed.columns,
      rows: parsed.rows
    };
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

  private emitCommand(execution: CommandExecution): void {
    for (const listener of this.commandListeners) {
      listener(execution);
    }
  }
}
