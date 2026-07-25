import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow, NativeImage } from "electron";
import { buildModelRoutes } from "../../core/modelRegistry";
import type { AppSettings, CreateMemberInput, CreatePartyInput, CreateSessionInput, InitialAppState, StartPartyMemberInput, TranscriptSave, TranscriptSaveResult, WorkspaceDisplay } from "../../shared/types";
import { harnessDefaultsOf } from "../../shared/types";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import type { CodexPolicy } from "../../shared/codexPolicy";
import type { CursorPolicy } from "../../shared/cursorPolicy";
import { permissionDiscoveryFor } from "../../shared/permissionDiscovery";
import type { ImageAttachment } from "../../shared/attachments";
import type { McpServerSnapshot } from "../../shared/mcp";
import { providerOfHarness, type UsageLimitsSnapshot, type UsageProviderId, type UsageWindow } from "../../shared/usageLimits";
import type { TokenUsageAggregate, TokenUsageQuery, TokenUsageTurnsQuery, TurnUsageRecord } from "../../shared/tokenUsage";
import { parseWorkspaceLocation, serializeWorkspaceLocation } from "../../shared/workspaceLocation";
import { clearOpenRouterKey, cursorCliAuthState, getAuthState, invalidateCursorAuthCache, setOpenRouterKey, testOpenRouterKey, withCursorCliAuth, withSubscriptionProxyAuth } from "../authService";
import { harnesses } from "../harness/types";
import { getLogFilePath, log } from "../logger";
import type { PartyApplicationService } from "./partyApplicationService";
import { getPublicSettings, getSettings, updateSettings } from "../settings";
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

