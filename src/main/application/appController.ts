import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  decodeLocalFileTarget,
  isLaunchable,
  localFileHostPath,
  normalizeLocalFileTarget,
  withoutLocalFileSourceLocation,
} from "../../shared/localFiles";
import type { BrowserWindow, NativeImage } from "electron";
import { buildModelRoutes } from "../../core/modelRegistry";
import { invokePartyToolFromExecutionHost, partyToolNameOf, type PartyToolResult } from "../../core/partyBridge";
import type { AppSettings, AuthProviderState, CreateMemberInput, CreatePartyInput, CreateSessionInput, InitialAppState, MemberPermissionInput, NativeCliAuthHost, NativeCliAuthProgress, NativeCliAuthProvider, NativeCliAuthTestResult, StartPartyMemberInput, TranscriptSave, TranscriptSaveResult, WorkspaceDisplay } from "../../shared/types";
import { HARNESS_IDS, harnessDefaultsOf } from "../../shared/types";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import type { DiagnosticsReport } from "../../shared/diagnostics";
import type { EnvironmentReport } from "../../shared/environment";
import { probeEnvironment, probeNativeCliAuthentication, runEnvironmentRepair, setMockEnvironmentReport, type EnvironmentRepairResult } from "../environmentService";
import { GALLERY_ENVIRONMENT_REPORT } from "../../shared/environmentGallery";
import { EMPTY_LAYOUT, openMemberTab, type WorkbenchLayout } from "../../shared/workbenchLayout";
import type { CodexPolicy } from "../../shared/codexPolicy";
import type { CursorPolicy } from "../../shared/cursorPolicy";
import { permissionDiscoveryFor } from "../../shared/permissionDiscovery";
import type { ImageAttachment } from "../../shared/attachments";
import type { QueueCommand } from "../../shared/messageQueue";
import type { McpServerSnapshot } from "../../shared/mcp";
import { USAGE_PROVIDER_ORDER, type UsageLimitsSnapshot, type UsageWindow } from "../../shared/usageLimits";
import type { TokenUsageAggregate, TokenUsageQuery, TokenUsageTurnsQuery, TurnUsageRecord } from "../../shared/tokenUsage";
import { isWslLocation, parseWorkspaceLocation, serializeWorkspaceLocation, workspaceKey, wslUncPath } from "../../shared/workspaceLocation";
import type { PartyDefinition, PartyMember } from "../../shared/types";
import type { PartyGroup, RegisteredParty } from "../../shared/partyGroups";
import { PartyGroupStore, type PartyGroupState } from "../partyGroupStore";
import { migratePartyGroups, type MigrationReport } from "../partyGroupMigration";
import { cwdProblem, parseMemberLocation, type CwdPreferences, type CwdProblem, type ExecutionEnv, type MemberExecutionLocation, type MemberLocationRow } from "../../shared/memberLocation";
import { clearDefaultCwd, getCheckedCwdPreferences, getCwdPreferences, rememberCwd, removeRecentCwd, setDefaultCwd } from "../cwdPreferencesStore";
import { appWorkspaceRoot, checkCwd, locationFromPickedFolder, wslDistros, wslHome } from "../cwdService";
import { clearDeepseekKey, clearOpenRouterKey, codexCliAuthState, cursorCliAuthState, getAuthState, invalidateCursorAuthCache, setDeepseekKey, setOpenRouterKey, testDeepseekKey, testOpenRouterKey, withClaudeNativeAuth, withCodexCliAuth, withCursorCliAuth, withSubscriptionProxyAuth } from "../authService";
import { harnesses } from "../harness/types";
import { getLogFilePath, log } from "../logger";
import type { PartyApplicationService } from "./partyApplicationService";
import { PartyRepository } from "../partyRepository";
import { getPublicSettings, getSettings, storedThemePreference, updateSettings } from "../settings";
import { applyPartyPrimerPatch, applyPartyPrimerTranslation, partyPrimerTotals, partyPrimerView, PARTY_PRIMER_DELIVERY, PARTY_PRIMER_VARIABLES, type PartyPrimerSectionView } from "../../shared/partyPrimer";
import { translatePrimerSection } from "../../core/primerTranslator";
import { matchesFontQuery, normalizeFontSettings, RECOMMENDED_FONTS, type FontSettings, type LocalFontFamily, type LocalFontListing, type RecommendedFont } from "../../shared/appFonts";
import { isE2E } from "../runtimeMode";
import type { SessionManager } from "../sessionManager";
import type { EngineConnection, QaInteractionInput, QaMemberSpec } from "../engine/engineConnection";
import type { EngineRegistry } from "../engine/engineRegistry";
import type { WindowEntry, WindowInfo, WindowRegistry } from "../windowRegistry";
import { runSessionAction } from "./sessionActions";
import { MODEL_PROVIDERS } from "../../shared/modelProviders";
import { refreshRemoteModelCatalog, remoteModelCatalogStatus, type RemoteCatalogStatus } from "../remoteModelCatalog";
import type { SubscriptionProxyController } from "../subscriptionProxyService";
import type { SubscriptionProxyProvider } from "../../core/subscriptionProxy";
import { getSubscriptionProxyStatus, subscriptionProxyConfig } from "../../core/subscriptionProxy";
import { cursorAgentLogout, inspectCursorAgent } from "../../core/cursorAgentCli";
import type { DiscordBridgeService } from "../discordBridgeService";
import type { DiscordBridgeSettings, DiscordBridgeStatus } from "../../shared/discordBridge";
import { AGENT_TAB_IDS, LEGACY_RUNTIME_TAB_IDS, SETTINGS_TAB_IDS, isAgentTabId, isRuntimeTabId, isSettingsTabId } from "../../shared/runtimeTabs";
import { initialUpdateStatus, requireUpdateChannel, type ReleaseSummary, type UpdateChannel, type UpdateCheckOptions, type UpdateStatus } from "../../shared/appUpdate";
import type { MobileLinkService } from "../mobileLink";
import type { ApprovalIndex } from "../approvalIndex";
import { SingleFlight } from "../singleFlight";
import type { ApprovalDelivery, ApprovalResponseResult, PendingApproval } from "../../shared/approvals";
import type { GatewayStatus, MobileConnectionLockKind, MobileConnectionLockStatus, MobileSettings, NatDiagnostics, TrustedDevice } from "../../shared/mobileProtocol";
import { cliContinuationArgv, cliCrossCwdContinuationCommand, formatCliContinuationCommand, type CliContinuationAction, type CliContinuationDetails, type CliContinuationResult } from "../../shared/cliContinuation";
import { processExists } from "../../core/processTree";
import type { GuideInspect, GuideScreenInfo } from "../../shared/guide";
import { hasConnectedAccount } from "../../shared/guideAuth";
import type { GuideChatKind, GuideChatSettings, GuideChatView } from "../../shared/guideChat";
import type { GuideOfferView } from "../../shared/guideOffer";
import { getGuideOffer, markGuideOfferShown } from "../guideOffer";
import { requireAppLocale, type AppLocale } from "../../shared/appLocale";
import {
  appearanceAccess,
  appearanceOwnerError,
  appearanceStateOf,
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  normalizeThemePreference,
  requireThemePreference,
  windowBackgroundFor,
  type AppearanceHost,
  type AppearanceRemote,
  type AppearanceState,
  type ThemePreference,
} from "../../shared/appTheme";
import { applyNativeCliAuthProgress, nativeCliAuthProgressCheck } from "../../shared/nativeCliAuth";

export interface AppControllerDeps {
  sessionManager: SessionManager;
  engineRegistry: EngineRegistry;
  /**
   * Desktop-owned party engine backed by the Windows-global party store.
   * Absent only in a headless execution worker, which never owns global state.
   */
  partyEngine?: EngineConnection;
  /** Filesystem workspace used internally by {@link partyEngine}. */
  partyStorageWorkspace?: string;
  windowRegistry: WindowRegistry;
  /** Desktop-owned lifecycle. Absent only in the headless remote engine. */
  subscriptionProxy?: SubscriptionProxyController;
  getRouterBaseUrl: () => string;
  getAutomationBaseUrl: () => string;
  /**
   * Headless execution-worker route for party tools owned by the desktop host.
   * A WSL worker may still have old workspace-local party files, but those are
   * migration sources, never an authority after global-party mode was added.
   */
  remotePartyTool?: (ownerWorkspace: string, member: string, tool: string, args: unknown, partyId?: string) => Promise<PartyToolResult>;
  /**
   * Identity of the running build, for diagnostics. Injected rather than read
   * from `electron.app` so this controller still loads headless (WSL engine),
   * where it is absent and the version is reported as explicitly unknown.
   */
  getAppBuild?: () => { version: string; packaged: boolean };
  openWindow: (workspacePath: string) => Promise<WindowInfo>;
  /**
   * Desktop appearance owner marker. A headless engine must NOT read/write its
   * own settings.json for appearance — it
   * forwards through {@link appearanceRemote} or fails visibly.
   */
  appearance?: AppearanceHost;
  /**
   * HostChannel to the desktop's appearance methods. Set on the WSL/headless
   * engine so GET/POST /api/appearance/theme mutate the Windows host, not the
   * distro's settings file.
   */
  appearanceRemote?: AppearanceRemote;
  /**
   * Opens the platform folder picker, resolving to the chosen path or undefined
   * when cancelled. Injected rather than imported so this controller still loads
   * headless (the WSL remote engine has no dialog to open).
   */
  pickFolder?: (windowId: string | undefined, env: ExecutionEnv, defaultPath?: string) => Promise<string | undefined>;
  /**
   * The app-global group registry changed. Every window shows the same folders,
   * so a create/rename/delete/move in one of them (or over HTTP) has to reach
   * the others — nothing else in the app is app-global this way.
   */
  onPartyGroupsChanged?: () => void;
  onSettingsChanged: () => void;
  /** Called when the set of hosted workspaces changes (rebind) so per-workspace
   *  discovery files can be reconciled. */
  onWorkspacesChanged: () => void;
  /** Discord bridge. Desktop-owned; absent in a headless remote engine. */
  discord?: DiscordBridgeService;
  /**
   * App self-update against the public releases repo. Desktop-owned and absent
   * in a headless remote engine — a distro-side engine has no installer to
   * replace, so the update endpoints report that plainly instead of pretending.
   */
  updater?: UpdateController;
  /**
   * Mobile link (pairing, phone sessions, diagnostics). Desktop-owned and
   * absent in a headless remote engine, which has no user to confirm a pairing
   * code — the mobile endpoints report that plainly instead of answering with
   * an empty device list.
   */
  mobileLink?: MobileLinkService;
  /**
   * Where each approval request was seen, so one can be answered by its id
   * alone. Fed from the workspace event stream in main.ts; absent in the
   * headless engine server, whose approvals are answered by session id over
   * RPC by the desktop that owns the window.
   */
  approvals?: ApprovalIndex;
  /** Opens an interactive CLI in the desktop user's default terminal. Desktop-only. */
  launchCliContinuation?: (input: { target: CliContinuationDetails; location: ReturnType<typeof parseWorkspaceLocation> }) => Promise<number>;
  /**
   * The guide screen inside an app window. Desktop-only — the headless engine
   * has no window to navigate and must fail out loud if something asks for it.
   */
  guide?: {
    /** `windowId` names WHICH window shows it; omitted means the focused one. */
    open: (windowId?: string) => Promise<GuideScreenInfo>;
    close: () => GuideScreenInfo;
    setSlide: (index: number) => Promise<GuideScreenInfo>;
    get: () => GuideScreenInfo;
    capture: (outputPath?: string) => Promise<{ ok: true; path: string; width: number; height: number; bytes: number }>;
    inspect: () => Promise<GuideInspect>;
    setAsk: (open: boolean) => GuideScreenInfo;
    click: (selector: string) => Promise<{ ok: true; selector: string }>;
    measureStage: (selector: string) => Promise<unknown>;
  };
  guideChat?: {
    knowledgePath: () => string;
    settings: () => GuideChatSettings;
    updateSettings: (patch: Partial<GuideChatSettings>) => GuideChatSettings;
    view: (kind: GuideChatKind) => GuideChatView;
    send: (kind: GuideChatKind, text: string, viewing?: { index: number; title: string; scene: string }) => Promise<GuideChatView>;
    reset: (kind: GuideChatKind) => GuideChatView;
    compact: (kind: GuideChatKind) => GuideChatView;
  };
}

/**
 * The update surface this controller drives. Declared here (rather than
 * importing the class) so the controller keeps loading headless, where
 * `electron-updater` does not exist.
 */
export interface UpdateController {
  getStatus(): UpdateStatus;
  getChannel(): UpdateChannel;
  setChannel(channel: UpdateChannel): Promise<UpdateStatus>;
  listReleases(refresh?: boolean): Promise<ReleaseSummary[]>;
  check(options?: UpdateCheckOptions): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  install(): { ok: true };
  setMockStatus(patch: Partial<UpdateStatus> | undefined): UpdateStatus;
  setMockReleases(releases: ReleaseSummary[] | undefined): ReleaseSummary[] | undefined;
}

/** Public model discovery shared by the UI and automation/member-tool clients. */
function publicModelDiscovery(codexModels: CodexModelDiscoveryState): {
  modelRoutes: unknown[];
  modelProviders: typeof MODEL_PROVIDERS;
  harnesses: unknown[];
  codexModels: CodexModelDiscoveryState;
} {
  const settings = getSettings();
  const modelRoutes = buildModelRoutes(harnessDefaultsOf(settings).model, [], [], codexModels.models).map((route) => {
    const harnessId = route.harnessId;
    return { ...route, executionHarness: harnessId, permission: permissionDiscoveryFor(settings, harnessId) };
  });
  return {
    modelRoutes,
    modelProviders: MODEL_PROVIDERS,
    harnesses: harnesses.map((harness) => ({
      id: harness.id,
      label: harness.label,
      status: harness.status,
      permission: permissionDiscoveryFor(settings, harness.id),
    })),
    codexModels,
  };
}

/**
 * Application use-cases. Party/session state is scoped to a **workspace**
 * (passed as `workspacePath`); window actions target a **window** (`windowId`).
 * IPC resolves both from the sender window; HTTP resolves them from a window-id
 * parameter (see automationApi). Mutations broadcast to every window viewing
 * the affected workspace so same-workspace windows stay in sync.
 */
export class AppController {
  constructor(private readonly deps: AppControllerDeps) {}

  dispose(): void {}

  /** App-global party groups + the party summaries filed under them. */
  private readonly partyGroups = new PartyGroupStore();

  /** Reads legacy cwd stores during the lazy move into the global party store. */
  private readonly partyRepository = new PartyRepository();

  /** One poller per persisted handoff, including handoffs recovered after an app restart. */
  private readonly cliContinuationWatchers = new Set<string>();

  /** Last explicit native-login proof per workspace/provider/host. */
  private readonly nativeCliAuthTests = new Map<string, { checkedAt: string; phase: NativeCliAuthProgress["phase"]; check: EnvironmentReport["checks"][number]; distro?: string }>();

  /**
   * Cursor Agent CLI status for the host that actually RUNS the harness: the
   * workspace's engine (the distro for a WSL workspace). Without a workspace
   * the desktop host is inspected.
   */
  getCursorHarnessStatus(workspacePath?: string) {
    if (workspacePath) {
      return this.engineFor(workspacePath).getCursorStatus();
    }
    return inspectCursorAgent(getSettings().cursorExecutablePath);
  }

  /**
   * The active party PER WINDOW (`windowId → partyId`). One engine serves every
   * window of a workspace (two `agent-party` runs on the same cwd open two windows
   * of ONE process), so "which party is active" cannot live on the shared engine —
   * it lives here, keyed by window. Every party view/op resolves the calling
   * window's entry and passes it to the engine, so windows stay independent.
   */
  private readonly activePartyByWindow = new Map<string, string>();

  private partyForWindow(windowId?: string): string | undefined {
    return windowId ? this.activePartyByWindow.get(windowId) : undefined;
  }

  /**
   * The window's active party, PINNING it on first resolve. A window that has not
   * explicitly selected must still get a STABLE party: without pinning it would
   * resolve through the engine's shared advisory hint, and another window's select
   * (which moves that hint) would then drag this window along. Pinning at load —
   * the first `getState`/`listParty` for the window — captures the party it opens
   * on, so later selects elsewhere never move it. Absent `windowId` (HTTP with no
   * `?window`) there is nothing to pin: fall back to the shared hint.
   */
  private async pinnedPartyForWindow(workspacePath: string, windowId?: string): Promise<string | undefined> {
    if (!windowId) {
      return undefined;
    }
    const existing = this.activePartyByWindow.get(windowId);
    if (existing) {
      return existing;
    }
    const current = (await this.partyEngine(workspacePath).listParty(undefined)).currentPartyId;
    if (current) {
      this.activePartyByWindow.set(windowId, current);
    }
    return current;
  }

  /** Drops a closed window's active-party entry (called from the window `closed` hook). */
  forgetWindow(windowId?: string): void {
    if (windowId) {
      this.activePartyByWindow.delete(windowId);
    }
  }

  private engineFor(workspacePath: string): EngineConnection {
    return this.deps.engineRegistry.forWorkspace(workspacePath);
  }

  /** Party state is global on the desktop; headless workers keep their local fallback. */
  private partyEngine(workspacePath: string): EngineConnection {
    return this.deps.partyEngine || this.engineFor(workspacePath);
  }

  private partyStorageWorkspace(workspacePath: string): string {
    return this.deps.partyStorageWorkspace || workspacePath;
  }

  private globalPartyMode(): boolean {
    return Boolean(this.deps.partyEngine && this.deps.partyStorageWorkspace);
  }

  /**
   * Resolves a session operation by session id. Party sessions live in the
   * desktop-global engine even when their harness runs in WSL; standalone
   * sessions remain in the caller's execution workspace.
   */
  private async engineForSession(workspacePath: string, sessionId: string): Promise<EngineConnection> {
    const source = this.engineFor(workspacePath);
    const party = this.partyEngine(workspacePath);
    if (source === party) {
      return source;
    }
    const partySessions = await party.listWorkspaceSessions();
    return partySessions.some((session) => session.id === sessionId) ? party : source;
  }

  private workspaceDisplay(workspacePath: string): WorkspaceDisplay {
    const location = parseWorkspaceLocation(workspacePath);
    return {
      uri: serializeWorkspaceLocation(location),
      kind: location.host.kind,
      distro: location.host.kind === "wsl" ? location.host.distro : undefined,
      path: location.path,
    };
  }

  private async broadcastParty(workspacePath: string): Promise<void> {
    // Each window gets ITS OWN party's view. In desktop global-party mode every
    // window reads the same store; `workspacePath` is only the legacy cwd that
    // caused this refresh and must not limit who sees it.
    const engine = this.partyEngine(workspacePath);
    const windows = this.globalPartyMode()
      ? this.deps.windowRegistry.all()
      : this.deps.windowRegistry.forWorkspace(workspacePath);
    for (const entry of windows) {
      const payload = await engine.listParty(this.activePartyByWindow.get(entry.id));
      entry.window.webContents.send("party:update", payload);
    }
    // A phone pins no window, so it gets the workspace's own current party —
    // the same listing `party.list` answers with. Skipped entirely when no
    // phone is connected, since it costs an extra engine call.
    if (this.deps.mobileLink?.hasSessions()) {
      const payload = await engine.listParty(undefined);
      const targets = this.globalPartyMode()
        ? new Set([...windows.map((entry) => entry.workspacePath), workspacePath])
        : new Set([workspacePath]);
      for (const target of targets) {
        this.deps.mobileLink.publish("party:update", payload, target);
      }
    }
    void this.reconcileUsageProviders();
  }

  /**
   * Tells the SessionManager which providers to keep account-usage fresh for even
   * with no open session: the union of every window's active-party member
   * providers. Driven off party changes (and window loads) so the background
   * usage poller tracks what the user actually uses. Best-effort — a listParty
   * failure for one window must not stop the others from counting.
   */
  private async reconcileUsageProviders(): Promise<void> {
    // The titlebar always renders every provider. Restricting reads to providers
    // with party members left empty workspaces permanently stuck at "loading".
    // SessionManager still reuses live sessions, so this creates no duplicates.
    this.deps.sessionManager.setUsageProviders(USAGE_PROVIDER_ORDER);
  }

  /**
   * Re-broadcasts a workspace's party state after an out-of-band change (e.g. a
   * member drove a party tool in-process). Wired from the SessionManager `party`
   * event in main.ts; see the party-communication design §8.
   */
  notifyPartyChanged(workspacePath: string): Promise<void> {
    return this.refreshChangedParty(workspacePath);
  }

  private async refreshChangedParty(workspacePath: string): Promise<void> {
    // Party state is desktop-global. Remote engines only host harnesses and
    // their party tools already route back through this controller.
    await this.syncPartyRegistry(workspacePath);
    await this.broadcastParty(workspacePath);
  }

  /** The party's workbench tab layout, or undefined when none is stored yet. */
  getPartyLayout(workspacePath: string, windowId?: string): Promise<ReturnType<PartyApplicationService["getPartyLayout"]>> {
    return this.partyEngine(workspacePath).getPartyLayout(this.partyForWindow(windowId));
  }

  /**
   * Records the party's tab layout and pushes it to every window showing that
   * party, so closing a tab in one window closes it everywhere.
   *
   * Including the window the change came from. Skipping it looked like a free
   * optimisation — that renderer already has the layout — but the UI is not the
   * only caller: an HTTP client addressing a window would then move every window
   * EXCEPT the one it named. The renderer ignores an echo of its own layout, so
   * one unconditional rule costs nothing and behaves the same either way.
   *
   * A layout identical to the stored one broadcasts nothing at all.
   */
  async setPartyLayout(workspacePath: string, layout: unknown, windowId?: string): Promise<ReturnType<PartyApplicationService["setPartyLayout"]>> {
    const result = await this.partyEngine(workspacePath).setPartyLayout(layout, this.partyForWindow(windowId));
    if (!result.changed || !result.layout || !result.partyId) {
      return result;
    }
    await this.publishPartyLayout(workspacePath, result.partyId, result.layout);
    return result;
  }

  /** Pushes a stored layout mutation (including member creation) to its party's windows. */
  private async publishPartyLayout(workspacePath: string, partyId: string, layout: WorkbenchLayout): Promise<void> {
    const windows = this.globalPartyMode() ? this.deps.windowRegistry.all() : this.deps.windowRegistry.forWorkspace(workspacePath);
    for (const entry of windows) {
      // Only windows actually showing this party — another window of the same
      // workspace may be on a different one, whose tabs must not be replaced.
      //
      // Resolved the way every READ resolves it, not by reading the pin map
      // directly: a window that loaded before this workspace had any party never
      // pinned one, and testing the raw map silently dropped it from the
      // broadcast — the first window of a fresh workspace, i.e. the common case.
      if (await this.pinnedPartyForWindow(workspacePath, entry.id) !== partyId) {
        continue;
      }
      entry.window.webContents.send("party:layout", { partyId, layout });
    }
    const mobileTargets = this.globalPartyMode()
      ? new Set([...windows.map((entry) => entry.workspacePath), workspacePath])
      : new Set([workspacePath]);
    for (const target of mobileTargets) {
      this.deps.mobileLink?.publish("party:layout", { partyId, layout }, target);
    }
  }

