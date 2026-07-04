import type { Readable, Writable } from "node:stream";
import type { CreateMemberInput, CreatePartyInput, CreateSessionInput, StartPartyMemberInput } from "../../../shared/types";
import type { CodexPolicy } from "../../../shared/codexPolicy";
import type { ImageAttachment } from "../../../shared/attachments";
import type { McpAuthResult, McpServerSnapshot } from "../../../shared/mcp";
import type { EngineConnection, QaEmitInput, QaInteractionInput, QaMemberSpec } from "../engineConnection";
import { readLines, writeLine, type RpcResponse } from "./rpc";

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
 * resolves. See docs/WSL_REMOTE.md §7.
 */
export class RemoteEngineClient implements EngineConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly eventListeners = new Set<(channel: string, payload: unknown) => void>();
  private readonly transport: Promise<RemoteTransport>;
  private detach: (() => void) | undefined;
  private disposed = false;

  constructor(transport: RemoteTransport | Promise<RemoteTransport>, readonly workspacePath: string, private readonly onDispose?: () => void) {
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
        });
      },
      (error) => this.failAll(error instanceof Error ? error : new Error(String(error))),
    );
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

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();
  }

  private call<T>(method: keyof EngineConnection, ...args: unknown[]): Promise<T> {
    return this.transport.then(
      (t) =>
        new Promise<T>((resolve, reject) => {
          const id = this.nextId++;
          this.pending.set(id, { resolve, reject });
          writeLine(t.output, { id, method: String(method), args });
        }),
    );
  }

  listParty() { return this.call<Result<"listParty">>("listParty"); }
  createParty(input: CreatePartyInput) { return this.call<Result<"createParty">>("createParty", input); }
  selectParty(partyId: string) { return this.call<Result<"selectParty">>("selectParty", partyId); }
  removeParty(partyId: string) { return this.call<Result<"removeParty">>("removeParty", partyId); }
  createMember(input: CreateMemberInput) { return this.call<Result<"createMember">>("createMember", input); }
  sendPartyMessage(name: string, content: string, from?: string, attachments?: ImageAttachment[]) { return this.call<Result<"sendPartyMessage">>("sendPartyMessage", name, content, from, attachments); }
  sendUserMessage(name: string, text: string, attachments?: ImageAttachment[]) { return this.call<Result<"sendUserMessage">>("sendUserMessage", name, text, attachments); }
  closeMember(name: string) { return this.call<Result<"closeMember">>("closeMember", name); }
  resumeMember(name: string) { return this.call<Result<"resumeMember">>("resumeMember", name); }
  openMember(name: string) { return this.call<Result<"openMember">>("openMember", name); }
  startMember(name: string, input?: StartPartyMemberInput) { return this.call<Result<"startMember">>("startMember", name, input); }
  bindMember(name: string, sessionId: string) { return this.call<Result<"bindMember">>("bindMember", name, sessionId); }
  removeMember(name: string) { return this.call<Result<"removeMember">>("removeMember", name); }
  partyAction(name: string, action: string, body: any) { return this.call<Result<"partyAction">>("partyAction", name, action, body); }
  getMemberTranscript(name: string) { return this.call<Result<"getMemberTranscript">>("getMemberTranscript", name); }
  saveMemberTranscript(name: string, blocks: unknown[]) { return this.call<Result<"saveMemberTranscript">>("saveMemberTranscript", name, blocks); }
  listCodexModels(refresh?: boolean) { return this.call<Result<"listCodexModels">>("listCodexModels", refresh); }
  createSession(input?: CreateSessionInput | string) { return this.call<Result<"createSession">>("createSession", input); }
  listResumableSessions() { return this.call<Result<"listResumableSessions">>("listResumableSessions"); }
  resumeSession(sessionId: string) { return this.call<Result<"resumeSession">>("resumeSession", sessionId); }
  listWorkspaceSessions() { return this.call<Result<"listWorkspaceSessions">>("listWorkspaceSessions"); }
  sendUserTurn(sessionId: string, text: string, attachments?: ImageAttachment[]) { return this.call<void>("sendUserTurn", sessionId, text, attachments); }
  interruptSession(sessionId: string) { return this.call<void>("interruptSession", sessionId); }
  restartSession(sessionId: string) { return this.call<void>("restartSession", sessionId); }
  compactSession(sessionId: string) { return this.call<void>("compactSession", sessionId); }
  setSessionModel(sessionId: string, model: string, providerId?: string, runtimeModel?: string) { return this.call<void>("setSessionModel", sessionId, model, providerId, runtimeModel); }
  setSessionEffort(sessionId: string, effort: string) { return this.call<void>("setSessionEffort", sessionId, effort); }
  setSessionThinking(sessionId: string, mode: string, budget?: number) { return this.call<void>("setSessionThinking", sessionId, mode, budget); }
  setSessionPermissionMode(sessionId: string, permissionMode: string) { return this.call<void>("setSessionPermissionMode", sessionId, permissionMode); }
  setSessionCodexPolicy(sessionId: string, policy: CodexPolicy) { return this.call<void>("setSessionCodexPolicy", sessionId, policy); }
  approveSession(sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string) { return this.call<void>("approveSession", sessionId, requestId, behavior, updatedInput, message); }
  closeSession(sessionId: string) { return this.call<boolean>("closeSession", sessionId); }
  listSessionMcpServers(sessionId: string) { return this.call<McpServerSnapshot>("listSessionMcpServers", sessionId); }
  reconnectSessionMcpServer(sessionId: string, server: string) { return this.call<void>("reconnectSessionMcpServer", sessionId, server); }
  setSessionMcpServerEnabled(sessionId: string, server: string, enabled: boolean) { return this.call<void>("setSessionMcpServerEnabled", sessionId, server, enabled); }
  authenticateSessionMcpServer(sessionId: string, server: string) { return this.call<McpAuthResult>("authenticateSessionMcpServer", sessionId, server); }
  qaSeed(input: { party?: string; members?: QaMemberSpec[] }) { return this.call<Result<"qaSeed">>("qaSeed", input); }
  qaCreateMockMember(spec: QaMemberSpec) { return this.call<Result<"qaCreateMockMember">>("qaCreateMockMember", spec); }
  qaEmit(name: string, body: QaEmitInput) { return this.call<Result<"qaEmit">>("qaEmit", name, body); }
  qaInteraction(name: string, body: QaInteractionInput) { return this.call<Result<"qaInteraction">>("qaInteraction", name, body); }
  qaReset() { return this.call<Result<"qaReset">>("qaReset"); }
}
