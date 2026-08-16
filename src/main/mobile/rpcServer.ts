import {
  METHOD_NOT_FOUND,
  PROTOCOL_VERSION,
  RPC_TIMEOUT_MS,
  RESERVED_METHODS,
  PushRegisterParamsSchema,
  decodeRpcEnvelope,
  errResponse,
  isReservedMethod,
  okResponse,
  type RpcEnvelope,
  type RpcEvent,
  type RpcRequest,
} from "@agentparty/protocol";
import { WORKSPACE_PARAM_FIELD } from "../../shared/mobileProtocol";
import { ChunkAssembler, needsChunking, splitEnvelope } from "./chunking";
import type { EventBridge } from "./eventBridge";
import type { MobileGatewayDeps } from "./index";
import type { MobileRequestHandler, MobileSnapshotProvider, RequestContext } from "./mobileGateway";

/**
 * Envelope handling for one phone session (01 §5).
 *
 * The pipe does not know what any `m` means. It decodes the envelope, applies
 * the response deadline, routes control commands, and hands `params` to
 * whatever the app registered. An unknown method comes back as
 * `method_not_found` rather than being dropped, so the phone always learns the
 * outcome of every request it sent.
 */

export interface RpcSessionLink {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  transport: "lanDirect" | "directViaRendezvous" | "userRelay";
  /** Encrypts and sends one envelope. */
  send(envelope: unknown): void;
  /** Ends the session; the phone reconnects and rewinds. */
  close(reason: string): void;
}

export interface RpcServerDeps {
  link: RpcSessionLink;
  eventBridge: EventBridge;
  handlers: () => ReadonlyMap<string, MobileRequestHandler>;
  snapshotProvider: () => MobileSnapshotProvider | undefined;
  /** Reported by `sys.info`. */
  appName: string;
  appVersion: string;
  /** Stores a push handle when the phone registers one (01 §7). */
  registerPush: (deviceId: string, platform: "android" | "ios", handle: string) => void;
  log: MobileGatewayDeps["log"];
  now?: () => number;
  /** Fresh id per outgoing chunk group. */
  newId?: () => string;
}

/** Live request bookkeeping, surfaced in the "mobile is driving" indicator. */
export interface RpcActivity {
  inFlight: number;
  lastRequestAt: number | undefined;
  lastRequestMethod: string | undefined;
}