  private async publishStoredPartyLayout(workspacePath: string, partyId: string): Promise<void> {
    const layout = await this.partyEngine(workspacePath).getPartyLayout(partyId);
    if (layout) {
      await this.publishPartyLayout(workspacePath, partyId, layout);
    }
  }

  private windowFor(windowId?: string): BrowserWindow | undefined {
    return this.deps.windowRegistry.resolve(windowId)?.window;
  }

  // --- Global state -------------------------------------------------------
  /**
   * Where THIS build was loaded from, read off the running module rather than
   * any configured path. Constant for the life of the process, and different in
   * every worktree — which is the point: an e2e can compare it against its own
   * location and prove it is driving the build it just made. Parallel worktrees
   * previously ran each other's builds and reported green for code that was
   * never under test.
   *
   * Guarded like the other module-dir reads in this codebase: the same class is
   * bundled into the ESM engine server that runs under a distro's plain node,
   * where `__dirname` does not exist and an unguarded read throws at LOAD time —
   * taking the whole WSL workspace down. There the engine runs from its server
   * dir, so cwd is the build's location.
   */
  private static readonly APP_ROOT = typeof __dirname === "string" ? __dirname : process.cwd();

  async getState(workspacePath: string, windowId?: string): Promise<InitialAppState> {
    // Boot is the first moment a workspace's parties can be registered, and this
    // is the one call every window makes on open. Idempotent, so the repeat on
    // every window costs a read and changes nothing.
    await this.migratePartyGroups([workspacePath]);
    const settings = getSettings();
    const engine = this.engineFor(workspacePath);
    const codexModels = await engine.listCodexModels();
    const partyEngine = this.partyEngine(workspacePath);
    const sourceSessions = await engine.listWorkspaceSessions();
    const partySessions = partyEngine === engine ? [] : await partyEngine.listWorkspaceSessions();
    const sessionsById = new Map([...sourceSessions, ...partySessions].map((session) => [session.id, session] as const));
    const state: InitialAppState = {
      ok: true,
      settings: { ...getPublicSettings(), workspacePath },
      workspace: this.workspaceDisplay(workspacePath),
      auth: await this.listAuthProviders(workspacePath),
      sessions: [...sessionsById.values()],
      modelRoutes: buildModelRoutes(harnessDefaultsOf(settings).model, [], [], codexModels.models),
      modelProviders: [...MODEL_PROVIDERS],
      codexModels,
      harnesses,
      router: { baseUrl: this.deps.getRouterBaseUrl() },
      automationApi: {
        baseUrl: this.deps.getAutomationBaseUrl(),
        spec: `${this.deps.getAutomationBaseUrl()}/api/spec`,
      },
      logs: { logFilePath: getLogFilePath() },
      runtime: { appRoot: AppController.APP_ROOT },
      party: await this.listPartyWithCliReconciled(
        workspacePath,
        await this.pinnedPartyForWindow(workspacePath, windowId),
      ),
      windows: this.deps.windowRegistry.list(),
      // Carried in the state a rewinding phone receives, so an approval raised
      // while it was outside the ring buffer is restored without a second call
      // — the case where it is otherwise unreachable. Omitted rather than empty
      // when this process keeps no index: "nothing is waiting" is a claim the
      // headless engine cannot make.
      ...(this.deps.approvals ? { pendingApprovals: this.deps.approvals.pending(this.partyStorageWorkspace(workspacePath)) } : {}),
      ...(await this.getResumableState(workspacePath)),
      guideOffer: getGuideOffer(),
    };
    // Keep the background usage poller tracking this window's providers.
    void this.reconcileUsageProviders();
    return state;
  }

  getLogs(): { logFilePath: string } {
    return { logFilePath: getLogFilePath() };
  }

  // --- Diagnostics ----------------------------------------------------------
  /**
   * The facts a bug report needs, in one call: build, host, workspace, log
   * location, auth wiring. Behind the settings screen's 진단 card AND
   * `GET /api/diagnostics`, so what a user pastes and what an agent reads are
   * the same report.
   */
  async getDiagnostics(workspacePath: string): Promise<DiagnosticsReport> {
    // Absent only in the headless engine, which has no Electron `app` to ask.
    // Reported as an explicit reason rather than an empty version string.
    const build = this.deps.getAppBuild?.();
    const logFilePath = getLogFilePath();
    return {
      version: build?.version || "",
      versionError: build ? undefined : "이 프로세스는 앱 버전을 알 수 없습니다(헤드리스 엔진).",
      packaged: build?.packaged === true,
      appRoot: AppController.APP_ROOT,
      os: { platform: process.platform, release: os.release(), arch: process.arch },
      versions: { node: process.versions.node, electron: process.versions.electron, chrome: process.versions.chrome },
      workspace: this.workspaceDisplay(workspacePath),
      logs: { filePath: logFilePath, folderPath: path.dirname(logFilePath) },
      auth: (await this.listAuthProviders(workspacePath)).map((provider) => ({ id: provider.id, label: provider.label, status: provider.status })),
    };
  }

  /**
   * Whether this machine can actually run a member, and what to do when it
   * cannot. Sibling of {@link getDiagnostics} and deliberately separate: that
   * one describes a build for a bug report, this one is a to-do list.
   *
   * `includeWsl` is opt-in because probing a distro starts it.
   */
  async getEnvironment(workspacePath: string, options: { refresh?: boolean; includeWsl?: boolean } = {}): Promise<EnvironmentReport> {
    return probeEnvironment({ ...options, workspacePath });
  }

  /**
   * Applies one of the fixes {@link getEnvironment} offered. The caller passes
   * an id, never a command — see `runEnvironmentRepair`.
   */
  async repairEnvironment(workspacePath: string, repairId: string): Promise<EnvironmentRepairResult> {
    if (!repairId) {
      throw new Error("repairId가 필요합니다.");
    }
    return runEnvironmentRepair(repairId, workspacePath);
  }

  /**
   * Reveals the log folder in the OS file manager, so a non-technical beta user
   * can actually hand over a log instead of copying a path they cannot follow.
   *
   * Electron is imported lazily for the same reason as
   * {@link writeImageToClipboard}: this controller also runs headless inside a
   * WSL distro, where `electron` does not exist.
   */
  async openLogFolder(): Promise<{ ok: true; path: string }> {
    const { shell } = await import("electron");
    const folder = path.dirname(getLogFilePath());
    // Existence is checked HERE rather than left to the shell. Measured on
    // Windows: handing `openPath` a missing directory pops Explorer's own modal
    // error dialog and the promise does not settle until a human dismisses it —
    // so the button would hang forever behind a dialog the app never mentioned.
    try {
      await fs.access(folder);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log("error", "diagnostics", "log folder missing", { folder, reason });
      throw new Error(`로그 폴더가 없습니다 (${folder}). 앱을 다시 시작하면 새로 만들어집니다.`);
    }
    // `openPath` RESOLVES with the OS error text on failure — it does not reject.
    // Dropping that return is exactly the silent failure this project forbids:
    // the button would report success while nothing appeared on screen.
    const failure = await shell.openPath(folder);
    if (failure) {
      log("error", "diagnostics", "log folder open failed", { folder, failure });
      throw new Error(`로그 폴더를 열지 못했습니다 (${folder}): ${failure}`);
    }
    log("info", "diagnostics", "log folder opened", { folder });
    return { ok: true, path: folder };
  }

  // --- Model routes ---------------------------------------------------------
  /**
   * Current selectable model routes + Codex catalog discovery state. `catalog`
   * reports which model catalog built the routes (remote/cache/bundled) so a
   * stale or failed remote fetch is visible to the UI and automation clients.
   */
  async listModels(workspacePath: string): Promise<{ ok: true; modelRoutes: unknown[]; modelProviders: typeof MODEL_PROVIDERS; harnesses: unknown[]; codexModels: CodexModelDiscoveryState; catalog: RemoteCatalogStatus }> {
    const codexModels = await this.engineFor(workspacePath).listCodexModels();
    return { ok: true, ...publicModelDiscovery(codexModels), catalog: remoteModelCatalogStatus() };
  }

  /** Re-runs Codex catalog discovery and returns the fresh state. */
  async refreshCodexModels(workspacePath: string): Promise<{ ok: true; modelRoutes: unknown[]; modelProviders: typeof MODEL_PROVIDERS; harnesses: unknown[]; codexModels: CodexModelDiscoveryState }> {
    const codexModels = await this.engineFor(workspacePath).listCodexModels(true);
    return { ok: true, ...publicModelDiscovery(codexModels) };
  }

  /**
   * Where the model catalog currently in effect came from (remote/cache/bundled),
   * with the last fetch outcome — a failed fetch is visible here, not silent.
   */
  getModelCatalogStatus(): { ok: true; catalog: RemoteCatalogStatus } {
    return { ok: true, catalog: remoteModelCatalogStatus() };
  }

  /**
   * Force-fetches the published remote catalog now. A changed catalog pushes
   * rebuilt model routes to every window via the callback wired in main.ts;
   * the returned status carries the outcome either way.
   */
  async refreshModelCatalog(): Promise<{ ok: true; catalog: RemoteCatalogStatus }> {
    const catalog = await refreshRemoteModelCatalog();
    return { ok: true, catalog };
  }

  /**
   * Pushes rebuilt model routes to every window after a Codex catalog discovery
   * settles (ready or error), so open pickers update live and a failure is
   * visible instead of silently keeping the static fallback. Wired from the
   * SessionManager `codex-models` event in main.ts.
   */
  async notifyCodexModelsChanged(): Promise<void> {
    for (const entry of this.deps.windowRegistry.all()) {
      const payload = await this.listModels(entry.workspacePath);
      entry.window.webContents.send("models:update", payload);
      this.deps.mobileLink?.publish("models:update", payload, entry.workspacePath);
    }
  }

  /**
   * Current account/provider-scoped rate-limit usage. Global (not workspace- or
   * window-scoped): these limits are shared by every agent using that provider,
   * so the single titlebar indicator reads from the one merged snapshot. Live
   * updates arrive via the "usage:update" push (wired in main.ts).
   */
  getUsageLimits(): { ok: true; usage: UsageLimitsSnapshot } {
    return { ok: true, usage: this.deps.sessionManager.getUsageLimits() };
  }

  async refreshUsageLimits(): Promise<{ ok: true; usage: UsageLimitsSnapshot }> {
    return { ok: true, usage: await this.deps.sessionManager.refreshUsageLimits() };
  }

  // --- App self-update ------------------------------------------------------
  /**
   * Where the app update stands. Global, like usage limits — one installed build
   * serves every window — so the status is fetched once per window and kept live
   * by the "update:status" push wired in main.ts.
   */
  getUpdateStatus(): { ok: true; update: UpdateStatus } {
    return { ok: true, update: this.updater().getStatus() };
  }

  getUpdateChannel(): { ok: true; channel: UpdateChannel } {
    return { ok: true, channel: this.updater().getChannel() };
  }

  async setUpdateChannel(value: unknown): Promise<{ ok: true; channel: UpdateChannel; update: UpdateStatus }> {
    const channel = requireUpdateChannel(value);
    const update = await this.updater().setChannel(channel);
    return { ok: true, channel, update };
  }

  /**
   * Published release history, newest first — the 설정 → 버전 tab's list. Kept
   * separate from {@link getUpdateStatus}: that one is "what should I do now",
   * this one is "what has ever shipped", and the tab shows the history even
   * when self-update is unavailable.
   */
  async listReleaseVersions(options: { refresh?: boolean } = {}): Promise<{ ok: true; releases: ReleaseSummary[] }> {
    return { ok: true, releases: await this.updater().listReleases(Boolean(options.refresh)) };
  }

  /** Asks the release feed for the latest version. Reports failures in the status, not by throwing. */
  async checkForUpdate(options: UpdateCheckOptions = {}): Promise<{ ok: true; update: UpdateStatus }> {
    return { ok: true, update: await this.updater().check({ quiet: Boolean(options.quiet) }) };
  }

  /** Starts downloading the pending installer; progress arrives on the push channel. */
  async downloadUpdate(): Promise<{ ok: true; update: UpdateStatus }> {
    return { ok: true, update: await this.updater().download() };
  }

  /**
   * Quits and installs the downloaded build. Every running member is stopped by
   * the quit — the UI confirms before calling this.
   */
  installUpdate(): { ok: true } {
    return this.updater().install();
  }

  /**
   * QA-only: pins an update status (and optionally a release history) so the
   * banner and the 버전 tab can be driven without publishing a release.
   */
  setMockUpdateStatus(patch: (Partial<UpdateStatus> & { releases?: ReleaseSummary[] }) | undefined): { ok: true; update: UpdateStatus; releases?: ReleaseSummary[] } {
    const updater = this.updater();
    if (!patch) {
      return { ok: true, update: updater.setMockStatus(undefined), releases: updater.setMockReleases(undefined) };
    }
    const { releases, ...status } = patch;
    return {
      ok: true,
      update: updater.setMockStatus(status),
      releases: releases ? updater.setMockReleases(releases) : undefined,
    };
  }

  /** The updater, or a hard error — a missing one must not read as "up to date". */
  private updater(): UpdateController {
    const updater = this.deps.updater;
    if (!updater) {
      const status = initialUpdateStatus(this.deps.getAppBuild?.().version || "0.0.0");
      throw new Error(`이 프로세스는 앱 자동 업데이트를 제공하지 않습니다 (현재 버전 ${status.currentVersion}).`);
    }
    return updater;
  }

  // --- Mobile link (설정 → 모바일 연결) -----------------------------------
  // Pairing, trusted phones, live phone sessions, and NAT diagnostics. The
  // capabilities a phone CALLS are not here — those are the same methods the
  // desktop UI and HTTP use, dispatched from the shared capability table.

  getMobileStatus(): { ok: true; status: GatewayStatus } {
    return { ok: true, status: this.mobile().status() };
  }

  getMobileSettings(): { ok: true; settings: MobileSettings } {
    return { ok: true, settings: this.mobile().settings() };
  }

  async updateMobileSettings(patch: Partial<MobileSettings>): Promise<{ ok: true; settings: MobileSettings }> {
    const settings = await this.mobile().updateSettings(patch);
    const publicSettings = getPublicSettings();
    for (const entry of this.deps.windowRegistry.all()) {
      entry.window.webContents.send("settings:update", publicSettings);
    }
    return { ok: true, settings };
  }

  listMobileDevices(): { ok: true; devices: TrustedDevice[] } {
    return { ok: true, devices: this.mobile().devices() };
  }

  /**
   * Opens a single-use pairing QR. The 4-digit confirmation code appears in
   * `getMobileStatus().pairing.code` once the phone has scanned — the caller
   * (UI or QA) polls that rather than holding a session object.
   */
  async openMobilePairing(): Promise<{ ok: true; qr: string; expiresAt: number }> {
    return { ok: true, ...(await this.mobile().openPairing()) };
  }

  async confirmMobilePairing(): Promise<{ ok: true; status: GatewayStatus }> {
    const link = this.mobile();
    await link.confirmPairing();
    return { ok: true, status: link.status() };
  }

  async cancelMobilePairing(): Promise<{ ok: true; status: GatewayStatus }> {
    const link = this.mobile();
    await link.cancelPairing();
    return { ok: true, status: link.status() };
  }

  /** Forgets a phone and drops any session it holds. Returns the list that remains. */
  async revokeMobileDevice(deviceId: string): Promise<{ ok: true; devices: TrustedDevice[] }> {
    const link = this.mobile();
    await link.revokeDevice(deviceId);
    return { ok: true, devices: link.devices() };
  }

  async renameMobileDevice(deviceId: string, name: string): Promise<{ ok: true; devices: TrustedDevice[] }> {
    const link = this.mobile();
    await link.renameDevice(deviceId, name);
    return { ok: true, devices: link.devices() };
  }

  /** Cuts one live phone session now; the trust record survives (04 §즉시 끊기). */
  async disconnectMobileSession(sessionId: string, reason?: string): Promise<{ ok: true; status: GatewayStatus }> {
    const link = this.mobile();
    await link.disconnectSession(sessionId, reason);
    return { ok: true, status: link.status() };
  }

  async getMobileDiagnostics(): Promise<{ ok: true; diagnostics: NatDiagnostics }> {
    return { ok: true, diagnostics: await this.mobile().diagnostics() };
  }

  getMobileConnectionLock(): { ok: true; lock: MobileConnectionLockStatus } {
    return { ok: true, lock: this.mobile().connectionLockStatus() };
  }

  async configureMobileConnectionLock(
    kind: MobileConnectionLockKind,
    secret: string,
  ): Promise<{ ok: true; lock: MobileConnectionLockStatus }> {
    return { ok: true, lock: await this.mobile().configureConnectionLock(kind, secret) };
  }

  async clearMobileConnectionLock(): Promise<{ ok: true; lock: MobileConnectionLockStatus }> {
    return { ok: true, lock: await this.mobile().clearConnectionLock() };
  }

  /**
   * The mobile link, or a hard error. Absent in the headless WSL engine, which
   * has no identity store and no user to confirm a pairing code, and in a build
   * whose optional mobile pipe was left out (`src/main/mobilePipe.ts`) — saying
   * so is better than answering with an empty device list that reads as "not
   * paired".
   */
  private mobile(): MobileLinkService {
    const link = this.deps.mobileLink;
    if (!link) {
      throw new Error("이 프로세스는 모바일 연결을 제공하지 않습니다 — 이 빌드에 모바일 파이프가 없거나(@agentparty/protocol 미설치), 데스크톱 앱이 아닌 프로세스입니다. 정확한 이유는 앱 로그의 mobile 항목에 있습니다.");
    }
    return link;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    if (Object.prototype.hasOwnProperty.call(patch || {}, "updateChannel")) {
      throw new Error("업데이트 채널은 POST /api/update/channel 또는 버전 탭에서 변경하세요.");
    }
    let validatedPatch = patch || {};
    if (Object.prototype.hasOwnProperty.call(validatedPatch, "locale")) {
      validatedPatch = { ...validatedPatch, locale: requireAppLocale(validatedPatch.locale) };
    }
    if (Object.prototype.hasOwnProperty.call(validatedPatch, "theme")) {
      if (appearanceAccess(this.deps) !== "local") {
        throw appearanceOwnerError();
      }
      validatedPatch = { ...validatedPatch, theme: requireThemePreference(validatedPatch.theme) };
    }
    const previous = getSettings();
    updateSettings(validatedPatch);
    this.deps.onSettingsChanged();
    if (typeof validatedPatch.debugEnabled === "boolean" && validatedPatch.debugEnabled !== previous.debugEnabled) {
      this.deps.sessionManager.setDebugMode(validatedPatch.debugEnabled);
    }
    // Idle sleep is acted on by whichever host owns the sessions, which for a WSL
    // workspace is inside the distro — and that host reads a different
    // settings.json. Push the value instead of letting each engine look it up.
    if (validatedPatch.idleSleep) {
      void this.deps.engineRegistry.setIdleSleep(getSettings().idleSleep);
    }
    if (validatedPatch.memberMessaging) {
      void this.deps.engineRegistry.setMemberMessaging(getSettings().memberMessaging);
    }
    if (Object.prototype.hasOwnProperty.call(validatedPatch, "theme")) {
      this.applyWindowTheme(validatedPatch.theme as ThemePreference);
      this.broadcastAppearance();
    }
    return this.publishSettings();
  }

  /** Pushes already-persisted app-global settings to every live consumer. */
  private publishSettings(): AppSettings {
    const settings = getPublicSettings();
    // The renderer preserves each window's own workspacePath on merge.
    this.deps.mobileLink?.publish("settings:update", settings);
    for (const entry of this.deps.windowRegistry.all()) {
      entry.window.webContents.send("settings:update", settings);
    }
    return settings;
  }

  getLocale(): { locale: AppLocale } {
    return { locale: getSettings().locale };
  }

  setLocale(value: unknown): AppSettings {
    return this.updateSettings({ locale: requireAppLocale(value) });
  }

  /**
   * Appearance: the user's built-in color theme and the theme the UI is
   * actually painting. Same method behind Settings
   * and GET /api/appearance/theme. A headless engine forwards to the desktop
   * over HostChannel; without a channel it rejects instead of writing a
   * distro-only settings.json.
   */
  async getAppearance(): Promise<AppearanceState> {
    const access = appearanceAccess(this.deps);
    if (access === "remote") {
      return this.deps.appearanceRemote!.getAppearance();
    }
    if (access === "unavailable") {
      throw appearanceOwnerError();
    }
    return this.readLocalAppearance();
  }

  async setTheme(value: unknown): Promise<AppearanceState> {
    const theme = requireThemePreference(value);
    const access = appearanceAccess(this.deps);
    if (access === "remote") {
      return this.deps.appearanceRemote!.setTheme(theme);
    }
    if (access === "unavailable") {
      throw appearanceOwnerError();
    }
    this.updateSettings({ theme });
    return this.getAppearance();
  }

  async qaSetRendererStorage(windowId: string | undefined, patch: { theme?: string | null; themePreference?: string | null }): Promise<{ theme: string | null; themePreference: string | null }> {
    this.requireQa();
    const win = this.windowFor(windowId);
    if (!win) {
      throw new Error("Target window is not available.");
    }
    const result = await win.webContents.executeJavaScript(
      `(() => {
        const theme = ${JSON.stringify(patch.theme === undefined ? undefined : patch.theme)};
        const pref = ${JSON.stringify(patch.themePreference === undefined ? undefined : patch.themePreference)};
        if (theme === null) localStorage.removeItem(${JSON.stringify(THEME_STORAGE_KEY)});
        else if (typeof theme === "string") localStorage.setItem(${JSON.stringify(THEME_STORAGE_KEY)}, theme);
        if (pref === null) localStorage.removeItem(${JSON.stringify(THEME_PREFERENCE_STORAGE_KEY)});
        else if (typeof pref === "string") localStorage.setItem(${JSON.stringify(THEME_PREFERENCE_STORAGE_KEY)}, pref);
        return {
          theme: localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}),
          themePreference: localStorage.getItem(${JSON.stringify(THEME_PREFERENCE_STORAGE_KEY)}),
        };
      })()`,
    );
    await win.webContents.session.flushStorageData();
    return result;
  }

  private readLocalAppearance(): AppearanceState {
    const stored = storedThemePreference();
    const preference = stored ?? normalizeThemePreference(getSettings().theme);
    return appearanceStateOf(preference, stored !== undefined);
  }

  private applyWindowTheme(preference: ThemePreference): void {
    const color = windowBackgroundFor(preference);
    const windows = typeof this.deps.windowRegistry.all === "function" ? this.deps.windowRegistry.all() : [];
    for (const entry of windows) {
      entry.window?.setBackgroundColor?.(color);
    }
  }

