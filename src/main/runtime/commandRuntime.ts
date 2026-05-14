import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { CommandExecution, CommandRisk, DataSourceSpec, RunResult } from "./types.js";

const COMMAND_TIMEOUT_MS = 10 * 60_000;

export interface CommandRequest {
  sessionId?: string;
  viewId?: string;
  command: string;
  cwd: string;
  parser?: DataSourceSpec["parser"];
  requireApproval?: boolean;
}

interface RuntimeHandlers {
  onCreate?: (execution: CommandExecution) => void;
  onUpdate?: (execution: CommandExecution) => void;
  onChunk?: (execution: CommandExecution, stream: "stdout" | "stderr", chunk: string) => void;
}

interface PendingCommand {
  request: CommandRequest;
  execution: CommandExecution;
  resolve: (result: RunResult) => void;
}

export class CommandRuntime {
  private readonly pending = new Map<string, PendingCommand>();
  private readonly running = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly executions = new Map<string, CommandExecution>();

  constructor(private readonly handlers: RuntimeHandlers = {}) {}

  run(request: CommandRequest): Promise<RunResult> {
    const riskInfo = classifyCommand(request.command);
    const needsApproval = request.requireApproval ?? riskInfo.risk !== "read";
    const now = Date.now();
    const execution: CommandExecution = {
      commandId: randomUUID(),
      sessionId: request.sessionId,
      viewId: request.viewId,
      command: request.command,
      cwd: request.cwd,
      parser: request.parser,
      status: needsApproval ? "pending-approval" : "running",
      startedAt: now,
      stdout: "",
      stderr: "",
      code: null,
      signal: null,
      risk: riskInfo.risk,
      riskReason: riskInfo.reason,
      approvedByUser: !needsApproval
    };

    this.executions.set(execution.commandId, execution);
    this.handlers.onCreate?.(structuredClone(execution));

    if (needsApproval) {
      return new Promise((resolve) => {
        this.pending.set(execution.commandId, { request, execution, resolve });
        resolve(toResult(execution));
      });
    }

    return this.spawnExecution(request, execution);
  }

  approve(commandId: string): Promise<RunResult> {
    const pending = this.pending.get(commandId);
    if (!pending) {
      const existing = this.executions.get(commandId);
      return Promise.resolve(toResult(existing));
    }

    this.pending.delete(commandId);
    pending.execution.status = "running";
    pending.execution.approvedByUser = true;
    pending.execution.startedAt = Date.now();
    this.handlers.onUpdate?.(structuredClone(pending.execution));

    const promise = this.spawnExecution(pending.request, pending.execution);
    void promise.then(pending.resolve);
    return promise;
  }

  deny(commandId: string): RunResult {
    const pending = this.pending.get(commandId);
    const execution = pending?.execution ?? this.executions.get(commandId);
    if (!execution) {
      return {
        commandId,
        status: "denied",
        startedAt: Date.now(),
        endedAt: Date.now(),
        stdout: "",
        stderr: "Command denied.",
        code: 126,
        signal: null,
        risk: "unknown",
        approvedByUser: false
      };
    }

    this.pending.delete(commandId);
    execution.status = "denied";
    execution.endedAt = Date.now();
    execution.stderr = "Command denied.";
    execution.code = 126;
    this.handlers.onUpdate?.(structuredClone(execution));
    pending?.resolve(toResult(execution));
    return toResult(execution);
  }

  stop(commandId: string): RunResult | undefined {
    const child = this.running.get(commandId);
    const execution = this.executions.get(commandId);

    if (child && execution) {
      child.kill("SIGTERM");
      return toResult(execution);
    }

    const pending = this.pending.get(commandId);
    if (pending) {
      this.pending.delete(commandId);
      pending.execution.status = "stopped";
      pending.execution.endedAt = Date.now();
      pending.execution.code = 130;
      pending.execution.stderr = "Command stopped before approval.";
      this.handlers.onUpdate?.(structuredClone(pending.execution));
      pending.resolve(toResult(pending.execution));
      return toResult(pending.execution);
    }

    return execution ? toResult(execution) : undefined;
  }

  stopSession(sessionId: string): void {
    for (const execution of this.executions.values()) {
      if (execution.sessionId === sessionId && (execution.status === "running" || execution.status === "pending-approval")) {
        this.stop(execution.commandId);
      }
    }
  }

