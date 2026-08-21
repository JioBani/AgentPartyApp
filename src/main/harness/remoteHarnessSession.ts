import { EventEmitter } from "node:events";
import type { ClaudeNormalizedEvent, ClaudeSessionSnapshot } from "../../core/events";
import type { CodexPolicy } from "../../shared/codexPolicy";
import type { CursorPolicy } from "../../shared/cursorPolicy";
import type { ImageAttachment } from "../../shared/attachments";
import type { McpAuthResult, McpServerSnapshot } from "../../shared/mcp";
import type { CreateSessionInput, HostedPartySessionBinding } from "../../shared/types";
import type { EngineConnection } from "../engine/engineConnection";
import type { HarnessSession } from "./types";

export type RemoteEventSource = EngineConnection & {
  onEvent(listener: (channel: string, payload: unknown) => void): () => void;
};

export interface RemoteHarnessSessionOptions {
  id: string;
  cwd: string;
  request: CreateSessionInput;
  resumeSessionId?: string;
  binding: HostedPartySessionBinding;
  engine: RemoteEventSource;
}

/**
 * A HarnessSession facade whose provider process lives in another engine.
 *
 * SessionManager deliberately still owns the facade: this keeps the member's
 * party binding, queue, transcript, watchdog and UI session id on the party's
 * original host. The remote engine owns only the native harness process and
 * sends its normalized event/snapshot stream back over EngineConnection.
 */
export class RemoteHarnessSession extends EventEmitter implements HarnessSession {
  private readonly startedAt = new Date().toISOString();
  private snapshot: ClaudeSessionSnapshot;
  private remoteSessionId: string | undefined;
  private ready: Promise<string> | undefined;
  private disposed = false;
  private readonly pendingApprovals = new Set<string>();
  private readonly buffered: Array<{ channel: string; payload: unknown }> = [];
  private readonly detach: () => void;

  constructor(private readonly options: RemoteHarnessSessionOptions) {
    super();
    this.snapshot = {
      id: options.id,
      cwd: options.cwd,
      model: options.request.model || "",
      effort: options.request.effort || "medium",
      status: "starting",
      harnessAlive: true,
      startedAt: this.startedAt,
      debugMode: false,
      turnCount: 0,
      queuedTurnCount: 0,
    };
    this.detach = options.engine.onEvent((channel, payload) => this.accept(channel, payload));
  }

  start(): void {
    if (this.ready || this.disposed) {
      return;
    }
    // The execution engine's workspace is the remote cwd. The local SessionManager
    // already owns the original workspace identity and remaps every pushed event.
    const remoteInput: CreateSessionInput = {
      ...this.options.request,
      workspacePath: this.options.engine.workspacePath,
      cwd: this.options.cwd,
    };
    this.ready = this.options.engine.createHostedSession(
      remoteInput,
      this.options.resumeSessionId,
      this.options.binding,
    ).then((view) => {
      if (this.disposed) {
        void this.options.engine.closeSession(view.id).catch(() => undefined);
        return view.id;
      }
      this.remoteSessionId = view.id;
      this.applySnapshot(view.snapshot);
      const queued = this.buffered.splice(0);
      for (const item of queued) {
        this.accept(item.channel, item.payload);
      }
      return view.id;
    }).catch((error) => {
      this.reportError(error, true);
      throw error;
    });
  }

  sendUserTurn(text: string, attachments?: ImageAttachment[]): void {
    this.run((id) => this.options.engine.sendUserTurn(id, text, attachments));
  }

