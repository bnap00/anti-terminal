import type { ActionInvocation, ChatMessage, CommandExecution, DebugLogEntry, RunResult, SessionSnapshot, TaskSession } from "../main/runtime/types";
import type { AppSettings } from "../main/settings/types";

declare global {
  interface Window {
    antiTerminal: {
      createTask(prompt: string): Promise<TaskSession>;
      runAction(input: ActionInvocation): Promise<SessionSnapshot>;
      stopTask(sessionId: string): Promise<SessionSnapshot>;
      getSessions(): Promise<SessionSnapshot>;
      getDebugLogs(): Promise<DebugLogEntry[]>;
      getSettings(): Promise<AppSettings>;
      updateSettings(next: Partial<AppSettings>): Promise<AppSettings>;
      sendChat(sessionId: string, userText: string): Promise<ChatMessage>;
      openSettingsWindow(): Promise<void>;
      restartTask(sessionId: string): Promise<SessionSnapshot>;
      deleteTask(sessionId: string): Promise<SessionSnapshot>;
      windowMinimize(): Promise<void>;
      windowMaximize(): Promise<void>;
      windowClose(): Promise<void>;
      runShell(command: string, sessionId?: string): Promise<RunResult>;
      getCwd(): Promise<string>;
      startChat(prompt: string): Promise<TaskSession>;
      runDirect(sessionId: string | null, command: string): Promise<TaskSession>;
      approveCommand(commandId: string): Promise<RunResult>;
      denyCommand(commandId: string): Promise<RunResult>;
      stopCommand(commandId: string): Promise<RunResult | undefined>;
      onSettingsUpdate(listener: (settings: AppSettings) => void): () => void;
      onSessionsUpdate(listener: (snapshot: SessionSnapshot) => void): () => void;
      onDebugLog(listener: (entry: DebugLogEntry) => void): () => void;
      onCommandUpdate(listener: (execution: CommandExecution) => void): () => void;
    };
  }
}

export {};