  private spawnExecution(request: CommandRequest, execution: CommandExecution): Promise<RunResult> {
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(request.command, {
        cwd: request.cwd,
        shell: "/bin/zsh",
        env: process.env
      });

      this.running.set(execution.commandId, child);

      const timeout = setTimeout(() => {
        if (!settled) {
          execution.status = "timed-out";
          child.kill("SIGTERM");
        }
      }, COMMAND_TIMEOUT_MS);

      child.stdout.on("data", (buffer: Buffer) => {
        const chunk = buffer.toString();
        execution.stdout += chunk;
        this.handlers.onChunk?.(structuredClone(execution), "stdout", chunk);
      });

      child.stderr.on("data", (buffer: Buffer) => {
        const chunk = buffer.toString();
        execution.stderr += chunk;
        this.handlers.onChunk?.(structuredClone(execution), "stderr", chunk);
      });

      child.on("error", (error) => {
        execution.stderr += `${error.message}\n`;
      });

      child.on("close", (code, signal) => {
        settled = true;
        clearTimeout(timeout);
        this.running.delete(execution.commandId);
        execution.endedAt = Date.now();
        execution.code = code;
        execution.signal = signal;
        if (execution.status === "timed-out") {
          execution.code = 124;
          execution.stderr = `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.\n${execution.stderr}`;
        } else if (signal) {
          execution.status = "stopped";
          execution.code = code ?? 130;
        } else {
          execution.status = code === 0 ? "completed" : "failed";
        }
        this.handlers.onUpdate?.(structuredClone(execution));
        resolve(toResult(execution));
      });
    });
  }
}

export function classifyCommand(command: string): { risk: CommandRisk; reason: string } {
  const normalized = command.trim();
  const lower = normalized.toLowerCase();
  const riskText = lower.replace(/\b[12]?>\s*\/dev\/null\b/g, "");
  const first = lower.split(/\s+/)[0] ?? "";

  if (!normalized) return { risk: "unknown", reason: "Empty command." };

  if (/\brm\s+(-[^\s]*r|-[^\s]*f|--recursive|--force)\b/.test(lower) || /\b(shred|mkfs|diskutil|dd)\b/.test(lower)) {
    return { risk: "destructive", reason: "Command may delete or overwrite files or disks." };
  }

  if (/\b(npm|pnpm|yarn|bun|pip|pip3|brew|apt|apt-get|curl|wget)\b/.test(lower) && /\b(install|add|update|upgrade|i|exec|x|dlx)\b/.test(lower)) {
    return { risk: "network/install", reason: "Command may download code or install packages." };
  }

  if (/[>|]\s*(tee|xargs)\b/.test(riskText) || /\b(touch|mkdir|mv|cp|chmod|chown|ln|git\s+(commit|push|pull|merge|rebase|checkout|switch|reset|clean|apply)|npm\s+version)\b/.test(riskText)) {
    return { risk: "write", reason: "Command may change files, permissions, or repository state." };
  }

  if (/[>]{1,2}/.test(riskText) || /\b(sed\s+-i|perl\s+-pi|python\d?\s+-c|node\s+-e)\b/.test(riskText)) {
    return { risk: "write", reason: "Command may write to the filesystem." };
  }

  const readCommands = new Set([
    "ls", "ll", "la", "pwd", "cat", "sed", "awk", "grep", "rg", "find", "du", "df", "ps", "top",
    "head", "tail", "wc", "sort", "uniq", "date", "whoami", "uname", "hostname", "id", "env",
    "printenv", "git", "docker", "docker-compose", "kubectl"
  ]);

  if (readCommands.has(first)) {
    if (first === "git" && /\b(add|commit|push|pull|merge|rebase|checkout|switch|reset|clean|apply)\b/.test(lower)) {
      return { risk: "write", reason: "Git command may change repository state." };
    }
    return { risk: "read", reason: "Command appears read-only." };
  }

  return { risk: "unknown", reason: "Command risk could not be classified confidently." };
}

function toResult(execution?: CommandExecution): RunResult {
  if (!execution) {
    return { stdout: "", stderr: "Command not found.", code: 127, status: "failed" };
  }

  return {
    commandId: execution.commandId,
    status: execution.status,
    startedAt: execution.startedAt,
    endedAt: execution.endedAt,
    stdout: execution.stdout,
    stderr: execution.stderr,
    code: execution.code,
    signal: execution.signal,
    risk: execution.risk,
    approvedByUser: execution.approvedByUser
  };
}
