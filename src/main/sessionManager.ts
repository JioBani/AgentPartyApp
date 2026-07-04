import { EventEmitter } from "node:events";
import * as path from "node:path";
import { ClaudeAdapter } from "../core/claudeAdapter";
import { CodexAdapter } from "../core/codexAdapter";
import type { PartyBridge, PartyIdentity } from "../core/partyBridge";
import { ClaudeNormalizedEvent, ClaudeSessionSnapshot } from "../core/events";
import { ModelRouteConfig, inferModelProvider } from "../core/modelRegistry";
import { discoverCodexModels } from "../core/codexModelDiscovery";
import { EmbeddedRouter } from "../core/routerShim";
import { CreateSessionInput, ResumableSessionInfo, SessionView, harnessDefaultsOf } from "../shared/types";
import type { CodexModelDiscoveryState } from "../shared/codexModels";
import { CODEX_MODELS_PENDING } from "../shared/codexModels";
import type { CodexPolicy } from "../shared/codexPolicy";
import type { ImageAttachment } from "../shared/attachments";
import type { McpAuthResult, McpServerSnapshot } from "../shared/mcp";
import { HarnessSession } from "./harness/types";
import { MockHarnessSession } from "./harness/mockHarness";
import { isE2E } from "./runtimeMode";
import { getSettings } from "./settings";

interface ManagedSession {
  id: string;
  workspace: string;
  adapter: HarnessSession;
  queuedEvents: ClaudeNormalizedEvent[];
  flushTimer?: NodeJS.Timeout;
  closed?: boolean;
  /** Stall watchdog bookkeeping (harness-general; see {@link SessionManager.scanForStalls}). */
  lastActivityAt: number;
  turnActive: boolean;
  awaitingUser: boolean;
  stallNotified: boolean;
}

/** Pairs a party member's bridge with its identity for in-process tool access. */
export interface SessionPartyBinding {
  bridge: PartyBridge;
  identity: PartyIdentity;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private codexModels: CodexModelDiscoveryState = CODEX_MODELS_PENDING;
  private codexDiscovery: Promise<CodexModelDiscoveryState> | undefined;
  /**
   * Stall watchdog: a turn that goes silent for this long (no event of any kind
   * from the harness, and not waiting on the user for an approval) is flagged so
   * the UI stops showing an indefinite "responding" spinner. A warning, never an
   * auto-kill — the model may just be slow — so the user decides (wait / stop /
   * restart). Harness-general: it observes the normalized event stream every
   * adapter emits, so a new harness needs no watchdog code of its own.
   */
  private static readonly STALL_MS = 120_000;
  private static readonly WATCHDOG_INTERVAL_MS = 20_000;
  private watchdog: NodeJS.Timeout | undefined;

  /**
   * @param userDataDir base dir for harness debug logs (Electron's userData on
   *   the desktop; an engine-chosen dir when running headless, e.g. in WSL).
   *   Injected rather than read from `electron.app` so the engine core runs
   *   under plain node. See docs/WSL_REMOTE.md.
   */
  constructor(private readonly router: EmbeddedRouter, private readonly userDataDir: string) {
    super();
  }

  createSession(input?: string | CreateSessionInput, resumeSessionId?: string, binding?: SessionPartyBinding): SessionView {
    const settings = getSettings();
    const id = resumeSessionId ? `resume-${Date.now()}` : `session-${Date.now()}`;
    const request = normalizeCreateSessionInput(input);
    const workspace = request.workspacePath || settings.workspacePath || process.cwd();
    const adapter = this.createAdapter(id, workspace, resumeSessionId, request, binding);
    return this.registerSession(id, workspace, adapter);
  }

  /**
   * Signals that a workspace's party state changed out-of-band (e.g. a member
   * drove a party tool). Re-broadcast by the main process; see
   * docs/PARTY_COMMUNICATION.md §8.
   */
  notifyPartyChanged(workspace: string): void {
    this.emit("party", { workspace });
  }

