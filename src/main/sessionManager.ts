import { EventEmitter } from "node:events";
import * as path from "node:path";
import { app } from "electron";
import { ClaudeAdapter } from "../core/claudeAdapter";
import { ClaudeNormalizedEvent, ClaudeSessionSnapshot } from "../core/events";
import { ModelRouteConfig } from "../core/modelRegistry";
import { EmbeddedRouter } from "../core/routerShim";
import { CreateSessionInput, ResumableSessionInfo, SessionView } from "../shared/types";
import { HarnessSession } from "./harness/types";
import { MockHarnessSession } from "./harness/mockHarness";
import { getSettings } from "./settings";

interface ManagedSession {
  id: string;
  workspace: string;
  adapter: HarnessSession;
  queuedEvents: ClaudeNormalizedEvent[];
  flushTimer?: NodeJS.Timeout;
  closed?: boolean;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();

  constructor(private readonly router: EmbeddedRouter) {
    super();
  }

  createSession(input?: string | CreateSessionInput, resumeSessionId?: string): SessionView {
    const settings = getSettings();
    const id = resumeSessionId ? `resume-${Date.now()}` : `session-${Date.now()}`;
    const request = normalizeCreateSessionInput(input);
    const workspace = request.workspacePath || settings.workspacePath || process.cwd();
    const adapter = this.createAdapter(id, workspace, resumeSessionId, request);
    return this.registerSession(id, workspace, adapter);
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
      model: request.model || settings.claudeModel,
      effort: request.effort || settings.claudeEffort,
      permissionMode: request.permissionMode || settings.claudePermissionMode,
      autoReply: options?.autoReply,
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
    const session: ManagedSession = { id, workspace, adapter, queuedEvents: [] };
    this.sessions.set(id, session);
    this.bind(session);
    adapter.start();
    this.emit("sessions", this.listSessions());
    return this.toView(session);
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

  sendUserTurn(id: string, text: string): void {
    this.sessions.get(id)?.adapter.sendUserTurn(text);
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
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

  setPermissionMode(id: string, permissionMode: string): void {
    this.sessions.get(id)?.adapter.setPermissionMode(permissionMode);
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
    for (const session of this.sessions.values()) {
      if (session.flushTimer) {
        clearTimeout(session.flushTimer);
      }
      session.adapter.dispose();
    }
    this.sessions.clear();
  }

  private createAdapter(id: string, cwd: string, resumeSessionId: string | undefined, request: CreateSessionInput): HarnessSession {
    const settings = getSettings();
    const storageDir = path.join(app.getPath("userData"), "logs");
    const routerAccountingKey = `agentparty-native-session:${id}`;
    return new ClaudeAdapter({
      id,
      cwd,
      executablePath: settings.claudeExecutablePath,
      model: request.model || settings.claudeModel,
      providerId: request.selectedProviderId || settings.selectedProviderId,
      effort: request.effort || settings.claudeEffort,
      permissionMode: request.permissionMode || settings.claudePermissionMode,
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
    });
  }

  private bind(session: ManagedSession): void {
    session.adapter.on("event", (event: ClaudeNormalizedEvent) => {
      if (session.closed || !this.sessions.has(session.id)) {
        return;
      }
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
