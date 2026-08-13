import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isLaunchable } from "../../shared/localFiles";
import type { BrowserWindow, NativeImage } from "electron";
import { buildModelRoutes } from "../../core/modelRegistry";
import type { AppSettings, CreateMemberInput, CreatePartyInput, CreateSessionInput, InitialAppState, MemberPermissionInput, StartPartyMemberInput, TranscriptSave, TranscriptSaveResult, WorkspaceDisplay } from "../../shared/types";
import { harnessDefaultsOf } from "../../shared/types";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import type { DiagnosticsReport } from "../../shared/diagnostics";
import type { EnvironmentReport } from "../../shared/environment";
import { probeEnvironment, runEnvironmentRepair, setMockEnvironmentReport, type EnvironmentRepairResult } from "../environmentService";
import { GALLERY_ENVIRONMENT_REPORT } from "../../shared/environmentGallery";
import { EMPTY_LAYOUT, openMemberTab } from "../../shared/workbenchLayout";
import type { CodexPolicy } from "../../shared/codexPolicy";
import type { CursorPolicy } from "../../shared/cursorPolicy";
import { permissionDiscoveryFor } from "../../shared/permissionDiscovery";
import type { ImageAttachment } from "../../shared/attachments";
import type { QueueCommand } from "../../shared/messageQueue";
import type { McpServerSnapshot } from "../../shared/mcp";
import { USAGE_PROVIDER_ORDER, type UsageLimitsSnapshot, type UsageWindow } from "../../shared/usageLimits";
import type { TokenUsageAggregate, TokenUsageQuery, TokenUsageTurnsQuery, TurnUsageRecord } from "../../shared/tokenUsage";
import { parseWorkspaceLocation, serializeWorkspaceLocation } from "../../shared/workspaceLocation";
import { clearDeepseekKey, clearOpenRouterKey, cursorCliAuthState, getAuthState, invalidateCursorAuthCache, setDeepseekKey, setOpenRouterKey, testDeepseekKey, testOpenRouterKey, withCursorCliAuth, withSubscriptionProxyAuth } from "../authService";
import { harnesses } from "../harness/types";
import { getLogFilePath, log } from "../logger";
import type { PartyApplicationService } from "./partyApplicationService";
import { getPublicSettings, getSettings, updateSettings } from "../settings";
import { matchesFontQuery, normalizeFontSettings, RECOMMENDED_FONTS, type FontSettings, type LocalFontFamily, type LocalFontListing, type RecommendedFont } from "../../shared/appFonts";
import { isE2E } from "../runtimeMode";
import type { SessionManager } from "../sessionManager";
import type { EngineConnection, QaInteractionInput, QaMemberSpec } from "../engine/engineConnection";
import type { EngineRegistry } from "../engine/engineRegistry";
import type { WindowInfo, WindowRegistry } from "../windowRegistry";
import { runSessionAction } from "./sessionActions";
import { MODEL_PROVIDERS } from "../../shared/modelProviders";
import type { SubscriptionProxyController } from "../subscriptionProxyService";
import type { SubscriptionProxyProvider } from "../../core/subscriptionProxy";
import { getSubscriptionProxyStatus } from "../../core/subscriptionProxy";
import type { CodexAuthenticationApplyResult, CodexAuthenticationUpdate } from "../../shared/codexAuthentication";
import { cursorAgentLogout, inspectCursorAgent } from "../../core/cursorAgentCli";
import type { DiscordBridgeService } from "../discordBridgeService";
import type { DiscordBridgeSettings, DiscordBridgeStatus } from "../../shared/discordBridge";
import { RUNTIME_TAB_IDS, isRuntimeTabId } from "../../shared/runtimeTabs";