  /**
   * Snapshot of the live Codex account catalog (`model/list`); kicks discovery
   * on first call and caches the settle for the process lifetime. `refresh`
   * re-runs discovery and awaits the fresh result. A settle (ready or error)
   * emits `"codex-models"` so the app can push updated model routes to windows —
   * a failure stays visible in the state, never silently reverts the UI.
   */
  getCodexModelState(): CodexModelDiscoveryState {
    if (!this.codexDiscovery) {
      // E2E must not reach user-owned provider APIs; discovery only runs when
      // the test supplies a fake codex binary. The skip is stated, not silent.
      if (isE2E() && !process.env.AGENTPARTY_CODEX_BIN) {
        this.codexModels = {
          status: "error",
          models: [],
          error: "Codex model discovery is disabled in E2E mode without an AGENTPARTY_CODEX_BIN override.",
          at: new Date().toISOString(),
        };
        this.codexDiscovery = Promise.resolve(this.codexModels);
      } else {
        this.codexDiscovery = this.runCodexDiscovery();
      }
    }
    return this.codexModels;
  }

  async refreshCodexModels(): Promise<CodexModelDiscoveryState> {
    this.codexDiscovery = this.runCodexDiscovery();
    return this.codexDiscovery;
  }

  private async runCodexDiscovery(): Promise<CodexModelDiscoveryState> {
    try {
      const models = await discoverCodexModels({ cwd: this.userDataDir });
      this.codexModels = { status: "ready", models, at: new Date().toISOString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.codexModels = { status: "error", models: [], error: message, at: new Date().toISOString() };
    }
    this.emit("codex-models", this.codexModels);
    return this.codexModels;
  }

  /**
   * Creates a QA mock session backed by {@link MockHarnessSession}. It performs
   * no model calls; events are driven by the QA API. Used only in QA mode.
   */
  createMockSession(input?: string | CreateSessionInput, options?: { autoReply?: boolean }): SessionView {
    const settings = getSettings();
    const id = `mock-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const request = normalizeCreateSessionInput(input);
    const workspace = request.workspacePath || settings.workspacePath || process.cwd();
    const adapter = new MockHarnessSession({
      id,
      cwd: workspace,
      model: request.model || harnessDefaultsOf(settings).model,
      effort: request.effort || harnessDefaultsOf(settings).effort,
      permissionMode: request.permissionMode || harnessDefaultsOf(settings).permissionMode || "default",
      autoReply: options?.autoReply,
      harness: request.selectedHarnessId || settings.selectedHarnessId,
    });
    return this.registerSession(id, workspace, adapter);
  }

  injectMockEvent(id: string, event: unknown): void {
    const adapter = this.mockAdapter(id);
    adapter.inject(event as any);
  }

  setMockStatus(id: string, status: string): void {
    this.mockAdapter(id).setStatus(status);
  }

  isMockSession(id: string): boolean {
    return this.sessions.get(id)?.adapter instanceof MockHarnessSession;
  }

  private mockAdapter(id: string): MockHarnessSession {
    const session = this.sessions.get(id);
    if (!session || !(session.adapter instanceof MockHarnessSession)) {
      throw new Error(`Session '${id}' is not a mock session.`);
    }
    return session.adapter;
  }

  private registerSession(id: string, workspace: string, adapter: HarnessSession): SessionView {
    const session: ManagedSession = { id, workspace, adapter, queuedEvents: [], lastActivityAt: Date.now(), turnActive: false, awaitingUser: false, stallNotified: false };
    this.sessions.set(id, session);
    this.bind(session);
    this.ensureWatchdog();
    adapter.start();
    this.emit("sessions", this.listSessions());
    return this.toView(session);
  }

  private ensureWatchdog(): void {
    if (this.watchdog) {
      return;
    }
    this.watchdog = setInterval(() => this.scanForStalls(), SessionManager.WATCHDOG_INTERVAL_MS);
    // Never keep the process alive on the watchdog alone.
    this.watchdog.unref?.();
  }

  /**
   * Tracks per-turn liveness from the normalized event stream so the watchdog can
   * tell "still generating" from "hung". Any real event re-arms the alarm; a turn
   * that is waiting on the user (approval) is intentionally not treated as stalled.
   */
  private trackTurnActivity(session: ManagedSession, event: ClaudeNormalizedEvent): void {
    session.lastActivityAt = Date.now();
    session.stallNotified = false;
    switch (event.type) {
      case "turn_complete":
      case "error":
        session.turnActive = false;
        session.awaitingUser = false;
        break;
      case "approval_request":
        session.turnActive = true;
        session.awaitingUser = true;
        break;
      case "approval_resolved":
        session.awaitingUser = false;
        break;
      case "status": {
        const status = String((event as { status?: unknown }).status || "");
        if (status === "sent" || status === "requesting" || status === "responding") {
          session.turnActive = true;
        }
        break;
      }
      default:
        break;
    }
  }

  /** Flags any active turn that has gone silent past the stall threshold (once). */
  private scanForStalls(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.closed || !session.turnActive || session.awaitingUser || session.stallNotified) {
        continue;
      }
      const idleMs = now - session.lastActivityAt;
      if (idleMs < SessionManager.STALL_MS) {
        continue;
      }
      session.stallNotified = true;
      const seconds = Math.round(idleMs / 1000);
      const event: ClaudeNormalizedEvent = {
        type: "diagnostic",
        severity: "warning",
        category: "stall",
        title: "응답이 멈춘 것 같습니다",
        detail: `${seconds}초 동안 하네스에서 아무 응답이 없습니다. 모델이 도구 호출 등에서 실패했거나 멈췄을 수 있습니다(모델이 느린 것일 수도 있습니다).`,
        recovery: "계속 기다리거나, 정지 후 다시 시도하거나, 세션을 재시작하세요.",
        at: new Date().toISOString(),
      };
      // Route through the normal event pipeline (not trackTurnActivity) so the
      // renderer shows it and the flag is not immediately re-armed.
      this.queueEvent(session, event);
      this.flushEvents(session);
      this.emit("sessions", this.listSessions());
    }
  }

  async listResumableSessions(workspacePath?: string): Promise<{ sessions: ResumableSessionInfo[]; error?: string }> {
    try {
      const sdk = await loadClaudeSdk();
      const sessions = await sdk.listSessions({ dir: workspacePath || getSettings().workspacePath, limit: 40 });
      return { sessions: sessions.map((session: any) => ({
        sessionId: String(session.sessionId || session.session_id || ""),
        customTitle: session.customTitle,
        summary: session.summary,
        firstPrompt: session.firstPrompt,
        lastModified: session.lastModified ? new Date(session.lastModified).toISOString() : undefined,
        gitBranch: session.gitBranch,
      })) };
    } catch (error) {
      return { sessions: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  resumeSession(sessionId: string, workspacePath?: string): SessionView {
    return this.createSession({ workspacePath }, sessionId);
  }

  sendUserTurn(id: string, text: string, attachments?: ImageAttachment[]): void {
    this.sessions.get(id)?.adapter.sendUserTurn(text, attachments);
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * The live harness thread id (Claude/Codex) for an app session — but only once
   * a turn has committed. A zero-turn session is not yet persisted by the harness,
   * so storing its id and resuming it later fails with "No conversation found".
   * Gating on turnCount is the root-cause prevention; the adapter's
   * resume-not-found recovery covers the residual cases (cross-run GC, expiry).
   */
  harnessSessionId(id: string): string | undefined {
    const snapshot = this.sessions.get(id)?.adapter.getSnapshot();
    if (!snapshot?.sessionId || !(snapshot.turnCount && snapshot.turnCount > 0)) {
      return undefined;
    }
    return snapshot.sessionId;
  }

  interrupt(id: string): void {
    this.sessions.get(id)?.adapter.interrupt();
  }

  restart(id: string): void {
    const existing = this.sessions.get(id);
    if (!existing) {
      return;
    }
    existing.adapter.restart();
  }

  compact(id: string): void {
    this.sessions.get(id)?.adapter.compact();
  }

  closeSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
    }
    session.closed = true;
    session.adapter.dispose();
    this.sessions.delete(id);
    this.emit("sessions", this.listSessions());
    return true;
  }

  setModel(id: string, model: string, providerId?: string, runtimeModel?: string): void {
    this.sessions.get(id)?.adapter.setModel(model, providerId as any, runtimeModel);
  }

  setEffort(id: string, effort: string): void {
    this.sessions.get(id)?.adapter.setEffort(effort as any);
  }

  setThinking(id: string, mode: string, budget?: number): void {
    this.sessions.get(id)?.adapter.setThinking(mode, budget);
  }

  setPermissionMode(id: string, permissionMode: string): void {
    this.sessions.get(id)?.adapter.setPermissionMode(permissionMode);
  }

  setCodexPolicy(id: string, policy: CodexPolicy): void {
    const adapter = this.sessions.get(id)?.adapter;
    if (!adapter?.setCodexPolicy) {
      throw new Error(`Session '${id}' does not support a Codex policy (not a Codex harness).`);
    }
    adapter.setCodexPolicy(policy);
  }

  // --- MCP (external servers a member connects to as a client) -------------
  private requireAdapter(id: string): HarnessSession {
    const adapter = this.sessions.get(id)?.adapter;
    if (!adapter) {
      throw new Error(`Session '${id}' not found.`);
    }
    return adapter;
  }

  listMcpServers(id: string): Promise<McpServerSnapshot> {
    const adapter = this.requireAdapter(id);
    if (!adapter.listMcpServers) {
      throw new Error(`Session '${id}' does not expose MCP status.`);
    }
    return adapter.listMcpServers();
  }

  reconnectMcpServer(id: string, name: string): Promise<void> {
    const adapter = this.requireAdapter(id);
    if (!adapter.reconnectMcpServer) {
      throw new Error(`Session '${id}' does not support reconnecting an MCP server.`);
    }
    return adapter.reconnectMcpServer(name);
  }

  setMcpServerEnabled(id: string, name: string, enabled: boolean): Promise<void> {
    const adapter = this.requireAdapter(id);
    if (!adapter.setMcpServerEnabled) {
      throw new Error(`Session '${id}' does not support enabling/disabling an MCP server (config-file driven on this harness).`);
    }
    return adapter.setMcpServerEnabled(name, enabled);
  }

  authenticateMcpServer(id: string, name: string): Promise<McpAuthResult> {
    const adapter = this.requireAdapter(id);
    if (!adapter.authenticateMcpServer) {
      throw new Error(`Session '${id}' does not support MCP OAuth here — authenticate via the interactive client.`);
    }
    return adapter.authenticateMcpServer(name);
  }

  setDebugMode(enabled: boolean): void {
    for (const session of this.sessions.values()) {
      session.adapter.setDebugMode(enabled);
    }
    this.emit("sessions", this.listSessions());
  }

  approve(id: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): void {
    this.sessions.get(id)?.adapter.respondApproval(requestId, behavior, updatedInput, message);
  }

  listSessions(): SessionView[] {
    return Array.from(this.sessions.values()).map((session) => this.toView(session));
  }

  dispose(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    for (const session of this.sessions.values()) {
      if (session.flushTimer) {
        clearTimeout(session.flushTimer);
      }
      session.adapter.dispose();
    }
    this.sessions.clear();
  }

  private createAdapter(id: string, cwd: string, resumeSessionId: string | undefined, request: CreateSessionInput, binding?: SessionPartyBinding): HarnessSession {
    const settings = getSettings();
    const harnessId = request.selectedHarnessId || settings.selectedHarnessId;
    const harnessDefaults = harnessDefaultsOf(settings, harnessId);
    if (harnessId === "codex") {
      return new CodexAdapter({
        id,
        cwd,
        model: request.model || harnessDefaults.model,
        effort: request.effort || harnessDefaults.effort,
        permissionMode: request.permissionMode || harnessDefaults.permissionMode,
        policy: request.codexPolicy || harnessDefaults.codexPolicy,
        debugEnabled: settings.debugEnabled,
        resumeSessionId,
        partyIdentity: binding?.identity,
        // Enables Codex→OpenRouter routing for OpenRouter-slug models; absent =
        // account catalog (openai) only. See codexProviders.ts.
        openRouterApiKey: settings.openRouterApiKey || process.env.OPENROUTER_API_KEY || undefined,
      });
    }
    const storageDir = path.join(this.userDataDir, "logs");
    const routerAccountingKey = `agentparty-native-session:${id}`;
    const model = request.model || harnessDefaults.model;
    return new ClaudeAdapter({
      id,
      cwd,
      executablePath: settings.claudeExecutablePath,
      model,
      providerId: request.selectedProviderId || inferModelProvider(model),
      effort: request.effort || harnessDefaults.effort,
      thinking: request.thinking,
      thinkingBudget: request.thinkingBudget,
      permissionMode: request.permissionMode || harnessDefaults.permissionMode,
      safeMode: settings.claudeSafeMode,
      debugEnabled: settings.debugEnabled,
      storageDir,
      customModelRoutes: [] as ModelRouteConfig[],
      routerBaseUrl: this.router.baseUrl || settings.routerBaseUrl,
      routerAuthToken: routerAccountingKey,
      routerAccountingKey,
      resetRouterTurnUsage: (accountingKey) => this.router.resetTurnUsage(accountingKey),
      consumeRouterTurnUsage: (accountingKey) => this.router.consumeTurnUsage(accountingKey),
      resumeSessionId,
      partyBridge: binding?.bridge,
      partyIdentity: binding?.identity,
    });
  }

  private bind(session: ManagedSession): void {
    session.adapter.on("event", (event: ClaudeNormalizedEvent) => {
      if (session.closed || !this.sessions.has(session.id)) {
        return;
      }
      this.trackTurnActivity(session, event);
      this.queueEvent(session, event);
      if (event.type === "session" || event.type === "turn_complete" || event.type === "error" || event.type === "status") {
        this.emit("sessions", this.listSessions());
      }
    });
    session.adapter.on("snapshot", (snapshot: ClaudeSessionSnapshot) => {
      if (session.closed || !this.sessions.has(session.id)) {
        return;
      }
      this.emit("snapshot", { sessionId: session.id, workspace: session.workspace, snapshot });
      this.emit("sessions", this.listSessions());
    });
  }

  private queueEvent(session: ManagedSession, event: ClaudeNormalizedEvent): void {
    session.queuedEvents.push(event);
    if (event.type === "turn_complete" || event.type === "error" || event.type === "approval_request") {
      this.flushEvents(session);
      return;
    }
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => this.flushEvents(session), 33);
    }
  }

  private flushEvents(session: ManagedSession): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = undefined;
    }
    if (!session.queuedEvents.length) {
      return;
    }
    const events = compactEvents(session.queuedEvents);
    session.queuedEvents = [];
    this.emit("events", { sessionId: session.id, workspace: session.workspace, events });
  }

  private toView(session: ManagedSession): SessionView {
    const snapshot = session.adapter.getSnapshot();
    return {
      id: session.id,
      title: snapshot.model || "Claude Code",
      workspace: session.workspace,
      snapshot,
    };
  }
}

function normalizeCreateSessionInput(input?: string | CreateSessionInput): CreateSessionInput {
  if (!input) {
    return {};
  }
  if (typeof input === "string") {
    return { workspacePath: input };
  }
  return input;
}

async function loadClaudeSdk(): Promise<typeof import("@anthropic-ai/claude-agent-sdk")> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof import("@anthropic-ai/claude-agent-sdk")>;
  return await dynamicImport("@anthropic-ai/claude-agent-sdk");
}

function compactEvents(events: ClaudeNormalizedEvent[]): ClaudeNormalizedEvent[] {
  const compacted: ClaudeNormalizedEvent[] = [];
  for (const event of events) {
    const previous = compacted[compacted.length - 1];
    if (
      previous?.type === event.type
      && (event.type === "assistant_text_delta" || event.type === "reasoning_delta")
      && previous.type === event.type
      && previous.blockIndex === event.blockIndex
    ) {
      previous.text += event.text;
      previous.at = event.at;
      continue;
    }
    compacted.push(event);
  }
  return compacted;
}
