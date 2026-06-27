import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow, NativeImage } from "electron";
import { buildModelRoutes } from "../../core/modelRegistry";
import type { AppSettings, CreateMemberInput, CreatePartyInput, CreateSessionInput, InitialAppState, StartPartyMemberInput } from "../../shared/types";
import { workspaceKey } from "../../shared/workspaceLocation";
import { clearOpenRouterKey, getAuthState, setOpenRouterKey, testOpenRouterKey } from "../authService";
import { harnesses } from "../harness/types";
import { getLogFilePath, log } from "../logger";
import { PartyApplicationService } from "./partyApplicationService";
import { getPublicSettings, getSettings, updateSettings } from "../settings";
import { isE2E } from "../runtimeMode";
import type { SessionManager } from "../sessionManager";
import type { WorkspaceManager } from "../workspaceManager";
import type { WindowInfo, WindowRegistry } from "../windowRegistry";

/** One mock member to seed for frontend QA. */
interface QaMemberSpec {
  name: string;
  role?: string;
  model?: string;
  effort?: string;
  status?: "working" | "idle" | "approval";
  autoReply?: boolean;
  blocks?: unknown[];
}

export interface AppControllerDeps {
  sessionManager: SessionManager;
  workspaceManager: WorkspaceManager;
  windowRegistry: WindowRegistry;
  getRouterBaseUrl: () => string;
  getAutomationBaseUrl: () => string;
  openWindow: (workspacePath: string) => Promise<WindowInfo>;
  onSettingsChanged: () => void;
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

  private party(workspacePath: string): PartyApplicationService {
    return this.deps.workspaceManager.context(workspacePath).party;
  }

  private broadcastParty(workspacePath: string): void {
    const payload = this.party(workspacePath).list();
    for (const entry of this.deps.windowRegistry.forWorkspace(workspacePath)) {
      entry.window.webContents.send("party:update", payload);
    }
  }

  private windowFor(windowId?: string): BrowserWindow | undefined {
    return this.deps.windowRegistry.resolve(windowId)?.window;
  }

  // --- Global state -------------------------------------------------------
  async getState(workspacePath: string): Promise<InitialAppState> {
    const settings = getSettings();
    return {
      ok: true,
      settings: { ...getPublicSettings(), workspacePath },
      auth: getAuthState(),
      sessions: this.sessionsForWorkspace(workspacePath),
      modelRoutes: buildModelRoutes(settings.claudeModel, [], []),
      harnesses,
      router: { baseUrl: this.deps.getRouterBaseUrl() },
      automationApi: {
        baseUrl: this.deps.getAutomationBaseUrl(),
        spec: `${this.deps.getAutomationBaseUrl()}/api/spec`,
      },
      logs: { logFilePath: getLogFilePath() },
      party: this.party(workspacePath).list(),
      windows: this.deps.windowRegistry.list(),
      ...(await this.getResumableState(workspacePath)),
    };
  }

