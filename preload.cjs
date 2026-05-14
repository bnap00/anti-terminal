const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("antiTerminal", {
  createTask(prompt) {
    return ipcRenderer.invoke("task:create", prompt);
  },
  runAction(input) {
    return ipcRenderer.invoke("task:action", input);
  },
  stopTask(sessionId) {
    return ipcRenderer.invoke("task:stop", sessionId);
  },
  sendChat(sessionId, userText) {
    return ipcRenderer.invoke("chat:send", sessionId, userText);
  },
  openSettingsWindow() {
    return ipcRenderer.invoke("settings:open-window");
  },
  restartTask(sessionId) {
    return ipcRenderer.invoke("task:restart", sessionId);
  },
  deleteTask(sessionId) {
    return ipcRenderer.invoke("task:delete", sessionId);
  },
  getSessions() {
    return ipcRenderer.invoke("sessions:get");
  },
  getDebugLogs() {
    return ipcRenderer.invoke("debug:get");
  },
  getSettings() {
    return ipcRenderer.invoke("settings:get");
  },
  updateSettings(next) {
    return ipcRenderer.invoke("settings:update", next);
  },
  runShell(command, sessionId) {
    return sessionId
      ? ipcRenderer.invoke("shell:run-for-session", sessionId, command)
      : ipcRenderer.invoke("shell:run", command);
  },
  getCwd() {
    return ipcRenderer.invoke("cwd:get");
  },
  startChat(prompt) {
    return ipcRenderer.invoke("chat:start", prompt);
  },
  runDirect(sessionId, command) {
    return ipcRenderer.invoke("chat:direct", sessionId, command);
  },
  approveCommand(commandId) {
    return ipcRenderer.invoke("command:approve", commandId);
  },
  denyCommand(commandId) {
    return ipcRenderer.invoke("command:deny", commandId);
  },
  stopCommand(commandId) {
    return ipcRenderer.invoke("command:stop", commandId);
  },
  onSettingsUpdate(listener) {
    const wrapped = (_event, s) => listener(s);
    ipcRenderer.on("settings:updated", wrapped);
    return () => ipcRenderer.removeListener("settings:updated", wrapped);
  },
  windowMinimize() {
    return ipcRenderer.invoke("window:minimize");
  },
  windowMaximize() {
    return ipcRenderer.invoke("window:maximize");
  },
  windowClose() {
    return ipcRenderer.invoke("window:close");
  },
  onSessionsUpdate(listener) {
    const wrapped = (_event, snapshot) => {
      listener(snapshot);
    };

    ipcRenderer.on("sessions:update", wrapped);
    return () => {
      ipcRenderer.removeListener("sessions:update", wrapped);
    };
  },
  onDebugLog(listener) {
    const wrapped = (_event, entry) => {
      listener(entry);
    };

    ipcRenderer.on("debug:log", wrapped);
    return () => {
      ipcRenderer.removeListener("debug:log", wrapped);
    };
  },
  onCommandUpdate(listener) {
    const wrapped = (_event, execution) => {
      listener(execution);
    };

    ipcRenderer.on("command:update", wrapped);
    return () => {
      ipcRenderer.removeListener("command:update", wrapped);
    };
  }
});