  private broadcastAppearance(): void {
    const appearance = this.readLocalAppearance();
    this.deps.mobileLink?.publish("appearance:update", appearance);
    const windows = typeof this.deps.windowRegistry.all === "function" ? this.deps.windowRegistry.all() : [];
    for (const entry of windows) {
      entry.window.webContents.send("appearance:update", appearance);
    }
  }

  /**
   * The party-member primer, section by section: the built-in text, the user's
   * edit, and whether the section is on. This is what Settings → 런타임 → 파티
   * 프롬프트 renders, and what an agent reads before editing a section, so both
   * see one truth rather than a copy of the prompt.
   */
  getPartyPrimer(): {
    sections: PartyPrimerSectionView[];
    variables: readonly string[];
    totals: ReturnType<typeof partyPrimerTotals>;
    delivery: typeof PARTY_PRIMER_DELIVERY;
  } {
    const sections = partyPrimerView(getSettings().partyPrimer);
    return {
      sections,
      variables: PARTY_PRIMER_VARIABLES,
      totals: partyPrimerTotals(sections),
      // When each harness installs it — the answer to "턴마다 들어가나?".
      delivery: PARTY_PRIMER_DELIVERY,
    };
  }

  /**
   * Edits ONE primer section: `text` sets an override (`null`, empty, or text
   * identical to the built-in clears it), `enabled` turns an optional section off.
   * Returns the resulting section so a caller never has to assume the edit landed.
   * Takes effect for sessions started (or resumed) after the change — a running
   * member keeps the primer it booted with.
   */
  savePartyPrimerSection(patch: { section: string; text?: string | null; enabled?: boolean }): { section: PartyPrimerSectionView; settings: AppSettings } {
    const { settings: partyPrimer, applied } = applyPartyPrimerPatch(getSettings().partyPrimer, patch);
    const settings = this.updateSettings({ partyPrimer });
    return { section: applied, settings };
  }

  /**
   * Translates one primer section into Korean and stores the result next to it.
   * The prompt itself stays English — this is a reading aid for the human, which
   * is why the stored translation carries a hash of the English it came from and
   * reports itself stale once that text is edited.
   *
   * `translation: null` in the patch clears a saved translation instead.
   */
  async translatePartyPrimerSection(patch: { section: string; clear?: boolean; model?: string }): Promise<{ section: PartyPrimerSectionView; settings: AppSettings }> {
    const current = getSettings();
    const view = partyPrimerView(current.partyPrimer).find((entry) => entry.id === patch.section);
    if (!view) {
      throw new Error(`알 수 없는 프롬프트 섹션입니다: ${patch.section}`);
    }
    const translation = patch.clear
      ? null
      : {
          ...(await translatePrimerSection({ title: view.title, text: view.text }, {
            routerBaseUrl: this.deps.getRouterBaseUrl(),
            routerAuthToken: getSettings().routerAuthToken,
            subscriptionProxy: subscriptionProxyConfig(),
          }, patch.model)),
          // Hash the text the translator was actually given, not the section as
          // it may read by the time the answer arrives.
          source: view.text,
        };
    const { settings: partyPrimer, applied } = applyPartyPrimerTranslation(current.partyPrimer, { section: patch.section, translation });
    const settings = this.updateSettings({ partyPrimer });
    return { section: applied, settings };
  }

  /** Desktop auth cards with each native CLI's real, cached login state. */
  private async authStateWithCli(workspacePath: string, base?: ReturnType<typeof getAuthState>, forceClaude = false): Promise<ReturnType<typeof getAuthState>> {
    const [cursor, codex, claude] = await Promise.all([
      cursorCliAuthState(),
      codexCliAuthState(),
      this.engineFor(workspacePath).getClaudeNativeAuth(forceClaude),
    ]);
    const state = withClaudeNativeAuth(withCodexCliAuth(withCursorCliAuth(base || getAuthState(), cursor), codex), claude);
    return this.withNativeCliTestState(state, workspacePath);
  }

  private nativeCliAuthTestKey(workspacePath: string, provider: NativeCliAuthProvider, host: NativeCliAuthHost): string {
    return `${workspaceKey(workspacePath)}:${provider}:${host}`;
  }

  /** Applies the last button-driven proof without rerunning WSL during a routine auth refresh. */
  private withNativeCliTestState(states: AuthProviderState[], workspacePath: string): AuthProviderState[] {
    let next = states;
    for (const state of states) {
      const action = state.action;
      if (action?.type !== "nativeCliTest") continue;
      const tested = this.nativeCliAuthTests.get(this.nativeCliAuthTestKey(workspacePath, action.provider, action.host));
      if (!tested) continue;
      next = applyNativeCliAuthProgress(next, {
        provider: action.provider,
        host: action.host,
        checkedAt: tested.checkedAt,
        phase: tested.phase,
        distro: tested.distro,
        check: tested.check,
      });
    }
    return next;
  }

  /**
   * Executes one native CLI until login/runtime readiness is proven or one
   * named stage fails. UI, IPC, and HTTP all call this exact method.
   */
  async testNativeCliAuth(
    provider: NativeCliAuthProvider,
    host: NativeCliAuthHost,
    workspacePath = getSettings().workspacePath || process.cwd(),
    distro?: string,
  ): Promise<NativeCliAuthTestResult> {
    const checkedAt = new Date().toISOString();
    const publish = (progress: Omit<NativeCliAuthProgress, "provider" | "host" | "checkedAt">) => {
      const event: NativeCliAuthProgress = { provider, host, checkedAt, ...progress };
      this.nativeCliAuthTests.set(this.nativeCliAuthTestKey(workspacePath, provider, host), {
        checkedAt,
        phase: event.phase,
        check: event.check,
        distro: event.distro,
      });
      this.broadcastNativeCliAuthProgress(event, workspacePath);
    };
    publish({
      phase: "pending",
      check: nativeCliAuthProgressCheck(provider, host, [], "pending"),
      ...(distro ? { distro } : {}),
    });
    let tested: Awaited<ReturnType<typeof probeNativeCliAuthentication>>;
    try {
      tested = await probeNativeCliAuthentication({
        provider,
        host,
        workspacePath,
        distro,
        onProgress: ({ phase, check, distro: activeDistro }) => publish({
          phase,
          check,
          ...(activeDistro ? { distro: activeDistro } : {}),
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.nativeCliAuthTests.get(this.nativeCliAuthTestKey(workspacePath, provider, host));
      const settled = (current?.check.steps || []).filter((step) => step.status === "ok" || step.status === "failed" || step.status === "skipped");
      const active = current?.check.steps?.find((step) => step.status === "running")
        || current?.check.steps?.find((step) => step.status === "pending")
        || { id: "probe", label: "검사 실행", detail: "검사를 시작하지 못했습니다." };
      const failure = {
        ...active,
        status: "failed" as const,
        detail: `예상하지 못한 검사 오류가 발생했습니다: ${message}`,
        failureKind: "protocol" as const,
        raw: message,
      };
      const failedCheck = nativeCliAuthProgressCheck(provider, host, [...settled.filter((step) => step.id !== active.id), failure], "complete", {
        ...(current?.check || nativeCliAuthProgressCheck(provider, host, [], "pending")),
        status: "error",
        detail: failure.detail,
      });
      publish({ phase: "complete", check: failedCheck, ...(current?.distro ? { distro: current.distro } : {}) });
      throw error;
    }
    const auth = this.broadcastAuth(withSubscriptionProxyAuth(
      await this.authStateWithCli(workspacePath),
      await this.getSubscriptionStatus(),
    ));
    return {
      ok: tested.check.status === "ok" || tested.check.status === "warn",
      provider,
      host,
      ...(tested.distro ? { distro: tested.distro } : {}),
      checkedAt,
      check: tested.check,
      auth,
    };
  }

  /** Non-blocking snapshot for automation clients following an in-flight test. */
  getNativeCliAuthProgress(
    provider: NativeCliAuthProvider,
    host: NativeCliAuthHost,
    workspacePath = getSettings().workspacePath || process.cwd(),
  ): NativeCliAuthProgress | undefined {
    const tested = this.nativeCliAuthTests.get(this.nativeCliAuthTestKey(workspacePath, provider, host));
    return tested ? {
      provider,
      host,
      checkedAt: tested.checkedAt,
      phase: tested.phase,
      check: tested.check,
      ...(tested.distro ? { distro: tested.distro } : {}),
    } : undefined;
  }

  async listAuthProviders(workspacePath = getSettings().workspacePath || process.cwd()): Promise<ReturnType<typeof getAuthState>> {
    const subscriptions = await this.getSubscriptionStatus();
    return withSubscriptionProxyAuth(await this.authStateWithCli(workspacePath), subscriptions);
  }

  /** Exact native Claude login for the engine host serving this workspace. */
  getNativeClaudeAuth(workspacePath: string, force = false) {
    return this.engineFor(workspacePath).getClaudeNativeAuth(force);
  }

  async setOpenRouterKey(key: string, workspacePath = getSettings().workspacePath || process.cwd()): Promise<ReturnType<typeof getAuthState>> {
    const state = setOpenRouterKey(key || "");
    this.deps.onSettingsChanged();
    return this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCli(workspacePath, state), await this.getSubscriptionStatus()));
  }

  async clearOpenRouterKey(workspacePath = getSettings().workspacePath || process.cwd()): Promise<ReturnType<typeof getAuthState>> {
    const state = clearOpenRouterKey();
    this.deps.onSettingsChanged();
    return this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCli(workspacePath, state), await this.getSubscriptionStatus()));
  }

