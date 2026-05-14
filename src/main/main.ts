import { app, BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTaskPlan } from "./planner/index.js";
import { SessionManager } from "./runtime/sessionManager.js";
import { runCommand } from "./runtime/shell.js";
import type { ActionInvocation, DebugLogEntry } from "./runtime/types.js";
import { SettingsManager } from "./settings/settingsManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;

function openSettingsWindow(devServerUrl?: string): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 520,
    height: 780,
    resizable: true,
    title: "Settings — anti terminal",
    backgroundColor: "#0d0e10",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(process.cwd(), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (devServerUrl) {
    void settingsWindow.loadURL(`${devServerUrl}/settings.html`);
  } else {
    void settingsWindow.loadFile(path.join(process.cwd(), "dist-renderer/settings.html"));
  }

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

const debugEntries: DebugLogEntry[] = [];
let sessionManager: SessionManager;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    backgroundColor: "#0d0e10",
    frame: false,
    webPreferences: {
      preload: path.join(process.cwd(), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
    void loadRenderer(mainWindow, devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(process.cwd(), "dist-renderer/index.html"));
  }
}

async function loadRenderer(window: BrowserWindow, url: string, retries = 20): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await window.loadURL(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  throw new Error(`Unable to load renderer at ${url}`);
}

app.whenReady().then(() => {
  const userData = app.getPath("userData");
  const settingsManager = new SettingsManager(path.join(userData, "settings.json"));
  sessionManager = new SessionManager(process.cwd(), path.join(userData, "sessions.json"), emitDebugLog);
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  createWindow();

  const unsubscribe = sessionManager.subscribe((snapshot) => {
    mainWindow?.webContents.send("sessions:update", snapshot);
  });

  void sessionManager.load();

  app.on("before-quit", () => {
    unsubscribe();
  });

  ipcMain.handle("task:create", async (_event, prompt: string) => {
    const sessionId = randomUUID();
    emitDebugLog({
      level: "info",
      scope: "main",
      sessionId,
      message: "Received createTask request.",
      detail: prompt
    });
    const settings = await settingsManager.get();
    emitDebugLog({
      level: "info",
      scope: "main",
      sessionId,
      message: `Loaded settings with provider ${settings.provider}.`,
      detail: settings.providers[settings.provider].model,
    });
    const { plan, source } = await createTaskPlan(prompt, settings, process.cwd(), (entry) => {
      emitDebugLog({
        scope: "planner",
        sessionId,
        ...entry
      });
    });
    emitDebugLog({
      level: "info",
      scope: "main",
      sessionId,
      message: `Planner resolved using ${source}.`,
      detail: `${plan.mode} | ${plan.title}`
    });
    return sessionManager.createSession(prompt, plan, source, sessionId);
  });

  ipcMain.handle("task:action", async (_event, input: ActionInvocation) => {
    await sessionManager.invokeAction(input);
    return sessionManager.getSnapshot();
  });

  ipcMain.handle("task:stop", async (_event, sessionId: string) => {
    sessionManager.stopSession(sessionId);
    return sessionManager.getSnapshot();
  });

  ipcMain.handle("task:restart", async (_event, sessionId: string) => {
    sessionManager.restartSession(sessionId);
    return sessionManager.getSnapshot();
  });

  ipcMain.handle("task:delete", async (_event, sessionId: string) => {
    sessionManager.deleteSession(sessionId);
    return sessionManager.getSnapshot();
  });

  ipcMain.handle("chat:start", async (_event, prompt: string) => {
    const settings = await settingsManager.get();
    return sessionManager.startChat(prompt, settings);
  });

  ipcMain.handle("chat:send", async (_event, sessionId: string, userText: string) => {
    const settings = await settingsManager.get();
    return sessionManager.chat(sessionId, userText, settings);
  });

  ipcMain.handle("settings:open-window", () => {
    openSettingsWindow(devServerUrl);
  });

  ipcMain.handle("sessions:get", async () => sessionManager.getSnapshot());
  ipcMain.handle("settings:get", async () => settingsManager.get());
  ipcMain.handle("settings:update", async (_event, next) => {
    const saved = await settingsManager.update(next);
    mainWindow?.webContents.send("settings:updated", saved);
    return saved;
  });
  ipcMain.handle("cwd:get", () => process.cwd());
  ipcMain.handle("debug:get", async () => debugEntries);

  ipcMain.handle("chat:direct", async (_event, sessionId: string | null, command: string) => {
    return sessionManager.runDirect(sessionId, command);
  });

  ipcMain.handle("shell:run", async (_event, command: string) => {
    return runCommand(command, process.cwd());
  });

  ipcMain.handle("window:minimize", () => { mainWindow?.minimize(); });
  ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle("window:close", () => { mainWindow?.close(); });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function emitDebugLog(entry: Omit<DebugLogEntry, "id" | "at">): void {
  const next: DebugLogEntry = {
    id: randomUUID(),
    at: Date.now(),
    ...entry
  };

  debugEntries.unshift(next);
  if (debugEntries.length > 300) {
    debugEntries.length = 300;
  }

  const line = `[${next.scope}] ${next.message}${next.detail ? ` :: ${next.detail}` : ""}`;
  if (next.level === "error") {
    console.error(line);
  } else if (next.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }

  mainWindow?.webContents.send("debug:log", next);
}
