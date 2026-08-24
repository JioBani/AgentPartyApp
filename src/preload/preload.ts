import { contextBridge, ipcRenderer, webUtils } from "electron";
import { parseAppearanceBootArgs } from "../shared/appTheme";
import type { DiagnosticsReport } from "../shared/diagnostics";
import type { EnvironmentReport } from "../shared/environment";
import type { InitialAppState, NativeCliAuthHost, NativeCliAuthProgress, NativeCliAuthProvider, NativeCliAuthTestResult, TranscriptSave, TranscriptSaveResult } from "../shared/types";
import type { QueueCommand } from "../shared/messageQueue";
import type { WorkbenchLayout } from "../shared/workbenchLayout";
import type { ReleaseSummary, UpdateChannel, UpdateStatus } from "../shared/appUpdate";
import type { GatewayStatus, MobileConnectionLockKind, MobileConnectionLockStatus, MobileSettings, NatDiagnostics, TrustedDevice } from "../shared/mobileProtocol";
import type { ApprovalDelivery, ApprovalResponseResult } from "../shared/approvals";
import type { CliContinuationAction, CliContinuationResult } from "../shared/cliContinuation";
import type { GuideScreenInfo } from "../shared/guide";
import type { GuideHostApi } from "../shared/guideHost";

const appearanceBoot = parseAppearanceBootArgs(process.argv)
  || ipcRenderer.sendSync("appearance:boot");
