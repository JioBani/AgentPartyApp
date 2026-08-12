import type { Readable, Writable } from "node:stream";
import type { CreateMemberInput, CreatePartyInput, CreateSessionInput, StartPartyMemberInput, TranscriptSave } from "../../../shared/types";
import type { CodexPolicy } from "../../../shared/codexPolicy";
import type { CursorPolicy } from "../../../shared/cursorPolicy";
import type { ImageAttachment } from "../../../shared/attachments";
import type { QueueCommand } from "../../../shared/messageQueue";
import type { McpAuthResult, McpServerSnapshot } from "../../../shared/mcp";
import type { EngineConnection, QaEmitInput, QaInteractionInput, QaMemberSpec } from "../engineConnection";
import { readLines, writeLine, type RpcHostCall, type RpcResponse } from "./rpc";
import { log } from "../../logger";
import type { CodexAuthenticationUpdate } from "../../../shared/codexAuthentication";
import type { IdleSleepSettings } from "../../../shared/idleSleep";
import type { MemberMessagingSettings } from "../../../shared/memberMessaging";
import type { TokenUsageQuery, TokenUsageTurnsQuery } from "../../../shared/tokenUsage";

/** Awaited return type of an EngineConnection method. */
type Result<K extends keyof EngineConnection> = EngineConnection[K] extends (...args: any[]) => infer Ret ? Awaited<Ret> : never;

/** The stream pair the client talks over (a child process's stdio). */
export interface RemoteTransport {
  input: Readable;
  output: Writable;
}

/**
 * Drives an engine running behind a transport (a child process / WSL distro) as
 * if it were local, fulfilling {@link EngineConnection}. Requests correlate to
 * responses by id. The transport is supplied as a promise so the client can be
 * constructed synchronously (keeping EngineRegistry.forWorkspace sync) while the
 * distro spawn/handshake completes in the background — calls queue until it
 * resolves. See the WSL remote-engine design §7.
 */
export class RemoteEngineClient implements EngineConnection {
  /**
   * How long one engine RPC may stay unanswered before it is failed.
   *
   * This is only a backstop for an engine that is alive but wedged — an engine
   * that DIED is detected immediately by the transport-close handler below.
   * Deliberately generous: its job is to guarantee that every call terminates,
   * not to police latency.
   */
  private static readonly CALL_TIMEOUT_MS = 120_000;

  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly eventListeners = new Set<(channel: string, payload: unknown) => void>();
  private readonly transport: Promise<RemoteTransport>;
  private detach: (() => void) | undefined;
  private disposed = false;
  /**
   * Set once this client can never work again (transport gone, or disposed).
   * Later calls fail fast instead of queueing behind a peer that will never
   * answer — the difference between a reported error and an app that hangs.
   */
  private deadError: Error | undefined;

  constructor(
    transport: RemoteTransport | Promise<RemoteTransport>,
    readonly workspacePath: string,
    private readonly onDispose?: () => void,
    /**
     * Handlers for engine→desktop calls. The engine delegates work that only the
     * desktop host can do — reaching the subscription bridge / embedded router,
     * which bind desktop loopback and are unreachable from inside a distro.
     */
    private readonly hostHandlers: Record<string, (...args: any[]) => Promise<unknown>> = {},
    /**
     * Called when the transport dies on its own (not via {@link dispose}). The
     * owner uses it to drop this client so the next request builds a fresh
     * engine; without that, one dead engine poisons the workspace for the rest
     * of the app's life.
     */
    private readonly onTransportLost?: (error: Error) => void,
  ) {
    this.transport = Promise.resolve(transport);
    this.transport.then(
      (t) => {
        if (this.disposed) {
          return;
        }
        this.detach = readLines(t.input, (message: RpcResponse & { kind?: string; channel?: string; payload?: unknown }) => {
          if (message?.kind === "event" && typeof message.channel === "string") {
            for (const listener of this.eventListeners) {
              listener(message.channel, message.payload);
            }
            return;
          }
          if (message?.kind === "call") {
            void this.serveHostCall(t, message as unknown as RpcHostCall);
            return;
          }
          if (typeof message?.id !== "number") {
            return;
          }
          const waiter = this.pending.get(message.id);
          if (!waiter) {
            return;
          }
          this.pending.delete(message.id);
          if (message.ok) {
            waiter.resolve(message.result);
          } else {
            waiter.reject(new Error(message.error || "engine error"));
          }
        }, (error) => this.handleTransportLost(error));
      },
      (error) => this.failAll(error instanceof Error ? error : new Error(String(error))),
    );
  }

