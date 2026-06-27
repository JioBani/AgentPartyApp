import type { Readable, Writable } from "node:stream";
import type { CreateMemberInput, CreatePartyInput, CreateSessionInput, StartPartyMemberInput } from "../../../shared/types";
import type { EngineConnection, QaEmitInput, QaMemberSpec } from "../engineConnection";
import { readLines, writeLine, type RpcResponse } from "./rpc";

/** Awaited return type of an EngineConnection method. */
type Result<K extends keyof EngineConnection> = EngineConnection[K] extends (...args: any[]) => infer Ret ? Awaited<Ret> : never;

/**
 * Drives an engine running behind a transport (a child process / WSL distro)
 * as if it were local, fulfilling {@link AsyncEngineConnection}. Requests are
 * correlated to responses by id over the stream pair. See docs/WSL_REMOTE.md §7.
 */
export class RemoteEngineClient implements EngineConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly detach: () => void;

  constructor(input: Readable, private readonly output: Writable, readonly workspacePath: string) {
    this.detach = readLines(input, (message: RpcResponse) => {
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
  }

  /** Detaches and rejects anything in flight. */
  dispose(): void {
    this.detach();
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error("engine client disposed"));
    }
    this.pending.clear();
  }

  private call<T>(method: keyof EngineConnection, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      writeLine(this.output, { id, method: String(method), args });
    });
  }

  listParty() { return this.call<Result<"listParty">>("listParty"); }
  createParty(input: CreatePartyInput) { return this.call<Result<"createParty">>("createParty", input); }
  selectParty(partyId: string) { return this.call<Result<"selectParty">>("selectParty", partyId); }
  createMember(input: CreateMemberInput) { return this.call<Result<"createMember">>("createMember", input); }
  sendPartyMessage(name: string, content: string, from?: string) { return this.call<Result<"sendPartyMessage">>("sendPartyMessage", name, content, from); }
  closeMember(name: string) { return this.call<Result<"closeMember">>("closeMember", name); }
  resumeMember(name: string) { return this.call<Result<"resumeMember">>("resumeMember", name); }
  openMember(name: string) { return this.call<Result<"openMember">>("openMember", name); }
  startMember(name: string, input?: StartPartyMemberInput) { return this.call<Result<"startMember">>("startMember", name, input); }
  bindMember(name: string, sessionId: string) { return this.call<Result<"bindMember">>("bindMember", name, sessionId); }
  removeMember(name: string) { return this.call<Result<"removeMember">>("removeMember", name); }
  partyAction(name: string, action: string, body: any) { return this.call<Result<"partyAction">>("partyAction", name, action, body); }
  createSession(input?: CreateSessionInput | string) { return this.call<Result<"createSession">>("createSession", input); }
  listResumableSessions() { return this.call<Result<"listResumableSessions">>("listResumableSessions"); }
  resumeSession(sessionId: string) { return this.call<Result<"resumeSession">>("resumeSession", sessionId); }
  listWorkspaceSessions() { return this.call<Result<"listWorkspaceSessions">>("listWorkspaceSessions"); }
  qaSeed(input: { party?: string; members?: QaMemberSpec[] }) { return this.call<Result<"qaSeed">>("qaSeed", input); }
  qaCreateMockMember(spec: QaMemberSpec) { return this.call<Result<"qaCreateMockMember">>("qaCreateMockMember", spec); }
  qaEmit(name: string, body: QaEmitInput) { return this.call<Result<"qaEmit">>("qaEmit", name, body); }
  qaReset() { return this.call<Result<"qaReset">>("qaReset"); }
}