export interface AppControllerDeps {
  sessionManager: SessionManager;
  engineRegistry: EngineRegistry;
  windowRegistry: WindowRegistry;
  /** Desktop-owned lifecycle. Absent only in the headless remote engine. */
  subscriptionProxy?: SubscriptionProxyController;
  getRouterBaseUrl: () => string;
  getAutomationBaseUrl: () => string;
  /**
   * Identity of the running build, for diagnostics. Injected rather than read
   * from `electron.app` so this controller still loads headless (WSL engine),
   * where it is absent and the version is reported as explicitly unknown.
   */
  getAppBuild?: () => { version: string; packaged: boolean };
  openWindow: (workspacePath: string) => Promise<WindowInfo>;
  onSettingsChanged: () => void;
  /** Called when the set of hosted workspaces changes (rebind) so per-workspace
   *  discovery files can be reconciled. */
  onWorkspacesChanged: () => void;
  /** Discord bridge. Desktop-owned; absent in a headless remote engine. */
  discord?: DiscordBridgeService;
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
  private codexAuthenticationGeneration = "";
  private codexAuthenticationApply: Promise<unknown> = Promise.resolve();

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
    const current = (await this.engineFor(workspacePath).listParty(undefined)).currentPartyId;
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
    // Each window gets ITS OWN party's view (per-window active party), so one
    // window selecting a party never switches another window of the same workspace.
    const engine = this.engineFor(workspacePath);
    for (const entry of this.deps.windowRegistry.forWorkspace(workspacePath)) {
      const payload = await engine.listParty(this.activePartyByWindow.get(entry.id));
      entry.window.webContents.send("party:update", payload);
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
    return this.broadcastParty(workspacePath);
  }

  /** The party's workbench tab layout, or undefined when none is stored yet. */
  getPartyLayout(workspacePath: string, windowId?: string): Promise<ReturnType<PartyApplicationService["getPartyLayout"]>> {
    return this.engineFor(workspacePath).getPartyLayout(this.partyForWindow(windowId));
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
    const result = await this.engineFor(workspacePath).setPartyLayout(layout, this.partyForWindow(windowId));
    if (!result.changed || !result.layout || !result.partyId) {
      return result;
    }
    for (const entry of this.deps.windowRegistry.forWorkspace(workspacePath)) {
      // Only windows actually showing this party — another window of the same
      // workspace may be on a different one, whose tabs must not be replaced.
      //
      // Resolved the way every READ resolves it, not by reading the pin map
      // directly: a window that loaded before this workspace had any party never
      // pinned one, and testing the raw map silently dropped it from the
      // broadcast — the first window of a fresh workspace, i.e. the common case.
      if (await this.pinnedPartyForWindow(workspacePath, entry.id) !== result.partyId) {
        continue;
      }
      entry.window.webContents.send("party:layout", { partyId: result.partyId, layout: result.layout });
    }
    return result;
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
    const settings = getSettings();
    const engine = this.engineFor(workspacePath);
    await this.synchronizeCodexAuthentication(engine);
    const codexModels = await engine.listCodexModels();
    const state: InitialAppState = {
      ok: true,
      settings: { ...getPublicSettings(), workspacePath },
      workspace: this.workspaceDisplay(workspacePath),
      auth: await this.listAuthProviders(),
      sessions: await engine.listWorkspaceSessions(),
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
      party: await engine.listParty(await this.pinnedPartyForWindow(workspacePath, windowId)),
      windows: this.deps.windowRegistry.list(),
      ...(await this.getResumableState(workspacePath)),
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
      auth: (await this.listAuthProviders()).map((provider) => ({ id: provider.id, label: provider.label, status: provider.status })),
    };
  }

  /**
   * Whether this machine can actually run a member, and what to do when it
   * cannot. Sibling of {@link getDiagnostics} and deliberately separate: that
   * one describes a build for a bug report, this one is a to-do list.
   *
   * `includeWsl` is opt-in because probing a distro starts it.
   */
  async getEnvironment(options: { refresh?: boolean; includeWsl?: boolean } = {}): Promise<EnvironmentReport> {
    return probeEnvironment(options);
  }