  async testOpenRouterKey(workspacePath = getSettings().workspacePath || process.cwd()): Promise<ReturnType<typeof getAuthState>> {
    return this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCli(workspacePath, await testOpenRouterKey()), await this.getSubscriptionStatus()));
  }

  async setDeepseekKey(key: string, workspacePath = getSettings().workspacePath || process.cwd()): Promise<ReturnType<typeof getAuthState>> {
    const state = setDeepseekKey(key || "");
    this.deps.onSettingsChanged();
    return this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCli(workspacePath, state), await this.getSubscriptionStatus()));
  }

  async clearDeepseekKey(workspacePath = getSettings().workspacePath || process.cwd()): Promise<ReturnType<typeof getAuthState>> {
    const state = clearDeepseekKey();
    this.deps.onSettingsChanged();
    return this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCli(workspacePath, state), await this.getSubscriptionStatus()));
  }

  async testDeepseekKey(workspacePath = getSettings().workspacePath || process.cwd()): Promise<ReturnType<typeof getAuthState>> {
    return this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCli(workspacePath, await testDeepseekKey()), await this.getSubscriptionStatus()));
  }

  /** The full provider list, for the automation API's GET /api/auth. */
  async getAuthProviders(workspacePath = getSettings().workspacePath || process.cwd()): Promise<ReturnType<typeof getAuthState>> {
    return withSubscriptionProxyAuth(await this.authStateWithCli(workspacePath, getAuthState()), await this.getSubscriptionStatus());
  }

  /** Live OAuth-backed model availability from the local CLIProxyAPI. */
  getSubscriptionAuthState(): ReturnType<SubscriptionProxyController["getStatus"]> {
    return this.getSubscriptionStatus();
  }

  /** Starts one browser OAuth flow and returns the same auth state the UI uses. */
  async loginSubscriptionProvider(provider: SubscriptionProxyProvider, workspacePath = getSettings().workspacePath || process.cwd()) {
    if (!this.deps.subscriptionProxy) {
      throw new Error("Subscription OAuth must be started from the AgentParty desktop Authentication screen, not a remote workspace engine.");
    }
    const result = await this.deps.subscriptionProxy.login(provider);
    const auth = this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCli(workspacePath), result.subscriptions));
    return {
      ...result,
      auth,
    };
  }

  /** Disconnects one persisted subscription account and refreshes every UI. */
  async disconnectSubscriptionProvider(provider: SubscriptionProxyProvider | "cursor", workspacePath = getSettings().workspacePath || process.cwd()) {
    if (provider === "cursor") {
      return this.disconnectCursor(workspacePath);
    }
    if (!this.deps.subscriptionProxy) {
      throw new Error("Subscription OAuth must be managed from the AgentParty desktop Authentication screen, not a remote workspace engine.");
    }
    const result = await this.deps.subscriptionProxy.disconnect(provider);
    const auth = this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCli(workspacePath), result.subscriptions));
    return {
      ...result,
      auth,
    };
  }

  /**
   * Signs the DESKTOP HOST's Cursor Agent CLI out (`cursor-agent logout`) — the
   * account the auth card describes. A WSL distro's own Cursor login is that
   * host's credential and is not touched here.
   */
  private async disconnectCursor(workspacePath: string) {
    const result = await cursorAgentLogout(getSettings().cursorExecutablePath);
    invalidateCursorAuthCache();
    const auth = this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCli(workspacePath), await this.getSubscriptionStatus()));
    return {
      ok: result.ok,
      provider: "cursor" as const,
      status: "disconnected" as const,
      detail: result.detail,
      auth,
    };
  }

  private getSubscriptionStatus(): ReturnType<SubscriptionProxyController["getStatus"]> {
    return this.deps.subscriptionProxy?.getStatus() || getSubscriptionProxyStatus();
  }

  /** Keeps every window in sync when Authentication is driven over HTTP. */
  private broadcastAuth(auth: ReturnType<typeof getAuthState>): ReturnType<typeof getAuthState> {
    this.deps.mobileLink?.publish("auth:update", auth);
    for (const entry of this.deps.windowRegistry.all()) {
      entry.window.webContents.send("auth:update", auth);
    }
    return auth;
  }

  /** Lightweight incremental event; avoids rerunning unrelated CLIs per step. */
  private broadcastNativeCliAuthProgress(progress: NativeCliAuthProgress, workspacePath: string): void {
    this.deps.mobileLink?.publish("auth:native-progress", progress, workspacePath);
    for (const entry of this.deps.windowRegistry.all()) {
      if (workspaceKey(entry.workspacePath) !== workspaceKey(workspacePath)) continue;
      entry.window.webContents.send("auth:native-progress", progress);
    }
  }

  // --- Windows + workspace ------------------------------------------------
  listWindows(): WindowInfo[] {
    return this.deps.windowRegistry.list();
  }

  /**
   * The workspaces this desktop is currently serving: one entry per workspace an
   * open window is viewing, plus the default a new window would use.
   *
   * A paired phone reaches every workspace of the PC it paired with (문서 04 §3),
   * so it lists these once and then stamps `workspacePath` on each later call
   * rather than being pinned to one workspace for the life of its session.
   */
  listWorkspaces(): { workspaces: Array<WorkspaceDisplay & { windowIds: string[]; isDefault: boolean }> } {
    const byKey = new Map<string, { path: string; windowIds: string[] }>();
    const remember = (workspacePath: string, windowId?: string) => {
      const key = workspaceKey(workspacePath);
      const entry = byKey.get(key) || { path: workspacePath, windowIds: [] };
      if (windowId) entry.windowIds.push(windowId);
      byKey.set(key, entry);
    };
    for (const window of this.deps.windowRegistry.list()) {
      remember(window.workspacePath, window.id);
    }
    const fallback = getSettings().workspacePath || process.cwd();
    remember(fallback);
    const defaultKey = workspaceKey(fallback);
    return {
      workspaces: [...byKey].map(([key, entry]) => ({
        ...this.workspaceDisplay(entry.path),
        windowIds: entry.windowIds,
        isDefault: key === defaultKey,
      })),
    };
  }

  /**
   * Opens a window, optionally ON a specific party.
   *
   * Party ids are global. Validate after lazily importing the requested cwd and
   * before creating the BrowserWindow; PartyApplicationService.list() normally
   * falls back from an unknown id, which would otherwise hide a routing bug.
   *
   * The party is PINNED before the window can ask, because pinning otherwise
   * happens at the window's first `getState` and would capture whatever the
   * shared advisory hint held at that moment — i.e. the party the OTHER window
   * is on. Setting it up front is what makes "open this party in a new window"
   * land on that party instead of a copy of the current one.
   */
  async openWindow(workspacePath?: string, partyId?: string): Promise<WindowInfo> {
    const targetWorkspace = workspacePath || getSettings().workspacePath || process.cwd();
    // Resolve the engine before creating a BrowserWindow. This is the shared
    // workspace validity boundary (local + WSL), so an API call with a relative
    // path fails visibly instead of first returning a window whose renderer can
    // never hydrate.
    // Resolve the execution workspace as a validity check, but party lookup is
    // global and must never re-scope to the cwd used to open this window.
    this.engineFor(targetWorkspace);
    await this.migratePartyGroups([targetWorkspace]);
    if (partyId) {
      const listing = await this.partyEngine(targetWorkspace).listParty(undefined);
      if (!(listing.parties || []).some((party) => party.id === partyId)) {
        throw new Error(`Party '${partyId}' does not exist in the global party store.`);
      }
    }

    const info = await this.deps.openWindow(targetWorkspace);
    if (partyId) {
      this.activePartyByWindow.set(info.id, partyId);
    }
    return info;
  }

  /**
   * Navigates the focused app window to the guide screen. Same path as the nav
   * rail's 가이드 button and as POST /api/guide/open, so a user and an agent
   * land identically — including the account gate below. Touches no party store.
   */
  async openGuideScreen(windowId?: string): Promise<GuideScreenInfo> {
    const auth = await this.listAuthProviders();
    if (!hasConnectedAccount(auth)) {
      const target = this.deps.windowRegistry.resolve(windowId);
      if (target) {
        this.navigate(target.id, "auth");
      }
      throw new Error("연결된 계정이 없습니다. 인증 화면에서 계정을 연결한 뒤 다시 열어 주세요.");
    }
    return this.requireGuide().open(windowId);
  }

  closeGuideScreen(): GuideScreenInfo {
    return this.requireGuide().close();
  }

  setGuideSlide(index: number): Promise<GuideScreenInfo> {
    return this.requireGuide().setSlide(index);
  }

  getGuideScreen(): GuideScreenInfo {
    return this.requireGuide().get();
  }

  captureGuideScreen(outputPath?: string): Promise<{ ok: true; path: string; width: number; height: number; bytes: number }> {
    return this.requireGuide().capture(outputPath);
  }

  inspectGuideScreen(): Promise<GuideInspect> {
    return this.requireGuide().inspect();
  }

  clickGuide(selector: string): Promise<{ ok: true; selector: string }> {
    return this.requireGuide().click(selector);
  }

  /** Slide spotlight geometry, in the units the slide catalog is written in. */
  measureGuideStage(selector: string): Promise<unknown> {
    if (!selector.trim()) {
      throw new Error("POST /api/guide/stage/measure 는 'selector' 가 필요합니다.");
    }
    return this.requireGuide().measureStage(selector.trim());
  }

  setGuideAsk(open: boolean): GuideScreenInfo {
    return this.requireGuide().setAsk(open);
  }

  guideKnowledge(): { path: string } {
    return { path: this.requireGuideChat().knowledgePath() };
  }

  /** The model catalog the guide's own settings modal shows. Scoped to
   *  the guide's cwd (its knowledge folder) so it never touches a user party. */
  async guideModels(): Promise<unknown[]> {
    const payload = await this.listModels(this.requireGuideChat().knowledgePath());
    return payload.modelRoutes;
  }

  getGuideChatSettings(): GuideChatSettings {
    return this.requireGuideChat().settings();
  }

  updateGuideChatSettings(patch: Partial<GuideChatSettings>): GuideChatSettings {
    return this.requireGuideChat().updateSettings(patch);
  }

  getGuideChat(kind: GuideChatKind): GuideChatView {
    return this.requireGuideChat().view(kind);
  }

  sendGuideChat(kind: GuideChatKind, text: string, viewing?: { index: number; title: string; scene: string }): Promise<GuideChatView> {
    return this.requireGuideChat().send(kind, text, viewing);
  }

  resetGuideChat(kind: GuideChatKind): GuideChatView {
    return this.requireGuideChat().reset(kind);
  }

  compactGuideChat(kind: GuideChatKind): GuideChatView {
    return this.requireGuideChat().compact(kind);
  }

  getGuideOffer(): GuideOfferView {
    return getGuideOffer();
  }

  markGuideOfferShown(): GuideOfferView {
    return markGuideOfferShown();
  }

  private requireGuide(): NonNullable<AppControllerDeps["guide"]> {
    if (!this.deps.guide) {
      throw new Error("가이드 화면은 데스크톱 앱에서만 열 수 있습니다.");
    }
    return this.deps.guide;
  }

  private requireGuideChat(): NonNullable<AppControllerDeps["guideChat"]> {
    if (!this.deps.guideChat) {
      throw new Error("가이드 채팅은 데스크톱 앱에서만 쓸 수 있습니다.");
    }
    return this.deps.guideChat;
  }

  /** Changes a window's cwd/execution context and imports that former store. */
  async setWindowWorkspace(windowId: string | undefined, workspacePath: string): Promise<InitialAppState>;
  async setWindowWorkspace(
    windowId: string | undefined,
    workspacePath: string,
    options: { omitStateWhenUnchanged: true },
  ): Promise<InitialAppState | undefined>;
  async setWindowWorkspace(
    windowId: string | undefined,
    workspacePath: string,
    options?: { omitStateWhenUnchanged?: boolean },
  ): Promise<InitialAppState | undefined> {
    const entry = this.deps.windowRegistry.resolve(windowId);
    // The renderer asks whenever a party names a home and cannot reliably
    // decide whether this window is already there from its asynchronous copy.
    // Decide here against the authoritative window registry.
    if (entry && workspaceKey(entry.workspacePath) === workspaceKey(workspacePath)) {
      // The grouped sidebar does not consume a duplicate state when no move
      // occurred. Other callers retain the documented fresh-state response.
      if (options?.omitStateWhenUnchanged) {
        return undefined;
      }
      return this.getState(entry.workspacePath, entry.id);
    }
    if (entry) {
      // Hydrate first. A bad/offline destination must not commit a window move
      // that its renderer cannot apply.
      const nextState = await this.getState(workspacePath, this.globalPartyMode() ? entry.id : undefined);
      this.rebindWindowWorkspace(entry, workspacePath);
      // In global-party mode a selected party remains valid while the window's
      // cwd/migration source changes. Headless legacy mode still replaces the
      // workspace-scoped pin with that destination's current party.
      const pinnedParty = this.activePartyByWindow.get(entry.id);
      this.forgetWindow(entry.id);
      if (this.globalPartyMode() && pinnedParty) {
        this.activePartyByWindow.set(entry.id, pinnedParty);
      } else if (nextState.party.currentPartyId) {
        this.activePartyByWindow.set(entry.id, nextState.party.currentPartyId);
      }
      // The window now serves a different workspace → refresh discovery files.
      this.deps.onWorkspacesChanged();
      updateSettings({ workspacePath });
      return nextState;
    }
    // Remember as the default workspace for newly opened windows.
    updateSettings({ workspacePath });
    // No concrete window to rebind (headless/internal caller): return the same
    // host-correct snapshot without inventing window ownership.
    return this.getState(workspacePath);
  }

  /**
   * Rebinds one already-validated window and releases the old engine when no
   * window owns it anymore. A workspace switch bypasses the BrowserWindow close
   * hook, so without this a WSL child process and its sessions lived forever.
   */
  private rebindWindowWorkspace(entry: WindowEntry, workspacePath: string): void {
    const previousWorkspace = entry.workspacePath;
    this.deps.windowRegistry.setWorkspace(entry.id, workspacePath);
    if (this.deps.windowRegistry.forWorkspace(previousWorkspace).length === 0) {
      this.deps.engineRegistry.dispose(previousWorkspace);
    }
  }

  // --- Sessions (addressed globally by session id) ------------------------
  createSession(workspacePath: string, input?: CreateSessionInput | string): Promise<ReturnType<SessionManager["createSession"]>> {
    return this.engineFor(workspacePath).createSession(input);
  }

  listResumableSessions(workspacePath: string): ReturnType<SessionManager["listResumableSessions"]> {
    return this.engineFor(workspacePath).listResumableSessions();
  }

  resumeSession(workspacePath: string, sessionId: string): Promise<ReturnType<SessionManager["resumeSession"]>> {
    return this.engineFor(workspacePath).resumeSession(sessionId);
  }

  // --- Token usage dashboard ---------------------------------------------
  /**
   * Aggregated party-turn ledger for the Token Usage dashboard — the single
   * method backing both the UI and `GET /api/token-usage`. Party usage follows
   * the party data into the global store regardless of its member hosts.
   */
  getTokenUsage(workspacePath: string, query: TokenUsageQuery): Promise<TokenUsageAggregate> {
    return this.partyEngine(workspacePath).getTokenUsage(query);
  }

  /** Raw per-turn records for the member drill-in (context curve + expensive turns). */
  getTokenUsageTurns(workspacePath: string, query: TokenUsageTurnsQuery): Promise<TurnUsageRecord[]> {
    return this.partyEngine(workspacePath).getTokenUsageTurns(query);
  }

  // Session control resolves by session id: party sessions live in the global
  // engine even when their harness runs in WSL; standalone sessions stay with
  // the window's Windows/WSL execution context.
  async closeSession(workspacePath: string, sessionId: string): Promise<{ ok: boolean }> {
    return { ok: await (await this.engineForSession(workspacePath, sessionId)).closeSession(sessionId) };
  }

  async sendSessionMessage(workspacePath: string, sessionId: string, text: string, attachments?: ImageAttachment[]): Promise<void> {
    return (await this.engineForSession(workspacePath, sessionId)).sendUserTurn(sessionId, text, attachments);
  }

  async handleSessionAction(workspacePath: string, sessionId: string, action: string, body: any): Promise<{ ok: true; result?: unknown }> {
    const result = await runSessionAction(await this.engineForSession(workspacePath, sessionId), sessionId, action, body);
    // `approve` answers with a delivery verdict; a caller that reported a bare
    // `{ok:true}` would tell the user an expired request had been approved.
    if (action !== "approve") {
      // Every other action answered a bare `{ok:true}` before and still does —
      // whatever they happen to return is internal, not a contract.
      return { ok: true };
    }
    if (result === "delivered") {
      this.deps.approvals?.markResolved(String(body?.requestId || ""), body?.behavior === "deny" ? "deny" : "allow");
    }
    return { ok: true, result };
  }

  async interruptSession(workspacePath: string, sessionId: string): Promise<void> {
    return (await this.engineForSession(workspacePath, sessionId)).interruptSession(sessionId);
  }

  /** Releases a turn the harness never closed (the UI's manual force-stop). */
  async forceStopSession(workspacePath: string, sessionId: string): Promise<void> {
    return (await this.engineForSession(workspacePath, sessionId)).forceStopSession(sessionId);
  }

  async restartSession(workspacePath: string, sessionId: string): Promise<void> {
    return (await this.engineForSession(workspacePath, sessionId)).restartSession(sessionId);
  }

  async compactSession(workspacePath: string, sessionId: string): Promise<void> {
    return (await this.engineForSession(workspacePath, sessionId)).compactSession(sessionId);
  }

  async setSessionModel(workspacePath: string, sessionId: string, model: string, providerId?: string, runtimeModel?: string): Promise<void> {
    return (await this.engineForSession(workspacePath, sessionId)).setSessionModel(sessionId, model, providerId, runtimeModel);
  }

  async setSessionEffort(workspacePath: string, sessionId: string, effort: string): Promise<void> {
    return (await this.engineForSession(workspacePath, sessionId)).setSessionEffort(sessionId, effort);
  }

  async setSessionThinking(workspacePath: string, sessionId: string, mode: string, budget?: number): Promise<void> {
    return (await this.engineForSession(workspacePath, sessionId)).setSessionThinking(sessionId, mode, budget);
  }

  async setSessionPermissionMode(workspacePath: string, sessionId: string, permissionMode: string): Promise<void> {
    return (await this.engineForSession(workspacePath, sessionId)).setSessionPermissionMode(sessionId, permissionMode);
  }

  async setSessionCodexPolicy(workspacePath: string, sessionId: string, policy: CodexPolicy): Promise<void> {
    return (await this.engineForSession(workspacePath, sessionId)).setSessionCodexPolicy(sessionId, policy);
  }

  async setSessionCursorPolicy(workspacePath: string, sessionId: string, policy: CursorPolicy): Promise<void> {
    return (await this.engineForSession(workspacePath, sessionId)).setSessionCursorPolicy(sessionId, policy);
  }

  async approveSession(workspacePath: string, sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): Promise<ApprovalDelivery> {
    const delivery = await (await this.engineForSession(workspacePath, sessionId)).approveSession(sessionId, requestId, behavior, updatedInput, message);
    if (delivery === "delivered") {
      this.deps.approvals?.markResolved(requestId, behavior);
    }
    return delivery;
  }

  /**
   * Answers an approval knowing only its OWN id.
   *
   * This is the path a phone takes out of a push notification: it holds the
   * approval id and nothing else, and iOS gives it seconds, so it cannot first
   * ask which session owns the request — and a session id it remembered from an
   * earlier run is stale the moment the member respawns.
   *
   * The outcome is reported as a distinct value rather than success/failure,
   * because the ordinary case is a notification tapped long after the request
   * expired or was answered at the desk. Reporting those as success would have
   * the phone tell its user it approved something that never happened.
   */
  /**
   * Approvals still waiting on an answer, for a client that was not listening
   * when they were raised.
   *
   * Resolves each one to its MEMBER NAME here rather than storing it: a member
   * can be renamed while its approval waits, and a list that named the member
   * as it was would send the user looking for something that is no longer on
   * their screen. A session with no member behind it (a plain session tab)
   * reports no name rather than a made-up one.
   */
  async listPendingApprovals(workspacePath?: string): Promise<{ ok: true; approvals: PendingApproval[] }> {
    const approvals = this.deps.approvals;
    if (!approvals) {
      // Same reason as `respondToApproval`: the headless engine keeps no index.
      // An empty list would read as "nothing is waiting", which is a claim this
      // process cannot make.
      throw new Error("이 프로세스는 승인 요청 색인을 보유하지 않습니다 (데스크톱 앱에서 호출하세요).");
    }
    const pending = approvals.pending(this.globalPartyMode() ? this.partyStorageWorkspace(workspacePath || "") : workspacePath);
    const namesByWorkspace = new Map<string, Map<string, string>>();
    const namesFor = async (workspace: string): Promise<Map<string, string>> => {
      const cached = namesByWorkspace.get(workspace);
      if (cached) {
        return cached;
      }
      const names = new Map<string, string>();
      try {
        const listing = await this.partyEngine(workspace).listParty();
        for (const member of listing.members) {
          if (member.sessionId) {
            names.set(member.sessionId, member.name);
          }
        }
      } catch (error) {
        // A workspace whose engine is down must not take the whole list with
        // it: the approvals are still real and still answerable by id. Only the
        // friendly name is lost, and it is logged rather than swallowed.
        log("warn", "api", "pending approvals: party lookup failed", { workspace, error: String(error) });
      }
      namesByWorkspace.set(workspace, names);
      return names;
    };
    const listed: PendingApproval[] = [];
    for (const entry of pending) {
      const names = await namesFor(entry.workspacePath);
      listed.push({
        requestId: entry.requestId,
        workspacePath: entry.workspacePath,
        sessionId: entry.sessionId,
        member: names.get(entry.sessionId),
        requestedAt: entry.requestedAt,
        toolName: entry.toolName,
        title: entry.title,
      });
    }
    return { ok: true, approvals: listed };
  }

  /**
   * Answers in flight, keyed by request id.
   *
   * `resolvedAt` makes a REPEAT call idempotent, but not a CONCURRENT one: two
   * taps, or two devices, both pass the resolved check before either marks the
   * request, and both reach the harness. The second then gets `not_pending`
   * back and reports `expired` — telling the user their answer was too late
   * when it was in fact delivered by the first. Sharing the first promise makes
   * the second call return what actually happened.
   */
  private readonly approvalsInFlight = new SingleFlight<ApprovalResponseResult>();

  respondToApproval(requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): Promise<ApprovalResponseResult> {
    return this.approvalsInFlight.run(requestId, () =>
      this.deliverApprovalResponse(requestId, behavior, updatedInput, message));
  }

  private async deliverApprovalResponse(requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): Promise<ApprovalResponseResult> {
    const approvals = this.deps.approvals;
    if (!approvals) {
      // The headless engine server keeps no index — the desktop that owns the
      // window does. Answering `unknown` here would be a confident lie: it
      // looks identical to "that approval aged out", and the caller would stop
      // retrying against the process that CAN answer.
      throw new Error("이 프로세스는 승인 요청 색인을 보유하지 않습니다 (데스크톱 앱에서 호출하세요).");
    }
    const known = approvals.find(requestId);
    if (!known) {
      return { ok: true, outcome: "unknown", requestId };
    }
    const where = { requestId, workspacePath: known.workspacePath, sessionId: known.sessionId, requestedAt: known.requestedAt };
    if (known.resolvedAt) {
      return { ok: true, outcome: "already_resolved", ...where, resolvedAt: known.resolvedAt, decision: known.decision };
    }
    // A failure to REACH the engine (a WSL distro that is down) is not one of
    // the four outcomes — it propagates, so the phone retries rather than
    // telling the user the request is gone.
    const delivery = await this.engineFor(known.workspacePath).approveSession(known.sessionId, requestId, behavior, updatedInput, message);
    if (delivery === "delivered") {
      approvals.markResolved(requestId, behavior);
      return { ok: true, outcome: "delivered", ...where, resolvedAt: Date.now(), decision: behavior };
    }
    // The session is gone, or it is alive but no longer holds the request: the
    // turn moved on. Either way nothing can consume this answer.
    log("info", "api", "approval could not be delivered", { requestId, delivery, workspace: known.workspacePath });
    return { ok: true, outcome: "expired", ...where };
  }

  // --- MCP (external servers a member connects to; by session id) ---------
  // Same AppController method behind the UI panel and the HTTP API, so an agent
  // drives the identical route a user does (route-parity rule).
  async listSessionMcpServers(workspacePath: string, sessionId: string): Promise<McpServerSnapshot> {
    return (await this.engineForSession(workspacePath, sessionId)).listSessionMcpServers(sessionId);
  }

  async sessionMcpAction(workspacePath: string, sessionId: string, action: string, body: any): Promise<unknown> {
    const engine = await this.engineForSession(workspacePath, sessionId);
    const server = String(body?.server || "");
    switch (action) {
      case "reconnect":
        await engine.reconnectSessionMcpServer(sessionId, server);
        return { ok: true };
      case "toggle":
        await engine.setSessionMcpServerEnabled(sessionId, server, Boolean(body?.enabled));
        return { ok: true };
      case "authenticate":
        return engine.authenticateSessionMcpServer(sessionId, server);
      default:
        throw new Error(`Unknown MCP action '${action}'.`);
    }
  }

  // --- Party (global store + the CALLING WINDOW's active party) ------------
  // `windowId` selects which window's active party the op resolves against, so
  // two windows of one workspace act on different parties independently. When
  // absent (HTTP with no `?window`), the engine falls back to its advisory hint.
  // A member tool can pass its spawning `partyId` explicitly; it wins over a
  // later desktop selection so the member never crosses party boundaries.
  async listPartyMembers(workspacePath: string, windowId?: string, partyId?: string): Promise<ReturnType<PartyApplicationService["list"]>> {
    return this.listPartyWithCliReconciled(
      workspacePath,
      partyId || await this.pinnedPartyForWindow(workspacePath, windowId),
    );
  }

  // ---------------------------------------------------------------- 파티 그룹
  //
  // The group registry is app-global (userData), so these are deliberately NOT
  // workspace methods: the answer must be the same whichever directory the app
  // was opened from, which is the entire point of the feature.

  /**
   * Copies pre-existing party data from registered or explicitly opened former
   * cwds into the Windows-global store and backfills missing member locations.
   *
   * Desktop-global mode imports the former workspaces already named by the
   * durable group registry, plus explicitly supplied workspaces. This is not a
   * filesystem scan: every candidate is a location the user previously opened
   * and registered. Importing all of them is what makes a Windows-search launch
   * show the same party list as a launch from one particular WSL cwd.
   */
  async migratePartyGroups(extraWorkspaces: string[] = []): Promise<MigrationReport> {
    if (this.globalPartyMode()) {
      const target = this.deps.partyStorageWorkspace as string;
      const workspaces = [...new Set([
        ...this.partyGroups.knownWorkspaces(),
        ...extraWorkspaces.filter(Boolean),
      ])];
      const report: MigrationReport = {
        ok: true,
        workspaces,
        registered: 0,
        backfilled: 0,
        conflicts: [],
        failures: [],
      };
      const before = JSON.stringify(this.partyGroups.read());
      for (const sourceIdentity of workspaces) {
        try {
          if (workspaceKey(sourceIdentity) === workspaceKey(target)) {
            continue;
          }
          const location = parseWorkspaceLocation(sourceIdentity);
          const sourceFsPath = location.host.kind === "wsl"
            ? wslUncPath(location.host.distro, location.path)
            : location.path;
          const imported = this.partyRepository.importWorkspace(
            sourceFsPath,
            target,
            serializeWorkspaceLocation(location),
            serializeWorkspaceLocation(location),
          );
          report.registered += imported.imported;
          report.backfilled += imported.backfilledLocations;
          for (const conflict of imported.conflicts) {
            report.ok = false;
            report.conflicts.push({ partyId: conflict.partyId, workspacePaths: [sourceIdentity, target] });
            report.failures.push({ workspacePath: sourceIdentity, error: conflict.reason });
          }
        } catch (error) {
          report.ok = false;
          report.failures.push({ workspacePath: sourceIdentity, error: error instanceof Error ? error.message : String(error) });
        }
      }
      await this.syncPartyRegistry(target, { surfaceFailure: true });
      if (JSON.stringify(this.partyGroups.read()) !== before) {
        this.deps.onPartyGroupsChanged?.();
      }
      log(report.ok ? "info" : "warn", "party", "cwd party data migration finished", report);
      return report;
    }

    const openWorkspaces = this.deps.windowRegistry.all().map((entry) => entry.workspacePath);
    const openKeys = new Set(openWorkspaces.map(workspaceKey));
    const workspaces = [...new Set([
      // Closed local workspaces are cheap to reconcile in-process. A registered,
      // closed WSL workspace already has a durable summary; starting every known
      // distro engine on each native Windows boot would turn drawing the list
      // into opening every party. It is refreshed whenever that workspace opens.
      ...this.partyGroups.knownWorkspaces().filter((workspace) =>
        !isWslLocation(parseWorkspaceLocation(workspace)) || openKeys.has(workspaceKey(workspace))),
      ...openWorkspaces,
      ...extraWorkspaces.filter(Boolean),
    ])];
    const before = JSON.stringify(this.partyGroups.read());
    const report = await migratePartyGroups(workspaces, {
      store: this.partyGroups,
      loadWorkspace: async (workspacePath) => {
        const engine = this.engineFor(workspacePath);
        const { backfilled } = await engine.backfillMemberLocations();
        const state = await engine.listAllParties();
        return { ...state, backfilled };
      },
    });
    if (JSON.stringify(this.partyGroups.read()) !== before) {
      this.deps.onPartyGroupsChanged?.();
    }
    return report;
  }

  listPartyGroups(): { ok: true; groups: PartyGroup[]; parties: RegisteredParty[]; conflicts: PartyGroupState["conflicts"] } {
    const state = this.partyGroups.read();
    return { ok: true, groups: state.groups, parties: this.visibleRegisteredParties(state), conflicts: state.conflicts };
  }

  createPartyGroup(name: string): { ok: true; group: PartyGroup; groups: PartyGroup[]; parties: RegisteredParty[] } {
    const { state, group } = this.partyGroups.createGroup(name);
    this.deps.onSettingsChanged();
    this.deps.onPartyGroupsChanged?.();
    return { ok: true, group, groups: state.groups, parties: this.visibleRegisteredParties(state) };
  }

  renamePartyGroup(groupId: string, name: string): { ok: true; groups: PartyGroup[]; parties: RegisteredParty[] } {
    const state = this.partyGroups.renameGroup(groupId, name);
    this.deps.onSettingsChanged();
    this.deps.onPartyGroupsChanged?.();
    return { ok: true, groups: state.groups, parties: this.visibleRegisteredParties(state) };
  }

  /**
   * Deletes a group. `moved` is how many parties landed in the default group —
   * returned so the UI can say what happened rather than just closing.
   */
  removePartyGroup(groupId: string): { ok: true; moved: number; groups: PartyGroup[]; parties: RegisteredParty[] } {
    const { state, moved } = this.partyGroups.removeGroup(groupId);
    this.deps.onSettingsChanged();
    this.deps.onPartyGroupsChanged?.();
    return { ok: true, moved, groups: state.groups, parties: this.visibleRegisteredParties(state) };
  }

  /** Full new order, ids first-to-last. Idempotent; see the store. */
  reorderPartyGroups(order: string[]): { ok: true; groups: PartyGroup[]; parties: RegisteredParty[] } {
    const state = this.partyGroups.reorderGroups(order);
    this.deps.onSettingsChanged();
    this.deps.onPartyGroupsChanged?.();
    return { ok: true, groups: state.groups, parties: this.visibleRegisteredParties(state) };
  }

  async movePartyToGroup(partyId: string, groupId: string): Promise<{ ok: true; groups: PartyGroup[]; parties: RegisteredParty[] }> {
    const isVisible = () => this.visibleRegisteredParties(this.partyGroups.read()).some((party) => party.id === partyId);
    if (!isVisible()) {
      // A just-created/imported global party can be visible before its summary
      // write completes. Reconcile the authoritative store, then retry the move;
      // do not invent a row or hide a genuinely missing id.
      await this.syncPartyRegistry(this.partyStorageWorkspace(""), { surfaceFailure: true });
    }
    if (!isVisible()) {
      throw new Error(`Party '${partyId}' does not exist in the global party list.`);
    }
    const state = this.partyGroups.moveParty(partyId, groupId);
    this.deps.onSettingsChanged();
    this.deps.onPartyGroupsChanged?.();
    return { ok: true, groups: state.groups, parties: this.visibleRegisteredParties(state) };
  }

  /**
   * Refreshes the global store's party summaries in the group registry.
   *
   * Called after any change to the global party list. Counts come from the
   * state that was just written, so the sidebar can show them for a party it has
   * not opened — which is what removes the "0 members" guess.
   */
  registerWorkspaceParties(workspacePath: string, parties: PartyDefinition[], members: PartyMember[]): boolean {
    const now = new Date().toISOString();
    const summaries = parties.map((party) => {
      const own = members.filter((member) => member.partyId === party.id);
      const envs = own.map((member) => (member.location ? parseMemberLocation(member.location).env : undefined));
      return {
        id: party.id,
        groupId: party.groupId || "",
        name: party.name,
        memberCount: own.length,
        runningCount: own.filter((member) => member.status === "running").length,
        windowsCount: envs.filter((env) => env === "windows").length,
        wslCount: envs.filter((env) => env === "wsl").length,
        updatedAt: party.updatedAt || now,
        workspacePath,
      };
    });
    return this.globalPartyMode()
      ? this.partyGroups.reconcileGlobal(this.partyStorageWorkspace(workspacePath), summaries).changed
      : this.partyGroups.reconcileWorkspace(workspacePath, summaries).changed;
  }

  private visibleRegisteredParties(state: PartyGroupState): RegisteredParty[] {
    return this.globalPartyMode()
      ? this.partyGroups.globalParties(this.deps.partyStorageWorkspace as string)
      : state.parties;
  }

  // ------------------------------------------------------------ 멤버 실행 위치

  /** Default + recent cwds. `check: true` re-probes each entry (spawns wsl.exe). */
  async getCwdPreferences(options?: { check?: boolean }): Promise<{ ok: true; preferences: CwdPreferences; appWorkspaceRoot: string }> {
    return {
      ok: true,
      preferences: options?.check ? await getCheckedCwdPreferences() : getCwdPreferences(),
      // The last-resort suggestion for a user with no recent and no default.
      // Sent with the preferences because the renderer cannot know userData.
      appWorkspaceRoot: appWorkspaceRoot(),
    };
  }

  async setDefaultCwd(location: MemberExecutionLocation): Promise<{ ok: true; preferences: CwdPreferences }> {
    const preferences = await setDefaultCwd(location);
    this.deps.onSettingsChanged();
    this.publishSettings();
    return { ok: true, preferences };
  }

  clearDefaultCwd(env: ExecutionEnv): { ok: true; preferences: CwdPreferences } {
    const preferences = clearDefaultCwd(env);
    this.deps.onSettingsChanged();
    this.publishSettings();
    return { ok: true, preferences };
  }

  removeRecentCwd(location: MemberExecutionLocation): { ok: true; preferences: CwdPreferences } {
    const preferences = removeRecentCwd(location);
    this.deps.onSettingsChanged();
    this.publishSettings();
    return { ok: true, preferences };
  }

  /**
   * Checks one location in the environment it belongs to.
   *
   * Returns the verdict rather than throwing: "왜 못 쓰는지" is the answer the
   * picker wants to display, and an exception would make every caller invent
   * its own wording for the same three failures.
   */
  async checkCwd(location: MemberExecutionLocation): Promise<{ ok: true; usable: boolean; problem?: CwdProblem; location: MemberExecutionLocation }> {
    const result = await checkCwd(location);
    return { ok: true, usable: !result.problem, problem: result.problem, location: result.location };
  }

  async listWslDistros(): Promise<{ ok: true; distros: string[]; error?: string }> {
    const { names, error } = await wslDistros();
    return { ok: true, distros: names, error };
  }

  /**
   * Lists one directory level inside a distro, for the WSL folder browser.
   *
   * `cwd` omitted means the distro's `$HOME`. Separate from {@link browseCwd}
   * because the Windows folder dialog cannot browse a distro that will not
   * start, and reaching a running one through `\\wsl$\...` answers a question
   * about the redirector rather than about the environment the member runs in.
   */
  /**
   * Opens the platform folder picker and returns the location it produced.
   *
   * For WSL the SAME dialog is used, pointed at `\\wsl$\<distro>\<home>` — the
   * distro's own filesystem, reachable from Explorer once the distro is up. The
   * pick comes back as a UNC path and `locationFromPickedFolder` turns it into
   * the `{distro, /posix/path}` pair; nothing is browsed by hand.
   *
   * The distro's `$HOME` is asked for first, because that is where a WSL user's
   * work lives — `\wsl$\<distro>` alone opens onto `proc`, `sys` and `mnt`. A
   * distro that will not start answers with the reason instead of opening a
   * dialog onto an unreachable path.
   *
   * Resolves `{ ok: true, cancelled: true }` when the user closed the dialog —
   * distinct from a failure, because the caller must leave the previous choice
   * alone rather than clear it.
   */
  async browseCwd(env: ExecutionEnv, windowId?: string, distro?: string): Promise<{ ok: true; cancelled?: true; location?: MemberExecutionLocation; problem?: CwdProblem }> {
    if (!this.deps.pickFolder) {
      throw new Error("이 프로세스에서는 폴더 선택기를 열 수 없습니다.");
    }
    let defaultPath: string | undefined;
    if (env === "wsl") {
      if (!distro) {
        return { ok: true, problem: cwdProblem("distro-missing") };
      }
      const { home, problem } = await wslHome(distro);
      if (problem) {
        return { ok: true, problem };
      }
      defaultPath = wslUncPath(distro, home as string);
      log("info", "cwd", "opening the folder dialog inside a distro", { distro, home, defaultPath });
    }
    const folder = await this.deps.pickFolder(windowId, env, defaultPath);
    if (!folder) {
      return { ok: true, cancelled: true };
    }
    const location = locationFromPickedFolder(folder, env);
    // Asked for a WSL folder and handed a Windows one: the user navigated out of
    // `\\wsl$\` in the dialog. Refused rather than stored, because a `C:\...`
    // path is not a POSIX cwd and converting it is a guess about how that distro
    // mounts the drive.
    if (env === "wsl" && location.env !== "wsl") {
      return { ok: true, problem: { kind: "not-absolute", message: `WSL 배포판 안의 폴더를 선택하세요 (\\\\wsl$\\${distro}\\...): ${folder}` } };
    }
    const { problem } = await checkCwd(location);
    return { ok: true, location, problem };
  }

  /** Existing members' fixed locations, for the read-only settings list. */
  async memberLocations(workspacePath: string): Promise<{ ok: true; members: MemberLocationRow[] }> {
    // All parties: location belongs to a member, never to the cwd that opened a window.
    const party = await this.partyEngine(workspacePath).listAllParties();
    const nameById = new Map((party.parties || []).map((entry: PartyDefinition) => [entry.id, entry.name] as const));
    const members: MemberLocationRow[] = (party.members || [])
      .filter((member: PartyMember) => Boolean(member.location))
      .map((member: PartyMember) => ({
        member: member.name,
        partyName: nameById.get(member.partyId || "") || "",
        location: parseMemberLocation(member.location as string),
      }));
    return { ok: true, members };
  }

  async createParty(workspacePath: string, input: CreatePartyInput, windowId?: string): Promise<ReturnType<PartyApplicationService["createParty"]>> {
    // `main` needs a cwd it can actually run in. Checked BEFORE the party is
    // created, so a bad path leaves nothing half-made behind.
    const location = await this.requireUsableLocation(input.location, workspacePath);
    const result = await this.partyEngine(workspacePath).createParty({ ...input, location: location.serialized });
    // The window that created the party switches to it (others are untouched).
    if (windowId && result.currentPartyId) {
      this.activePartyByWindow.set(windowId, result.currentPartyId);
    }
    // Only a creation that SUCCEEDED puts the cwd in the recent list (README §6).
    rememberCwd(location.location);
    this.deps.onSettingsChanged();
    this.publishSettings();
    await this.syncPartyRegistry(workspacePath);
    await this.broadcastParty(workspacePath);
    return result;
  }

  async selectParty(workspacePath: string, partyId: string, windowId?: string): Promise<ReturnType<PartyApplicationService["selectParty"]>> {
    const result = await this.partyEngine(workspacePath).selectParty(partyId);
    if (windowId) {
      this.activePartyByWindow.set(windowId, partyId);
    }
    await this.broadcastParty(workspacePath);
    return result;
  }

  async removeParty(workspacePath: string, partyId: string, windowId?: string): Promise<ReturnType<PartyApplicationService["removeParty"]>> {
    const result = await this.partyEngine(workspacePath).removeParty(partyId);
    // Any window that was viewing the deleted party falls back to the default.
    for (const [wid, pid] of this.activePartyByWindow) {
      if (pid === partyId) {
        this.activePartyByWindow.delete(wid);
      }
    }
    this.partyGroups.removeParty(partyId);
    await this.broadcastParty(workspacePath);
    return result;
  }

  async createPartyMember(workspacePath: string, input: CreateMemberInput, windowId?: string): Promise<ReturnType<PartyApplicationService["createMember"]>> {
    const location = await this.requireUsableLocation(input.location, workspacePath);
    const partyId = input.partyId || this.partyForWindow(windowId);
    // The member lands in the party the renderer names, else the window's party.
    const result = await this.mutateParty(workspacePath, (engine) => engine.createMember({
      ...input,
      location: location.serialized,
      partyId,
    }));
    // Party state must arrive first: the renderer can then adopt this layout
    // without pruning the just-created member as "not in the party".
    const createdPartyId = result.member?.partyId || result.currentPartyId || partyId;
    if (createdPartyId) {
      await this.publishStoredPartyLayout(workspacePath, createdPartyId);
    }
    rememberCwd(location.location);
    if (input.saveAsDefault) {
      // Best-effort: the member is already made, and failing to store a
      // preference must not be reported as a failed creation. It is logged, not
      // swallowed silently.
      await setDefaultCwd(location.location).catch((error) => {
        log("warn", "cwd", "could not save default cwd", { location: location.serialized, error: error instanceof Error ? error.message : String(error) });
      });
    }
    this.deps.onSettingsChanged();
    this.publishSettings();
    await this.syncPartyRegistry(workspacePath);
    return result;
  }

  /** Batch form of createPartyMember; validates each cwd, then publishes one coherent party update. */
  async createPartyMembers(workspacePath: string, inputs: CreateMemberInput[], windowId?: string) {
    if (!inputs.length) throw new Error("members must be a non-empty array.");
    const names = inputs.map((input) => input.name);
    if (new Set(names).size !== names.length) throw new Error("members contains duplicate member names.");
    const created: Array<{ name: string; status?: string }> = [];
    const failed: Array<{ name: string; error: string }> = [];
    const createdPartyIds = new Set<string>();
    const engine = this.partyEngine(workspacePath);
    for (const input of inputs) {
      try {
        const location = await this.requireUsableLocation(input.location, workspacePath);
        const partyId = input.partyId || this.partyForWindow(windowId);
        const result = await engine.createMember({ ...input, location: location.serialized, partyId });
        created.push({ name: input.name, status: result.member?.status });
        const createdPartyId = result.member?.partyId || result.currentPartyId || partyId;
        if (createdPartyId) createdPartyIds.add(createdPartyId);
        rememberCwd(location.location);
        if (input.saveAsDefault) {
          await setDefaultCwd(location.location).catch((error) => {
            log("warn", "cwd", "could not save default cwd", { location: location.serialized, error: error instanceof Error ? error.message : String(error) });
          });
        }
      } catch (error) {
        failed.push({ name: input.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (created.length) {
      // State first, then layouts: renderers must know every new member before
      // adopting panels that reference them. One update avoids intermediate,
      // partially-created batches in other windows.
      await this.broadcastParty(workspacePath);
      for (const partyId of createdPartyIds) {
        await this.publishStoredPartyLayout(workspacePath, partyId);
      }
      this.deps.onSettingsChanged();
      this.publishSettings();
      await this.syncPartyRegistry(workspacePath);
    }
    return { ok: created.length > 0, created, failed };
  }

  /**
   * Resolves the location a party/member will run in, or refuses with the reason.
   *
   * An omitted location falls back to the workspace — that is where the member
   * would have run before locations existed, so agent-facing callers keep
   * working. What never happens is a stated location being replaced by a
   * working one: an unusable path is an error, not a redirect (README §12).
   */
  private async requireUsableLocation(value: unknown, workspacePath: string) {
    const serialized = value == null || value === "" ? workspacePath : value;
    if (typeof serialized !== "string") {
      throw new Error("실행 위치 형식이 잘못되었습니다 — 직렬화된 경로 문자열이 필요합니다.");
    }
    const check = await checkCwd(parseMemberLocation(serialized));
    if (check.problem) {
      throw new Error(`실행 위치를 사용할 수 없습니다 — ${check.problem.message}: ${check.serialized}`);
    }
    return check;
  }

  /** Re-publishes the authoritative party store into the app-global registry. */
  private async syncPartyRegistry(workspacePath: string, options?: { surfaceFailure?: boolean }): Promise<boolean> {
    try {
      // The WHOLE workspace, not the viewed party: counting from the view
      // reported every unselected party as empty.
      const state = await this.partyEngine(workspacePath).listAllParties();
      const changed = this.registerWorkspaceParties(this.partyStorageWorkspace(workspacePath), state.parties || [], state.members || []);
      if (changed) {
        this.deps.onPartyGroupsChanged?.();
      }
      return changed;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log("warn", "party", "could not refresh the party group registry", { workspacePath, error: detail });
      if (options?.surfaceFailure) {
        throw new Error(`파티 목록을 새로 고치지 못했습니다 (${workspacePath}): ${detail}`);
      }
      return false;
    }
  }

  sendPartyMessage(workspacePath: string, name: string, content: string, from?: string, attachments?: ImageAttachment[], windowId?: string, options?: { interrupt?: boolean; force?: boolean; forceReason?: string }, partyId?: string): Promise<ReturnType<PartyApplicationService["sendMessage"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.sendPartyMessage(name, content, from, attachments, partyId || this.partyForWindow(windowId), options));
  }

  /** Sends one message to multiple explicit recipients, then publishes one coherent result snapshot. */
  async sendPartyMessages(workspacePath: string, names: string[], content: string, from?: string, attachments?: ImageAttachment[], windowId?: string, options?: { interrupt?: boolean; force?: boolean; forceReason?: string }, partyId?: string) {
    if (!names.length) throw new Error("to must be a non-empty array.");
    if (new Set(names).size !== names.length) throw new Error("to contains duplicate member names.");
    const delivered: string[] = [];
    const queuedMembers: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    const engine = this.partyEngine(workspacePath);
    const targetPartyId = partyId || this.partyForWindow(windowId);
    for (const name of names) {
      try {
        const result = await engine.sendPartyMessage(name, content, from, attachments, targetPartyId, options);
        if (result.queued || result.partyMessage?.error === "queued_for_busy_member" || result.partyMessage?.error === "queued_for_sleeping_member") {
          queuedMembers.push(name);
        } else if (result.partyMessage?.delivered) {
          delivered.push(name);
        } else {
          failed.push({ name, error: result.partyMessage?.error || "not_delivered" });
        }
      } catch (error) {
        failed.push({ name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await this.broadcastParty(workspacePath);
    return { ok: delivered.length + queuedMembers.length > 0, delivered, queuedMembers, failed };
  }

  /**
   * Runs one party tool as a member whose harness reaches us over HTTP (Codex).
   * The party comes from the CALLER's own identity, never from a window: the
   * member's tools act inside its own party regardless of what anyone is viewing.
   */
  async invokePartyToolAs(
    workspacePath: string,
    member: string,
    tool: string,
    args: unknown,
    partyId?: string,
    hostPrepared = false,
  ): ReturnType<PartyApplicationService["invokePartyToolAs"]> {
    const result = await this.invokePartyToolAsRaw(workspacePath, member, tool, args, partyId, hostPrepared);
    if (result.ok && partyToolNameOf(tool) === "member-create" && partyId) {
      // `PartyApplicationService.createMember` persisted placement together with
      // the member. Publish it after mutateParty's member broadcast, matching
      // the UI/HTTP ordering above.
      const owner = this.globalPartyMode()
        ? workspacePath
        : await this.deps.engineRegistry.workspaceOwningParty(partyId, workspacePath) || workspacePath;
      await this.publishStoredPartyLayout(owner, partyId);
    }
    return result;
  }

  private async invokePartyToolAsRaw(
    workspacePath: string,
    member: string,
    tool: string,
    args: unknown,
    partyId?: string,
    hostPrepared = false,
  ): ReturnType<PartyApplicationService["invokePartyToolAs"]> {
    if (this.globalPartyMode()) {
      // A raw Windows MCP relay also enters through HTTP, so prepare its local
      // file inputs here. A WSL worker has already prepared them and arrives
      // through the trusted host channel with `hostPrepared=true`; re-reading
      // its `/...` path on Windows would recreate the cross-host image bug.
      if (!hostPrepared) {
        return invokePartyToolFromExecutionHost(
          (preparedTool, preparedArgs) => this.mutateParty(
            workspacePath,
            (engine) => engine.invokePartyToolAs(member, preparedTool, preparedArgs, partyId),
          ),
          tool,
          args,
        );
      }
      return this.mutateParty(workspacePath, (engine) => engine.invokePartyToolAs(member, tool, args, partyId));
    }
    // A headless WSL engine is an execution worker, not a second party owner.
    // Its local storage can contain the legacy copy that was just migrated. If
    // we ask `workspaceOwningParty` first, that stale copy wins and a WSL Codex
    // MCP call sees only the pre-migration members. Route an identity-bound tool
    // straight to the desktop authority even when that legacy party still
    // exists locally; the party id is supplied by the member's immutable MCP
    // environment, not by model-controlled arguments.
    if (partyId && this.deps.remotePartyTool) {
      return invokePartyToolFromExecutionHost(
        (preparedTool, preparedArgs) => this.deps.remotePartyTool!(workspacePath, member, preparedTool, preparedArgs, partyId),
        tool,
        args,
      );
    }
    // `workspacePath` came from the FOCUSED WINDOW, because an HTTP caller has
    // no window of its own — and one process serves every open window. With a
    // second workspace open, every member of the unfocused one was looked up in
    // the wrong place ("Member 'refactor' is not in this party."). The party the
    // member names is the reliable key, so it decides which engine runs the tool.
    const owner = partyId ? await this.deps.engineRegistry.workspaceOwningParty(partyId, workspacePath) : undefined;
    return this.mutateParty(owner || workspacePath, (engine) => engine.invokePartyToolAs(member, tool, args, partyId));
  }

  /**
   * Deterministic E2E entry: launches the real stdio MCP relay on the member's
   * execution host, rather than calling the party controller directly.
   */
  async invokeMemberPartyMcpTool(workspacePath: string, partyId: string, memberName: string, tool: string, args: unknown) {
    const listing = await this.partyEngine(workspacePath).listParty(partyId);
    const member = listing.members.find((entry) => entry.partyId === partyId && entry.name === memberName);
    if (!member) {
      throw new Error(`Party member '${memberName}' does not exist in party '${partyId}'.`);
    }
    if (!member.location) {
      throw new Error(`Party member '${memberName}' has no execution location.`);
    }
    const location = parseWorkspaceLocation(member.location);
    const result = await this.engineFor(member.location).invokePartyMcpTransport(member.name, partyId, tool, args);
    return {
      ...result,
      transport: "mcp-stdio" as const,
      member: member.name,
      partyId,
      tool,
      executionLocation: member.location,
      executionHost: location.host.kind === "wsl" ? "wsl" as const : "windows" as const,
      ...(location.host.kind === "wsl" ? { distro: location.host.distro } : {}),
    };
  }

  /** Product-E2E discovery through the relay on the member's actual host. */
  async listMemberPartyMcpTools(workspacePath: string, partyId: string, memberName: string) {
    const listing = await this.partyEngine(workspacePath).listParty(partyId);
    const member = listing.members.find((entry) => entry.partyId === partyId && entry.name === memberName);
    if (!member) {
      throw new Error(`Party member '${memberName}' does not exist in party '${partyId}'.`);
    }
    if (!member.location) {
      throw new Error(`Party member '${memberName}' has no execution location.`);
    }
    const location = parseWorkspaceLocation(member.location);
    return {
      ok: true as const,
      tools: await this.engineFor(member.location).listPartyMcpTools(member.name, partyId),
      transport: "mcp-stdio" as const,
      member: member.name,
      partyId,
      executionLocation: member.location,
      executionHost: location.host.kind === "wsl" ? "wsl" as const : "windows" as const,
      ...(location.host.kind === "wsl" ? { distro: location.host.distro } : {}),
    };
  }

  /** The shared "user sends a message to a member" path (UI Send button + HTTP). */
  sendMemberMessage(workspacePath: string, name: string, text: string, attachments?: ImageAttachment[], windowId?: string, options?: { interrupt?: boolean }): Promise<ReturnType<PartyApplicationService["sendUserMessage"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.sendUserMessage(name, text, attachments, this.partyForWindow(windowId), options));
  }

  /** Messages a busy member has been sent but not yet handed (shared/messageQueue.ts). */
  getMemberQueue(workspacePath: string, name: string, windowId?: string): Promise<ReturnType<PartyApplicationService["getMemberQueue"]>> {
    return this.partyEngine(workspacePath).getMemberQueue(name, this.partyForWindow(windowId));
  }

  /**
   * The shared path for every queue mutation — the row buttons in the UI and the
   * HTTP endpoint both land here, so an agent can drive the queue exactly as a
   * person does. Broadcasts, because a queue nobody can see is worse than none.
   */
  runQueueCommand(workspacePath: string, name: string, command: QueueCommand, windowId?: string): Promise<ReturnType<PartyApplicationService["runQueueCommand"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.runQueueCommand(name, command, this.partyForWindow(windowId)));
  }

  async handlePartyAction(workspacePath: string, name: string, action: string, body: any, windowId?: string, partyId?: string): Promise<ReturnType<PartyApplicationService["sendMessage"]>> {
    const result = await this.partyEngine(workspacePath).partyAction(name, action, body || {}, partyId || this.partyForWindow(windowId));
    await this.broadcastParty(workspacePath);
    return result;
  }

  closePartyMember(workspacePath: string, name: string, windowId?: string): Promise<ReturnType<PartyApplicationService["closeMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.closeMember(name, this.partyForWindow(windowId)));
  }

  resumePartyMember(workspacePath: string, name: string, windowId?: string): Promise<ReturnType<PartyApplicationService["resumeMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.resumeMember(name, this.partyForWindow(windowId)));
  }

  /** Reloads the member's session, resuming the same conversation — the tab toolbar's respawn. */
  respawnPartyMember(workspacePath: string, name: string, input?: StartPartyMemberInput, windowId?: string): Promise<ReturnType<PartyApplicationService["respawnMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.respawnMember(name, input, this.partyForWindow(windowId)));
  }

  /**
   * Opens a member — marks it opened AND gives it a tab.
   *
   * The tab was the missing half. This answered "Member 'X' opened." while only
   * setting a status flag, so an agent (or any HTTP caller) asking for a member
   * got a success message and no tab anywhere. Adding it to the party layout is
   * exactly what a sidebar click does, through the same shared operation and the
   * same broadcast, so both callers land in the same place.
   */
  async openPartyMember(workspacePath: string, name: string, windowId?: string): Promise<ReturnType<PartyApplicationService["openMember"]>> {
    const result = await this.mutateParty(workspacePath, (engine) => engine.openMember(name, this.partyForWindow(windowId)));
    const stored = await this.partyEngine(workspacePath).getPartyLayout(this.partyForWindow(windowId));
    await this.setPartyLayout(workspacePath, openMemberTab(stored ?? EMPTY_LAYOUT, name), windowId);
    return result;
  }

  startPartyMember(workspacePath: string, name: string, input?: StartPartyMemberInput, windowId?: string): Promise<ReturnType<PartyApplicationService["startMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.startMember(name, input, this.partyForWindow(windowId)));
  }

  bindPartyMember(workspacePath: string, name: string, sessionId: string, windowId?: string): Promise<ReturnType<PartyApplicationService["bindMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.bindMember(name, sessionId, this.partyForWindow(windowId)));
  }

  async removePartyMember(workspacePath: string, name: string, windowId?: string): Promise<ReturnType<PartyApplicationService["removeMember"]>> {
    const result = await this.mutateParty(workspacePath, (engine) => engine.removeMember(name, this.partyForWindow(windowId)));
    // Member detail and the grouped sidebar summary are separate stores. Keep
    // the summary authoritative immediately after a successful deletion.
    await this.syncPartyRegistry(workspacePath);
    return result;
  }

  /** Batch form of removePartyMember; applies every deletion before publishing the final party snapshot. */
  async removePartyMembers(workspacePath: string, names: string[], windowId?: string, partyId?: string) {
    if (!names.length) throw new Error("name must be a non-empty array.");
    if (new Set(names).size !== names.length) throw new Error("name contains duplicate member names.");
    const removed: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    const engine = this.partyEngine(workspacePath);
    const targetPartyId = partyId || this.partyForWindow(windowId);
    for (const name of names) {
      try {
        await engine.removeMember(name, targetPartyId);
        removed.push(name);
      } catch (error) {
        failed.push({ name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (removed.length) {
      await this.syncPartyRegistry(workspacePath);
      await this.broadcastParty(workspacePath);
    }
    return { ok: removed.length > 0, removed, failed };
  }

  /** Persists a member's auto-compaction threshold. UI + HTTP share the party-action path. */
  setMemberAutoCompact(workspacePath: string, name: string, autoCompact: unknown, windowId?: string): Promise<ReturnType<PartyApplicationService["setMemberAutoCompact"]>> {
    return this.handlePartyAction(workspacePath, name, "auto-compact", { autoCompact }, windowId) as Promise<ReturnType<PartyApplicationService["setMemberAutoCompact"]>>;
  }

  /**
   * Pins a member awake, or lets it follow the global idle-sleep policy again.
   * Un-pinning does not sleep the member — the sweep decides that on its own
   * once the member has been quiet long enough.
   */
  setMemberKeepAwake(workspacePath: string, name: string, keepAwake: boolean, windowId?: string): Promise<ReturnType<PartyApplicationService["setMemberKeepAwake"]>> {
    return this.handlePartyAction(workspacePath, name, "keep-awake", { keepAwake }, windowId) as Promise<ReturnType<PartyApplicationService["setMemberKeepAwake"]>>;
  }

  /** Releases a member's harness process now, keeping its conversation. */
  sleepPartyMember(workspacePath: string, name: string, windowId?: string): Promise<ReturnType<PartyApplicationService["sleepMember"]>> {
    return this.handlePartyAction(workspacePath, name, "sleep", {}, windowId) as Promise<ReturnType<PartyApplicationService["sleepMember"]>>;
  }

  /** Brings a sleeping member's process back and resumes its conversation. */
  wakePartyMember(workspacePath: string, name: string, windowId?: string): Promise<ReturnType<PartyApplicationService["wakeMember"]>> {
    return this.handlePartyAction(workspacePath, name, "wake", {}, windowId) as Promise<ReturnType<PartyApplicationService["wakeMember"]>>;
  }

  /**
   * Compacts a member's conversation now, waking it first if it is asleep.
   *
   * The member-addressed route the UI and agents both use. `compactSession`
   * below is the session-addressed one, which cannot reach a sleeping member —
   * it has no session — and so is not what a `/compact` should call.
   */
  compactPartyMember(workspacePath: string, name: string, windowId?: string): Promise<ReturnType<PartyApplicationService["compactMember"]>> {
    return this.handlePartyAction(workspacePath, name, "compact", {}, windowId) as Promise<ReturnType<PartyApplicationService["compactMember"]>>;
  }

  /**
   * Persists a member's permission (Claude mode / Codex policy / Cursor policy)
   * and applies it to the live adapter when one is running. This is the member
   * -scoped route the composer's permission control drives, so a change made
   * while the session is down is still recorded instead of being dropped — the
   * session-scoped setters below only reach a live adapter.
   */
  setMemberPermission(workspacePath: string, name: string, permission: MemberPermissionInput, windowId?: string): Promise<ReturnType<PartyApplicationService["setMemberPermission"]>> {
    return this.handlePartyAction(workspacePath, name, "permission", permission, windowId) as Promise<ReturnType<PartyApplicationService["setMemberPermission"]>>;
  }

  /** Persists a member's Message Gate override (mode/rule/reviewer patch). UI + HTTP + agent share this path. */
  setMemberGate(workspacePath: string, name: string, gate: unknown, windowId?: string): Promise<ReturnType<PartyApplicationService["setMemberGate"]>> {
    return this.handlePartyAction(workspacePath, name, "gate", { gate }, windowId) as Promise<ReturnType<PartyApplicationService["setMemberGate"]>>;
  }

  /** Sets true/false, or clears to the Runtime default with null/undefined. */
  setMemberOutboundInterrupt(workspacePath: string, name: string, outboundInterrupt: boolean | null | undefined, windowId?: string): Promise<ReturnType<PartyApplicationService["setMemberOutboundInterrupt"]>> {
    return this.handlePartyAction(workspacePath, name, "outbound-interrupt", { outboundInterrupt }, windowId) as Promise<ReturnType<PartyApplicationService["setMemberOutboundInterrupt"]>>;
  }

  /** Persists the party-wide Message Gate default (enablement + rule). */
  async setPartyGate(workspacePath: string, partyId: string, gate: unknown, windowId?: string): Promise<ReturnType<PartyApplicationService["setPartyGate"]>> {
    const target = partyId || this.partyForWindow(windowId);
    const result = await this.partyEngine(workspacePath).setPartyGate(target, gate);
    await this.broadcastParty(workspacePath);
    return result;
  }

  // --- Discord bridge (docs/기획 노트.md §11) ------------------------------
  // UI, HTTP and the member's MCP tools all land here, so there is one code path
  // per capability. The token never leaves this process: status carries a mask.

  discordStatus(): DiscordBridgeStatus {
    return this.requireDiscord().status();
  }

  updateDiscordSettings(patch: Partial<DiscordBridgeSettings>): DiscordBridgeStatus {
    const status = this.requireDiscord().updateSettings(patch);
    this.deps.onSettingsChanged();
    return status;
  }

  /**
   * Runs a Discord control-panel command (`!상태`, `!등록 …`) without typing it in
   * Discord. Same dispatcher the gateway uses — the bot cannot post as the user,
   * so this is how the panel is driven from the UI, HTTP and QA.
   */
  discordRunCommand(input: { content: string; channelId?: string; authorId?: string; post?: boolean }): Promise<{ ok: true; handled: boolean; reply?: string }> {
    return this.requireDiscord().runControlCommand(input);
  }

  /**
   * Registers a party's Discord channel without touching its members — the same
   * operation the `!등록` control command performs (docs/기획 노트.md §11.14).
   * Exposed over HTTP so QA and agents can drive it without typing in Discord.
   */
  async discordRegisterParty(workspacePath: string, partyId?: string, windowId?: string): Promise<{ ok: true; channel: string; channelId: string; created: boolean }> {
    const target = partyId || (await this.pinnedPartyForWindow(workspacePath, windowId)) || "";
    const listing = await this.listPartyMembers(workspacePath, windowId, target);
    const party = (listing as any)?.parties?.find((entry: any) => entry?.id === target);
    const result = await this.requireDiscord().registerParty({
      workspacePath: this.partyStorageWorkspace(workspacePath),
      party: target,
      partyLabel: party?.name,
    });
    return { ok: true, channel: result.channelName, channelId: result.channelId, created: result.created };
  }

  /** Same operation the member's `discord-connect` tool performs, for UI/QA. */
  async discordConnectMember(workspacePath: string, name: string, channelName?: string, windowId?: string, partyId?: string): Promise<{ ok: true; channel: string; channelId: string; thread: string; threadId: string; created: boolean; threadCreated: boolean }> {
    const party = await this.partyOfMember(workspacePath, name, windowId, partyId);
    const listing = await this.listPartyMembers(workspacePath, windowId, party);
    const result = await this.requireDiscord().connectMember({
      workspacePath: this.partyStorageWorkspace(workspacePath),
      party,
      partyLabel: (listing as any)?.parties?.find((entry: any) => entry?.id === party)?.name,
      member: name,
      channelName,
    });
    return {
      ok: true,
      channel: result.channelName,
      channelId: result.channelId,
      thread: result.threadName,
      threadId: result.threadId,
      created: result.created,
      threadCreated: (result as { threadCreated?: boolean }).threadCreated === true,
    };
  }

  async discordSendAsMember(workspacePath: string, name: string, content: string, windowId?: string, partyId?: string): Promise<{ ok: true; channel: string }> {
    const party = await this.partyOfMember(workspacePath, name, windowId, partyId);
    const result = await this.requireDiscord().sendAsMember(this.partyStorageWorkspace(workspacePath), party, name, content);
    return { ok: true, channel: result.channelName };
  }

  /** Uploads one image as that member — the `discord-send-image` tool's path. */
  async discordSendImageAsMember(
    workspacePath: string,
    name: string,
    image: { dataBase64: string; filename: string; mediaType: string },
    caption?: string,
    windowId?: string,
    partyId?: string,
  ): Promise<{ ok: true; channel: string }> {
    const party = await this.partyOfMember(workspacePath, name, windowId, partyId);
    const result = await this.requireDiscord().sendImageAsMember(this.partyStorageWorkspace(workspacePath), party, name, image, caption);
    return { ok: true, channel: result.channelName };
  }

  async discordDisconnectMember(workspacePath: string, name: string, windowId?: string, partyId?: string): Promise<{ ok: true; removed: boolean }> {
    const party = await this.partyOfMember(workspacePath, name, windowId, partyId);
    const result = this.requireDiscord().disconnectMember(this.partyStorageWorkspace(workspacePath), party, name);
    return { ok: true, removed: result.removed };
  }

  /**
   * The party a member actually belongs to — NOT merely the caller's active one.
   * A binding is keyed by (workspace, party, member), and the member's own MCP
   * tools key it with their real party id; resolving from the window instead
   * would key the same member two different ways and silently bind a second
   * channel. Explicit `partyId` still wins.
   */
  private async partyOfMember(workspacePath: string, name: string, windowId?: string, partyId?: string): Promise<string> {
    if (partyId) {
      return partyId;
    }
    const listing = await this.listPartyMembers(workspacePath, windowId);
    const member = (listing as any)?.members?.find((entry: any) => entry?.name === name);
    return member?.partyId || (await this.pinnedPartyForWindow(workspacePath, windowId)) || "";
  }

  private requireDiscord(): DiscordBridgeService {
    if (!this.deps.discord) {
      // Explicit, not a silent no-op: a headless engine has no bridge.
      throw new Error("The Discord bridge is not available in this process.");
    }
    return this.deps.discord;
  }

  getMemberTranscript(workspacePath: string, name: string, windowId?: string, partyId?: string) {
    return this.partyEngine(workspacePath).getMemberTranscript(name, partyId || this.partyForWindow(windowId));
  }

  /** Where the harness keeps its own untrimmed copy of a member's conversation. */
  async getHarnessOriginal(workspacePath: string, name: string, windowId?: string) {
    const partyEngine = this.partyEngine(workspacePath);
    const target = await partyEngine.getHarnessOriginalTarget(name, this.partyForWindow(windowId));
    if (!target.sessionId || !target.runtime) {
      return { ok: true as const, original: null };
    }
    if (!target.location) {
      throw new Error(`Member '${name}' has no execution location.`);
    }
    const location = parseWorkspaceLocation(target.location);
    return this.engineFor(target.location).resolveHarnessOriginal(target.runtime, target.sessionId, location.path);
  }

  /**
   * Inspects or transfers a member's native harness thread to an external CLI.
   * `inspect` is read-only; `launch` closes the app-owned adapter first so two
   * processes never write the same conversation concurrently.
   */
  async continueMemberInCli(
    workspacePath: string,
    name: string,
    action: CliContinuationAction,
    windowId?: string,
  ): Promise<CliContinuationResult> {
    if (action !== "inspect" && action !== "launch") {
      throw new Error(`Unknown CLI continuation action '${String(action)}'.`);
    }
    const engine = this.partyEngine(workspacePath);
    const partyId = this.partyForWindow(windowId);
    const member = (await engine.listParty(partyId)).members.find((entry) => entry.name === name);
    if (!member?.location) {
      throw new Error(`Member '${name}' has no execution location.`);
    }
    // Check the saved location BEFORE taking writer ownership. If it vanished,
    // closing the app adapter and then failing Set-Location would leave the user
    // with neither an app session nor a working terminal.
    const inspected = await engine.getCliContinuationTarget(name, partyId);
    if (!inspected.supported) {
      return { ok: true, supported: false, member: name, reason: inspected.reason, launched: false };
    }
    const location = parseWorkspaceLocation(member.location);
    const locationCheck = await checkCwd(parseMemberLocation(member.location));
    const shell = location.host.kind === "wsl" ? "bash" : "powershell";
    const argv = cliContinuationArgv(inspected.target, location.host);
    const details: CliContinuationDetails = {
      ok: true,
      supported: true,
      member: name,
      ...inspected.target,
      cwd: location.path,
      host: location.host.kind,
      ...(location.host.kind === "wsl" ? { distro: location.host.distro } : {}),
      command: formatCliContinuationCommand(argv, shell),
      launched: false,
      ...(locationCheck.problem ? {
        locationProblem: locationCheck.problem,
        repairCommand: cliCrossCwdContinuationCommand(inspected.target, location.host, shell),
      } : {}),
      cwdSync: "not-automatic",
      // Resume protocols restore model context, but none of the adapters replay
      // turns created by a different interactive process into the UI event feed.
      transcriptSync: "not-automatic",
    };
    if (action === "inspect" || locationCheck.problem) {
      return details;
    }
    const resolved = await engine.beginCliContinuation(name, partyId);
    if (!resolved.supported) {
      return { ok: true, supported: false, member: name, reason: resolved.reason, launched: false };
    }
    // `begin` captures the live adapter's latest thread id. A turn can finish
    // between inspection and ownership transfer, so launch from this committed
    // target rather than the earlier read-only snapshot.
    const launchDetails: CliContinuationDetails = {
      ...details,
      ...resolved.target,
      command: formatCliContinuationCommand(cliContinuationArgv(resolved.target, location.host), shell),
    };
    const handoffId = "handoffId" in resolved ? String(resolved.handoffId || "") : "";
    if (!handoffId) {
      throw new Error("CLI handoff did not return an ownership id.");
    }
    if (!this.deps.launchCliContinuation) {
      await engine.finishCliContinuation(name, handoffId, partyId);
      throw new Error("CLI 터미널 실행은 데스크톱 앱 프로세스에서만 사용할 수 있습니다.");
    }
    // The engine has synchronously terminated its whole harness process tree.
    // Publish the disabled tab before the terminal appears, then give the OS a
    // short lock-release boundary before another process claims the thread.
    await this.broadcastParty(workspacePath);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    let terminalPid: number;
    try {
      terminalPid = await this.deps.launchCliContinuation({ target: launchDetails, location });
      await engine.recordCliContinuationProcess(name, handoffId, {
        terminalPid,
        host: location.host.kind,
        ...(location.host.kind === "wsl" ? { distro: location.host.distro } : {}),
      }, partyId);
    } catch (error) {
      await engine.finishCliContinuation(name, handoffId, partyId).catch(() => undefined);
      await this.broadcastParty(workspacePath);
      const message = error instanceof Error ? error.message : String(error);
      log("error", "cli-continuation", "default terminal launch failed", { workspacePath, member: name, error: message });
      throw new Error(`기본 터미널을 열지 못했습니다. 멤버는 앱에서 다시 사용할 수 있습니다: ${message}`);
    }
    await this.broadcastParty(workspacePath);
    this.watchCliContinuation(workspacePath, name, handoffId, terminalPid, partyId);
    return { ...launchDetails, launched: true, terminalPid };
  }

  private watchCliContinuation(
    workspacePath: string,
    name: string,
    handoffId: string,
    terminalPid: number,
    partyId?: string,
  ): void {
    const watcherKey = `${workspacePath}\u0000${partyId || ""}\u0000${name}\u0000${handoffId}`;
    if (this.cliContinuationWatchers.has(watcherKey)) return;
    this.cliContinuationWatchers.add(watcherKey);
    const timer = setInterval(() => {
      if (processExists(terminalPid)) return;
      clearInterval(timer);
      // Let the harness release its on-disk writer lock after its terminal host
      // exits before the UI becomes messageable again.
      setTimeout(() => {
        void this.partyEngine(workspacePath).finishCliContinuation(name, handoffId, partyId)
          .then(() => this.broadcastParty(workspacePath))
          .catch((error) => log("warn", "cli-continuation", "could not release completed handoff", {
            workspacePath,
            member: name,
            handoffId,
            error: String(error),
          }))
          .finally(() => this.cliContinuationWatchers.delete(watcherKey));
      }, 350);
    }, 500);
    timer.unref?.();
  }

  /**
   * Re-arms persisted CLI ownership after an app restart and releases stale
   * handoffs whose terminal has already exited. A no-PID handoff is the narrow
   * begin-to-spawn window; only treat it as stale after a generous grace period.
   */
  private async listPartyWithCliReconciled(
    workspacePath: string,
    partyId?: string,
  ): Promise<ReturnType<PartyApplicationService["list"]>> {
    const engine = this.partyEngine(workspacePath);
    let listing = await engine.listParty(partyId);
    let changed = false;
    for (const member of listing.members) {
      const handoff = member.externalCli;
      if (!handoff?.handoffId) continue;
      const pid = Number(handoff.terminalPid);
      if (Number.isInteger(pid) && pid > 0 && processExists(pid)) {
        this.watchCliContinuation(workspacePath, member.name, handoff.handoffId, pid, member.partyId || partyId);
        continue;
      }
      const ageMs = Date.now() - Date.parse(String(handoff.startedAt || ""));
      if ((!Number.isInteger(pid) || pid <= 0) && (!Number.isFinite(ageMs) || ageMs < 30_000)) {
        continue;
      }
      await engine.finishCliContinuation(member.name, handoff.handoffId, member.partyId || partyId);
      changed = true;
    }
    if (changed) listing = await engine.listParty(partyId);
    return listing;
  }

  /** One screenshot a transcript references, as a data URL (its bytes live out-of-line). */
  getTranscriptImage(workspacePath: string, file: string): Promise<{ ok: true; dataUrl: string; bytes: number }> {
    return this.partyEngine(workspacePath).getTranscriptImage(file);
  }

  saveMemberTranscript(workspacePath: string, name: string, save: TranscriptSave, windowId?: string): Promise<TranscriptSaveResult> {
    return this.partyEngine(workspacePath).saveMemberTranscript(name, save, this.partyForWindow(windowId));
  }

  // --- Window actions (addressed by window id) ----------------------------
  minimizeWindow(windowId?: string): { ok: true } {
    this.windowFor(windowId)?.minimize();
    return { ok: true };
  }

  toggleMaximizeWindow(windowId?: string): { ok: true; maximized: boolean } {
    const win = this.windowFor(windowId);
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
    return { ok: true, maximized: Boolean(win?.isMaximized()) };
  }

  closeWindow(windowId?: string): { ok: true } {
    this.windowFor(windowId)?.close();
    return { ok: true };
  }

  /**
   * Switches the visible screen, optionally landing on a specific tab within it.
   * A tab that the target view does not have is an ERROR: forwarding it would
   * report a navigation that never happened.
   */
  navigate(windowId: string | undefined, view: string, tab?: string, harness?: string): { ok: true; view: string; tab?: string; harness?: string } {
    const legacyView = view;
    if (view === "runtime") {
      if (tab && !isRuntimeTabId(tab)) throw new Error(`Unknown legacy runtime tab '${tab}'. Known: ${LEGACY_RUNTIME_TAB_IDS.join(", ")}.`);
      const legacyTab = tab || "general";
      if (["environment", "workspace", "mobile", "versions", "diagnostics"].includes(legacyTab)) {
        view = "settings";
        tab = legacyTab;
      } else {
        view = "agent";
        tab = legacyTab === "harness" ? "defaults" : legacyTab;
      }
    } else if (view === "automation") {
      if (tab) throw new Error("The deprecated 'automation' alias does not accept a tab; it maps to settings/automation.");
      view = "settings";
      tab = "automation";
    }
    const tabbed = view === "agent" || view === "settings";
    const validViews = ["workbench", "guide", "usage", "auth", "agent", "settings"];
    if (!validViews.includes(view)) throw new Error(`Unknown view '${legacyView}'. Known: ${validViews.join(", ")} (legacy aliases: runtime, automation).`);
    if (tab && !tabbed) throw new Error(`The '${view}' screen has no tabs.`);
    if (view === "agent" && tab && !isAgentTabId(tab)) throw new Error(`Unknown agent tab '${tab}'. Known: ${AGENT_TAB_IDS.join(", ")}.`);
    if (view === "settings" && tab && !isSettingsTabId(tab)) throw new Error(`Unknown settings tab '${tab}'. Known: ${SETTINGS_TAB_IDS.join(", ")}.`);
    if (view === "settings" && tab === "mobile" && getSettings().mobile?.enabled !== true) {
      throw new Error("The Settings 'mobile' tab is unavailable because Mobile Link is disabled in this build.");
    }
    // The Agent defaults tab shows ONE harness at a time, so driving it needs to
    // name which — same rule as the tab itself: an unknown one is an error, not a
    // navigation that silently lands somewhere else.
    if (harness) {
      if (view !== "agent" || tab !== "defaults") {
        throw new Error("A harness can only be selected on the agent 'defaults' tab.");
      }
      if (!(HARNESS_IDS as readonly string[]).includes(harness)) {
        throw new Error(`Unknown harness '${harness}'. Known: ${HARNESS_IDS.join(", ")}.`);
      }
    }
    const win = this.windowFor(windowId);
    if (!win) {
      throw new Error("Target window is not available.");
    }
    win.webContents.send("nav:set", { view, tab, harness });
    return { ok: true, view, ...(tab ? { tab } : {}), ...(harness ? { harness } : {}) };
  }

  async captureWindow(windowId: string | undefined, body: any): Promise<{ ok: true; path: string; width: number; height: number; bytes: number; clicked?: true; applied?: { theme?: string; clicked?: boolean; scrollY?: number; scrollX?: number } }> {
    const win = this.windowFor(windowId);
    if (!win) {
      throw new Error("Target window is not available.");
    }
    // Optional `scrollY`: scroll the main scroll region (or a selector) before
    // capturing, so a below-the-fold section of a long screen (e.g. the Token
    // Usage tables) can be screenshotted over HTTP without a resize. Pass a
    // number of pixels, or the string "bottom".
    // Optional `theme`: flip the active theme before capturing so both light and
    // dark fidelity can be screenshotted over HTTP (the theme is a user-toggleable
    // display attribute, so setting it here is harmless).
    const applied: { theme?: string; clicked?: boolean; scrollY?: number; scrollX?: number } = {};
    /** Runs a pre-capture step, attributing any failure to the option that asked for it. */
    const evaluate = async (option: string, script: string): Promise<any> =>
      win.webContents.executeJavaScript(script).catch((error: unknown) => {
        throw new Error(`Capture ${option} could not be applied: ${error instanceof Error ? error.message : String(error)}`);
      });
    if (typeof body?.theme === "string" && (body.theme === "light" || body.theme === "dark")) {
      await evaluate(
        "theme",
        `(() => { document.documentElement.setAttribute("data-theme", ${JSON.stringify(body.theme)}); })()`,
      );
      applied.theme = body.theme;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    // Optional `click`: dispatch a click on a selector before capturing, so an
    // interactive state (compare toggle, a drill-in row) can be screenshotted over
    // HTTP.
    //
    // A selector that matches NOTHING is an error, not a no-op. This used to
    // resolve `false` internally and still answer `{ok:true}`, so every e2e that
    // drove the UI through a mistyped or since-renamed selector passed green
    // without having clicked anything — the verification tooling itself was
    // lying. Failing loudly is the only form a caller cannot skip past.
    const clickSelector = typeof body?.click === "string" ? body.click.trim() : "";
    if (clickSelector) {
      const clicked = await evaluate(
        `click '${clickSelector}'`,
        `(() => { const el = document.querySelector(${JSON.stringify(clickSelector)}); if (el) { el.click(); return true; } return false; })()`,
      );
      if (!clicked) {
        throw new Error(`Capture click matched no element for selector '${clickSelector}' — nothing was clicked.`);
      }
      applied.clicked = true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // `scrollY`/`scrollX` carry the same hazard as `click`, and it is harder to
    // notice: a screenshot of the WRONG scroll position looks just as plausible
    // as the right one, so a below-the-fold check that never scrolled reads as a
    // pass. Both now report the position actually reached, and a NAMED selector
    // that does not exist fails instead of silently scrolling something else (or
    // nothing). Only the default region keeps the scrollingElement fallback.
    const scrollSelector = typeof body?.scrollSelector === "string" ? body.scrollSelector.trim() : "";
    if (body?.scrollY !== undefined) {
      const target = scrollSelector || ".program-scroll";
      const fallback = scrollSelector ? "null" : "document.scrollingElement";
      const y = body.scrollY === "bottom" ? Number.MAX_SAFE_INTEGER : Number(body.scrollY) || 0;
      const reached = await evaluate(
        `scrollY '${target}'`,
        `(() => { const el = document.querySelector(${JSON.stringify(target)}) || ${fallback}; if (!el) return null; el.scrollTop = ${y}; return el.scrollTop; })()`,
      );
      if (reached === null) {
        throw new Error(`Capture scrollY found no element for selector '${target}' — the page was not scrolled.`);
      }
      applied.scrollY = reached;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    // Optional `scrollX`: horizontal scroll of a selector (e.g. a wide table) so a
    // frozen-first-column / far-right section can be screenshotted. Requires
    // `scrollSelector`; pass pixels or "right".
    if (body?.scrollX !== undefined) {
      if (!scrollSelector) {
        throw new Error("Capture scrollX requires `scrollSelector` naming the element to scroll horizontally.");
      }
      const x = body.scrollX === "right" ? Number.MAX_SAFE_INTEGER : Number(body.scrollX) || 0;
      const reached = await evaluate(
        `scrollX '${scrollSelector}'`,
        `(() => { const el = document.querySelector(${JSON.stringify(scrollSelector)}); if (!el) return null; el.scrollLeft = ${x}; return el.scrollLeft; })()`,
      );
      if (reached === null) {
        throw new Error(`Capture scrollX found no element for selector '${scrollSelector}' — nothing was scrolled.`);
      }
      applied.scrollX = reached;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const { image, buffer } = await this.captureNonEmptyPage(win);
    const requestedPath = typeof body?.path === "string" && body.path.trim() ? body.path.trim() : "";
    const outputPath = requestedPath || path.join(path.dirname(getLogFilePath()), `capture-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, buffer);
    log("info", "capture", "window captured", { outputPath, size: buffer.length });
    return {
      ok: true,
      path: outputPath,
      width: image.getSize().width,
      height: image.getSize().height,
      bytes: buffer.length,
      // What each requested pre-capture step actually achieved (the position
      // reached, the theme set, the click landed). A caller checking that its
      // scroll took effect reads it here instead of inferring it from `ok`.
      ...(Object.keys(applied).length ? { applied } : {}),
      // Kept alongside `applied.clicked` because callers already assert on it.
      ...(applied.clicked ? { clicked: true as const } : {}),
    };
  }

  /**
   * Opens a local file the way the desktop would: with its default application,
   * or — when nothing is registered for that type, or the type is one that would
   * be EXECUTED rather than displayed — by revealing it in the file manager.
   *
   * The one route behind a clicked file link in the transcript and
   * `POST /api/shell/open-path`.
   *
   * Three deliberate refusals, because each would otherwise be a silent wrong
   * action rather than an error:
   * - A path that does not exist is an error naming the resolved path. A
   *   relative transcript link resolves against its authoring member's execution
   *   location; the window workspace is only the legacy fallback. Stating the
   *   resolved path makes a wrong resolution visible instead of doing nothing.
   * - An executable or script is never launched, only revealed — a link written
   *   by a model must not be able to run something. See shared/localFiles.ts.
   * - `shell.openPath` reporting a failure (no association) falls back to
   *   revealing, and says which happened in `action`.
   *
   * Electron is imported lazily for the same reason as `writeImageToClipboard`:
   * this controller also runs headless inside a WSL distro, where `electron`
   * does not exist.
   */
  async openLocalPath(windowId: string | undefined, target: string, options?: { reveal?: boolean; sourceLocation?: string }): Promise<{ ok: true; action: "opened" | "revealed"; path: string; reason?: string }> {
    const { shell } = await import("electron");
    const raw = String(target || "").trim();
    if (!raw) {
      throw new Error("open-path requires a 'path'.");
    }
    const sourceLocation = options?.sourceLocation
      ? this.requireAbsoluteSourceLocation(options.sourceLocation)
      : undefined;
    const resolutionOwner = sourceLocation ? "the member's execution location" : "the window's workspace";
    let resolved = this.resolveLocalPath(windowId, raw, sourceLocation);
    try {
      await fs.stat(resolved);
    } catch {
      // Model-authored citations often use `file.md:45` / `file.md:45:12`.
      // Preserve a real POSIX filename containing `:` by trying it first; only
      // when it is absent do we interpret the numeric tail as source location.
      const withoutLocation = withoutLocalFileSourceLocation(raw);
      if (!withoutLocation) {
        throw new Error(`No such file: '${resolved}'. A relative link resolves against ${resolutionOwner}.`);
      }
      const candidate = this.resolveLocalPath(windowId, withoutLocation, sourceLocation);
      try {
        await fs.stat(candidate);
        resolved = candidate;
      } catch {
        throw new Error(`No such file: '${resolved}'. A relative link resolves against ${resolutionOwner}.`);
      }
    }
    // `reveal` is the caller asking for the file manager outright — the folder
    // icon next to a file link. It shares this method (rather than getting its
    // own) so path resolution and the missing-file error stay identical; a
    // "reveal" that resolved differently from "open" would be its own bug.
    if (options?.reveal) {
      shell.showItemInFolder(resolved);
      log("info", "window", "local file revealed on request", { path: resolved });
      return { ok: true, action: "revealed", path: resolved };
    }
    if (!isLaunchable(resolved)) {
      shell.showItemInFolder(resolved);
      const reason = "실행 파일·스크립트는 열지 않고 파일 위치만 표시합니다.";
      log("info", "window", "local file revealed instead of launched", { path: resolved });
      return { ok: true, action: "revealed", path: resolved, reason };
    }
    // Returns "" on success and a message otherwise — the only way to learn that
    // the OS had no handler for this type.
    const failure = await shell.openPath(resolved);
    if (failure) {
      shell.showItemInFolder(resolved);
      log("info", "window", "no default app; revealed instead", { path: resolved, failure });
      return { ok: true, action: "revealed", path: resolved, reason: `기본 앱으로 열지 못해 파일 위치를 표시했습니다: ${failure}` };
    }
    log("info", "window", "local file opened in its default app", { path: resolved });
    return { ok: true, action: "opened", path: resolved };
  }

  /** `file://` URL or plain path → absolute, preferring the authoring member's location. */
  private resolveLocalPath(windowId: string | undefined, raw: string, sourceLocation?: string): string {
    // Decode before host classification: Windows `fileURLToPath` rejects
    // `file:///home/...` and `file:///mnt/c/...` (ERR_INVALID_FILE_URL_PATH)
    // even when the window is a WSL workspace that can open those paths.
    // Markdown and URL parsers commonly serialize a Windows drive path as
    // `/C:/...`. Node considers that absolute on Windows but normalizes it to
    // `\C:\...`, which can never exist. Restore the drive spelling after URL
    // decode, before the generic absolute/relative decision.
    const value = normalizeLocalFileTarget(decodeLocalFileTarget(raw), process.platform);
    const workspace = sourceLocation
      || (this.windowFor(windowId) ? this.deps.windowRegistry.resolve(windowId)?.workspacePath : undefined)
      || getSettings().workspacePath
      || process.cwd();
    // A WSL member's links point INTO the distro, whose files Windows reaches
    // only through `\\wsl$\<distro>\...`. Ask which host owns the path before
    // the platform-shaped absolute/relative decision below: `path.isAbsolute`
    // reads `/home/...` on Windows as the C: drive root.
    const hosted = localFileHostPath(value, workspace, process.platform);
    if (hosted !== value) {
      return hosted;
    }
    if (path.isAbsolute(value)) {
      return path.normalize(value);
    }
    return path.resolve(parseWorkspaceLocation(workspace).path || process.cwd(), value);
  }

  /** Rejects malformed resolution context instead of silently falling back to another host. */
  private requireAbsoluteSourceLocation(raw: string): string {
    const value = String(raw || "").trim();
    const location = parseWorkspaceLocation(value);
    if (location.host.kind === "wsl") {
      if (!location.host.distro || !path.posix.isAbsolute(location.path)) {
        throw new Error(`Invalid sourceLocation '${value}': an absolute WSL path is required.`);
      }
    } else if (!path.win32.isAbsolute(location.path) && !path.posix.isAbsolute(location.path)) {
      throw new Error(`Invalid sourceLocation '${value}': an absolute local path is required.`);
    }
    return serializeWorkspaceLocation(location);
  }

  /**
   * The fonts installed on this machine, the current selection, and the short
   * recommended list the picker floats to the top. `query` filters by family
   * name, the same substring match the picker's search box applies.
   *
   * This is an endpoint rather than a constant because the answer is the
   * MACHINE's, not the app's: the list is enumerated from the OS, and CSS
   * substitutes a missing family without a word. A caller that sets
   * `fonts.mono` to "D2Coding" on a machine without it would otherwise see a
   * successful write and a screen that never changed.
   *
   * Chromium is the only thing that can enumerate or classify, so the work runs
   * in the renderer — through the ONE implementation the picker itself uses
   * (renderer/app/fontProbe.ts), never a copy that could drift from it. When the
   * window cannot answer, `families` is empty and `error` says why, and
   * `installed` on a recommended entry is `null` rather than a made-up `false`.
   */
  async getFontCatalog(windowId?: string, query?: string): Promise<{
    ok: true;
    selected: FontSettings;
    recommended: (RecommendedFont & { installed: boolean | null })[];
    families: LocalFontFamily[];
    /** Families before `query` was applied — so a filtered call still reports scale. */
    totalFamilies: number;
    error?: string;
  }> {
    const selected = normalizeFontSettings(getSettings().fonts);
    const probeFamilies = RECOMMENDED_FONTS.map((font) => font.family);
    let probed: Record<string, boolean | null> = {};
    let listing: LocalFontListing = { families: [] };
    let error: string | undefined;

    const win = this.windowFor(windowId);
    if (!win) {
      error = "글꼴을 조회할 창이 없습니다.";
    } else {
      try {
        // `userGesture: true` — the Local Font Access API is gated on user
        // activation, which an automation call does not otherwise carry.
        const answer = await win.webContents.executeJavaScript(
          `window.agentPartyFonts
            ? window.agentPartyFonts.list().then((listing) => ({ listing, probed: window.agentPartyFonts.probe(${JSON.stringify(probeFamilies)}) }))
            : null`,
          true,
        );
        if (!answer) {
          error = "렌더러가 아직 글꼴 프로브를 게시하지 않았습니다 (창 로딩 중).";
        } else {
          listing = answer.listing || { families: [] };
          probed = answer.probed || {};
          error = listing.error;
        }
      } catch (caught) {
        error = `글꼴 조회 실패: ${caught instanceof Error ? caught.message : String(caught)}`;
      }
    }

    const installedFamilies = new Set(listing.families.map((entry) => entry.family));
    const recommended = RECOMMENDED_FONTS.map((font) => ({
      ...font,
      // Bundled is installed by definition; the enumeration is authoritative
      // for the rest, and the width probe is the only answer left when
      // enumeration was refused.
      installed: font.bundled || installedFamilies.has(font.family) ? true : (probed[font.family] ?? null),
    }));

    const families = query ? listing.families.filter((entry) => matchesFontQuery(entry.family, query)) : listing.families;
    return {
      ok: true,
      selected,
      recommended,
      families,
      totalFamilies: listing.families.length,
      ...(error ? { error } : {}),
    };
  }

  /**
   * Reads measurements off the LIVE screen — the numbers behind a design review.
   *
   * A capture answers "what does it look like"; this answers "what is it". The
   * questions that decide a faithful reproduction are not visible in a picture:
   * a 1px gap, whether a search box sits INSIDE the scroll region (identical
   * before the first scroll, wrong only after the user scrolls), whether the
   * last row is actually clickable or merely drawn under something else.
   *
   * Deliberately NOT a way to run arbitrary code in the renderer. The script is
   * fixed here; the request supplies selectors, style names and attribute names
   * — data. That boundary is the point: what a caller can ask is enumerable, so
   * the next person can tell what was verified from the request alone.
   *
   * It ASSERTS NOTHING. It returns values and a human decides. What it does
   * refuse to do is answer when it could not measure: a selector that matches
   * nothing is an error, never an empty list or a zero. "Gap: 0, looks fine" out
   * of a typo is exactly the silent pass this project keeps being bitten by.
   */
  async measureWindow(windowId: string | undefined, body: any): Promise<Record<string, unknown>> {
    const win = this.windowFor(windowId);
    if (!win) {
      throw new Error("Target window is not available.");
    }
    const selector = typeof body?.selector === "string" ? body.selector.trim() : "";
    if (!selector) {
      throw new Error("Measure requires a 'selector'.");
    }
    const asNames = (value: unknown, field: string): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !name.trim())) {
        throw new Error(`Measure '${field}' must be an array of names.`);
      }
      return value.map((name) => String(name).trim());
    };
    const request = {
      selector,
      styles: asNames(body?.styles, "styles"),
      attributes: asNames(body?.attributes, "attributes"),
      limit: Number.isFinite(Number(body?.limit)) && Number(body.limit) > 0 ? Math.floor(Number(body.limit)) : 100,
      within: typeof body?.within === "string" ? body.within.trim() : "",
      containedBy: typeof body?.containedBy === "string" ? body.containedBy.trim() : "",
      at: body?.at && Number.isFinite(Number(body.at.x)) && Number.isFinite(Number(body.at.y))
        ? { x: Number(body.at.x), y: Number(body.at.y) }
        : null,
      scroll: body?.scroll && typeof body.scroll.selector === "string" && body.scroll.selector.trim()
        ? { selector: String(body.scroll.selector).trim(), to: body.scroll.to === "bottom" ? "bottom" : Number(body.scroll.to) || 0 }
        : null,
    };
    const result = await win.webContents
      .executeJavaScript(`(${MEASURE_SCRIPT})(${JSON.stringify(request)})`)
      .catch((error: unknown) => {
        throw new Error(`Measure failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    if (result?.error) {
      // The renderer refusing to answer is a failure of the request, not a
      // result to be reported as data.
      throw new Error(String(result.error));
    }
    return { ok: true, ...result };
  }

  /**
   * Puts an image on the OS clipboard, so an image attached in the composer can
   * be pasted into any other app. The one route behind both the thumbnail's copy
   * button and `POST /api/clipboard/image`.
   *
   * Decoding is the check: `nativeImage` returns an EMPTY image for bytes it
   * cannot read, and writing that would clear the clipboard while reporting
   * success — the user would paste nothing and never learn why. So an empty
   * decode is an error, and the size actually written comes back for the caller
   * to assert on.
   *
   * Electron is imported HERE, lazily, not at module scope: this controller is
   * also the one the headless engine server runs inside a WSL distro, where
   * `electron` does not exist. A top-level Electron module import made every
   * WSL workspace fail to open (`WSL engine exited before ready (code 1)`), so
   * the dependency must stay inside the one method that needs it — a headless
   * caller then gets an explicit error instead of a dead engine.
   */
  async writeImageToClipboard(input: { dataBase64?: string; mediaType?: string }): Promise<{ ok: true; width: number; height: number; bytes: number }> {
    const { clipboard, nativeImage } = await import("electron");
    const dataBase64 = String(input?.dataBase64 || "").trim();
    if (!dataBase64) {
      throw new Error("clipboard image requires 'dataBase64' (base64 bytes, no data: prefix).");
    }
    const mediaType = String(input?.mediaType || "image/png").trim() || "image/png";
    // From the BUFFER rather than a data URL — one decode step instead of two,
    // and no size limit on the URL string for a large screenshot.
    //
    // Measured on Electron 33/Windows: the decoder rejects a 1x1 PNG (returns an
    // empty image) while reading a 16x16 one fine. So `isEmpty` here can mean
    // "genuinely undecodable" OR "degenerate size" — either way the bytes did not
    // become an image, and saying so beats writing an empty one.
    const image = nativeImage.createFromBuffer(Buffer.from(dataBase64, "base64"));
    if (image.isEmpty()) {
      throw new Error(`Could not decode a ${mediaType} image from the given bytes.`);
    }
    clipboard.writeImage(image);
    const size = image.getSize();
    log("info", "clipboard", "image copied", { mediaType, width: size.width, height: size.height });
    return { ok: true, width: size.width, height: size.height, bytes: image.toPNG().length };
  }

  // --- QA (test-only, workspace + window aware) ---------------------------
  isQaEnabled(): boolean {
    return isE2E() || process.env.AGENTPARTY_QA === "1";
  }

  async qaSeed(workspacePath: string, input: { party?: string; members?: QaMemberSpec[] }): Promise<{ ok: true; created: string[] } & ReturnType<PartyApplicationService["list"]>> {
    this.requireQa();
    const { created, listing } = await this.partyEngine(workspacePath).qaSeed(input);
    await this.broadcastParty(workspacePath);
    return { ok: true, created, ...listing };
  }

  async qaCreateMockMember(workspacePath: string, spec: QaMemberSpec): Promise<{ ok: true; sessionId?: string } & ReturnType<PartyApplicationService["list"]>> {
    this.requireQa();
    const { sessionId, listing } = await this.partyEngine(workspacePath).qaCreateMockMember(spec);
    await this.broadcastParty(workspacePath);
    return { ok: true, sessionId, ...listing };
  }

  async qaEmit(workspacePath: string, name: string, body: { events?: unknown[]; status?: "working" | "idle" | "approval" }): Promise<{ ok: true }> {
    this.requireQa();
    await this.partyEngine(workspacePath).qaEmit(name, body);
    return { ok: true };
  }

  async qaEmitSubagents(workspacePath: string, name: string, body: { scenario?: string }): Promise<{ ok: true; scenario: string; count: number }> {
    this.requireQa();
    const scenario = String(body?.scenario || "").trim();
    if (!scenario) {
      throw new Error("subagent injection requires a 'scenario' name.");
    }
    const result = await this.partyEngine(workspacePath).qaEmitSubagents(name, scenario);
    return { ok: true, ...result };
  }

  async qaInteraction(workspacePath: string, name: string, body: QaInteractionInput): Promise<{ ok: true; requestId: string }> {
    this.requireQa();
    const { requestId } = await this.partyEngine(workspacePath).qaInteraction(name, body);
    return { ok: true, requestId };
  }

  /**
   * Test-only: inject a provider usage-limit snapshot so the titlebar indicator
   * can be QA'd without consuming a real quota. Routes through the SAME
   * aggregation + broadcast path a real harness event takes.
   */
  qaEmitUsage(body: { provider?: string; windows?: Array<{ kind?: string; utilization?: number; resetsAt?: number }>; available?: boolean }): { ok: true; usage: UsageLimitsSnapshot } {
    this.requireQa();
    const provider = body?.provider === "codex" ? "codex" : body?.provider === "claude" ? "claude" : body?.provider === "cursor" ? "cursor" : undefined;
    if (!provider) {
      throw new Error("usage injection requires provider 'claude', 'codex', or 'cursor'.");
    }
    const windows: UsageWindow[] = [];
    for (const w of Array.isArray(body?.windows) ? body.windows : []) {
      const kind = w?.kind === "weekly" ? "weekly" : w?.kind === "five_hour" ? "five_hour" : w?.kind === "monthly" ? "monthly" : undefined;
      const utilization = Number(w?.utilization);
      if (kind && isFinite(utilization)) {
        windows.push({ kind, utilization, resetsAt: typeof w?.resetsAt === "number" ? w.resetsAt : undefined });
      }
    }
    if (!windows.length) {
      throw new Error("usage injection requires at least one window { kind: 'five_hour'|'weekly'|'monthly', utilization }.");
    }
    this.deps.sessionManager.injectUsageLimit({ type: "usage_limit", provider, windows, available: body?.available, at: new Date().toISOString() });
    return { ok: true, usage: this.deps.sessionManager.getUsageLimits() };
  }

  qaOpen(windowId: string | undefined, panels: string[][]): { ok: true; panels: string[][] } {
    this.requireQa();
    this.windowFor(windowId)?.webContents.send("qa:layout", { panels });
    return { ok: true, panels };
  }

  /** Opens a member's subagent detail (drill-in) — mock-driven QA of the detail view. */
  qaOpenSubagent(windowId: string | undefined, member: string, subId: string): { ok: true; member: string; subId: string } {
    this.requireQa();
    this.windowFor(windowId)?.webContents.send("qa:open-subagent", { member, subId });
    return { ok: true, member, subId };
  }

  /** Opens a Message Gate modal (member editor or party manager) — QA of the modal UI. */
  /**
   * Test-only: drives the mock gateway's PHONE side, which no HTTP caller can
   * otherwise reach — scanning a QR, dialling in, subscribing, sending an RPC.
   * This is what lets an E2E prove that a phone's `party.list` and the local
   * `GET /api/party` run the same handler.
   *
   * It fails loudly on the real gateway: a QA run that believes it paired a
   * phone must not pass while having exercised nothing.
   */
  async qaMobileSimulate(action: string, body: any): Promise<{ ok: true; action: string; result: unknown }> {
    this.requireQa();
    const result = await (async (): Promise<unknown> => {
      switch (action) {
        case "methods":
          return { methods: this.mobile().registeredMethods() };
        case "lock-set": {
          const kind = body?.kind === "pattern" ? "pattern" : body?.kind === "pin" ? "pin" : undefined;
          if (!kind) {
            throw new Error("lock-set requires kind 'pin' or 'pattern'.");
          }
          return this.configureMobileConnectionLock(kind, String(body?.secret ?? ""));
        }
        case "lock-clear":
          return this.clearMobileConnectionLock();
        case "scan":
          const mock = this.mobile().mockControls();
          mock.scanQr({ deviceName: body?.deviceName, deviceId: body?.deviceId });
          return this.mobile().status().pairing;
        case "fail-pairing":
          this.mobile().mockControls().failPairing(String(body?.error || "QA induced pairing failure"));
          return this.mobile().status().pairing;
        case "connect":
          return { sessionId: this.mobile().mockControls().connect({ deviceId: body?.deviceId, transport: body?.transport, workspaces: body?.workspaces }) };
        case "subscribe":
          this.mobile().mockControls().subscribe(String(body?.sessionId || ""), Array.isArray(body?.workspaces) ? body.workspaces : []);
          return { sessionId: body?.sessionId, workspaces: body?.workspaces };
        case "request":
          return this.mobile().mockControls().request(String(body?.method || ""), body?.params, body?.sessionId ? { sessionId: String(body.sessionId) } : undefined);
        case "delivered":
          return { events: this.mobile().mockControls().deliveredTo(String(body?.sessionId || "")) };
        case "emitted":
          return { events: this.mobile().mockControls().emitted() };
        case "snapshot":
          return this.mobile().mockControls().snapshot(body?.sessionId ? String(body.sessionId) : undefined);
        case "diagnostics":
          this.mobile().mockControls().setDiagnostics(body?.reason, body?.patch);
          return { reason: body?.reason };
        case "reset":
          this.mobile().mockControls().reset();
          return { reset: true };
        default:
          throw new Error(`Unknown mobile simulator action '${action}'.`);
      }
    })();
    return { ok: true, action, result };
  }

  qaOpenGate(windowId: string | undefined, kind: "member" | "party", member: string): { ok: true; kind: string; member: string } {
    this.requireQa();
    this.windowFor(windowId)?.webContents.send("qa:open-gate", { kind, member });
    return { ok: true, kind, member };
  }

  /**
   * Test-only: KILL a member's harness process, leaving the session behind —
   * the state a crashed harness actually leaves. The adapter then reports
   * whatever it really reports, which is the only way an e2e can discover that
   * different harnesses signal death differently.
   *
   * This used to inject `status: "closed"` instead. That is the value Claude
   * happens to use, so the test was handing itself the answer and could never
   * reveal that Codex and Cursor never produce it — the bug (#21) hid inside
   * the tool built to catch it. Killing for real, or failing when it cannot,
   * is the difference between observing and asserting what we already assumed.
   */
  async qaKillHarness(workspacePath: string, name: string): Promise<{ ok: true; sessionId: string; pid: number }> {
    this.requireQa();
    const party = await this.partyEngine(workspacePath).listParty();
    const sessionId = party.members?.find((member) => member.name === name)?.sessionId;
    if (!sessionId) {
      throw new Error(`Member '${name}' has no live session to end.`);
    }
    const pid = (await this.partyEngine(workspacePath).listWorkspaceSessions())
      .find((session) => session.id === sessionId)?.snapshot.pid;
    if (!pid) {
      // Refuse rather than simulate. The previous version injected the status
      // string Claude happens to use, which handed the test the answer: the
      // other adapters never produce that value, and no e2e could reveal it.
      // A QA tool that cannot do the real thing must say so (#21).
      throw new Error(
        `Member '${name}' reports no harness process id, so its harness cannot be killed for real. `
          + "Only harnesses that own an OS process (Codex, Cursor mid-turn) can be ended this way; "
          + "do not substitute a simulated status.",
      );
    }
    process.kill(pid);
    await this.broadcastParty(workspacePath);
    return { ok: true, sessionId, pid };
  }

  /**
   * Opens the card design gallery: a party of MOCK members, one per transcript
   * card case, each already showing its card.
   *
   * Every case used to live inside a demo script, so looking at the full set
   * meant running that script — the product itself had no way to show its own
   * cards. Same method behind the HTTP route and the UI, so what a designer
   * opens and what a driver captures cannot drift.
   */
  async qaDesignGallery(workspacePath: string): Promise<{ ok: true; party: string; members: string[] }> {
    this.requireQa();
    // The environment cards resolve their content from the report by id, so the
    // fixture goes in FIRST — otherwise they would render this machine's real
    // state and the states worth reviewing would never appear.
    setMockEnvironmentReport(GALLERY_ENVIRONMENT_REPORT);
    const built = await this.partyEngine(workspacePath).qaDesignGallery();
    await this.broadcastParty(workspacePath);
    return { ok: true, ...built };
  }

  /**
   * Installs the fixed environment fixture (or `{reset:true}` to go back to the
   * real probe). QA only — a normal run can never report anything but the
   * machine it is on.
   */
  qaEnvironment(body: { reset?: boolean } = {}): { ok: true; mocked: boolean } {
    this.requireQa();
    setMockEnvironmentReport(body.reset ? undefined : GALLERY_ENVIRONMENT_REPORT);
    return { ok: true, mocked: !body.reset };
  }

  async qaReset(workspacePath: string): Promise<{ ok: true } & ReturnType<PartyApplicationService["list"]>> {
    this.requireQa();
    const listing = await this.partyEngine(workspacePath).qaReset();
    await this.broadcastParty(workspacePath);
    return { ok: true, ...listing };
  }

  /**
   * Types into a field and/or presses a key — the input counterpart of
   * `/api/capture`'s `click`, so a driver can run a keyboard-driven workflow
   * through the real UI instead of calling the mutation behind it.
   *
   * The key goes through `sendInputEvent`, which produces an ACTUAL input event,
   * so the browser's own default action for that key still runs — a bare Enter
   * inside a `<form>` submits it. That fidelity is the point: a synthetic DOM
   * event dispatched from a script never triggers a default action, so any
   * behaviour that hinges on one (or on suppressing one) cannot be verified
   * end-to-end without this.
   *
   * `text` goes in as a REAL editing command (`insertText`), not by assigning a
   * value. The composer is no longer a textarea — a chip has to be able to sit
   * inside the sentence, so the editing surface is a contenteditable area, and a
   * contenteditable has no value to assign. Driving it the way a keyboard does
   * is the one approach that works on BOTH surfaces, and it is also the more
   * faithful one: the app sees the same beforeinput/input it sees from a person.
   *
   * Existing content is selected first, so `text` replaces rather than appends —
   * the semantics callers already relied on when this assigned a value.
   */
  async qaInput(
    windowId: string | undefined,
    body: { selector?: string; text?: string; select?: string; key?: string; modifiers?: string[] },
  ): Promise<{
    ok: true;
    selector: string;
    kind: "value" | "editable" | "none";
    value: string | null;
    references: string[];
    draft: string | null;
    key: string;
  }> {
    this.requireQa();
    const win = this.windowFor(windowId);
    if (!win) {
      throw new Error("Target window is not available.");
    }
    const selector = String(body?.selector || "").trim();
    if (selector) {
      const focused = await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return document.activeElement === el; })()`,
      );
      if (!focused) {
        // Never silently type into whatever happened to hold focus instead.
        throw new Error(`No focusable element matches selector '${selector}'.`);
      }
    }
    if (typeof body?.select === "string") {
      const selected = await win.webContents.executeJavaScript(
        `(() => {
          const el = document.activeElement;
          if (!(el instanceof HTMLSelectElement)) return { ok: false, tag: el?.tagName?.toLowerCase?.() || "none" };
          const value = ${JSON.stringify(body.select)};
          if (!Array.from(el.options).some((option) => option.value === value)) return { ok: false, tag: "select", value };
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, value: el.value };
        })()`,
      );
      if (!selected?.ok) {
        throw new Error(selected?.tag === "select"
          ? `Select has no option '${selected?.value || ""}'.`
          : `Cannot select an option on the focused element <${selected?.tag || "none"}>.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (typeof body?.text === "string") {
      // "Could not do it" is a failure, not a quiet success: asked to type into
      // something it cannot type into, this must not return ok and let the
      // caller read a no-op as a pass. The focused element's tag comes back in
      // the error, because knowing WHAT it tried to type into is what lets the
      // caller fix the selector.
      const target = await win.webContents.executeJavaScript(
        `(() => {
          const el = document.activeElement;
          if (!el) return { kind: "none", tag: "none" };
          const tag = el.tagName.toLowerCase();
          // A button element has a value too, so "has a value" is not the
          // question — "does it hold text a person can edit" is. Answering the
          // loose version let a mistargeted selector look like a real edit.
          const NOT_TEXT = ["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color"];
          const editableField = tag === "textarea" || (tag === "input" && !NOT_TEXT.includes(el.type));
          if (editableField) { el.select?.(); return { kind: "value", tag }; }
          if (!el.isContentEditable) return { kind: "none", tag };
          // Select what is there so the insert REPLACES it, matching the
          // replace-the-field semantics callers already depend on.
          const range = document.createRange();
          range.selectNodeContents(el);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return { kind: "editable", tag };
        })()`,
      );
      if (target?.kind === "none") {
        throw new Error(
          `Cannot type into the focused element <${target?.tag || "none"}> — it has no editable value and is not an editable area.`,
        );
      }
      // A real editing command, so the app receives the same beforeinput/input
      // a person's keystroke produces. `delete` for the empty string, because
      // inserting nothing is not an edit and would leave the selection standing.
      if (body.text) {
        win.webContents.insertText(body.text);
      } else {
        win.webContents.delete();
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const key = String(body?.key || "").trim();
    if (key) {
      const modifiers = (Array.isArray(body?.modifiers) ? body.modifiers : []).map((m) => String(m).toLowerCase());
      for (const type of ["keyDown", "char", "keyUp"] as const) {
        win.webContents.sendInputEvent({ type, keyCode: key, modifiers } as Parameters<typeof win.webContents.sendInputEvent>[0]);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Report what IS there, not that the call ran. An editable area is read as
    // its rendered text plus the paths of any chips in it: a chip DISPLAYS a
    // short name but stands for a full path, so the visible text alone would
    // misreport the message. The paths come back in `references` rather than
    // spliced into `value`, because assembling the final sentence is the
    // composer's rule to own — copying it here would let the two drift apart
    // silently, which is exactly the failure this endpoint exists to prevent.
    const read = selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.activeElement";
    const state = await win.webContents
      .executeJavaScript(
        `(() => {
          const el = ${read};
          if (!el) return { kind: "none", value: null, references: [], draft: null };
          const tag = el.tagName.toLowerCase();
          const NOT_TEXT = ["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color"];
          if (tag === "select" || tag === "textarea" || (tag === "input" && !NOT_TEXT.includes(el.type))) {
            return { kind: "value", value: el.value, references: [], draft: el.value };
          }
          if (!el.isContentEditable) return { kind: "none", value: null, references: [], draft: null };
          const references = Array.from(el.querySelectorAll("[data-path]")).map((chip) => chip.getAttribute("data-path"));
          // Read the text by walking, not via innerText: a chip is laid out as a
          // flex box, so innerText puts a line break on either side of it and
          // reports newlines the user never typed. Only a real line break (BR, or
          // a new block) counts as one. A chip contributes the short name it
          // DISPLAYS — the path it stands for is reported in references instead.
          let text = "";
          const walk = (node) => {
            for (const child of Array.from(node.childNodes)) {
              if (child.nodeType === Node.TEXT_NODE) { text += (child.nodeValue || ""); continue; }
              if (child.nodeType !== Node.ELEMENT_NODE) continue;
              if (child.hasAttribute("data-path")) { text += child.textContent || ""; continue; }
              if (child.tagName === "BR") { text += "\\n"; continue; }
              if (child.tagName === "DIV" && text && !text.endsWith("\\n")) text += "\\n";
              walk(child);
            }
          };
          walk(el);
          // An emptied editable area keeps a placeholder line break the browser
          // put there, which would read back as a newline nobody typed. "Holds
          // no text and no chip" is reported as empty — the same thing the app
          // itself treats as an empty draft.
          const empty = el.textContent === "" && references.length === 0;
          return {
            kind: "editable",
            value: empty ? "" : text.replace(/\\u00a0/g, " "),
            references,
            // The app's own answer to "what does this say", read off the editor
            // rather than reassembled here — a second implementation of that
            // rule could disagree with the real one and nobody would see it.
            // This is the draft as it stands; the composer trims it on send.
            draft: el.getAttribute("data-draft"),
          };
        })()`,
      )
      .catch(() => ({ kind: "none" as const, value: null, references: [] as string[], draft: null }));
    return { ok: true, selector, kind: state.kind, value: state.value, references: state.references, draft: state.draft, key };
  }

  /**
   * Sends pointer input to elements inside the Electron renderer without moving
   * the operating-system cursor. Unlike `element.click()`, these are Chromium
   * input events, so pointer-only controls receive their real pointer lifecycle.
   */
  async qaPointer(
    windowId: string | undefined,
    body: {
      steps?: Array<{ selector?: string; action?: string; at?: string; dx?: number; dy?: number }>;
      delayMs?: number;
    },
  ): Promise<{
    ok: true;
    steps: Array<{ selector: string; action: "move" | "down" | "up" | "click" | "rightclick"; x: number; y: number }>;
  }> {
    this.requireQa();
    const win = this.windowFor(windowId);
    if (!win) {
      throw new Error("Target window is not available.");
    }
    const requested = Array.isArray(body?.steps) ? body.steps : [];
    if (requested.length === 0 || requested.length > 64) {
      throw new Error("Pointer input requires between 1 and 64 steps.");
    }
    const delayMs = Math.min(500, Math.max(0, Number.isFinite(body?.delayMs) ? Number(body.delayMs) : 40));
    // Electron drops sendInputEvent input for an unfocused BrowserWindow. API
    // callers often run from a terminal that owns focus, so focus the explicitly
    // targeted QA window before reporting any pointer step as completed.
    if (!win.isFocused()) {
      win.show();
      win.focus();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    if (!win.isFocused()) {
      throw new Error("Target window could not be focused; pointer input was not sent.");
    }
    const completed: Array<{ selector: string; action: "move" | "down" | "up" | "click" | "rightclick"; x: number; y: number }> = [];
    let isDown = false;

    try {
      for (const [index, step] of requested.entries()) {
        const selector = String(step?.selector || "").trim();
        const action = String(step?.action || "click").trim().toLowerCase();
        if (!selector) {
          throw new Error(`Pointer step ${index + 1} requires a selector.`);
        }
        if (action !== "move" && action !== "down" && action !== "up" && action !== "click" && action !== "rightclick") {
          throw new Error(`Pointer step ${index + 1} has unsupported action '${action}'.`);
        }
        const at = String(step?.at || "center").trim().toLowerCase();
        if (!["center", "left", "right", "top", "bottom"].includes(at)) {
          throw new Error(`Pointer step ${index + 1} has unsupported at '${at}'.`);
        }
        const dx = Number.isFinite(step?.dx) ? Number(step?.dx) : 0;
        const dy = Number.isFinite(step?.dy) ? Number(step?.dy) : 0;
        // `at` aims at an EDGE of the element rather than its middle, and
        // dx/dy nudge from there. Both exist because some interactions are
        // defined by where inside a target the pointer is — dropping a tab on a
        // panel's bottom edge splits it, dropping it in the middle joins it —
        // and a driver that can only reach centres cannot express the
        // difference, which would leave a real user-facing behaviour untestable.
        const point = await win.webContents.executeJavaScript(
          `(() => {
            const selector = ${JSON.stringify(selector)};
            const at = ${JSON.stringify(at)};
            const matches = document.querySelectorAll(selector);
            if (matches.length !== 1) return { count: matches.length };
            const el = matches[0];
            el.scrollIntoView({ block: "center", inline: "center" });
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return { count: 1, hidden: true };
            // A tenth of the way in: inside the element for certain, and well
            // within any edge zone a UI would define.
            const inset = 0.1;
            let x = rect.left + rect.width / 2;
            let y = rect.top + rect.height / 2;
            if (at === "left") x = rect.left + rect.width * inset;
            if (at === "right") x = rect.right - rect.width * inset;
            if (at === "top") y = rect.top + rect.height * inset;
            if (at === "bottom") y = rect.bottom - rect.height * inset;
            return { count: 1, hidden: false, x: Math.round(x), y: Math.round(y) };
          })()`,
        );
        if (point?.count !== 1) {
          throw new Error(`Pointer selector '${selector}' matched ${point?.count || 0} elements; exactly one is required.`);
        }
        if (point.hidden || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          throw new Error(`Pointer selector '${selector}' is not visible.`);
        }
        const coordinates = { x: Math.round((point.x as number) + dx), y: Math.round((point.y as number) + dy) };
        win.webContents.sendInputEvent({ type: "mouseMove", ...coordinates });
        if (action === "down") {
          if (isDown) throw new Error(`Pointer step ${index + 1} tried to press while already pressed.`);
          win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...coordinates });
          isDown = true;
        } else if (action === "up") {
          if (!isDown) throw new Error(`Pointer step ${index + 1} tried to release before pressing.`);
          win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...coordinates });
          isDown = false;
        } else if (action === "click") {
          if (isDown) throw new Error(`Pointer step ${index + 1} cannot click while already pressed.`);
          win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...coordinates });
          win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...coordinates });
        } else if (action === "rightclick") {
          if (isDown) throw new Error(`Pointer step ${index + 1} cannot right-click while already pressed.`);
          win.webContents.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...coordinates });
          win.webContents.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, ...coordinates });
        }
        completed.push({ selector, action, ...coordinates });
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      if (isDown && completed.length > 0) {
        const last = completed[completed.length - 1];
        win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: last.x, y: last.y });
      }
      throw error;
    }
    if (isDown) {
      const last = completed[completed.length - 1];
      win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: last.x, y: last.y });
      throw new Error("Pointer sequence ended while still pressed; add a final 'up' step.");
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { ok: true, steps: completed };
  }

  /**
   * Resizes/moves the window so a driver can verify RESPONSIVE behaviour at a
   * real width — the app switches layout on measured element width, which no
   * amount of state injection stands in for. Only the given fields change, and
   * a maximized window is restored first because setBounds is ignored while
   * maximized.
   */
  qaWindowBounds(
    windowId: string | undefined,
    body: { x?: number; y?: number; width?: number; height?: number },
  ): { ok: true; bounds: { x: number; y: number; width: number; height: number } } {
    this.requireQa();
    const win = this.windowFor(windowId);
    if (!win) {
      throw new Error("Target window is not available.");
    }
    if (win.isMaximized()) {
      win.unmaximize();
    }
    const current = win.getBounds();
    const pick = (value: unknown, fallback: number) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback);
    win.setBounds({
      x: pick(body?.x, current.x),
      y: pick(body?.y, current.y),
      width: pick(body?.width, current.width),
      height: pick(body?.height, current.height),
    });
    return { ok: true, bounds: win.getBounds() };
  }

  // --- internals ----------------------------------------------------------
  private async mutateParty<T>(workspacePath: string, op: (engine: EngineConnection) => Promise<T> | T): Promise<T> {
    const result = await op(this.partyEngine(workspacePath));
    await this.broadcastParty(workspacePath);
    return result;
  }

  private requireQa(): void {
    if (!this.isQaEnabled()) {
      throw new Error("QA endpoints are disabled. Launch with AGENTPARTY_QA=1 (or E2E mode).");
    }
  }

  private async captureNonEmptyPage(win: BrowserWindow): Promise<{ image: NativeImage; buffer: Buffer }> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const image = await win.webContents.capturePage();
      const buffer = image.toPNG();
      if (buffer.length > 0) {
        return { image, buffer };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const image = await win.webContents.capturePage();
    return { image, buffer: image.toPNG() };
  }

  private async getResumableState(workspacePath: string): Promise<Pick<InitialAppState, "resumableSessions" | "resumableSessionsError">> {
    const result = await this.engineFor(workspacePath).listResumableSessions();
    return {
      resumableSessions: result.sessions,
      resumableSessionsError: result.error,
    };
  }

}

/**
 * The body of `POST /api/measure`, as source, evaluated in the renderer with the
 * request as its only argument.
 *
 * Written as one self-contained function so the page never receives caller
 * text: everything variable arrives as data through `request`. Every branch that
 * cannot answer returns `{ error }` rather than a plausible-looking zero —
 * measuring nothing and measuring zero are different facts, and reporting the
 * first as the second is how a typo becomes "spacing 0, looks correct".
 */
const MEASURE_SCRIPT = `function measure(request) {
  const round = (value) => Math.round(value * 100) / 100;
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height), top: round(r.top), right: round(r.right), bottom: round(r.bottom), left: round(r.left) };
  };
  const describe = (el) => {
    if (!el) return null;
    const id = el.id ? "#" + el.id : "";
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).join(".") : "";
    return el.tagName.toLowerCase() + id + cls;
  };

  const applied = {};
  // Scroll first when asked: several questions ("is the last row reachable",
  // "does the header survive") only have an answer at a scroll position.
  if (request.scroll) {
    const target = document.querySelector(request.scroll.selector);
    if (!target) return { error: "Measure scroll found no element for selector '" + request.scroll.selector + "' — nothing was scrolled." };
    target.scrollTop = request.scroll.to === "bottom" ? target.scrollHeight : request.scroll.to;
    applied.scrollTop = round(target.scrollTop);
    applied.scrolledTo = request.scroll.to;
  }

  const nodes = Array.from(document.querySelectorAll(request.selector));
  if (!nodes.length) return { error: "Measure found no element for selector '" + request.selector + "'." };

  let within = null;
  if (request.within) {
    within = document.querySelector(request.within);
    if (!within) return { error: "Measure 'within' found no element for selector '" + request.within + "'." };
  }
  let container = null;
  if (request.containedBy) {
    container = document.querySelector(request.containedBy);
    if (!container) return { error: "Measure 'containedBy' found no element for selector '" + request.containedBy + "'." };
  }

  const shown = nodes.slice(0, request.limit);
  const elements = shown.map((el, index) => {
    const cs = getComputedStyle(el);
    const styles = {};
    for (const name of request.styles) {
      const value = cs.getPropertyValue(name) || cs[name];
      // An unknown property computes to "" — that is "could not measure",
      // not "measured empty", and the caller must not read it as a value.
      if (value === undefined || value === "") return { failed: "Measure could not read style '" + name + "' (unknown property?)." };
      styles[name] = String(value);
    }
    const attributes = {};
    for (const name of request.attributes) {
      // null = the attribute is absent; "" = present and empty. Different facts.
      attributes[name] = el.hasAttribute(name) ? el.getAttribute(name) : null;
    }
    const box = rectOf(el);
    const entry = {
      index,
      tag: describe(el),
      text: (el.textContent || "").trim().slice(0, 200),
      box,
      content: { width: round(el.clientWidth), height: round(el.clientHeight) },
      scroll: { width: round(el.scrollWidth), height: round(el.scrollHeight), top: round(el.scrollTop), left: round(el.scrollLeft) },
      // Scrollable is content-vs-visible, not a style — the question behind
      // "does only the list scroll".
      scrollable: { vertical: el.scrollHeight > el.clientHeight + 1, horizontal: el.scrollWidth > el.clientWidth + 1 },
      styles,
      attributes,
    };
    if (within) {
      entry.withinAncestor = within.contains(el) && within !== el;
    }
    if (container) {
      const c = rectOf(container);
      entry.containedBy = {
        fully: box.top >= c.top - 1 && box.bottom <= c.bottom + 1 && box.left >= c.left - 1 && box.right <= c.right + 1,
        overflowTop: round(Math.max(0, c.top - box.top)),
        overflowBottom: round(Math.max(0, box.bottom - c.bottom)),
        overflowLeft: round(Math.max(0, c.left - box.left)),
        overflowRight: round(Math.max(0, box.right - c.right)),
      };
    }
    return entry;
  });
  const failed = elements.find((entry) => entry && entry.failed);
  if (failed) return { error: failed.failed };

  // Gaps between consecutive matches — the "1px apart" question, answered
  // between the boxes rather than eyeballed across a screenshot.
  const gaps = [];
  for (let i = 1; i < elements.length; i += 1) {
    gaps.push({
      from: i - 1,
      to: i,
      vertical: round(elements[i].box.top - elements[i - 1].box.bottom),
      horizontal: round(elements[i].box.left - elements[i - 1].box.right),
    });
  }

  const result = {
    selector: request.selector,
    count: nodes.length,
    measured: elements.length,
    texts: shown.map((el) => (el.textContent || "").trim()),
    elements,
    gaps,
    theme: document.documentElement.getAttribute("data-theme") || "",
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
  };
  if (Object.keys(applied).length) result.applied = applied;

  // What is actually at a point — the only way to tell "drawn there" from
  // "reachable there" when something else is painted on top.
  if (request.at) {
    const { x, y } = request.at;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return { error: "Measure 'at' point (" + x + "," + y + ") is outside the window (" + window.innerWidth + "x" + window.innerHeight + ")." };
    }
    const stack = document.elementsFromPoint(x, y);
    if (!stack.length) return { error: "Measure 'at' point (" + x + "," + y + ") hit no element." };
    result.at = {
      point: { x, y },
      topMost: describe(stack[0]),
      stack: stack.slice(0, 8).map(describe),
      matchesSelector: shown.some((el) => el === stack[0] || el.contains(stack[0])),
    };
  }
  return result;
}`;