  interrupt(): void { this.run((id) => this.options.engine.interruptSession(id)); }
  forceStop(): void { this.run((id) => this.options.engine.forceStopSession(id)); }
  restart(): void { this.run((id) => this.options.engine.restartSession(id)); }
  compact(): void { this.run((id) => this.options.engine.compactSession(id)); }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detach();
    const close = this.remoteSessionId
      ? Promise.resolve(this.remoteSessionId)
      : this.ready;
    if (close) {
      void close.then((id) => this.options.engine.closeSession(id)).catch(() => undefined);
    }
  }

  getSnapshot(): ClaudeSessionSnapshot { return { ...this.snapshot }; }

  setDebugMode(enabled: boolean): void {
    this.run((id) => this.options.engine.setSessionDebugMode(id, enabled));
  }

  setModel(model: string, providerId?: string, runtimeModel?: string): void {
    this.run((id) => this.options.engine.setSessionModel(id, model, providerId, runtimeModel));
  }
  setEffort(effort: string): void { this.run((id) => this.options.engine.setSessionEffort(id, effort)); }
  setThinking(mode: string, budget?: number): void { this.run((id) => this.options.engine.setSessionThinking(id, mode, budget)); }
  setPermissionMode(permissionMode: string): void { this.run((id) => this.options.engine.setSessionPermissionMode(id, permissionMode)); }
  setCodexPolicy(policy: CodexPolicy): void { this.run((id) => this.options.engine.setSessionCodexPolicy(id, policy)); }
  setCursorPolicy(policy: CursorPolicy): void { this.run((id) => this.options.engine.setSessionCursorPolicy(id, policy)); }

  listMcpServers(): Promise<McpServerSnapshot> {
    return this.requireReady().then((id) => this.options.engine.listSessionMcpServers(id));
  }
  reconnectMcpServer(name: string): Promise<void> {
    return this.requireReady().then((id) => this.options.engine.reconnectSessionMcpServer(id, name));
  }
  setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
    return this.requireReady().then((id) => this.options.engine.setSessionMcpServerEnabled(id, name, enabled));
  }
  authenticateMcpServer(name: string): Promise<McpAuthResult> {
    return this.requireReady().then((id) => this.options.engine.authenticateSessionMcpServer(id, name));
  }

  respondApproval(requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): boolean {
    if (!this.pendingApprovals.delete(requestId)) {
      return false;
    }
    void this.requireReady()
      .then((id) => this.options.engine.approveSession(id, requestId, behavior, updatedInput, message))
      .then((delivery) => {
        if (delivery !== "delivered") {
          this.reportError(new Error(`Remote approval '${requestId}' was ${delivery}.`), false);
        }
      })
      .catch((error) => this.reportError(error, false));
    return true;
  }

  private requireReady(): Promise<string> {
    if (!this.ready) {
      return Promise.reject(new Error("Remote harness session has not started."));
    }
    return this.ready;
  }

  private run(operation: (id: string) => Promise<unknown>): void {
    void this.requireReady().then(operation).catch((error) => this.reportError(error, false));
  }

  private accept(channel: string, payload: unknown): void {
    if (channel === "engine:lost") {
      const message = (payload as { error?: unknown } | undefined)?.error;
      this.reportError(new Error(typeof message === "string" ? message : "Remote execution engine stopped."), true);
      return;
    }
    const envelope = payload as { sessionId?: unknown; events?: unknown; snapshot?: unknown } | undefined;
    const sessionId = typeof envelope?.sessionId === "string" ? envelope.sessionId : undefined;
    if (!this.remoteSessionId) {
      // createHostedSession starts the adapter before its RPC response can reach
      // us, so synchronous startup events legitimately arrive first.
      if (sessionId && this.buffered.length < 200) {
        this.buffered.push({ channel, payload });
      }
      return;
    }
    if (sessionId !== this.remoteSessionId) {
      return;
    }
    if (channel === "session:events") {
      const events = Array.isArray(envelope?.events) ? envelope.events as ClaudeNormalizedEvent[] : [];
      for (const event of events) {
        if (event.type === "approval_request" && typeof event.requestId === "string") {
          this.pendingApprovals.add(event.requestId);
        } else if (event.type === "approval_resolved" && typeof event.requestId === "string") {
          this.pendingApprovals.delete(event.requestId);
        }
        this.emit("event", event);
      }
    } else if (channel === "session:snapshot" && envelope?.snapshot) {
      this.applySnapshot(envelope.snapshot as ClaudeSessionSnapshot);
    }
  }

  private applySnapshot(snapshot: ClaudeSessionSnapshot): void {
    this.snapshot = {
      ...snapshot,
      // The facade's id/cwd are the stable local facts. A remote engine is free
      // to use its own app-session id, but exposing it would break local member
      // bindings and transcript routing.
      id: this.options.id,
      cwd: this.options.cwd,
    };
    this.emit("snapshot", this.getSnapshot());
  }

  private reportError(error: unknown, fatal: boolean): void {
    if (this.disposed) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.snapshot = {
      ...this.snapshot,
      status: "error",
      harnessAlive: fatal ? false : this.snapshot.harnessAlive,
      lastError: message,
      lastEventAt: new Date().toISOString(),
    };
    this.emit("event", { type: "error", message, at: new Date().toISOString() } satisfies ClaudeNormalizedEvent);
    this.emit("snapshot", this.getSnapshot());
  }
}