  getLogs(): { logFilePath: string } {
    return { logFilePath: getLogFilePath() };
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
    }
    // Remember as the default workspace for newly opened windows.
    updateSettings({ workspacePath });
    return this.getState(workspacePath);
  }

  // --- Sessions (addressed globally by session id) ------------------------
  createSession(workspacePath: string, input?: CreateSessionInput | string): ReturnType<SessionManager["createSession"]> {
    return this.deps.sessionManager.createSession(this.withWorkspace(workspacePath, input));
  }

  listResumableSessions(workspacePath: string): ReturnType<SessionManager["listResumableSessions"]> {
    return this.deps.sessionManager.listResumableSessions(workspacePath);
  }

  resumeSession(workspacePath: string, sessionId: string): ReturnType<SessionManager["resumeSession"]> {
    return this.deps.sessionManager.resumeSession(sessionId, workspacePath);
  }

  closeSession(sessionId: string): { ok: boolean } {
    return { ok: this.deps.sessionManager.closeSession(sessionId) };
  }

  sendSessionMessage(sessionId: string, text: string): void {
    this.deps.sessionManager.sendUserTurn(sessionId, text);
  }

  handleSessionAction(sessionId: string, action: string, body: any): { ok: true } {
    const handler = this.sessionActions()[action];
    if (!handler) {
      throw new Error(`Unknown session action '${action}'.`);
    }
    handler(sessionId, body || {});
    return { ok: true };
  }

  interruptSession(sessionId: string): void {
    this.deps.sessionManager.interrupt(sessionId);
  }

  restartSession(sessionId: string): void {
    this.deps.sessionManager.restart(sessionId);
  }

  compactSession(sessionId: string): void {
    this.deps.sessionManager.compact(sessionId);
  }

  setSessionModel(sessionId: string, model: string, providerId?: string, runtimeModel?: string): void {
    this.deps.sessionManager.setModel(sessionId, model, providerId, runtimeModel);
  }

  setSessionEffort(sessionId: string, effort: string): void {
    this.deps.sessionManager.setEffort(sessionId, effort);
  }

  setSessionPermissionMode(sessionId: string, permissionMode: string): void {
    this.deps.sessionManager.setPermissionMode(sessionId, permissionMode);
  }

  approveSession(sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): void {
    this.deps.sessionManager.approve(sessionId, requestId, behavior, updatedInput, message);
  }

  // --- Party (scoped to a workspace) --------------------------------------
  listPartyMembers(workspacePath: string): ReturnType<PartyApplicationService["list"]> {
    return this.party(workspacePath).list();
  }

  createParty(workspacePath: string, input: CreatePartyInput): ReturnType<PartyApplicationService["createParty"]> {
    return this.mutateParty(workspacePath, (party) => party.createParty(input));
  }

  selectParty(workspacePath: string, partyId: string): ReturnType<PartyApplicationService["selectParty"]> {
    return this.mutateParty(workspacePath, (party) => party.selectParty(partyId));
  }

  createPartyMember(workspacePath: string, input: CreateMemberInput): ReturnType<PartyApplicationService["createMember"]> {
    return this.mutateParty(workspacePath, (party) => party.createMember(input));
  }

  sendPartyMessage(workspacePath: string, name: string, content: string, from?: string): ReturnType<PartyApplicationService["sendMessage"]> {
    return this.mutateParty(workspacePath, (party) => party.sendMessage(name, content, from));
  }

  handlePartyAction(workspacePath: string, name: string, action: string, body: any): ReturnType<PartyApplicationService["sendMessage"]> {
    const party = this.party(workspacePath);
    const handler = this.partyActions(party)[action];
    if (!handler) {
      throw new Error(`Unknown party action '${action}'.`);
    }
    const result = handler(name, body || {});
    this.broadcastParty(workspacePath);
    return result;
  }

  closePartyMember(workspacePath: string, name: string): ReturnType<PartyApplicationService["closeMember"]> {
    return this.mutateParty(workspacePath, (party) => party.closeMember(name));
  }

  resumePartyMember(workspacePath: string, name: string): ReturnType<PartyApplicationService["resumeMember"]> {
    return this.mutateParty(workspacePath, (party) => party.resumeMember(name));
  }

  openPartyMember(workspacePath: string, name: string): ReturnType<PartyApplicationService["openMember"]> {
    return this.mutateParty(workspacePath, (party) => party.openMember(name));
  }

  startPartyMember(workspacePath: string, name: string, input?: StartPartyMemberInput): ReturnType<PartyApplicationService["startMember"]> {
    return this.mutateParty(workspacePath, (party) => party.startMember(name, input));
  }

  bindPartyMember(workspacePath: string, name: string, sessionId: string): ReturnType<PartyApplicationService["bindMember"]> {
    return this.mutateParty(workspacePath, (party) => party.bindMember(name, sessionId));
  }

  removePartyMember(workspacePath: string, name: string): ReturnType<PartyApplicationService["removeMember"]> {
    return this.mutateParty(workspacePath, (party) => party.removeMember(name));
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

  qaSeed(workspacePath: string, input: { party?: string; members?: QaMemberSpec[] }): { ok: true; created: string[] } & ReturnType<PartyApplicationService["list"]> {
    this.requireQa();
    const party = this.party(workspacePath);
    const parties = party.list().parties;
    const existing = input.party ? parties.find((item) => item.name === input.party) : undefined;
    if (existing) {
      party.selectParty(existing.id);
    } else if (input.party || parties.length === 0) {
      party.createParty({ name: input.party || "QA Party" });
    }
    const created: string[] = [];
    for (const spec of input.members || []) {
      const sessionId = this.qaStartMockMember(party, spec);
      if (sessionId) {
        this.qaApplyBlocks(sessionId, spec.blocks);
        this.qaApplyStatus(sessionId, spec.status);
      }
      created.push(spec.name);
    }
    this.broadcastParty(workspacePath);
    return { ok: true, created, ...party.list() };
  }

  qaCreateMockMember(workspacePath: string, spec: QaMemberSpec): { ok: true; sessionId?: string } & ReturnType<PartyApplicationService["list"]> {
    this.requireQa();
    const party = this.party(workspacePath);
    const sessionId = this.qaStartMockMember(party, spec);
    if (sessionId) {
      this.qaApplyBlocks(sessionId, spec.blocks);
      this.qaApplyStatus(sessionId, spec.status);
    }
    this.broadcastParty(workspacePath);
    return { ok: true, sessionId, ...party.list() };
  }

  qaEmit(workspacePath: string, name: string, body: { events?: unknown[]; status?: "working" | "idle" | "approval" }): { ok: true } {
    this.requireQa();
    const sessionId = this.qaSessionIdFor(workspacePath, name);
    this.qaApplyBlocks(sessionId, body.events);
    this.qaApplyStatus(sessionId, body.status);
    return { ok: true };
  }

  qaOpen(windowId: string | undefined, panels: string[][]): { ok: true; panels: string[][] } {
    this.requireQa();
    this.windowFor(windowId)?.webContents.send("qa:layout", { panels });
    return { ok: true, panels };
  }

  qaReset(workspacePath: string): { ok: true } & ReturnType<PartyApplicationService["list"]> {
    this.requireQa();
    const party = this.party(workspacePath);
    for (const member of party.list().members) {
      if (member.name !== "main" && member.sessionId && this.deps.sessionManager.isMockSession(member.sessionId)) {
        party.removeMember(member.name);
      }
    }
    this.broadcastParty(workspacePath);
    return { ok: true, ...party.list() };
  }

  // --- internals ----------------------------------------------------------
  private mutateParty<T>(workspacePath: string, op: (party: PartyApplicationService) => T): T {
    const result = op(this.party(workspacePath));
    this.broadcastParty(workspacePath);
    return result;
  }

  private withWorkspace(workspacePath: string, input?: CreateSessionInput | string): CreateSessionInput {
    if (typeof input === "string" || !input) {
      return { workspacePath };
    }
    return { ...input, workspacePath: input.workspacePath || workspacePath };
  }

  private sessionsForWorkspace(workspacePath: string) {
    const key = workspaceKey(workspacePath);
    return this.deps.sessionManager.listSessions().filter((session) => workspaceKey(session.workspace) === key);
  }

  private qaStartMockMember(party: PartyApplicationService, spec: QaMemberSpec): string | undefined {
    if (!spec.name) {
      throw new Error("QA member requires a name.");
    }
    const exists = party.list().members.some((member) => member.name === spec.name);
    if (!exists) {
      party.createMember({
        name: spec.name,
        requirement: spec.role || `QA mock member ${spec.name}`,
        runtime: "claude-code",
        model: spec.model,
        effort: spec.effort,
      });
    }
    const result = party.startMember(
      spec.name,
      { model: spec.model, effort: spec.effort as StartPartyMemberInput["effort"] },
      { mock: true, autoReply: spec.autoReply ?? true },
    );
    return result.member?.sessionId || result.session?.id;
  }

  private qaApplyBlocks(sessionId: string | undefined, blocks?: unknown[]): void {
    if (!sessionId || !blocks) {
      return;
    }
    for (const event of blocks) {
      this.deps.sessionManager.injectMockEvent(sessionId, event);
    }
  }

  private qaApplyStatus(sessionId: string | undefined, status?: "working" | "idle" | "approval"): void {
    if (!sessionId || !status) {
      return;
    }
    this.deps.sessionManager.setMockStatus(sessionId, status === "working" ? "responding" : "idle");
  }

  private qaSessionIdFor(workspacePath: string, name: string): string {
    const member = this.party(workspacePath).list().members.find((item) => item.name === name);
    if (!member?.sessionId) {
      throw new Error(`Mock member '${name}' has no active session. Seed it first.`);
    }
    return member.sessionId;
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
    const result = await this.deps.sessionManager.listResumableSessions(workspacePath);
    return {
      resumableSessions: result.sessions,
      resumableSessionsError: result.error,
    };
  }

  private sessionActions(): Record<string, (sessionId: string, body: any) => void> {
    return {
      send: (sessionId, body) => this.deps.sessionManager.sendUserTurn(sessionId, String(body.text || "")),
      interrupt: (sessionId) => this.deps.sessionManager.interrupt(sessionId),
      close: (sessionId) => { this.deps.sessionManager.closeSession(sessionId); },
      restart: (sessionId) => this.deps.sessionManager.restart(sessionId),
      compact: (sessionId) => this.deps.sessionManager.compact(sessionId),
      model: (sessionId, body) => this.deps.sessionManager.setModel(sessionId, String(body.model || ""), body.providerId, body.runtimeModel),
      effort: (sessionId, body) => this.deps.sessionManager.setEffort(sessionId, String(body.effort || "")),
      permission: (sessionId, body) => this.deps.sessionManager.setPermissionMode(sessionId, String(body.permissionMode || "")),
      approve: (sessionId, body) => this.deps.sessionManager.approve(sessionId, String(body.requestId || ""), body.behavior, body.updatedInput, body.message),
    };
  }

  private partyActions(party: PartyApplicationService): Record<string, (name: string, body: any) => ReturnType<PartyApplicationService["sendMessage"]>> {
    return {
      send: (name, body) => party.sendMessage(name, String(body.content || ""), body.from),
      close: (name) => party.closeMember(name),
      resume: (name) => party.resumeMember(name),
      open: (name) => party.openMember(name),
      start: (name, body) => party.startMember(name, body),
      bind: (name, body) => party.bindMember(name, String(body.sessionId || "")),
      remove: (name) => party.removeMember(name),
    };
  }
}
