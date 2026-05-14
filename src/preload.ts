import { contextBridge, ipcRenderer } from "electron";

import type { ActionInvocation, ChatMessage, DebugLogEntry, RunResult, SessionSnapshot, TaskSession } from "./main/runtime/types.js";
import type { AppSettings } from "./main/settings/types.js";

type Listener = (snapshot: SessionSnapshot) => void;
type DebugListener = (entry: DebugLogEntry) => void;

contextBridge.exposeInMainWorld("antiTerminal", {
  createTask(prompt: string): Promise<TaskSession> {
    return ipcRenderer.invoke("task:create", prompt);
  },
  runAction(input: ActionInvocation): Promise<SessionSnapshot> {
    return ipcRenderer.invoke("task:action", input);
  },
  stopTask(sessionId: string): Promise<SessionSnapshot> {
    return ipcRenderer.invoke("task:stop", sessionId);
  },
  getSessions(): Promise<SessionSnapshot> {
    return ipcRenderer.invoke("sessions:get");
  },
  getDebugLogs(): Promise<DebugLogEntry[]> {
    return ipcRenderer.invoke("debug:get");
  },
  getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke("settings:get");
  },
  updateSettings(next: Partial<AppSettings>): Promise<AppSettings> {
    return ipcRenderer.invoke("settings:update", next);
  },
  sendChat(sessionId: string, userText: string): Promise<ChatMessage> {
    return ipcRenderer.invoke("chat:send", sessionId, userText);
  },
  openSettingsWindow(): Promise<void> {
    return ipcRenderer.invoke("settings:open-window");
  },
  restartTask(sessionId: string): Promise<SessionSnapshot> {
    return ipcRenderer.invoke("task:restart", sessionId);
  },
  deleteTask(sessionId: string): Promise<SessionSnapshot> {
    return ipcRenderer.invoke("task:delete", sessionId);
  },
  onSessionsUpdate(listener: Listener): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: SessionSnapshot) => {
      listener(snapshot);
    };

    ipcRenderer.on("sessions:update", wrapped);
    return () => {
      ipcRenderer.removeListener("sessions:update", wrapped);
    };
  },
  runShell(command: string): Promise<RunResult> {
    return ipcRenderer.invoke("shell:run", command);
  },
  getCwd(): Promise<string> {
    return ipcRenderer.invoke("cwd:get");
  },
  runDirect(sessionId: string | null, command: string): Promise<TaskSession> {
    return ipcRenderer.invoke("chat:direct", sessionId, command);
  },
  onSettingsUpdate(listener: (settings: AppSettings) => void): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, s: AppSettings) => listener(s);
    ipcRenderer.on("settings:updated", wrapped);
    return () => ipcRenderer.removeListener("settings:updated", wrapped);
  },
  windowMinimize(): Promise<void> { return ipcRenderer.invoke("window:minimize"); },
  windowMaximize(): Promise<void> { return ipcRenderer.invoke("window:maximize"); },
  windowClose(): Promise<void> { return ipcRenderer.invoke("window:close"); },
  onDebugLog(listener: DebugListener): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, entry: DebugLogEntry) => {
      listener(entry);
    };

    ipcRenderer.on("debug:log", wrapped);
    return () => {
      ipcRenderer.removeListener("debug:log", wrapped);
    };
  }
});