if (appearanceBoot) {
  contextBridge.exposeInMainWorld("agentPartyAppearanceBoot", appearanceBoot);
}

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
  setLocale: (locale: string) => ipcRenderer.invoke("locale:set", locale),
  getAppearance: () => ipcRenderer.invoke("appearance:get"),
  setTheme: (theme: unknown) => ipcRenderer.invoke("appearance:set", theme),
  appearanceReady: () => ipcRenderer.send("appearance:ready"),
  /** Edits ONE section of the member primer (Agent → 파티 프롬프트). */
  savePartyPrimerSection: (patch: unknown) => ipcRenderer.invoke("party:primer:save", patch),
  /** Translates (or clears the translation of) one primer section. */
  translatePartyPrimerSection: (patch: unknown) => ipcRenderer.invoke("party:primer:translate", patch),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  // 파티 그룹 · 멤버 실행 위치(cwd). Each is the same AppController method the
  // HTTP route calls, so the UI and an agent drive one implementation.
  listPartyGroups: () => ipcRenderer.invoke("partyGroups:list"),
  switchWorkspace: (workspacePath: string): Promise<InitialAppState | undefined> =>
    ipcRenderer.invoke("workspace:switch", workspacePath),
  createPartyGroup: (name: string) => ipcRenderer.invoke("partyGroups:create", name),
  movePartyToGroup: (partyId: string, groupId: string) => ipcRenderer.invoke("partyGroups:move", partyId, groupId),
  renamePartyGroup: (groupId: string, name: string) => ipcRenderer.invoke("partyGroups:rename", groupId, name),
  reorderPartyGroups: (order: string[]) => ipcRenderer.invoke("partyGroups:reorder", order),
  removePartyGroup: (groupId: string) => ipcRenderer.invoke("partyGroups:remove", groupId),
  getCwdPreferences: (options?: { check?: boolean }) => ipcRenderer.invoke("cwd:preferences", options),
  setDefaultCwd: (location: unknown) => ipcRenderer.invoke("cwd:setDefault", location),
  clearDefaultCwd: (env: string) => ipcRenderer.invoke("cwd:clearDefault", env),
  removeRecentCwd: (location: unknown) => ipcRenderer.invoke("cwd:removeRecent", location),
  checkCwd: (location: unknown) => ipcRenderer.invoke("cwd:check", location),
  listWslDistros: () => ipcRenderer.invoke("cwd:distros"),
  browseCwd: (env: string, distro?: string) => ipcRenderer.invoke("cwd:browse", env, distro),
  listMemberLocations: () => ipcRenderer.invoke("cwd:memberLocations"),
  listAuth: () => ipcRenderer.invoke("auth:list"),
  setDeepseekKey: (value: string) => ipcRenderer.invoke("auth:setDeepseekKey", value),
  clearDeepseekKey: () => ipcRenderer.invoke("auth:clearDeepseekKey"),
  testDeepseekKey: () => ipcRenderer.invoke("auth:testDeepseekKey"),
  setOpenRouterKey: (value: string) => ipcRenderer.invoke("auth:setOpenRouterKey", value),
  clearOpenRouterKey: () => ipcRenderer.invoke("auth:clearOpenRouterKey"),
  testOpenRouterKey: () => ipcRenderer.invoke("auth:testOpenRouterKey"),
  testNativeCliAuth: (provider: NativeCliAuthProvider, host: NativeCliAuthHost): Promise<NativeCliAuthTestResult> =>
    ipcRenderer.invoke("auth:testNativeCli", provider, host),
  loginSubscription: (provider: "codex" | "claude") => ipcRenderer.invoke("auth:loginSubscription", provider),
  disconnectSubscription: (provider: "codex" | "claude" | "cursor") => ipcRenderer.invoke("auth:disconnectSubscription", provider),
  listModels: () => ipcRenderer.invoke("models:list"),
  refreshCodexModels: () => ipcRenderer.invoke("models:refreshCodex"),
  // Mobile link (설정 → 모바일 연결). Reads are cheap and synchronous inside the
  // main process; `onMobileStatus` keeps the tab live between them.
  getMobileStatus: (): Promise<{ ok: true; status: GatewayStatus }> => ipcRenderer.invoke("mobile:status"),
  getMobileSettings: (): Promise<{ ok: true; settings: MobileSettings }> => ipcRenderer.invoke("mobile:settings"),
  updateMobileSettings: (patch: Partial<MobileSettings>): Promise<{ ok: true; settings: MobileSettings }> =>
    ipcRenderer.invoke("mobile:updateSettings", patch),
  listMobileDevices: (): Promise<{ ok: true; devices: TrustedDevice[] }> => ipcRenderer.invoke("mobile:devices"),
  /** Opens a pairing QR; the confirmation code arrives on the status stream. */
  openMobilePairing: (): Promise<{ ok: true; qr: string; expiresAt: number }> => ipcRenderer.invoke("mobile:pairOpen"),
  confirmMobilePairing: (): Promise<{ ok: true; status: GatewayStatus }> => ipcRenderer.invoke("mobile:pairConfirm"),
  cancelMobilePairing: (): Promise<{ ok: true; status: GatewayStatus }> => ipcRenderer.invoke("mobile:pairCancel"),
  revokeMobileDevice: (deviceId: string): Promise<{ ok: true; devices: TrustedDevice[] }> =>
    ipcRenderer.invoke("mobile:revokeDevice", deviceId),
  renameMobileDevice: (deviceId: string, name: string): Promise<{ ok: true; devices: TrustedDevice[] }> =>
    ipcRenderer.invoke("mobile:renameDevice", deviceId, name),
  /** Cuts one phone session now; the pairing survives. */
  disconnectMobileSession: (sessionId: string): Promise<{ ok: true; status: GatewayStatus }> =>
    ipcRenderer.invoke("mobile:disconnectSession", sessionId),
  runMobileDiagnostics: (): Promise<{ ok: true; diagnostics: NatDiagnostics }> => ipcRenderer.invoke("mobile:diagnostics"),
  getMobileConnectionLock: (): Promise<{ ok: true; lock: MobileConnectionLockStatus }> =>
    ipcRenderer.invoke("mobile:lockStatus"),
  configureMobileConnectionLock: (
    kind: MobileConnectionLockKind,
    secret: string,
  ): Promise<{ ok: true; lock: MobileConnectionLockStatus }> => ipcRenderer.invoke("mobile:lockSet", kind, secret),
  clearMobileConnectionLock: (): Promise<{ ok: true; lock: MobileConnectionLockStatus }> =>
    ipcRenderer.invoke("mobile:lockClear"),
  getDiscordStatus: () => ipcRenderer.invoke("discord:get"),
  updateDiscordSettings: (patch: unknown) => ipcRenderer.invoke("discord:update", patch),
  getUsageLimits: () => ipcRenderer.invoke("usage:get"),
  refreshUsageLimits: () => ipcRenderer.invoke("usage:refresh"),
  /** Where the app update stands. Kept live by `onUpdateStatus`. */
  getUpdateStatus: (): Promise<{ ok: true; update: UpdateStatus }> => ipcRenderer.invoke("update:get"),
  getUpdateChannel: (): Promise<{ ok: true; channel: UpdateChannel }> => ipcRenderer.invoke("update:channel:get"),
  setUpdateChannel: (channel: UpdateChannel): Promise<{ ok: true; channel: UpdateChannel; update: UpdateStatus }> =>
    ipcRenderer.invoke("update:channel:set", channel),
  /** Published release history, newest first — the 설정 → 버전 tab's list. */
  listUpdateVersions: (options?: { refresh?: boolean }): Promise<{ ok: true; releases: ReleaseSummary[] }> =>
    ipcRenderer.invoke("update:versions", options || {}),
  /** Re-asks the release feed. Failures come back inside the status, not as a rejection. */
  checkForUpdate: (options?: { quiet?: boolean }): Promise<{ ok: true; update: UpdateStatus }> =>
    ipcRenderer.invoke("update:check", options || {}),
  /** Downloads the pending installer; progress arrives on the status channel. */
  downloadUpdate: (): Promise<{ ok: true; update: UpdateStatus }> => ipcRenderer.invoke("update:download"),
  /** Quits the app and runs the downloaded installer. Rejects if it could not start. */
  installUpdate: (): Promise<{ ok: true }> => ipcRenderer.invoke("update:install"),
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
  /**
   * Answers an approval. Resolves with what became of it — `delivered` only when
   * the harness took it, so a click on a card whose turn has already moved on is
   * reported instead of silently doing nothing.
   */
  approve: (sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): Promise<ApprovalDelivery> =>
    ipcRenderer.invoke("session:approve", sessionId, requestId, behavior, updatedInput, message),
  /** Answers an approval by its id alone, for a caller with no session in hand. */
  respondToApproval: (requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): Promise<ApprovalResponseResult> =>
    ipcRenderer.invoke("approval:respond", requestId, behavior, updatedInput, message),
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
  /** Opens (or focuses) the guide stage window. Same path as POST /api/guide/open. */
  openGuide: (): Promise<GuideScreenInfo> => ipcRenderer.invoke("guide:open"),
  /** First-install offer (§8). Same path as GET /api/guide/offer. */
  getGuideOffer: (): Promise<{ pending: boolean; shown: boolean }> => ipcRenderer.invoke("guide:offer"),
  /** Records that the offer popup was shown. Same path as POST /api/guide/offer. */
  markGuideOfferShown: (): Promise<{ pending: boolean; shown: boolean }> => ipcRenderer.invoke("guide:offer:shown"),
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
  /** Compacts a member's conversation, waking it first if it is asleep. */
  compactPartyMember: (name: string) => ipcRenderer.invoke("party:compact", name),
  setMemberPermission: (name: string, permission: unknown) => ipcRenderer.invoke("party:permission", name, permission),
  setMemberGate: (name: string, gate: unknown) => ipcRenderer.invoke("party:gate", name, gate),
  setMemberOutboundInterrupt: (name: string, outboundInterrupt: boolean | null) => ipcRenderer.invoke("party:outbound-interrupt", name, outboundInterrupt),
  setPartyGate: (partyId: string, gate: unknown) => ipcRenderer.invoke("party:partyGate", partyId, gate),
  getPartyLayout: (): Promise<WorkbenchLayout | undefined> => ipcRenderer.invoke("party:layout:get"),
  setPartyLayout: (layout: WorkbenchLayout) => ipcRenderer.invoke("party:layout:set", layout),
  getMemberTranscript: (name: string, partyId?: string) => ipcRenderer.invoke("party:transcript:get", name, partyId),
  saveMemberTranscript: (name: string, save: TranscriptSave): Promise<TranscriptSaveResult> => ipcRenderer.invoke("party:transcript:save", name, save),
  /** Bytes for one screenshot a transcript references, fetched only when shown. */
  getTranscriptImage: (file: string): Promise<{ ok: true; dataUrl: string; bytes: number }> => ipcRenderer.invoke("party:transcript:image", file),
  /** Where the harness keeps its own untrimmed copy of this member's conversation. */
  getHarnessOriginal: (name: string): Promise<{ ok: true; original: { harness: string; path: string; exists: boolean; bytes?: number } | null }> => ipcRenderer.invoke("party:harness-original", name),
  /** Inspects or transfers this member's native thread to the default terminal. */
  continueMemberInCli: (name: string, action: CliContinuationAction): Promise<CliContinuationResult> =>
    ipcRenderer.invoke("party:cli-continuation", name, action),
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
  onPartyGroupsUpdate: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("partyGroups:update", listener);
    return () => ipcRenderer.removeListener("partyGroups:update", listener);
  },
  onSettingsUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("settings:update", listener);
    return () => ipcRenderer.off("settings:update", listener);
  },
  onAppearanceUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("appearance:update", listener);
    return () => ipcRenderer.off("appearance:update", listener);
  },
  onAuthUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("auth:update", listener);
    return () => ipcRenderer.off("auth:update", listener);
  },
  onNativeCliAuthProgress: (callback: (payload: NativeCliAuthProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: NativeCliAuthProgress) => callback(payload);
    ipcRenderer.on("auth:native-progress", listener);
    return () => ipcRenderer.off("auth:native-progress", listener);
  },
  onDiscordUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("discord:update", listener);
    return () => ipcRenderer.off("discord:update", listener);
  },
  onMobileStatus: (callback: (payload: GatewayStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: GatewayStatus) => callback(payload);
    ipcRenderer.on("mobile:status", listener);
    return () => ipcRenderer.off("mobile:status", listener);
  },
  onUsageUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("usage:update", listener);
    return () => ipcRenderer.off("usage:update", listener);
  },
  onUpdateStatus: (callback: (payload: UpdateStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: UpdateStatus) => callback(payload);
    ipcRenderer.on("update:status", listener);
    return () => ipcRenderer.off("update:status", listener);
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
  /** `{view, tab?, harness?}` — `tab` lands the runtime screen on one of its
   *  tabs, `harness` on one harness inside the 하네스 기본값 tab. */
  onNavigate: (callback: (payload: { view: string; tab?: string; harness?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { view: string; tab?: string; harness?: string }) => callback(payload);
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
};

contextBridge.exposeInMainWorld("agentParty", api);

/**
 * The guide screen's own surface. Separate from `agentParty` on purpose: the
 * workbench must not be able to reach the guide's chat session, and the guide's
 * chrome asks for things (a knowledge path, a harness-free model catalog) that
 * are not part of the app bridge.
 */
const guide: GuideHostApi = {
  notifyState: (state) => ipcRenderer.send("guide:state", state),
  onSetSlide: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { index?: number }) => {
      if (typeof payload?.index === "number") {
        callback(payload.index);
      }
    };
    ipcRenderer.on("guide:set-slide", listener);
    return () => {
      ipcRenderer.off("guide:set-slide", listener);
    };
  },
  onSetAsk: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { open?: boolean }) => {
      if (typeof payload?.open === "boolean") {
        callback(payload.open);
      }
    };
    ipcRenderer.on("guide:set-ask", listener);
    return () => {
      ipcRenderer.off("guide:set-ask", listener);
    };
  },
  knowledgePath: () => ipcRenderer.invoke("guide:knowledge"),
  listRoutes: () => ipcRenderer.invoke("guide:models"),
  getChat: (kind) => ipcRenderer.invoke("guide:chat:get", kind),
  sendChat: (kind, text, viewing) => ipcRenderer.invoke("guide:chat:send", kind, text, viewing),
  resetChat: (kind) => ipcRenderer.invoke("guide:chat:reset", kind),
  compactChat: (kind) => ipcRenderer.invoke("guide:chat:compact", kind),
  getChatSettings: () => ipcRenderer.invoke("guide:chat:settings"),
  updateChatSettings: (patch) => ipcRenderer.invoke("guide:chat:settings", patch),
  onChatUpdate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
    ipcRenderer.on("guide:chat-update", listener);
    return () => {
      ipcRenderer.off("guide:chat-update", listener);
    };
  },
};

contextBridge.exposeInMainWorld("agentPartyGuide", guide);

export type AgentPartyApi = typeof api;
