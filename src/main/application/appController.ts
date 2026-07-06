import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow, NativeImage } from "electron";
import { buildModelRoutes } from "../../core/modelRegistry";
import type { AppSettings, CreateMemberInput, CreatePartyInput, CreateSessionInput, InitialAppState, StartPartyMemberInput, WorkspaceDisplay } from "../../shared/types";
import { harnessDefaultsOf } from "../../shared/types";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import type { CodexPolicy } from "../../shared/codexPolicy";
import type { ImageAttachment } from "../../shared/attachments";
import type { McpServerSnapshot } from "../../shared/mcp";
import { parseWorkspaceLocation, serializeWorkspaceLocation } from "../../shared/workspaceLocation";
import { clearOpenRouterKey, getAuthState, setOpenRouterKey, testOpenRouterKey } from "../authService";
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

export interface AppControllerDeps {
  sessionManager: SessionManager;
  engineRegistry: EngineRegistry;
  windowRegistry: WindowRegistry;
  getRouterBaseUrl: () => string;
  getAutomationBaseUrl: () => string;
  openWindow: (workspacePath: string) => Promise<WindowInfo>;
  onSettingsChanged: () => void;
  /** Called when the set of hosted workspaces changes (rebind) so per-workspace
   *  discovery files can be reconciled. */
  onWorkspacesChanged: () => void;
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
    const payload = await this.engineFor(workspacePath).listParty();
    for (const entry of this.deps.windowRegistry.forWorkspace(workspacePath)) {
      entry.window.webContents.send("party:update", payload);
    }
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
  async getState(workspacePath: string): Promise<InitialAppState> {
    const settings = getSettings();
    const codexModels = await this.engineFor(workspacePath).listCodexModels();
    return {
      ok: true,
      settings: { ...getPublicSettings(), workspacePath },
      workspace: this.workspaceDisplay(workspacePath),
      auth: getAuthState(),
      sessions: await this.engineFor(workspacePath).listWorkspaceSessions(),
      modelRoutes: buildModelRoutes(harnessDefaultsOf(settings).model, [], [], codexModels.models),
      codexModels,
      harnesses,
      router: { baseUrl: this.deps.getRouterBaseUrl() },
      automationApi: {
        baseUrl: this.deps.getAutomationBaseUrl(),
        spec: `${this.deps.getAutomationBaseUrl()}/api/spec`,
      },
      logs: { logFilePath: getLogFilePath() },
      party: await this.engineFor(workspacePath).listParty(),
      windows: this.deps.windowRegistry.list(),
      ...(await this.getResumableState(workspacePath)),
    };
  }

  getLogs(): { logFilePath: string } {
    return { logFilePath: getLogFilePath() };
  }

  // --- Model routes ---------------------------------------------------------
  /** Current selectable model routes + Codex catalog discovery state. */
  async listModels(workspacePath: string): Promise<{ ok: true; modelRoutes: unknown[]; codexModels: CodexModelDiscoveryState }> {
    const codexModels = await this.engineFor(workspacePath).listCodexModels();
    return { ok: true, modelRoutes: buildModelRoutes(harnessDefaultsOf(getSettings()).model, [], [], codexModels.models), codexModels };
  }

  /** Re-runs Codex catalog discovery and returns the fresh state. */
  async refreshCodexModels(workspacePath: string): Promise<{ ok: true; modelRoutes: unknown[]; codexModels: CodexModelDiscoveryState }> {
    const codexModels = await this.engineFor(workspacePath).listCodexModels(true);
    return { ok: true, modelRoutes: buildModelRoutes(harnessDefaultsOf(getSettings()).model, [], [], codexModels.models), codexModels };
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

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const previous = getSettings();
    updateSettings(patch || {});
    this.deps.onSettingsChanged();
    if (typeof patch?.debugEnabled === "boolean" && patch.debugEnabled !== previous.debugEnabled) {
      this.deps.sessionManager.setDebugMode(patch.debugEnabled);
    }
    return getPublicSettings();
  }

