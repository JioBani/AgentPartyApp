import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DiagnosticsReport } from "../shared/diagnostics";
import type { EnvironmentReport } from "../shared/environment";
import type { TranscriptSave, TranscriptSaveResult } from "../shared/types";
import type { QueueCommand } from "../shared/messageQueue";
import type { WorkbenchLayout } from "../shared/workbenchLayout";

const api = {
  /**
   * The absolute path of a dropped or picked `File`. Electron 32 removed the
   * non-standard `File.path`, and `webUtils` is not reachable from the isolated
   * renderer world — so this bridge is the only way the UI can turn a dropped
   * file into a path to hand a member. Throws for a file with no path on disk
   * (e.g. one synthesized in the page); the caller reports that per file rather
   * than dropping it silently.
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  getInitialState: () => ipcRenderer.invoke("app:getInitialState"),
  updateSettings: (patch: unknown) => ipcRenderer.invoke("settings:update", patch),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  listAuth: () => ipcRenderer.invoke("auth:list"),
  setDeepseekKey: (value: string) => ipcRenderer.invoke("auth:setDeepseekKey", value),
  clearDeepseekKey: () => ipcRenderer.invoke("auth:clearDeepseekKey"),
  testDeepseekKey: () => ipcRenderer.invoke("auth:testDeepseekKey"),
  setOpenRouterKey: (value: string) => ipcRenderer.invoke("auth:setOpenRouterKey", value),
  clearOpenRouterKey: () => ipcRenderer.invoke("auth:clearOpenRouterKey"),
  testOpenRouterKey: () => ipcRenderer.invoke("auth:testOpenRouterKey"),
  loginSubscription: (provider: "codex" | "claude") => ipcRenderer.invoke("auth:loginSubscription", provider),
  disconnectSubscription: (provider: "codex" | "claude" | "cursor") => ipcRenderer.invoke("auth:disconnectSubscription", provider),
  listModels: () => ipcRenderer.invoke("models:list"),
  refreshCodexModels: () => ipcRenderer.invoke("models:refreshCodex"),
  getDiscordStatus: () => ipcRenderer.invoke("discord:get"),
  updateDiscordSettings: (patch: unknown) => ipcRenderer.invoke("discord:update", patch),
  getUsageLimits: () => ipcRenderer.invoke("usage:get"),
  refreshUsageLimits: () => ipcRenderer.invoke("usage:refresh"),
  getTokenUsage: (query: unknown) => ipcRenderer.invoke("tokenUsage:get", query),
  getTokenUsageTurns: (query: unknown) => ipcRenderer.invoke("tokenUsage:turns", query),
  createSession: (input?: unknown) => ipcRenderer.invoke("session:create", input),
  listResumableSessions: (workspacePath?: string) => ipcRenderer.invoke("session:listResumable", workspacePath),
  resumeSession: (sessionId: string, workspacePath?: string) => ipcRenderer.invoke("session:resume", sessionId, workspacePath),
  closeSession: (sessionId: string) => ipcRenderer.invoke("session:close", sessionId),
  sendMessage: (sessionId: string, text: string, attachments?: unknown) => ipcRenderer.invoke("session:send", sessionId, text, attachments),
  interrupt: (sessionId: string) => ipcRenderer.invoke("session:interrupt", sessionId),
  forceStop: (sessionId: string) => ipcRenderer.invoke("session:forceStop", sessionId),
  restart: (sessionId: string) => ipcRenderer.invoke("session:restart", sessionId),
  compact: (sessionId: string) => ipcRenderer.invoke("session:compact", sessionId),
  setModel: (sessionId: string, model: string, providerId?: string, runtimeModel?: string) => ipcRenderer.invoke("session:setModel", sessionId, model, providerId, runtimeModel),
  setEffort: (sessionId: string, effort: string) => ipcRenderer.invoke("session:setEffort", sessionId, effort),
  setThinking: (sessionId: string, mode: string, budget?: number) => ipcRenderer.invoke("session:setThinking", sessionId, mode, budget),
  setPermissionMode: (sessionId: string, permissionMode: string) => ipcRenderer.invoke("session:setPermissionMode", sessionId, permissionMode),
  setCodexPolicy: (sessionId: string, policy: unknown) => ipcRenderer.invoke("session:setCodexPolicy", sessionId, policy),
  setCursorPolicy: (sessionId: string, policy: unknown) => ipcRenderer.invoke("session:setCursorPolicy", sessionId, policy),
  approve: (sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string) => ipcRenderer.invoke("session:approve", sessionId, requestId, behavior, updatedInput, message),
  listMcpServers: (sessionId: string) => ipcRenderer.invoke("session:mcpList", sessionId),
  reconnectMcpServer: (sessionId: string, server: string) => ipcRenderer.invoke("session:mcpReconnect", sessionId, server),
  setMcpServerEnabled: (sessionId: string, server: string, enabled: boolean) => ipcRenderer.invoke("session:mcpToggle", sessionId, server, enabled),
  authenticateMcpServer: (sessionId: string, server: string) => ipcRenderer.invoke("session:mcpAuthenticate", sessionId, server),
  getDiagnostics: (): Promise<DiagnosticsReport> => ipcRenderer.invoke("diagnostics:get"),
  /** Readiness of this machine's harnesses. `includeWsl` boots distros, so it is opt-in. */
  getEnvironment: (options?: { refresh?: boolean; includeWsl?: boolean }): Promise<EnvironmentReport> =>
    ipcRenderer.invoke("environment:get", options || {}),
  /**
   * Applies a fix the report offered, by id — never a command string. Resolves
   * with the post-repair report so the caller re-renders from one source.
   */
  repairEnvironment: (repairId: string): Promise<{ ok: boolean; detail: string; output?: string; report: EnvironmentReport }> =>
    ipcRenderer.invoke("environment:repair", repairId),
  /** Reveals the log folder. Rejects with the OS reason when it cannot open. */
  openLogFolder: (): Promise<{ ok: true; path: string }> => ipcRenderer.invoke("diagnostics:openLogFolder"),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  /** Opens a local file with its default app, or reveals it when there is none. */
  openPath: (target: string) => ipcRenderer.invoke("shell:openPath", target),
  /** Shows a local file in the OS file manager without opening it. */
  revealPath: (target: string) => ipcRenderer.invoke("shell:openPath", target, { reveal: true }),
  // `mediaType` is optional because the main process sniffs the real format off
  // the bytes — an image copied from a remote URL may not declare one.
  copyImageToClipboard: (image: { dataBase64: string; mediaType?: string }) => ipcRenderer.invoke("clipboard:writeImage", image),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  maximizeWindow: () => ipcRenderer.invoke("window:maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  newWindow: (workspacePath?: string, partyId?: string) => ipcRenderer.invoke("window:new", workspacePath, partyId),
  listWindows: () => ipcRenderer.invoke("window:list"),
  listParty: () => ipcRenderer.invoke("party:list"),
  createParty: (input: unknown) => ipcRenderer.invoke("party:createParty", input),
  selectParty: (partyId: string) => ipcRenderer.invoke("party:select", partyId),
  deleteParty: (partyId: string) => ipcRenderer.invoke("party:deleteParty", partyId),
  createPartyMember: (input: unknown) => ipcRenderer.invoke("party:create", input),
  sendPartyMessage: (to: string, content: string, from?: string, attachments?: unknown) => ipcRenderer.invoke("party:send", to, content, from, attachments),
  sendMemberMessage: (name: string, text: string, attachments?: unknown, options?: { interrupt?: boolean }) => ipcRenderer.invoke("party:message", name, text, attachments, options),
  /** Messages a busy member has been sent but has not been handed yet (shared/messageQueue.ts). */
  getMemberQueue: (name: string) => ipcRenderer.invoke("party:queue:get", name),
  /** Every queue mutation, as one discriminated action — the same path the HTTP API drives. */
  runQueueCommand: (name: string, command: QueueCommand) => ipcRenderer.invoke("party:queue:command", name, command),
  bindPartyMember: (name: string, sessionId: string) => ipcRenderer.invoke("party:bind", name, sessionId),
  openPartyMember: (name: string) => ipcRenderer.invoke("party:open", name),
  closePartyMember: (name: string) => ipcRenderer.invoke("party:close", name),
  resumePartyMember: (name: string) => ipcRenderer.invoke("party:resume", name),
  respawnPartyMember: (name: string, input?: unknown) => ipcRenderer.invoke("party:respawn", name, input),
  startPartyMember: (name: string, input?: unknown) => ipcRenderer.invoke("party:start", name, input),
  removePartyMember: (name: string) => ipcRenderer.invoke("party:remove", name),
  setMemberAutoCompact: (name: string, autoCompact: unknown) => ipcRenderer.invoke("party:autoCompact", name, autoCompact),
  setMemberKeepAwake: (name: string, keepAwake: boolean) => ipcRenderer.invoke("party:keepAwake", name, keepAwake),
  sleepPartyMember: (name: string) => ipcRenderer.invoke("party:sleep", name),
  wakePartyMember: (name: string) => ipcRenderer.invoke("party:wake", name),
  setMemberPermission: (name: string, permission: unknown) => ipcRenderer.invoke("party:permission", name, permission),
  setMemberGate: (name: string, gate: unknown) => ipcRenderer.invoke("party:gate", name, gate),
  setMemberOutboundInterrupt: (name: string, outboundInterrupt: boolean | null) => ipcRenderer.invoke("party:outbound-interrupt", name, outboundInterrupt),
  setPartyGate: (partyId: string, gate: unknown) => ipcRenderer.invoke("party:partyGate", partyId, gate),
  getPartyLayout: (): Promise<WorkbenchLayout | undefined> => ipcRenderer.invoke("party:layout:get"),
  setPartyLayout: (layout: WorkbenchLayout) => ipcRenderer.invoke("party:layout:set", layout),
  getMemberTranscript: (name: string) => ipcRenderer.invoke("party:transcript:get", name),
  saveMemberTranscript: (name: string, save: TranscriptSave): Promise<TranscriptSaveResult> => ipcRenderer.invoke("party:transcript:save", name, save),
  /** Bytes for one screenshot a transcript references, fetched only when shown. */
  getTranscriptImage: (file: string): Promise<{ ok: true; dataUrl: string; bytes: number }> => ipcRenderer.invoke("party:transcript:image", file),
  /** Where the harness keeps its own untrimmed copy of this member's conversation. */
  getHarnessOriginal: (name: string): Promise<{ ok: true; original: { harness: string; path: string; exists: boolean; bytes?: number } | null }> => ipcRenderer.invoke("party:harness-original", name),
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
  /** Another window on this party changed the tab layout. */
  onPartyLayout: (callback: (payload: { partyId: string; layout: WorkbenchLayout }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { partyId: string; layout: WorkbenchLayout }) => callback(payload);
    ipcRenderer.on("party:layout", listener);
    return () => ipcRenderer.off("party:layout", listener);
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
  onAuthUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("auth:update", listener);
    return () => ipcRenderer.off("auth:update", listener);
  },
  onDiscordUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("discord:update", listener);
    return () => ipcRenderer.off("discord:update", listener);
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
  onQaOpenGate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("qa:open-gate", listener);
    return () => ipcRenderer.off("qa:open-gate", listener);
  },
  /** `{view, tab?}` — `tab` lands the runtime screen on one of its tabs. */
  onNavigate: (callback: (payload: { view: string; tab?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { view: string; tab?: string }) => callback(payload);
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
