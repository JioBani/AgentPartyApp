/**
 * The fake `window.agentParty` the guide STAGE serves.
 *
 * Typed as the real `AgentPartyApi`, so any method the real bridge grows and
 * this one does not breaks the build instead of breaking the stage at runtime.
 * `App` cannot tell the difference; that is the point — the guide shows the real
 * workbench, so it follows UI changes for free.
 *
 * This used to be a preload for the guide's own BrowserWindow. The guide now
 * lives inside the main window, where `window.agentParty` is the REAL bridge, so
 * the stage runs in an iframe and installs this object in the iframe's own
 * document. No preload, therefore no `ipcRenderer`: every call that used to
 * reach main is refused here instead.
 */
import type { AgentPartyApi } from "../../../preload/preload";
import type { GuideSnapshot } from "../../../shared/guide";
import { GUIDE_REFUSED, GUIDE_SLIDE_COUNT } from "../../../shared/guide";
import type { PartyCommandResult } from "../../../shared/types";
import { DEFAULT_FONT_SETTINGS } from "../../../shared/appFonts";
import { DEFAULT_THEME_PREFERENCE, appearanceStateOf, requireThemePreference } from "../../../shared/appTheme";
import { DEFAULT_COMPOSER_SETTINGS } from "../../../shared/composerSettings";
import { DEFAULT_IDLE_SLEEP } from "../../../shared/idleSleep";
import { DEFAULT_MEMBER_MESSAGING_SETTINGS } from "../../../shared/memberMessaging";
import type { AppLocale } from "../../../shared/appLocale";
import { DEFAULT_SIDEBAR_DRAWERS } from "../../../shared/sidebarDrawers";

