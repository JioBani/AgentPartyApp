import { contextBridge, ipcRenderer } from "electron";

const api = {
  getInitialState: () => ipcRenderer.invoke("app:getInitialState"),
  updateSettings: (patch: unknown) => ipcRenderer.invoke("settings:update", patch),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  listAuth: () => ipcRenderer.invoke("auth:list"),
  setOpenRouterKey: (value: string) => ipcRenderer.invoke("auth:setOpenRouterKey", value),
  clearOpenRouterKey: () => ipcRenderer.invoke("auth:clearOpenRouterKey"),
  testOpenRouterKey: () => ipcRenderer.invoke("auth:testOpenRouterKey"),
  createSession: (input?: unknown) => ipcRenderer.invoke("session:create", input),
  listResumableSessions: (workspacePath?: string) => ipcRenderer.invoke("session:listResumable", workspacePath),
  resumeSession: (sessionId: string, workspacePath?: string) => ipcRenderer.invoke("session:resume", sessionId, workspacePath),
  closeSession: (sessionId: string) => ipcRenderer.invoke("session:close", sessionId),
  sendMessage: (sessionId: string, text: string) => ipcRenderer.invoke("session:send", sessionId, text),
  interrupt: (sessionId: string) => ipcRenderer.invoke("session:interrupt", sessionId),
  restart: (sessionId: string) => ipcRenderer.invoke("session:restart", sessionId),
  compact: (sessionId: string) => ipcRenderer.invoke("session:compact", sessionId),
  setModel: (sessionId: string, model: string, providerId?: string, runtimeModel?: string) => ipcRenderer.invoke("session:setModel", sessionId, model, providerId, runtimeModel),
  setEffort: (sessionId: string, effort: string) => ipcRenderer.invoke("session:setEffort", sessionId, effort),
  setPermissionMode: (sessionId: string, permissionMode: string) => ipcRenderer.invoke("session:setPermissionMode", sessionId, permissionMode),
  approve: (sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string) => ipcRenderer.invoke("session:approve", sessionId, requestId, behavior, updatedInput, message),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  maximizeWindow: () => ipcRenderer.invoke("window:maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  newWindow: (workspacePath?: string) => ipcRenderer.invoke("window:new", workspacePath),
  listWindows: () => ipcRenderer.invoke("window:list"),
  listParty: () => ipcRenderer.invoke("party:list"),
  createParty: (input: unknown) => ipcRenderer.invoke("party:createParty", input),
  selectParty: (partyId: string) => ipcRenderer.invoke("party:select", partyId),
  createPartyMember: (input: unknown) => ipcRenderer.invoke("party:create", input),
  sendPartyMessage: (to: string, content: string, from?: string) => ipcRenderer.invoke("party:send", to, content, from),
  bindPartyMember: (name: string, sessionId: string) => ipcRenderer.invoke("party:bind", name, sessionId),
  openPartyMember: (name: string) => ipcRenderer.invoke("party:open", name),
  closePartyMember: (name: string) => ipcRenderer.invoke("party:close", name),
  resumePartyMember: (name: string) => ipcRenderer.invoke("party:resume", name),
  startPartyMember: (name: string, input?: unknown) => ipcRenderer.invoke("party:start", name, input),
  removePartyMember: (name: string) => ipcRenderer.invoke("party:remove", name),
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
  onQaLayout: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("qa:layout", listener);
    return () => ipcRenderer.off("qa:layout", listener);
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