export class RpcServer {
  private readonly assembler = new ChunkAssembler();
  private readonly inFlight = new Map<string, AbortController>();
  private lastRequestAt: number | undefined;
  private lastRequestMethod: string | undefined;
  private closed = false;

  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: RpcServerDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => `c-${Math.random().toString(36).slice(2)}-${this.now()}`);
  }

  get activity(): RpcActivity {
    return {
      inFlight: this.inFlight.size,
      lastRequestAt: this.lastRequestAt,
      lastRequestMethod: this.lastRequestMethod,
    };
  }

  /** Delivers one desktop→phone event, chunking if it is oversize. */
  deliver(event: RpcEvent): void {
    this.write(event);
  }

  /**
   * Handles one decrypted payload from the secure session.
   *
   * A payload that is not a valid envelope ends the session: the peer is either
   * speaking a different protocol version or has been tampered with, and both
   * cases are worse to guess about than to stop on.
   */
  handle(payload: unknown): void {
    if (this.closed) {
      return;
    }
    let envelope: RpcEnvelope;
    try {
      envelope = decodeRpcEnvelope(payload);
    } catch (error) {
      this.fail(`알 수 없는 형식의 메시지를 받아 세션을 종료했습니다: ${String(error)}`);
      return;
    }

    switch (envelope.k) {
      case "req":
        void this.dispatch(envelope);
        return;
      case "ctl":
        this.control(envelope);
        return;
      case "res":
      case "evt":
        // 01 §5.1 — requests flow phone→desktop and events desktop→phone only.
        // Receiving either means the roles got crossed.
        this.fail(`이 방향으로 올 수 없는 메시지(${envelope.k})를 받았습니다.`);
        return;
      default:
        this.fail("알 수 없는 봉투 종류를 받았습니다.");
    }
  }

  /** Aborts in-flight handlers so they stop work nobody will receive. */
  dispose(): void {
    this.closed = true;
    for (const controller of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
    this.assembler.reset();
  }

  // -- requests -------------------------------------------------------------

  private async dispatch(request: RpcRequest): Promise<void> {
    this.lastRequestAt = this.now();
    this.lastRequestMethod = request.m;

    const controller = new AbortController();
    this.inFlight.set(request.id, controller);
    const deadline = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

    try {
      const result = isReservedMethod(request.m)
        ? await this.handleReserved(request)
        : await this.handleApp(request, controller.signal);
      this.write(okResponse(request.id, result));
    } catch (error) {
      const code = error instanceof RpcError ? error.code : controller.signal.aborted ? "handler_timeout" : "handler_failed";
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log(code === "method_not_found" ? "debug" : "warn", "mobile rpc request failed", {
        method: request.m,
        code,
        message,
      });
      this.write(errResponse(request.id, code, message));
    } finally {
      clearTimeout(deadline);
      this.inFlight.delete(request.id);
    }
  }

  private async handleApp(request: RpcRequest, signal: AbortSignal): Promise<unknown> {
    const handler = this.deps.handlers().get(request.m);
    if (!handler) {
      throw new RpcError(METHOD_NOT_FOUND, `등록되지 않은 메서드입니다: ${request.m}`);
    }
    return handler(request.p, this.contextFor(request, signal));
  }

  private async handleReserved(request: RpcRequest): Promise<unknown> {
    switch (request.m) {
      case "sys.ping":
        return {
          ts: this.now(),
          bootId: this.deps.eventBridge.bootId,
          transport: this.deps.link.transport,
        };
      case "sys.info": {
        const window = this.deps.eventBridge.window();
        return {
          name: this.deps.appName,
          version: this.deps.appVersion,
          protocolVersion: PROTOCOL_VERSION,
          bootId: this.deps.eventBridge.bootId,
          minSeq: window.minSeq,
          maxSeq: window.maxSeq,
        };
      }
      case "push.register": {
        const params = PushRegisterParamsSchema.parse(request.p);
        this.deps.registerPush(this.deps.link.deviceId, params.platform, params.handle);
        return { ok: true };
      }
      default:
        // RESERVED_METHODS and this switch must stay in step; a new reserved
        // name with no branch would otherwise answer with a confusing error.
        throw new RpcError("internal", `예약 메서드 ${request.m}에 대한 처리가 없습니다.`);
    }
  }

  private contextFor(request: RpcRequest, signal: AbortSignal): RequestContext {
    return {
      deviceId: this.deps.link.deviceId,
      deviceName: this.deps.link.deviceName,
      sessionId: this.deps.link.sessionId,
      requestId: request.id,
      method: request.m,
      workspacePath: workspacePathOf(request.p),
      transport: this.deps.link.transport,
      receivedAt: this.now(),
      signal,
    };
  }

  // -- control --------------------------------------------------------------

  private control(envelope: Extract<RpcEnvelope, { k: "ctl" }>): void {
    switch (envelope.c) {
      case "subscribe": {
        const workspaces = this.deps.eventBridge.setSubscription(
          this.deps.link.sessionId,
          (envelope as { workspaces?: string[] }).workspaces ?? [],
        );
        this.write({ k: "ctl", c: "subscribed", workspaces });
        return;
      }
      case "resume":
        this.resume(envelope as { bootId?: string | null; lastSeq?: number | null });
        return;
      case "ping":
        this.write({ k: "ctl", c: "pong", ts: this.now() });
        return;
      case "chunk":
        this.assemble(envelope as unknown as { id: string; i: number; n: number; data: string });
        return;
      default:
        // `subscribed`/`resumed`/`snapshot`/`pong` are desktop→phone only.
        this.deps.log("warn", "mobile rpc: unexpected control command", { c: envelope.c });
    }
  }

  /**
   * 01 §5.3. `bootId`/`seq` travel on both answers so the phone's cursor is
   * only ever set from what the desktop reports — never guessed locally.
   */
  private resume(request: { bootId?: string | null; lastSeq?: number | null }): void {
    const outcome = this.deps.eventBridge.resume(
      this.deps.link.sessionId,
      request.bootId ?? null,
      request.lastSeq ?? null,
    );

    if (outcome.kind === "replay") {
      for (const event of outcome.events) {
        this.write(event);
      }
      this.write({ k: "ctl", c: "resumed", bootId: this.deps.eventBridge.bootId, seq: outcome.throughSeq });
      return;
    }

    const provider = this.deps.snapshotProvider();
    if (!provider) {
      // Sending `state: null` would read to the phone as "the desktop has
      // nothing", which is indistinguishable from a real empty state. 01 §5.3
      // has no error variant of `snapshot`, and inventing a field would now be
      // rejected by the strict envelope schemas — so the session ends with a
      // reason the phone can show instead.
      this.fail("이 데스크톱에 스냅샷 제공자가 등록되지 않아 되감기를 처리할 수 없습니다.");
      return;
    }

    void this.sendSnapshot(provider, outcome.reason);
  }

  private async sendSnapshot(provider: MobileSnapshotProvider, reason: string): Promise<void> {
    try {
      const state = await provider({
        deviceId: this.deps.link.deviceId,
        sessionId: this.deps.link.sessionId,
        workspaces: this.deps.eventBridge.subscriptionOf(this.deps.link.sessionId),
      });
      // Taken after the provider ran: any event published while it was working
      // is already inside `state`, so replaying from an earlier seq would
      // duplicate it.
      const seq = this.deps.eventBridge.markSnapshotDelivered(this.deps.link.sessionId);
      this.write({ k: "ctl", c: "snapshot", bootId: this.deps.eventBridge.bootId, seq, state });
      this.deps.log("info", "mobile rpc sent a snapshot", { reason, seq });
    } catch (error) {
      // Same reasoning as a missing provider: a fabricated empty state would be
      // silently wrong, so the failure ends the session with its cause.
      this.fail(`스냅샷을 만들 수 없어 되감기를 처리하지 못했습니다: ${String(error)}`);
    }
  }

  // -- chunking -------------------------------------------------------------

  private assemble(chunk: { id: string; i: number; n: number; data: string }): void {
    let assembled: string | undefined;
    try {
      assembled = this.assembler.accept({ k: "ctl", c: "chunk", ...chunk });
    } catch (error) {
      // 01 §5.6 — a gap or interleave cannot be recovered from.
      this.fail(`분할 메시지를 조립할 수 없어 세션을 종료했습니다: ${String(error)}`);
      return;
    }
    if (assembled === undefined) {
      return;
    }
    try {
      this.handle(JSON.parse(assembled));
    } catch (error) {
      this.fail(`분할 메시지의 조립 결과가 올바른 JSON이 아닙니다: ${String(error)}`);
    }
  }

  /** Serializes and sends, splitting when the envelope exceeds one frame. */
  private write(envelope: unknown): void {
    if (this.closed) {
      return;
    }
    const serialized = JSON.stringify(envelope);
    if (!needsChunking(serialized)) {
      this.deps.link.send(envelope);
      return;
    }
    // splitEnvelope enforces the 16 MiB assembly ceiling and throws past it,
    // so an envelope too large to send fails loudly at the source.
    for (const chunk of splitEnvelope(serialized, this.newId())) {
      this.deps.link.send(chunk);
    }
  }

  private fail(reason: string): void {
    if (this.closed) {
      return;
    }
    this.deps.log("error", "mobile rpc session terminated", { reason });
    this.dispose();
    this.deps.link.close(reason);
  }
}

/** An error carrying a protocol error code back to the phone. */
export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * 04 §3 — the app routes by workspace, so the pipe lifts a string
 * `workspacePath` out of the params into the context. It never interprets the
 * value; anything that is not a plain string is left absent.
 */
function workspacePathOf(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[WORKSPACE_PARAM_FIELD];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Re-exported so the gateway can assert its registry against the same list. */
export { RESERVED_METHODS };