  /**
   * Applies one of the fixes {@link getEnvironment} offered. The caller passes
   * an id, never a command — see `runEnvironmentRepair`.
   */
  async repairEnvironment(repairId: string): Promise<EnvironmentRepairResult> {
    if (!repairId) {
      throw new Error("repairId가 필요합니다.");
    }
    return runEnvironmentRepair(repairId);
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
  /** Current selectable model routes + Codex catalog discovery state. */
  async listModels(workspacePath: string): Promise<{ ok: true; modelRoutes: unknown[]; modelProviders: typeof MODEL_PROVIDERS; harnesses: unknown[]; codexModels: CodexModelDiscoveryState }> {
    const codexModels = await this.engineFor(workspacePath).listCodexModels();
    return { ok: true, ...publicModelDiscovery(codexModels) };
  }

  /** Re-runs Codex catalog discovery and returns the fresh state. */
  async refreshCodexModels(workspacePath: string): Promise<{ ok: true; modelRoutes: unknown[]; modelProviders: typeof MODEL_PROVIDERS; harnesses: unknown[]; codexModels: CodexModelDiscoveryState }> {
    const codexModels = await this.engineFor(workspacePath).listCodexModels(true);
    return { ok: true, ...publicModelDiscovery(codexModels) };
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

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const previous = getSettings();
    updateSettings(patch || {});
    this.deps.onSettingsChanged();
    if (typeof patch?.debugEnabled === "boolean" && patch.debugEnabled !== previous.debugEnabled) {
      this.deps.sessionManager.setDebugMode(patch.debugEnabled);
    }
    // Idle sleep is acted on by whichever host owns the sessions, which for a WSL
    // workspace is inside the distro — and that host reads a different
    // settings.json. Push the value instead of letting each engine look it up.
    if (patch?.idleSleep) {
      void this.deps.engineRegistry.setIdleSleep(getSettings().idleSleep);
    }
    if (patch?.memberMessaging) {
      void this.deps.engineRegistry.setMemberMessaging(getSettings().memberMessaging);
    }
    const settings = getPublicSettings();
    // Settings are global — push to EVERY window so a change made over HTTP or in
    // another window reflects live (e.g. transcript zoom), not only on next load.
    // (The renderer preserves each window's own workspacePath on merge.)
    for (const entry of this.deps.windowRegistry.all()) {
      entry.window.webContents.send("settings:update", settings);
    }
    return settings;
  }

  /** The desktop auth cards with the Cursor CLI's REAL (cached) login state overlaid. */
  private async authStateWithCursor(base?: ReturnType<typeof getAuthState>): Promise<ReturnType<typeof getAuthState>> {
    return withCursorCliAuth(base || getAuthState(), await cursorCliAuthState());
  }

  async listAuthProviders(): Promise<ReturnType<typeof getAuthState>> {
    const subscriptions = await this.getSubscriptionStatus();
    if (subscriptions.codex.available) {
      await this.synchronizeCodexAuthentication();
    }
    return withSubscriptionProxyAuth(await this.authStateWithCursor(), subscriptions);
  }

  async setOpenRouterKey(key: string): Promise<ReturnType<typeof getAuthState>> {
    const state = setOpenRouterKey(key || "");
    this.deps.onSettingsChanged();
    return this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCursor(state), await this.getSubscriptionStatus()));
  }

  async clearOpenRouterKey(): Promise<ReturnType<typeof getAuthState>> {
    const state = clearOpenRouterKey();
    this.deps.onSettingsChanged();
    return this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCursor(state), await this.getSubscriptionStatus()));
  }

  async testOpenRouterKey(): Promise<ReturnType<typeof getAuthState>> {
    return this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCursor(await testOpenRouterKey()), await this.getSubscriptionStatus()));
  }

  async setDeepseekKey(key: string): Promise<ReturnType<typeof getAuthState>> {
    const state = setDeepseekKey(key || "");
    this.deps.onSettingsChanged();
    return this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCursor(state), await this.getSubscriptionStatus()));
  }

  async clearDeepseekKey(): Promise<ReturnType<typeof getAuthState>> {
    const state = clearDeepseekKey();
    this.deps.onSettingsChanged();
    return this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCursor(state), await this.getSubscriptionStatus()));
  }

  async testDeepseekKey(): Promise<ReturnType<typeof getAuthState>> {
    return this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCursor(await testDeepseekKey()), await this.getSubscriptionStatus()));
  }

  /** The full provider list, for the automation API's GET /api/auth. */
  async getAuthProviders(): Promise<ReturnType<typeof getAuthState>> {
    return withSubscriptionProxyAuth(await this.authStateWithCursor(getAuthState()), await this.getSubscriptionStatus());
  }

  /** Live OAuth-backed model availability from the local CLIProxyAPI. */
  getSubscriptionAuthState(): ReturnType<SubscriptionProxyController["getStatus"]> {
    return this.getSubscriptionStatus();
  }

  /** Starts one browser OAuth flow and returns the same auth state the UI uses. */
  async loginSubscriptionProvider(provider: SubscriptionProxyProvider) {
    if (!this.deps.subscriptionProxy) {
      throw new Error("Subscription OAuth must be started from the AgentParty desktop Authentication screen, not a remote workspace engine.");
    }
    const result = await this.deps.subscriptionProxy.login(provider);
    const auth = this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCursor(), result.subscriptions));
    return {
      ...result,
      auth,
    };
  }

  /** Disconnects one persisted subscription account and refreshes every UI. */
  async disconnectSubscriptionProvider(provider: SubscriptionProxyProvider | "cursor") {
    if (provider === "cursor") {
      return this.disconnectCursor();
    }
    if (!this.deps.subscriptionProxy) {
      throw new Error("Subscription OAuth must be managed from the AgentParty desktop Authentication screen, not a remote workspace engine.");
    }
    const result = await this.deps.subscriptionProxy.disconnect(provider);
    const runtimeAuthentication = provider === "codex" && result.removedCredentials > 0
      ? await this.applyCodexAuthentication({ generation: "disconnected" })
      : [];
    const auth = this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCursor(), result.subscriptions));
    return {
      ...result,
      runtimeAuthentication,
      auth,
    };
  }

  /**
   * Signs the DESKTOP HOST's Cursor Agent CLI out (`cursor-agent logout`) — the
   * account the auth card describes. A WSL distro's own Cursor login is that
   * host's credential and is not touched here.
   */
  private async disconnectCursor() {
    const result = await cursorAgentLogout(getSettings().cursorExecutablePath);
    invalidateCursorAuthCache();
    const auth = this.broadcastAuth(withSubscriptionProxyAuth(await this.authStateWithCursor(), await this.getSubscriptionStatus()));
    return {
      ok: result.ok,
      provider: "cursor" as const,
      status: "disconnected" as const,
      detail: result.detail,
      auth,
    };
  }

  /**
   * Reconciles CLIProxyAPI's selected Codex account into every native engine.
   * A target is supplied during initial state load so a just-created WSL engine
   * is synchronized before it can discover models or prewarm a member.
   */
  private async synchronizeCodexAuthentication(target?: EngineConnection): Promise<CodexAuthenticationApplyResult[]> {
    const update = await this.deps.subscriptionProxy?.getCodexAuthentication();
    if (!update) {
      return [];
    }
    // A new generation must reach every already-live engine, not only the
    // workspace whose state request happened to detect it.
    if (update.generation !== this.codexAuthenticationGeneration) {
      return this.applyCodexAuthentication(update);
    }
    if (target) {
      const result = await target.setCodexAuthentication(update);
      return [result];
    }
    return [];
  }

  private applyCodexAuthentication(update: CodexAuthenticationUpdate): Promise<CodexAuthenticationApplyResult[]> {
    const task = this.codexAuthenticationApply.then(async () => {
      if (update.generation === this.codexAuthenticationGeneration) {
        return [];
      }
      const result = await this.deps.engineRegistry.setCodexAuthentication(update);
      this.codexAuthenticationGeneration = update.generation;
      return result;
    });
    this.codexAuthenticationApply = task.catch(() => undefined);
    return task;
  }

  private getSubscriptionStatus(): ReturnType<SubscriptionProxyController["getStatus"]> {
    return this.deps.subscriptionProxy?.getStatus() || getSubscriptionProxyStatus();
  }

  /** Keeps every window in sync when Authentication is driven over HTTP. */
  private broadcastAuth(auth: ReturnType<typeof getAuthState>): ReturnType<typeof getAuthState> {
    for (const entry of this.deps.windowRegistry.all()) {
      entry.window.webContents.send("auth:update", auth);
    }
    return auth;
  }

  // --- Windows + workspace ------------------------------------------------
  listWindows(): WindowInfo[] {
    return this.deps.windowRegistry.list();
  }

  /**
   * Opens a window, optionally ON a specific party.
   *
   * A party id is meaningful only inside its workspace. Validate that pair
   * before creating the BrowserWindow: PartyApplicationService.list() normally
   * falls back from an unknown id to the workspace's current party, which would
   * make a routing bug look like a successful open of an unrelated party.
   *
   * The party is PINNED before the window can ask, because pinning otherwise
   * happens at the window's first `getState` and would capture whatever the
   * shared advisory hint held at that moment — i.e. the party the OTHER window
   * is on. Setting it up front is what makes "open this party in a new window"
   * land on that party instead of a copy of the current one.
   */
  async openWindow(workspacePath?: string, partyId?: string): Promise<WindowInfo> {
    const targetWorkspace = workspacePath || getSettings().workspacePath || process.cwd();
    if (partyId) {
      const listing = await this.engineFor(targetWorkspace).listParty(undefined);
      if (!(listing.parties || []).some((party) => party.id === partyId)) {
        throw new Error(`Party '${partyId}' does not exist in workspace '${targetWorkspace}'.`);
      }
    }

    const info = await this.deps.openWindow(targetWorkspace);
    if (partyId) {
      this.activePartyByWindow.set(info.id, partyId);
    }
    return info;
  }

  /** Points a window at a different workspace and returns its fresh state. */
  async setWindowWorkspace(windowId: string | undefined, workspacePath: string): Promise<InitialAppState> {
    const entry = this.deps.windowRegistry.resolve(windowId);
    if (entry) {
      this.deps.windowRegistry.setWorkspace(entry.id, workspacePath);
      // The window's active party belonged to the PREVIOUS workspace — drop it so
      // the fresh getState below re-pins it to a party of the NEW workspace (else
      // member ops would carry a party id that doesn't exist here).
      this.forgetWindow(entry.id);
      // The window now serves a different workspace → refresh discovery files.
      this.deps.onWorkspacesChanged();
    }
    // Remember as the default workspace for newly opened windows.
    updateSettings({ workspacePath });
    return this.getState(workspacePath, entry?.id);
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
   * Aggregated per-turn usage ledger for the Token Usage dashboard — the single
   * method backing both the UI and `GET /api/token-usage`. Routed to the engine
   * that owns the workspace so a WSL distro's turns are read on their own host.
   */
  getTokenUsage(workspacePath: string, query: TokenUsageQuery): Promise<TokenUsageAggregate> {
    return this.engineFor(workspacePath).getTokenUsage(query);
  }

  /** Raw per-turn records for the member drill-in (context curve + expensive turns). */
  getTokenUsageTurns(workspacePath: string, query: TokenUsageTurnsQuery): Promise<TurnUsageRecord[]> {
    return this.engineFor(workspacePath).getTokenUsageTurns(query);
  }

  // Session control is routed to the engine that owns the workspace the caller
  // (window / ?window=) is viewing — the session lives in that engine, local or
  // a WSL distro. See the WSL remote-engine design §7.
  async closeSession(workspacePath: string, sessionId: string): Promise<{ ok: boolean }> {
    return { ok: await this.engineFor(workspacePath).closeSession(sessionId) };
  }

  sendSessionMessage(workspacePath: string, sessionId: string, text: string, attachments?: ImageAttachment[]): Promise<void> {
    return this.engineFor(workspacePath).sendUserTurn(sessionId, text, attachments);
  }

  async handleSessionAction(workspacePath: string, sessionId: string, action: string, body: any): Promise<{ ok: true }> {
    await runSessionAction(this.engineFor(workspacePath), sessionId, action, body);
    return { ok: true };
  }

  interruptSession(workspacePath: string, sessionId: string): Promise<void> {
    return this.engineFor(workspacePath).interruptSession(sessionId);
  }

  /** Releases a turn the harness never closed (the UI's manual force-stop). */
  forceStopSession(workspacePath: string, sessionId: string): Promise<void> {
    return this.engineFor(workspacePath).forceStopSession(sessionId);
  }

  restartSession(workspacePath: string, sessionId: string): Promise<void> {
    return this.engineFor(workspacePath).restartSession(sessionId);
  }

  compactSession(workspacePath: string, sessionId: string): Promise<void> {
    return this.engineFor(workspacePath).compactSession(sessionId);
  }

  setSessionModel(workspacePath: string, sessionId: string, model: string, providerId?: string, runtimeModel?: string): Promise<void> {
    return this.engineFor(workspacePath).setSessionModel(sessionId, model, providerId, runtimeModel);
  }

  setSessionEffort(workspacePath: string, sessionId: string, effort: string): Promise<void> {
    return this.engineFor(workspacePath).setSessionEffort(sessionId, effort);
  }

  setSessionThinking(workspacePath: string, sessionId: string, mode: string, budget?: number): Promise<void> {
    return this.engineFor(workspacePath).setSessionThinking(sessionId, mode, budget);
  }

  setSessionPermissionMode(workspacePath: string, sessionId: string, permissionMode: string): Promise<void> {
    return this.engineFor(workspacePath).setSessionPermissionMode(sessionId, permissionMode);
  }

  setSessionCodexPolicy(workspacePath: string, sessionId: string, policy: CodexPolicy): Promise<void> {
    return this.engineFor(workspacePath).setSessionCodexPolicy(sessionId, policy);
  }

  setSessionCursorPolicy(workspacePath: string, sessionId: string, policy: CursorPolicy): Promise<void> {
    return this.engineFor(workspacePath).setSessionCursorPolicy(sessionId, policy);
  }

  approveSession(workspacePath: string, sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): Promise<void> {
    return this.engineFor(workspacePath).approveSession(sessionId, requestId, behavior, updatedInput, message);
  }

  // --- MCP (external servers a member connects to; by session id) ---------
  // Same AppController method behind the UI panel and the HTTP API, so an agent
  // drives the identical route a user does (route-parity rule).
  listSessionMcpServers(workspacePath: string, sessionId: string): Promise<McpServerSnapshot> {
    return this.engineFor(workspacePath).listSessionMcpServers(sessionId);
  }

  async sessionMcpAction(workspacePath: string, sessionId: string, action: string, body: any): Promise<unknown> {
    const engine = this.engineFor(workspacePath);
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

  // --- Party (scoped to a workspace + the CALLING WINDOW's active party) ---
  // `windowId` selects which window's active party the op resolves against, so
  // two windows of one workspace act on different parties independently. When
  // absent (HTTP with no `?window`), the engine falls back to its advisory hint.
  // A member tool can pass its spawning `partyId` explicitly; it wins over a
  // later desktop selection so the member never crosses party boundaries.
  async listPartyMembers(workspacePath: string, windowId?: string, partyId?: string): Promise<ReturnType<PartyApplicationService["list"]>> {
    return this.engineFor(workspacePath).listParty(partyId || await this.pinnedPartyForWindow(workspacePath, windowId));
  }

  async createParty(workspacePath: string, input: CreatePartyInput, windowId?: string): Promise<ReturnType<PartyApplicationService["createParty"]>> {
    const result = await this.engineFor(workspacePath).createParty(input);
    // The window that created the party switches to it (others are untouched).
    if (windowId && result.currentPartyId) {
      this.activePartyByWindow.set(windowId, result.currentPartyId);
    }
    await this.broadcastParty(workspacePath);
    return result;
  }

  async selectParty(workspacePath: string, partyId: string, windowId?: string): Promise<ReturnType<PartyApplicationService["selectParty"]>> {
    const result = await this.engineFor(workspacePath).selectParty(partyId); // validates the id
    if (windowId) {
      this.activePartyByWindow.set(windowId, partyId);
    }
    await this.broadcastParty(workspacePath);
    return result;
  }

  async removeParty(workspacePath: string, partyId: string, windowId?: string): Promise<ReturnType<PartyApplicationService["removeParty"]>> {
    const result = await this.engineFor(workspacePath).removeParty(partyId);
    // Any window that was viewing the deleted party falls back to the default.
    for (const [wid, pid] of this.activePartyByWindow) {
      if (pid === partyId) {
        this.activePartyByWindow.delete(wid);
      }
    }
    await this.broadcastParty(workspacePath);
    return result;
  }

  createPartyMember(workspacePath: string, input: CreateMemberInput, windowId?: string): Promise<ReturnType<PartyApplicationService["createMember"]>> {
    // The member lands in the party the renderer names, else the window's party.
    return this.mutateParty(workspacePath, (engine) => engine.createMember({ ...input, partyId: input.partyId || this.partyForWindow(windowId) }));
  }

  sendPartyMessage(workspacePath: string, name: string, content: string, from?: string, attachments?: ImageAttachment[], windowId?: string, options?: { interrupt?: boolean; force?: boolean; forceReason?: string }, partyId?: string): Promise<ReturnType<PartyApplicationService["sendMessage"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.sendPartyMessage(name, content, from, attachments, partyId || this.partyForWindow(windowId), options));
  }

  /**
   * Runs one party tool as a member whose harness reaches us over HTTP (Codex).
   * The party comes from the CALLER's own identity, never from a window: the
   * member's tools act inside its own party regardless of what anyone is viewing.
   */
  async invokePartyToolAs(workspacePath: string, member: string, tool: string, args: unknown, partyId?: string): ReturnType<PartyApplicationService["invokePartyToolAs"]> {
    // `workspacePath` came from the FOCUSED WINDOW, because an HTTP caller has
    // no window of its own — and one process serves every open window. With a
    // second workspace open, every member of the unfocused one was looked up in
    // the wrong place ("Member 'refactor' is not in this party."). The party the
    // member names is the reliable key, so it decides which engine runs the tool.
    const owner = partyId ? await this.deps.engineRegistry.workspaceOwningParty(partyId, workspacePath) : undefined;
    return this.mutateParty(owner || workspacePath, (engine) => engine.invokePartyToolAs(member, tool, args, partyId));
  }

  /** The shared "user sends a message to a member" path (UI Send button + HTTP). */
  sendMemberMessage(workspacePath: string, name: string, text: string, attachments?: ImageAttachment[], windowId?: string, options?: { interrupt?: boolean }): Promise<ReturnType<PartyApplicationService["sendUserMessage"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.sendUserMessage(name, text, attachments, this.partyForWindow(windowId), options));
  }

  /** Messages a busy member has been sent but not yet handed (shared/messageQueue.ts). */
  getMemberQueue(workspacePath: string, name: string, windowId?: string): Promise<ReturnType<PartyApplicationService["getMemberQueue"]>> {
    return this.engineFor(workspacePath).getMemberQueue(name, this.partyForWindow(windowId));
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
    const result = await this.engineFor(workspacePath).partyAction(name, action, body || {}, partyId || this.partyForWindow(windowId));
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
    const stored = await this.engineFor(workspacePath).getPartyLayout(this.partyForWindow(windowId));
    await this.setPartyLayout(workspacePath, openMemberTab(stored ?? EMPTY_LAYOUT, name), windowId);
    return result;
  }

  startPartyMember(workspacePath: string, name: string, input?: StartPartyMemberInput, windowId?: string): Promise<ReturnType<PartyApplicationService["startMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.startMember(name, input, this.partyForWindow(windowId)));
  }

  bindPartyMember(workspacePath: string, name: string, sessionId: string, windowId?: string): Promise<ReturnType<PartyApplicationService["bindMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.bindMember(name, sessionId, this.partyForWindow(windowId)));
  }

  removePartyMember(workspacePath: string, name: string, windowId?: string): Promise<ReturnType<PartyApplicationService["removeMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.removeMember(name, this.partyForWindow(windowId)));
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
    const result = await this.engineFor(workspacePath).setPartyGate(target, gate);
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
      workspacePath,
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
      workspacePath,
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
    const result = await this.requireDiscord().sendAsMember(workspacePath, party, name, content);
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
    const result = await this.requireDiscord().sendImageAsMember(workspacePath, party, name, image, caption);
    return { ok: true, channel: result.channelName };
  }

  async discordDisconnectMember(workspacePath: string, name: string, windowId?: string, partyId?: string): Promise<{ ok: true; removed: boolean }> {
    const party = await this.partyOfMember(workspacePath, name, windowId, partyId);
    const result = this.requireDiscord().disconnectMember(workspacePath, party, name);
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

  getMemberTranscript(workspacePath: string, name: string, windowId?: string): Promise<unknown[]> {
    return this.engineFor(workspacePath).getMemberTranscript(name, this.partyForWindow(windowId));
  }

  /** Where the harness keeps its own untrimmed copy of a member's conversation. */
  getHarnessOriginal(workspacePath: string, name: string, windowId?: string) {
    return this.engineFor(workspacePath).getHarnessOriginal(name, this.partyForWindow(windowId));
  }

  /** One screenshot a transcript references, as a data URL (its bytes live out-of-line). */
  getTranscriptImage(workspacePath: string, file: string): Promise<{ ok: true; dataUrl: string; bytes: number }> {
    return this.engineFor(workspacePath).getTranscriptImage(file);
  }

  saveMemberTranscript(workspacePath: string, name: string, save: TranscriptSave, windowId?: string): Promise<TranscriptSaveResult> {
    return this.engineFor(workspacePath).saveMemberTranscript(name, save, this.partyForWindow(windowId));
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
  navigate(windowId: string | undefined, view: string, tab?: string): { ok: true; view: string; tab?: string } {
    if (tab) {
      if (view !== "runtime") {
        throw new Error(`The '${view}' screen has no tabs.`);
      }
      if (!isRuntimeTabId(tab)) {
        throw new Error(`Unknown runtime tab '${tab}'. Known: ${RUNTIME_TAB_IDS.join(", ")}.`);
      }
    }
    const win = this.windowFor(windowId);
    if (!win) {
      throw new Error("Target window is not available.");
    }
    win.webContents.send("nav:set", { view, tab });
    return { ok: true, view, ...(tab ? { tab } : {}) };
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
        `(() => { document.documentElement.setAttribute("data-theme", ${JSON.stringify(body.theme)}); try { localStorage.setItem("agentparty.theme", ${JSON.stringify(body.theme)}); } catch {} })()`,
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
   *   relative link resolves against the WINDOW'S WORKSPACE (the folder the user
   *   is looking at), not the app bundle, and stating the resolved path is what
   *   makes a wrong resolution visible instead of just "nothing happened".
   * - An executable or script is never launched, only revealed — a link written
   *   by a model must not be able to run something. See shared/localFiles.ts.
   * - `shell.openPath` reporting a failure (no association) falls back to
   *   revealing, and says which happened in `action`.
   *
   * Electron is imported lazily for the same reason as `writeImageToClipboard`:
   * this controller also runs headless inside a WSL distro, where `electron`
   * does not exist.
   */
  async openLocalPath(windowId: string | undefined, target: string, options?: { reveal?: boolean }): Promise<{ ok: true; action: "opened" | "revealed"; path: string; reason?: string }> {
    const { shell } = await import("electron");
    const raw = String(target || "").trim();
    if (!raw) {
      throw new Error("open-path requires a 'path'.");
    }
    const resolved = this.resolveLocalPath(windowId, raw);
    try {
      await fs.stat(resolved);
    } catch {
      throw new Error(`No such file: '${resolved}'. A relative link resolves against the window's workspace.`);
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

  /** `file://` URL or plain path → an absolute path, relative ones against the window's workspace. */
  private resolveLocalPath(windowId: string | undefined, raw: string): string {
    let value = raw;
    if (/^file:\/\//i.test(value)) {
      try {
        value = fileURLToPath(value);
      } catch {
        throw new Error(`Not a readable file URL: '${raw}'.`);
      }
    } else {
      // A link may be percent-encoded even without a scheme (spaces, Hangul).
      try { value = decodeURI(value); } catch { /* keep the literal text */ }
    }
    if (path.isAbsolute(value)) {
      return path.normalize(value);
    }
    const workspace = this.windowFor(windowId) ? this.deps.windowRegistry.resolve(windowId)?.workspacePath : undefined;
    return path.resolve(workspace || getSettings().workspacePath || process.cwd(), value);
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
   * `electron` does not exist. A top-level `import … from "electron"` made every
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
    const { created, listing } = await this.engineFor(workspacePath).qaSeed(input);
    await this.broadcastParty(workspacePath);
    return { ok: true, created, ...listing };
  }

  async qaCreateMockMember(workspacePath: string, spec: QaMemberSpec): Promise<{ ok: true; sessionId?: string } & ReturnType<PartyApplicationService["list"]>> {
    this.requireQa();
    const { sessionId, listing } = await this.engineFor(workspacePath).qaCreateMockMember(spec);
    await this.broadcastParty(workspacePath);
    return { ok: true, sessionId, ...listing };
  }

  async qaEmit(workspacePath: string, name: string, body: { events?: unknown[]; status?: "working" | "idle" | "approval" }): Promise<{ ok: true }> {
    this.requireQa();
    await this.engineFor(workspacePath).qaEmit(name, body);
    return { ok: true };
  }

  async qaEmitSubagents(workspacePath: string, name: string, body: { scenario?: string }): Promise<{ ok: true; scenario: string; count: number }> {
    this.requireQa();
    const scenario = String(body?.scenario || "").trim();
    if (!scenario) {
      throw new Error("subagent injection requires a 'scenario' name.");
    }
    const result = await this.engineFor(workspacePath).qaEmitSubagents(name, scenario);
    return { ok: true, ...result };
  }

  async qaInteraction(workspacePath: string, name: string, body: QaInteractionInput): Promise<{ ok: true; requestId: string }> {
    this.requireQa();
    const { requestId } = await this.engineFor(workspacePath).qaInteraction(name, body);
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
    const party = await this.engineFor(workspacePath).listParty();
    const sessionId = party.members?.find((member) => member.name === name)?.sessionId;
    if (!sessionId) {
      throw new Error(`Member '${name}' has no live session to end.`);
    }
    const pid = (await this.engineFor(workspacePath).listWorkspaceSessions())
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
    const built = await this.engineFor(workspacePath).qaDesignGallery();
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
    const listing = await this.engineFor(workspacePath).qaReset();
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
    body: { selector?: string; text?: string; key?: string; modifiers?: string[] },
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
          if (tag === "textarea" || (tag === "input" && !NOT_TEXT.includes(el.type))) {
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
    const result = await op(this.engineFor(workspacePath));
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