export const EMPTY_GUIDE_SNAPSHOT: GuideSnapshot = {
  state: {
    ok: true,
    settings: {
      locale: "ko",
      workspacePath: "C:\\Guide\\demo-workspace",
      updateChannel: "stable",
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
      theme: DEFAULT_THEME_PREFERENCE,
      fonts: { ...DEFAULT_FONT_SETTINGS },
      compactDefault: { on: false, at: 80 },
      idleSleep: { ...DEFAULT_IDLE_SLEEP },
      gateDefaults: { model: "haiku", effort: "low" },
      composer: { ...DEFAULT_COMPOSER_SETTINGS },
      memberMessaging: { ...DEFAULT_MEMBER_MESSAGING_SETTINGS },
      favoriteModels: [],
      sidebarDrawers: DEFAULT_SIDEBAR_DRAWERS,
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

/**
 * The unsubscribe value the real bridge returns (it hands back `ipcRenderer`).
 * There is no `ipcRenderer` here, so this ONE value is cast — everything else in
 * the object stays type-checked against the real surface.
 */
type Unsubscribe = ReturnType<AgentPartyApi["onSnapshot"]>;
const NOOP_OFF = (() => undefined) as unknown as Unsubscribe;
/** `notifyState` hands back the real `ipcRenderer`; there is none here. */
const NOOP_IPC = undefined as unknown as Electron.IpcRenderer;

export interface FakeAgentParty {
  api: AgentPartyApi;
  applySnapshot: (snapshot: GuideSnapshot) => void;
  getSnapshot: () => GuideSnapshot;
  /** After `App` remounts and subscribes, replay view / events / QA opens. */
  flushSideEffects: () => void;
}

export function createFakeAgentParty(): FakeAgentParty {
  let snapshot: GuideSnapshot = EMPTY_GUIDE_SNAPSHOT;
  const current = () => snapshot;

  const sessionEventListeners: Array<(payload: unknown) => void> = [];
  const navigateListeners: Array<(payload: { view: string; tab?: string; harness?: string }) => void> = [];
  const qaOpenSubListeners: Array<(payload: unknown) => void> = [];
  const qaOpenGateListeners: Array<(payload: unknown) => void> = [];

  function track<T>(list: Array<(payload: T) => void>, callback: (payload: T) => void): Unsubscribe {
    list.push(callback);
    return (() => {
      const index = list.indexOf(callback);
      if (index >= 0) {
        list.splice(index, 1);
      }
    }) as unknown as Unsubscribe;
  }

  function subscribe<T>(callback: (payload: T) => void): Unsubscribe {
    void callback;
    return NOOP_OFF;
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

  /** For calls whose real answer is "nothing happened" rather than an error —
   *  the demo's own titlebar and links must be inert, not throw at the user. */
  function inert(): Promise<{ ok: false; error: string }> {
    return Promise.resolve({ ok: false, error: GUIDE_REFUSED });
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
    setLocale: async (locale) => {
      if (locale !== "ko" && locale !== "en") throw new Error(`Unsupported locale: ${locale}`);
      const next = { ...current().state.settings, locale: locale as AppLocale };
      snapshot = { ...current(), state: { ...current().state, settings: next } };
      return next;
    },
    getAppearance: async () => appearanceStateOf(requireThemePreference(current().state.settings.theme), true),
    setTheme: async (theme) => {
      const preference = requireThemePreference(theme);
      const next = { ...current().state.settings, theme: preference };
      snapshot = { ...current(), state: { ...current().state, settings: next } };
      return appearanceStateOf(preference, true);
    },
    onAppearanceUpdate: (callback) => subscribe(callback),
    appearanceReady: () => undefined,
    chooseWorkspace: () => refused(),
    // The guide stage is a demo of the app, not the app: it has no group
    // registry and no filesystem, so these answer empty rather than pretending.
    listPartyGroups: () => Promise.resolve({ ok: true as const, groups: [], parties: [], conflicts: undefined }),
    switchWorkspace: () => refused(),
    createPartyGroup: () => refused(),
    movePartyToGroup: () => refused(),
    renamePartyGroup: () => refused(),
    reorderPartyGroups: () => refused(),
    removePartyGroup: () => refused(),
    getCwdPreferences: () => Promise.resolve({ ok: true as const, preferences: { windowsRecent: [], wslRecent: [] } }),
    setDefaultCwd: () => refused(),
    clearDefaultCwd: () => refused(),
    removeRecentCwd: () => refused(),
    checkCwd: () => refused(),
    listWslDistros: () => Promise.resolve({ ok: true as const, distros: [] }),
    browseCwd: () => refused(),
    listMemberLocations: () => Promise.resolve({ ok: true as const, members: [] }),
    listAuth: () => Promise.resolve(current().state.auth),
    setDeepseekKey: () => refused(),
    clearDeepseekKey: () => refused(),
    testDeepseekKey: () => refused(),
    setOpenRouterKey: () => refused(),
    clearOpenRouterKey: () => refused(),
    testOpenRouterKey: () => refused(),
    testNativeCliAuth: () => refused(),
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
        channel: "stable" as const,
        currentVersion: "guide",
        disabledReason: "가이드 무대는 업데이트를 다루지 않습니다.",
      },
    }),
    getUpdateChannel: () => Promise.resolve({ ok: true as const, channel: current().update?.channel || "stable" as const }),
    setUpdateChannel: () => refused(),
    listUpdateVersions: () => Promise.resolve({ ok: true as const, releases: [] }),
    checkForUpdate: () => Promise.resolve({
      ok: true as const,
      update: current().update ?? {
        state: "disabled" as const,
        channel: "stable" as const,
        currentVersion: "guide",
        disabledReason: "가이드 무대는 업데이트를 다루지 않습니다.",
      },
    }),
    downloadUpdate: () => refused(),
    installUpdate: () => refused(),
    getTokenUsage: () => Promise.resolve(current().tokenUsage ?? {
      fromMs: 0, toMs: 0, bucketMinutes: 5, buckets: [], parties: [], members: [], triggers: [],
      totals: { costUsd: 0, estCostUsd: 0, effectiveCostUsd: 0, reportedCostTurns: 0, estimatedCostTurns: 0, unpricedTurns: 0, unpricedTokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, turns: 0, overheadTokens: 0, firstHalfTokens: 0, secondHalfTokens: 0 },
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
    listMcpServers: () => Promise.resolve(current().mcp ?? { supported: true, harness: "claude-code" as const, servers: [] }),
    reconnectMcpServer: () => refused(),
    setMcpServerEnabled: () => refused(),
    authenticateMcpServer: () => refused(),
    getDiagnostics: () => Promise.resolve({
      version: "guide",
      versionError: "가이드 무대는 이 기기의 진단을 읽지 않습니다.",
      packaged: false,
      appRoot: "guide",
      os: { platform: "win32", release: "", arch: "x64" },
      versions: { node: "", electron: "", chrome: "" },
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
    // The stage is a picture of the app. Its links, its titlebar buttons and its
    // file reveals do nothing — they must not reach the user's real desktop.
    openExternal: () => inert(),
    openPath: () => inert(),
    revealPath: () => inert(),
    copyImageToClipboard: () => inert(),
    minimizeWindow: () => inert(),
    maximizeWindow: () => inert(),
    closeWindow: () => inert(),
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
    getMemberTranscript: (name: string) => Promise.resolve({ blocks: current().transcripts[name] || [] }),
    saveMemberTranscript: () => Promise.resolve({ applied: false, reason: GUIDE_REFUSED }),
    getTranscriptImage: () => refused(),
    getHarnessOriginal: () => Promise.resolve({ ok: true as const, original: null }),
    onSessionEvents: (callback) => track(sessionEventListeners, callback),
    onSnapshot: (callback) => subscribe(callback),
    onSessions: (callback) => subscribe(callback),
    onPartyUpdate: (callback) => subscribe(callback),
    onPartyLayout: (callback) => subscribe(callback),
    onModelsUpdate: (callback) => subscribe(callback),
    onPartyGroupsUpdate: (callback) => subscribe(callback),
    onSettingsUpdate: (callback) => subscribe(callback),
    onWindowRenderState: (callback) => subscribe(callback),
    onAuthUpdate: (callback) => subscribe(callback),
    onNativeCliAuthProgress: (callback) => subscribe(callback),
    onDiscordUpdate: (callback) => subscribe(callback),
    onUsageUpdate: (callback) => subscribe(callback),
    onUpdateStatus: (callback) => subscribe(callback),
    onQaLayout: (callback) => subscribe(callback),
    onQaOpenSubagent: (callback) => track(qaOpenSubListeners, callback),
    onQaOpenGate: (callback) => track(qaOpenGateListeners, callback),
    onNavigate: (callback) => track(navigateListeners, callback),
    onWorkspaceChoose: (callback) => subscribe(callback),
    onNewSession: (callback) => subscribe(callback),

    // Methods the real bridge gained after this fake was first written. The
    // stage demo never reaches them (mobile pairing, party primer, approvals,
    // and CLI continuation all talk to a real main process), so each refuses or
    // no-ops instead of faking a result — the same rule as every other call here.
    savePartyPrimerSection: () => refused(),
    translatePartyPrimerSection: () => refused(),
    getMobileStatus: () => refused(),
    getMobileSettings: () => refused(),
    updateMobileSettings: () => refused(),
    listMobileDevices: () => refused(),
    openMobilePairing: () => refused(),
    confirmMobilePairing: () => refused(),
    cancelMobilePairing: () => refused(),
    revokeMobileDevice: () => refused(),
    renameMobileDevice: () => refused(),
    disconnectMobileSession: () => refused(),
    runMobileDiagnostics: () => refused(),
    getMobileConnectionLock: () => refused(),
    configureMobileConnectionLock: () => refused(),
    clearMobileConnectionLock: () => refused(),
    onMobileStatus: () => () => NOOP_IPC,
    respondToApproval: () => refused(),
    continueMemberInCli: () => refused(),
  };

  return {
    api,
    applySnapshot: (next) => {
      snapshot = next;
    },
    getSnapshot: () => snapshot,
    flushSideEffects: () => {
      const next = current();
      if (next.view) {
        for (const listener of navigateListeners) {
          listener({ view: next.view, tab: next.viewTab, harness: next.viewHarness });
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
  };
}