  listAuthProviders(): ReturnType<typeof getAuthState> {
    return getAuthState();
  }

  setOpenRouterKey(key: string): ReturnType<typeof setOpenRouterKey> {
    const state = setOpenRouterKey(key || "");
    this.deps.onSettingsChanged();
    return state;
  }

  clearOpenRouterKey(): ReturnType<typeof clearOpenRouterKey> {
    const state = clearOpenRouterKey();
    this.deps.onSettingsChanged();
    return state;
  }

  testOpenRouterKey(): ReturnType<typeof testOpenRouterKey> {
    return testOpenRouterKey();
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
      // The window now serves a different workspace → refresh discovery files.
      this.deps.onWorkspacesChanged();
    }
    // Remember as the default workspace for newly opened windows.
    updateSettings({ workspacePath });
    return this.getState(workspacePath);
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

  // --- Party (scoped to a workspace) --------------------------------------
  listPartyMembers(workspacePath: string): Promise<ReturnType<PartyApplicationService["list"]>> {
    return this.engineFor(workspacePath).listParty();
  }

  createParty(workspacePath: string, input: CreatePartyInput): Promise<ReturnType<PartyApplicationService["createParty"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.createParty(input));
  }

  selectParty(workspacePath: string, partyId: string): Promise<ReturnType<PartyApplicationService["selectParty"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.selectParty(partyId));
  }

  removeParty(workspacePath: string, partyId: string): Promise<ReturnType<PartyApplicationService["removeParty"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.removeParty(partyId));
  }

  createPartyMember(workspacePath: string, input: CreateMemberInput): Promise<ReturnType<PartyApplicationService["createMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.createMember(input));
  }

  sendPartyMessage(workspacePath: string, name: string, content: string, from?: string, attachments?: ImageAttachment[]): Promise<ReturnType<PartyApplicationService["sendMessage"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.sendPartyMessage(name, content, from, attachments));
  }

  /** The shared "user sends a message to a member" path (UI Send button + HTTP). */
  sendMemberMessage(workspacePath: string, name: string, text: string, attachments?: ImageAttachment[]): Promise<ReturnType<PartyApplicationService["sendUserMessage"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.sendUserMessage(name, text, attachments));
  }

  async handlePartyAction(workspacePath: string, name: string, action: string, body: any): Promise<ReturnType<PartyApplicationService["sendMessage"]>> {
    const result = await this.engineFor(workspacePath).partyAction(name, action, body || {});
    await this.broadcastParty(workspacePath);
    return result;
  }

  closePartyMember(workspacePath: string, name: string): Promise<ReturnType<PartyApplicationService["closeMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.closeMember(name));
  }

  resumePartyMember(workspacePath: string, name: string): Promise<ReturnType<PartyApplicationService["resumeMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.resumeMember(name));
  }

  openPartyMember(workspacePath: string, name: string): Promise<ReturnType<PartyApplicationService["openMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.openMember(name));
  }

  startPartyMember(workspacePath: string, name: string, input?: StartPartyMemberInput): Promise<ReturnType<PartyApplicationService["startMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.startMember(name, input));
  }

  bindPartyMember(workspacePath: string, name: string, sessionId: string): Promise<ReturnType<PartyApplicationService["bindMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.bindMember(name, sessionId));
  }

  removePartyMember(workspacePath: string, name: string): Promise<ReturnType<PartyApplicationService["removeMember"]>> {
    return this.mutateParty(workspacePath, (engine) => engine.removeMember(name));
  }

  getMemberTranscript(workspacePath: string, name: string): Promise<unknown[]> {
    return this.engineFor(workspacePath).getMemberTranscript(name);
  }

  saveMemberTranscript(workspacePath: string, name: string, blocks: unknown[]): Promise<void> {
    return this.engineFor(workspacePath).saveMemberTranscript(name, blocks);
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