export interface AppControllerDeps {
  sessionManager: SessionManager;
  engineRegistry: EngineRegistry;
  windowRegistry: WindowRegistry;
  /** Desktop-owned lifecycle. Absent only in the headless remote engine. */
  subscriptionProxy?: SubscriptionProxyController;
  getRouterBaseUrl: () => string;
  getAutomationBaseUrl: () => string;
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
    const providers = new Set<UsageProviderId>();
    for (const entry of this.deps.windowRegistry.all()) {
      try {
        const party = await this.engineFor(entry.workspacePath).listParty(this.activePartyByWindow.get(entry.id));
        for (const member of party.members || []) {
          const harnessId = member.runtime === "codex" ? "codex" : member.runtime === "cursor" ? "cursor" : "claude-code";
          const provider = providerOfHarness(harnessId);
          if (provider) {
            providers.add(provider);
          }
        }
      } catch {
        // A single window's party read failing must not blank the whole set.
      }
    }
    this.deps.sessionManager.setUsageProviders([...providers]);
  }

  /**
   * Re-broadcasts a workspace's party state after an out-of-band change (e.g. a
   * member drove a party tool in-process). Wired from the SessionManager `party`
   * event in main.ts; see docs/PARTY_COMMUNICATION.md §8.
   */
  notifyPartyChanged(workspacePath: string): Promise<void> {
    return this.broadcastParty(workspacePath);
  }

  private windowFor(windowId?: string): BrowserWindow | undefined {
    return this.deps.windowRegistry.resolve(windowId)?.window;
  }

  // --- Global state -------------------------------------------------------
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

  openWindow(workspacePath?: string): Promise<WindowInfo> {
    return this.deps.openWindow(workspacePath || getSettings().workspacePath || process.cwd());
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
  // a WSL distro. See docs/WSL_REMOTE.md §7.
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

  /** The shared "user sends a message to a member" path (UI Send button + HTTP). */
  sendMemberMessage(workspacePath: string, name: string, text: string, attachments?: ImageAttachment[], windowId?: string): Promise<ReturnType<PartyApplicationService["sendUserMessage"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.sendUserMessage(name, text, attachments, this.partyForWindow(windowId)));
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

  openPartyMember(workspacePath: string, name: string, windowId?: string): Promise<ReturnType<PartyApplicationService["openMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.openMember(name, this.partyForWindow(windowId)));
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

  /** Persists a member's Message Gate override (mode/rule/reviewer patch). UI + HTTP + agent share this path. */
  setMemberGate(workspacePath: string, name: string, gate: unknown, windowId?: string): Promise<ReturnType<PartyApplicationService["setMemberGate"]>> {
    return this.handlePartyAction(workspacePath, name, "gate", { gate }, windowId) as Promise<ReturnType<PartyApplicationService["setMemberGate"]>>;
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

  /** Same operation the member's `discord-connect` tool performs, for UI/QA. */
  async discordConnectMember(workspacePath: string, name: string, channelName?: string, windowId?: string, partyId?: string): Promise<{ ok: true; channel: string; channelId: string; created: boolean }> {
    const result = await this.requireDiscord().connectMember({
      workspacePath,
      party: await this.partyOfMember(workspacePath, name, windowId, partyId),
      member: name,
      channelName,
    });
    return { ok: true, channel: result.channelName, channelId: result.channelId, created: result.created };
  }

  async discordSendAsMember(workspacePath: string, name: string, content: string, windowId?: string, partyId?: string): Promise<{ ok: true; channel: string }> {
    const party = await this.partyOfMember(workspacePath, name, windowId, partyId);
    const result = await this.requireDiscord().sendAsMember(workspacePath, party, name, content);
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

  navigate(windowId: string | undefined, view: string): { ok: true; view: string } {
    this.windowFor(windowId)?.webContents.send("nav:set", view);
    return { ok: true, view };
  }

  async captureWindow(windowId: string | undefined, body: any): Promise<{ ok: true; path: string; width: number; height: number; bytes: number }> {
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
    if (typeof body?.theme === "string" && (body.theme === "light" || body.theme === "dark")) {
      await win.webContents.executeJavaScript(
        `(() => { document.documentElement.setAttribute("data-theme", ${JSON.stringify(body.theme)}); try { localStorage.setItem("agentparty.theme", ${JSON.stringify(body.theme)}); } catch {} })()`,
      ).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    // Optional `click`: dispatch a click on a selector before capturing, so an
    // interactive state (compare toggle, a drill-in row) can be screenshotted over
    // HTTP. Repeatable via a CSS selector; no-op if the element isn't found.
    if (typeof body?.click === "string" && body.click.trim()) {
      await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(body.click.trim())}); if (el) { el.click(); return true; } return false; })()`,
      ).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (body?.scrollY !== undefined) {
      const target = typeof body?.scrollSelector === "string" && body.scrollSelector.trim() ? body.scrollSelector.trim() : ".program-scroll";
      const y = body.scrollY === "bottom" ? Number.MAX_SAFE_INTEGER : Number(body.scrollY) || 0;
      await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(target)}) || document.scrollingElement; if (el) el.scrollTop = ${y}; return el ? el.scrollTop : 0; })()`,
      ).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    // Optional `scrollX`: horizontal scroll of a selector (e.g. a wide table) so a
    // frozen-first-column / far-right section can be screenshotted. Requires
    // `scrollSelector`; pass pixels or "right".
    if (body?.scrollX !== undefined && typeof body?.scrollSelector === "string" && body.scrollSelector.trim()) {
      const x = body.scrollX === "right" ? Number.MAX_SAFE_INTEGER : Number(body.scrollX) || 0;
      await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(body.scrollSelector.trim())}); if (el) el.scrollLeft = ${x}; return el ? el.scrollLeft : 0; })()`,
      ).catch(() => undefined);
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
    };
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

  async qaReset(workspacePath: string): Promise<{ ok: true } & ReturnType<PartyApplicationService["list"]>> {
    this.requireQa();
    const listing = await this.engineFor(workspacePath).qaReset();
    await this.broadcastParty(workspacePath);
    return { ok: true, ...listing };
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