  /**
   * The engine process is gone. Every request waiting on it is unanswerable, so
   * fail them now and refuse new ones: a pending RPC that nothing could ever
   * settle is how a dead WSL engine turned each request into an indefinite hang
   * (`/api/health` among them) instead of a visible, recoverable error.
   */
  private handleTransportLost(error?: Error): void {
    if (this.disposed || this.deadError) {
      return;
    }
    const lost = error || new Error(`Engine for '${this.workspacePath}' exited.`);
    log("error", "engine", "remote engine transport closed", {
      workspace: this.workspacePath,
      pending: this.pending.size,
      error: lost.message,
    });
    this.failAll(lost);
    this.onTransportLost?.(lost);
  }

  /** Subscribe to pushed session events (session:events/snapshot/sessions). */
  onEvent(listener: (channel: string, payload: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Detaches and rejects anything in flight. */
  dispose(): void {
    this.disposed = true;
    this.detach?.();
    this.failAll(new Error("engine client disposed"));
    this.onDispose?.();
  }

  /**
   * Runs one engine→desktop call and always answers it. A handler that throws is
   * reported back as `ok:false` so the engine's caller sees a real error rather
   * than a promise that never settles.
   */
  private async serveHostCall(t: RemoteTransport, message: RpcHostCall): Promise<void> {
    const { id, method, args } = message;
    try {
      const handler = this.hostHandlers[method];
      if (!handler) {
        throw new Error(`Unknown host method '${method}'`);
      }
      const result = await handler(...(Array.isArray(args) ? args : []));
      writeLine(t.output, { kind: "callResult", id, ok: true, result });
    } catch (error) {
      writeLine(t.output, { kind: "callResult", id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private failAll(error: Error): void {
    this.deadError = error;
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();
  }

  private call<T>(method: keyof EngineConnection, ...args: unknown[]): Promise<T> {
    if (this.deadError) {
      return Promise.reject(this.deadError);
    }
    return this.transport.then(
      (t) =>
        new Promise<T>((resolve, reject) => {
          if (this.deadError) {
            reject(this.deadError);
            return;
          }
          const id = this.nextId++;
          // Bounded so an engine that is alive but wedged still terminates the
          // call. Cleared by whichever settles first; `unref` keeps a waiting
          // timer from holding the process open at quit.
          const timer = setTimeout(() => {
            if (!this.pending.delete(id)) {
              return;
            }
            const message = `Engine call '${String(method)}' for '${this.workspacePath}' got no response within ${RemoteEngineClient.CALL_TIMEOUT_MS}ms.`;
            log("error", "engine", "remote engine call timed out", { workspace: this.workspacePath, method: String(method) });
            reject(new Error(message));
          }, RemoteEngineClient.CALL_TIMEOUT_MS);
          timer.unref?.();
          this.pending.set(id, {
            resolve: (value) => { clearTimeout(timer); resolve(value); },
            reject: (error) => { clearTimeout(timer); reject(error); },
          });
          writeLine(t.output, { id, method: String(method), args });
        }),
    );
  }

  listParty(viewPartyId?: string) { return this.call<Result<"listParty">>("listParty", viewPartyId); }
  setIdleSleep(settings: IdleSleepSettings) { return this.call<Result<"setIdleSleep">>("setIdleSleep", settings); }
  setMemberMessaging(settings: MemberMessagingSettings) { return this.call<Result<"setMemberMessaging">>("setMemberMessaging", settings); }
  setCodexAuthentication(update: CodexAuthenticationUpdate) { return this.call<Result<"setCodexAuthentication">>("setCodexAuthentication", update); }
  createParty(input: CreatePartyInput) { return this.call<Result<"createParty">>("createParty", input); }
  selectParty(partyId: string) { return this.call<Result<"selectParty">>("selectParty", partyId); }
  removeParty(partyId: string) { return this.call<Result<"removeParty">>("removeParty", partyId); }
  setPartyGate(partyId: string | undefined, gate: unknown) { return this.call<Result<"setPartyGate">>("setPartyGate", partyId, gate); }
  createMember(input: CreateMemberInput) { return this.call<Result<"createMember">>("createMember", input); }
  sendPartyMessage(name: string, content: string, from?: string, attachments?: ImageAttachment[], partyId?: string, options?: { interrupt?: boolean; force?: boolean; forceReason?: string }) { return this.call<Result<"sendPartyMessage">>("sendPartyMessage", name, content, from, attachments, partyId, options); }
  invokePartyToolAs(member: string, tool: string, args: unknown, partyId?: string) { return this.call<Result<"invokePartyToolAs">>("invokePartyToolAs", member, tool, args, partyId); }
  sendUserMessage(name: string, text: string, attachments?: ImageAttachment[], partyId?: string, options?: { interrupt?: boolean }) { return this.call<Result<"sendUserMessage">>("sendUserMessage", name, text, attachments, partyId, options); }
  getMemberQueue(name: string, partyId?: string) { return this.call<Result<"getMemberQueue">>("getMemberQueue", name, partyId); }
  runQueueCommand(name: string, command: QueueCommand, partyId?: string) { return this.call<Result<"runQueueCommand">>("runQueueCommand", name, command, partyId); }
  closeMember(name: string, partyId?: string) { return this.call<Result<"closeMember">>("closeMember", name, partyId); }
  resumeMember(name: string, partyId?: string) { return this.call<Result<"resumeMember">>("resumeMember", name, partyId); }
  respawnMember(name: string, input?: StartPartyMemberInput, partyId?: string) { return this.call<Result<"respawnMember">>("respawnMember", name, input, partyId); }
  openMember(name: string, partyId?: string) { return this.call<Result<"openMember">>("openMember", name, partyId); }
  startMember(name: string, input?: StartPartyMemberInput, partyId?: string) { return this.call<Result<"startMember">>("startMember", name, input, partyId); }
  bindMember(name: string, sessionId: string, partyId?: string) { return this.call<Result<"bindMember">>("bindMember", name, sessionId, partyId); }
  removeMember(name: string, partyId?: string) { return this.call<Result<"removeMember">>("removeMember", name, partyId); }
  partyAction(name: string, action: string, body: any, partyId?: string) { return this.call<Result<"partyAction">>("partyAction", name, action, body, partyId); }
  getMemberTranscript(name: string, partyId?: string) { return this.call<Result<"getMemberTranscript">>("getMemberTranscript", name, partyId); }
  getTranscriptImage(file: string) { return this.call<Result<"getTranscriptImage">>("getTranscriptImage", file); }
  getHarnessOriginal(name: string, partyId?: string) { return this.call<Result<"getHarnessOriginal">>("getHarnessOriginal", name, partyId); }
  saveMemberTranscript(name: string, save: TranscriptSave, partyId?: string) { return this.call<Result<"saveMemberTranscript">>("saveMemberTranscript", name, save, partyId); }
  getPartyLayout(partyId?: string) { return this.call<Result<"getPartyLayout">>("getPartyLayout", partyId); }
  setPartyLayout(layout: unknown, partyId?: string) { return this.call<Result<"setPartyLayout">>("setPartyLayout", layout, partyId); }
  listCodexModels(refresh?: boolean) { return this.call<Result<"listCodexModels">>("listCodexModels", refresh); }
  getCursorStatus() { return this.call<Result<"getCursorStatus">>("getCursorStatus"); }
  createSession(input?: CreateSessionInput | string) { return this.call<Result<"createSession">>("createSession", input); }
  listResumableSessions() { return this.call<Result<"listResumableSessions">>("listResumableSessions"); }
  resumeSession(sessionId: string) { return this.call<Result<"resumeSession">>("resumeSession", sessionId); }
  listWorkspaceSessions() { return this.call<Result<"listWorkspaceSessions">>("listWorkspaceSessions"); }
  getTokenUsage(query: TokenUsageQuery) { return this.call<Result<"getTokenUsage">>("getTokenUsage", query); }
  getTokenUsageTurns(query: TokenUsageTurnsQuery) { return this.call<Result<"getTokenUsageTurns">>("getTokenUsageTurns", query); }
  sendUserTurn(sessionId: string, text: string, attachments?: ImageAttachment[]) { return this.call<void>("sendUserTurn", sessionId, text, attachments); }
  interruptSession(sessionId: string) { return this.call<void>("interruptSession", sessionId); }
  forceStopSession(sessionId: string) { return this.call<void>("forceStopSession", sessionId); }
  restartSession(sessionId: string) { return this.call<void>("restartSession", sessionId); }
  compactSession(sessionId: string) { return this.call<void>("compactSession", sessionId); }
  setSessionModel(sessionId: string, model: string, providerId?: string, runtimeModel?: string) { return this.call<void>("setSessionModel", sessionId, model, providerId, runtimeModel); }
  setSessionEffort(sessionId: string, effort: string) { return this.call<void>("setSessionEffort", sessionId, effort); }
  setSessionThinking(sessionId: string, mode: string, budget?: number) { return this.call<void>("setSessionThinking", sessionId, mode, budget); }
  setSessionPermissionMode(sessionId: string, permissionMode: string) { return this.call<void>("setSessionPermissionMode", sessionId, permissionMode); }
  setSessionCodexPolicy(sessionId: string, policy: CodexPolicy) { return this.call<void>("setSessionCodexPolicy", sessionId, policy); }
  setSessionCursorPolicy(sessionId: string, policy: CursorPolicy) { return this.call<void>("setSessionCursorPolicy", sessionId, policy); }
  approveSession(sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string) { return this.call<void>("approveSession", sessionId, requestId, behavior, updatedInput, message); }
  closeSession(sessionId: string) { return this.call<boolean>("closeSession", sessionId); }
  listSessionMcpServers(sessionId: string) { return this.call<McpServerSnapshot>("listSessionMcpServers", sessionId); }
  reconnectSessionMcpServer(sessionId: string, server: string) { return this.call<void>("reconnectSessionMcpServer", sessionId, server); }
  setSessionMcpServerEnabled(sessionId: string, server: string, enabled: boolean) { return this.call<void>("setSessionMcpServerEnabled", sessionId, server, enabled); }
  authenticateSessionMcpServer(sessionId: string, server: string) { return this.call<McpAuthResult>("authenticateSessionMcpServer", sessionId, server); }
  qaSeed(input: { party?: string; members?: QaMemberSpec[] }) { return this.call<Result<"qaSeed">>("qaSeed", input); }
  qaCreateMockMember(spec: QaMemberSpec) { return this.call<Result<"qaCreateMockMember">>("qaCreateMockMember", spec); }
  qaEmit(name: string, body: QaEmitInput) { return this.call<Result<"qaEmit">>("qaEmit", name, body); }
  qaEmitSubagents(name: string, scenario: string) { return this.call<Result<"qaEmitSubagents">>("qaEmitSubagents", name, scenario); }
  qaInteraction(name: string, body: QaInteractionInput) { return this.call<Result<"qaInteraction">>("qaInteraction", name, body); }
  qaDesignGallery() { return this.call<Result<"qaDesignGallery">>("qaDesignGallery"); }
  qaReset() { return this.call<Result<"qaReset">>("qaReset"); }
}
