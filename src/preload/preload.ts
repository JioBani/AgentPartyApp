import { contextBridge, ipcRenderer } from "electron";

const api = {
  getInitialState: () => ipcRenderer.invoke("app:getInitialState"),
  updateSettings: (patch: unknown) => ipcRenderer.invoke("settings:update", patch),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  listAuth: () => ipcRenderer.invoke("auth:list"),
  setOpenRouterKey: (value: string) => ipcRenderer.invoke("auth:setOpenRouterKey", value),
  clearOpenRouterKey: () => ipcRenderer.invoke("auth:clearOpenRouterKey"),
  testOpenRouterKey: () => ipcRenderer.invoke("auth:testOpenRouterKey"),
  listModels: () => ipcRenderer.invoke("models:list"),
  refreshCodexModels: () => ipcRenderer.invoke("models:refreshCodex"),
  getUsageLimits: () => ipcRenderer.invoke("usage:get"),
  refreshUsageLimits: () => ipcRenderer.invoke("usage:refresh"),
  createSession: (input?: unknown) => ipcRenderer.invoke("session:create", input),
  listResumableSessions: (workspacePath?: string) => ipcRenderer.invoke("session:listResumable", workspacePath),
  resumeSession: (sessionId: string, workspacePath?: string) => ipcRenderer.invoke("session:resume", sessionId, workspacePath),
  closeSession: (sessionId: string) => ipcRenderer.invoke("session:close", sessionId),
  sendMessage: (sessionId: string, text: string, attachments?: unknown) => ipcRenderer.invoke("session:send", sessionId, text, attachments),
  interrupt: (sessionId: string) => ipcRenderer.invoke("session:interrupt", sessionId),
  restart: (sessionId: string) => ipcRenderer.invoke("session:restart", sessionId),
  compact: (sessionId: string) => ipcRenderer.invoke("session:compact", sessionId),
  setModel: (sessionId: string, model: string, providerId?: string, runtimeModel?: string) => ipcRenderer.invoke("session:setModel", sessionId, model, providerId, runtimeModel),
  setEffort: (sessionId: string, effort: string) => ipcRenderer.invoke("session:setEffort", sessionId, effort),
  setThinking: (sessionId: string, mode: string, budget?: number) => ipcRenderer.invoke("session:setThinking", sessionId, mode, budget),
  setPermissionMode: (sessionId: string, permissionMode: string) => ipcRenderer.invoke("session:setPermissionMode", sessionId, permissionMode),
  setCodexPolicy: (sessionId: string, policy: unknown) => ipcRenderer.invoke("session:setCodexPolicy", sessionId, policy),
  approve: (sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string) => ipcRenderer.invoke("session:approve", sessionId, requestId, behavior, updatedInput, message),
  listMcpServers: (sessionId: string) => ipcRenderer.invoke("session:mcpList", sessionId),
  reconnectMcpServer: (sessionId: string, server: string) => ipcRenderer.invoke("session:mcpReconnect", sessionId, server),
  setMcpServerEnabled: (sessionId: string, server: string, enabled: boolean) => ipcRenderer.invoke("session:mcpToggle", sessionId, server, enabled),
  authenticateMcpServer: (sessionId: string, server: string) => ipcRenderer.invoke("session:mcpAuthenticate", sessionId, server),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  maximizeWindow: () => ipcRenderer.invoke("window:maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  newWindow: (workspacePath?: string) => ipcRenderer.invoke("window:new", workspacePath),
  listWindows: () => ipcRenderer.invoke("window:list"),
  listParty: () => ipcRenderer.invoke("party:list"),
  createParty: (input: unknown) => ipcRenderer.invoke("party:createParty", input),
  selectParty: (partyId: string) => ipcRenderer.invoke("party:select", partyId),
  deleteParty: (partyId: string) => ipcRenderer.invoke("party:deleteParty", partyId),
  createPartyMember: (input: unknown) => ipcRenderer.invoke("party:create", input),
  sendPartyMessage: (to: string, content: string, from?: string, attachments?: unknown) => ipcRenderer.invoke("party:send", to, content, from, attachments),
  sendMemberMessage: (name: string, text: string, attachments?: unknown) => ipcRenderer.invoke("party:message", name, text, attachments),
  bindPartyMember: (name: string, sessionId: string) => ipcRenderer.invoke("party:bind", name, sessionId),
  openPartyMember: (name: string) => ipcRenderer.invoke("party:open", name),
  closePartyMember: (name: string) => ipcRenderer.invoke("party:close", name),
  resumePartyMember: (name: string) => ipcRenderer.invoke("party:resume", name),
  respawnPartyMember: (name: string, input?: unknown) => ipcRenderer.invoke("party:respawn", name, input),
  startPartyMember: (name: string, input?: unknown) => ipcRenderer.invoke("party:start", name, input),
  removePartyMember: (name: string) => ipcRenderer.invoke("party:remove", name),
  getMemberTranscript: (name: string) => ipcRenderer.invoke("party:transcript:get", name),
  saveMemberTranscript: (name: string, blocks: unknown[]) => ipcRenderer.invoke("party:transcript:save", name, blocks),
  onSessionEvents: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("session:events", listener);
    return () => ipcRenderer.off("session:events", listener);
  },
  onSnapshot: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("session:snapshot", listener);
    return () => ipcRenderer.off("session:snapshot", listener);
  },
  onSessions: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("session:list", listener);
    return () => ipcRenderer.off("session:list", listener);
  },
  onPartyUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("party:update", listener);
    return () => ipcRenderer.off("party:update", listener);
  },
  onModelsUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("models:update", listener);
    return () => ipcRenderer.off("models:update", listener);
  },
  onSettingsUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("settings:update", listener);
    return () => ipcRenderer.off("settings:update", listener);
  },
  onUsageUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("usage:update", listener);
    return () => ipcRenderer.off("usage:update", listener);
  },
  onQaLayout: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("qa:layout", listener);
    return () => ipcRenderer.off("qa:layout", listener);
  },
  onQaOpenSubagent: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("qa:open-subagent", listener);
    return () => ipcRenderer.off("qa:open-subagent", listener);
  },
  onNavigate: (callback: (view: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, view: string) => callback(view);
    ipcRenderer.on("nav:set", listener);
    return () => ipcRenderer.off("nav:set", listener);
  },
  onWorkspaceChoose: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("workspace:choose", listener);
    return () => ipcRenderer.off("workspace:choose", listener);
  },
  onNewSession: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("session:new", listener);
    return () => ipcRenderer.off("session:new", listener);
  },
  onRefreshHistory: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("session:refreshHistory", listener);
    return () => ipcRenderer.off("session:refreshHistory", listener);
  },
};

contextBridge.exposeInMainWorld("agentParty", api);

export type AgentPartyApi = typeof api;
