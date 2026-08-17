/**
 * Guide-window preload. Exposes `window.agentParty` with the SAME type as the
 * real bridge, but every call stays inside this process — no party / settings
 * / session IPC. `App` cannot tell the difference; that is the point.
 *
 * Snapshots are injected by the guide chrome (`window.agentPartyGuide`).
 * Switching slides replaces the snapshot and remounts `App`.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { AgentPartyApi } from "./preload";
import type { GuideSnapshot } from "../shared/guide";
import { GUIDE_REFUSED, GUIDE_SLIDE_COUNT } from "../shared/guide";
import type { GuideHostApi } from "../shared/guideHost";
import type { PartyCommandResult } from "../shared/types";
import { DEFAULT_FONT_SETTINGS } from "../shared/appFonts";
import { DEFAULT_COMPOSER_SETTINGS } from "../shared/composerSettings";
import { DEFAULT_IDLE_SLEEP } from "../shared/idleSleep";
import { DEFAULT_MEMBER_MESSAGING_SETTINGS } from "../shared/memberMessaging";

const EMPTY_SNAPSHOT: GuideSnapshot = {
  state: {
    ok: true,
    settings: {
      workspacePath: "C:\\Guide\\demo-workspace",
      claudeExecutablePath: "",
      cursorExecutablePath: "",
      claudeSafeMode: false,
      selectedHarnessId: "claude-code",
      harnessDefaults: {
        "claude-code": { model: "sonnet", effort: "medium", permissionMode: "default" },
        codex: { model: "gpt-5.4", effort: "medium", codexPolicy: { sandbox: "workspace-write", approval: "on-request", guardian: false } },
        cursor: { model: "Grok 4.5", effort: "high", cursorPolicy: { mode: "agent", approval: "allowlist" } },
        grok: { model: "grok-4.6", effort: "high", permissionMode: "default" },
      },
      debugEnabled: false,
      routerBaseUrl: "http://127.0.0.1:3455",
      routerAuthToken: "",
      openRouterApiKey: "",
      deepseekApiKey: "",
      automationApiPort: 47831,
      transcriptFontScale: 1,
      fonts: { ...DEFAULT_FONT_SETTINGS },
      compactDefault: { on: false, at: 80 },
      idleSleep: { ...DEFAULT_IDLE_SLEEP },
      gateDefaults: { model: "haiku", effort: "low" },
      composer: { ...DEFAULT_COMPOSER_SETTINGS },
      memberMessaging: { ...DEFAULT_MEMBER_MESSAGING_SETTINGS },
      favoriteModels: [],
    },
    auth: [],
    sessions: [],
    modelRoutes: [],
    modelProviders: [],
    harnesses: [],
    router: { baseUrl: "" },
    automationApi: { baseUrl: "", spec: "" },
    logs: { logFilePath: "" },
    party: { members: [] },
    resumableSessions: [],
    guideOffer: { pending: false, shown: true },
  },
  transcripts: {},
};

let snapshot: GuideSnapshot = EMPTY_SNAPSHOT;

function current(): GuideSnapshot {
  return snapshot;
}

function refusedParty(): PartyCommandResult {
  const party = current().state.party;
  return {
    ok: false,
    message: GUIDE_REFUSED,
    parties: party.parties,
    currentPartyId: party.currentPartyId,
    members: party.members,
    messages: party.messages,
  };
}

function refused(): Promise<never> {
  return Promise.reject(new Error(GUIDE_REFUSED));
}

function subscribe<T>(callback: (payload: T) => void): () => Electron.IpcRenderer {
  void callback;
  return () => ipcRenderer;
}

const sessionEventListeners: Array<(payload: unknown) => void> = [];
const navigateListeners: Array<(payload: { view: string; tab?: string; harness?: string }) => void> = [];
const qaOpenSubListeners: Array<(payload: unknown) => void> = [];
const qaOpenGateListeners: Array<(payload: unknown) => void> = [];

function track<T>(list: Array<(payload: T) => void>, callback: (payload: T) => void): () => Electron.IpcRenderer {
  list.push(callback);
  return () => {
    const index = list.indexOf(callback);
    if (index >= 0) {
      list.splice(index, 1);
    }
    return ipcRenderer;
  };
}

const api: AgentPartyApi = {
  pathForFile: () => {
    throw new Error(GUIDE_REFUSED);
  },
  getInitialState: () => Promise.resolve(current().state),
  updateSettings: async (patch) => {
    // In-memory only. Font-zoom writes here; it must not reach real settings.
    const next = { ...current().state.settings, ...(patch as object) };
    snapshot = { ...current(), state: { ...current().state, settings: next } };
    return next;
  },
  chooseWorkspace: () => refused(),
  listAuth: () => Promise.resolve(current().state.auth),
  setDeepseekKey: () => refused(),
  clearDeepseekKey: () => refused(),
  testDeepseekKey: () => refused(),
  setOpenRouterKey: () => refused(),
  clearOpenRouterKey: () => refused(),
  testOpenRouterKey: () => refused(),
  loginSubscription: () => refused(),
  disconnectSubscription: () => refused(),
  listModels: () => Promise.resolve({
    modelRoutes: current().state.modelRoutes,
    modelProviders: current().state.modelProviders,
    harnesses: current().state.harnesses,
    codexModels: current().state.codexModels,
  }),
  refreshCodexModels: () => Promise.resolve({
    modelRoutes: current().state.modelRoutes,
    modelProviders: current().state.modelProviders,
    harnesses: current().state.harnesses,
    codexModels: current().state.codexModels,
  }),
  getDiscordStatus: () => Promise.resolve(current().discord ?? {
    desktopName: "",
    configured: false,
    connection: "off",
    allowedUserIds: [],
    bindings: [],
    partyChannels: [],
    instance: { pid: 0, startedAt: "" },
  }),
  updateDiscordSettings: () => refused(),
  getUsageLimits: () => Promise.resolve({ usage: current().usage || {} }),
  refreshUsageLimits: () => Promise.resolve({ usage: current().usage || {} }),
  getUpdateStatus: () => Promise.resolve({
    ok: true as const,
    update: current().update ?? {
      state: "disabled" as const,
      currentVersion: "guide",
      disabledReason: "가이드 무대는 업데이트를 다루지 않습니다.",
    },
  }),
  listUpdateVersions: () => Promise.resolve({ ok: true as const, releases: [] }),
  checkForUpdate: () => Promise.resolve({
    ok: true as const,
    update: current().update ?? {
      state: "disabled" as const,
      currentVersion: "guide",
      disabledReason: "가이드 무대는 업데이트를 다루지 않습니다.",
    },
  }),
  downloadUpdate: () => refused(),
  installUpdate: () => refused(),
  getTokenUsage: () => Promise.resolve(current().tokenUsage ?? {
    fromMs: 0, toMs: 0, bucketMinutes: 5, buckets: [], parties: [], members: [], triggers: [],
    totals: { costUsd: 0, estCostUsd: 0, unpricedTurns: 0, unpricedTokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, turns: 0, overheadTokens: 0, firstHalfTokens: 0, secondHalfTokens: 0 },
    totalTokens: 0, activeMsUnion: 0, recordCount: 0,
  }),
  getTokenUsageTurns: () => Promise.resolve(current().tokenUsageTurns || []),
  createSession: () => refused(),
  listResumableSessions: () => Promise.resolve({ sessions: current().state.resumableSessions || [] }),
  resumeSession: () => refused(),
  closeSession: () => refused(),
  sendMessage: () => refused(),
  interrupt: () => refused(),
  forceStop: () => refused(),
  restart: () => refused(),
  compact: () => refused(),
  setModel: () => refused(),
  setEffort: () => refused(),
  setThinking: () => refused(),
  setPermissionMode: () => refused(),
  setCodexPolicy: () => refused(),
  setCursorPolicy: () => refused(),
  approve: () => refused(),
  listMcpServers: () => Promise.resolve({ supported: true, harness: "claude-code" as const, servers: [] }),
  reconnectMcpServer: () => refused(),
  setMcpServerEnabled: () => refused(),
  authenticateMcpServer: () => refused(),
  getDiagnostics: () => Promise.resolve({
    version: "guide",
    versionError: "가이드 무대는 이 기기의 진단을 읽지 않습니다.",
    packaged: false,
    appRoot: "guide",
    os: { platform: process.platform, release: "", arch: process.arch },
    versions: { node: process.versions.node, electron: process.versions.electron, chrome: process.versions.chrome },
    workspace: { uri: "C:\\Guide\\demo-workspace", kind: "local" as const, path: "C:\\Guide\\demo-workspace" },
    logs: { filePath: "", folderPath: "" },
    auth: [],
  }),
  getEnvironment: () => Promise.resolve({
    checkedAt: new Date().toISOString(),
    checks: [],
  }),
  repairEnvironment: () => refused(),
  openLogFolder: () => refused(),
  openExternal: (url: string) => ipcRenderer.invoke("guide:open-external", url),
  openPath: () => refused(),
  revealPath: () => refused(),
  copyImageToClipboard: () => refused(),
  minimizeWindow: () => ipcRenderer.invoke("guide:window", "minimize"),
  maximizeWindow: () => ipcRenderer.invoke("guide:window", "maximize"),
  closeWindow: () => ipcRenderer.invoke("guide:window", "close"),
  newWindow: () => refused(),
  listWindows: () => Promise.resolve([]),
  openGuide: () => Promise.resolve({ open: true, presenting: true, slide: 0, slideCount: GUIDE_SLIDE_COUNT }),
  getGuideOffer: () => Promise.resolve({ pending: false, shown: true }),
  markGuideOfferShown: () => Promise.resolve({ pending: false, shown: true }),
  listParty: () => Promise.resolve(current().state.party),
  createParty: () => Promise.resolve(refusedParty()),
  selectParty: () => Promise.resolve(refusedParty()),
  deleteParty: () => Promise.resolve(refusedParty()),
  createPartyMember: () => Promise.resolve(refusedParty()),
  sendPartyMessage: () => Promise.resolve(refusedParty()),
  sendMemberMessage: () => Promise.resolve(refusedParty()),
  getMemberQueue: (name: string) => {
    const member = current().state.party.members.find((item) => item.name === name);
    return Promise.resolve(member?.queue ?? { items: [] });
  },
  runQueueCommand: () => Promise.resolve(refusedParty()),
  bindPartyMember: () => Promise.resolve(refusedParty()),
  openPartyMember: () => Promise.resolve(refusedParty()),
  closePartyMember: () => Promise.resolve(refusedParty()),
  resumePartyMember: () => Promise.resolve(refusedParty()),
  respawnPartyMember: () => Promise.resolve(refusedParty()),
  startPartyMember: () => Promise.resolve(refusedParty()),
  removePartyMember: () => Promise.resolve(refusedParty()),
  setMemberAutoCompact: () => Promise.resolve(refusedParty()),
  setMemberKeepAwake: () => Promise.resolve(refusedParty()),
  sleepPartyMember: () => Promise.resolve(refusedParty()),
  wakePartyMember: () => Promise.resolve(refusedParty()),
  compactPartyMember: () => Promise.resolve(refusedParty()),
  setMemberPermission: () => Promise.resolve(refusedParty()),
  setMemberGate: () => Promise.resolve(refusedParty()),
  setMemberOutboundInterrupt: () => Promise.resolve(refusedParty()),
  setPartyGate: () => Promise.resolve(refusedParty()),
  getPartyLayout: () => Promise.resolve(current().layout),
  setPartyLayout: () => refused(),
  getMemberTranscript: (name: string) => Promise.resolve(current().transcripts[name] || []),
  saveMemberTranscript: () => Promise.resolve({ applied: false, reason: GUIDE_REFUSED }),
  getTranscriptImage: () => refused(),
  getHarnessOriginal: () => Promise.resolve({ ok: true as const, original: null }),
  onSessionEvents: (callback) => track(sessionEventListeners, callback),
  onSnapshot: (callback) => subscribe(callback),
  onSessions: (callback) => subscribe(callback),
  onPartyUpdate: (callback) => subscribe(callback),
  onPartyLayout: (callback) => subscribe(callback),
  onModelsUpdate: (callback) => subscribe(callback),
  onSettingsUpdate: (callback) => subscribe(callback),
  onAuthUpdate: (callback) => subscribe(callback),
  onDiscordUpdate: (callback) => subscribe(callback),
  onUsageUpdate: (callback) => subscribe(callback),
  onUpdateStatus: (callback) => subscribe(callback),
  onQaLayout: (callback) => subscribe(callback),
  onQaOpenSubagent: (callback) => track(qaOpenSubListeners, callback),
  onQaOpenGate: (callback) => track(qaOpenGateListeners, callback),
  onNavigate: (callback) => track(navigateListeners, callback),
  onWorkspaceChoose: (callback) => subscribe(callback),
  onNewSession: (callback) => subscribe(callback),
  onRefreshHistory: (callback) => subscribe(callback),
};

const host: GuideHostApi = {
  applySnapshot: (next) => {
    snapshot = next;
  },
  getSnapshot: () => snapshot,
  notifySlide: (index) => {
    ipcRenderer.send("guide:slide-changed", { index });
  },
  flushSideEffects: () => {
    const next = current();
    if (next.view) {
      for (const listener of navigateListeners) {
        listener({ view: next.view });
      }
    }
    for (const payload of next.sessionEvents || []) {
      for (const listener of sessionEventListeners) {
        listener(payload);
      }
    }
    if (next.qaOpenSubagent) {
      for (const listener of qaOpenSubListeners) {
        listener(next.qaOpenSubagent);
      }
    }
    if (next.qaOpenGate) {
      for (const listener of qaOpenGateListeners) {
        listener(next.qaOpenGate);
      }
    }
  },
  leaveToWorkspace: () => ipcRenderer.invoke("guide:leave"),
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
    return () => ipcRenderer.off("guide:chat-update", listener);
  },
  onSetSlide: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { index?: number }) => {
      if (typeof payload?.index === "number") {
        callback(payload.index);
      }
    };
    ipcRenderer.on("guide:set-slide", listener);
    return () => ipcRenderer.off("guide:set-slide", listener);
  },
  onSetAsk: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { open?: boolean }) => {
      if (typeof payload?.open === "boolean") {
        callback(payload.open);
      }
    };
    ipcRenderer.on("guide:set-ask", listener);
    return () => ipcRenderer.off("guide:set-ask", listener);
  },
};

contextBridge.exposeInMainWorld("agentParty", api);
contextBridge.exposeInMainWorld("agentPartyGuide", host);
