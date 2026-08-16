import { WebSocket } from "ws";
import {
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeSignalingMessage,
  fromB64,
  signSignalingAuth,
  toB64,
  type ClientMessage,
  type Identity,
  type RelayKind,
  type ServerMessage,
} from "@agentparty/protocol";
import type { MobileGatewayDeps } from "./index";

/**
 * Always-on outbound connection to the rendezvous server (01 §3).
 *
 * The desktop dials out and stays connected so a phone can reach it without
 * the desktop having any inbound port. The socket carries only sealed blobs and
 * the pairing handshake; the server never sees plaintext (02 §신뢰 경계).
 *
 * Reconnection is automatic and backed off, because the common failure is a
 * laptop lid or a Wi-Fi change rather than a real outage. Authentication
 * failures are NOT retried on a fast loop: a rejected signature means the
 * server refuses this identity, and hammering it would neither fix that nor go
 * unnoticed.
 */

export type SignalingPhase = "idle" | "connecting" | "authenticating" | "connected" | "backoff" | "failed";

export interface SignalingClientDeps {
  url: string;
  identity: Identity;
  log: MobileGatewayDeps["log"];
  /** Injected in tests. */
  now?: () => number;
  openSocket?: (url: string) => SignalingSocket;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

/** The slice of a WebSocket this client needs; keeps `ws` out of the tests. */
export interface SignalingSocket {
  send(data: string): void;
  close(): void;
  onOpen(fn: () => void): void;
  onMessage(fn: (data: string) => void): void;
  onClose(fn: (reason: string) => void): void;
  onError(fn: (error: Error) => void): void;
}

export interface SignalingHandlers {
  /** A sealed relay envelope arrived from `from`. Still encrypted. */
  onRelay(from: string, kind: RelayKind, box: string): void;
  /** The phone joined an open pairing token with its sealed blob1. */
  onPairJoin(tokenHash: string, blob1: string): void;
  onPairAccept?(tokenHash: string, blob2: string): void;
  onPairDone(tokenHash: string, blob3: string): void;
  onPairClosed(tokenHash: string, reason: string): void;
  onPhaseChange(phase: SignalingPhase, detail: { error?: string }): void;
}

/**
 * 01 §3.4 + server limit — the server closes a socket that exceeds 20 messages
 * per second. ICE candidates arrive in bursts, so they are batched into a
 * window and the whole outbound stream is paced well under the ceiling.
 * Overrunning it would drop the socket mid-handshake, which reads to the user
 * as "the phone will not connect" with no clue why.
 */
const ICE_BATCH_WINDOW_MS = 100;
const MAX_MESSAGES_PER_SECOND = 10;

/** Reconnect backoff, capped so a long outage still retries at a sane rate. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

export class SignalingClient {
  private socket: SignalingSocket | undefined;
  private phase: SignalingPhase = "idle";
  private handlers: SignalingHandlers | undefined;
  private attempt = 0;
  private stopped = true;

  /** Outbound queue used to hold the per-second rate. */
  private readonly outbox: ClientMessage[] = [];
  private sentInWindow = 0;
  private windowStartedAt = 0;
  private flushTimer: NodeJS.Timeout | undefined;

  /** Pending `ice` relays, keyed by peer, merged over {@link ICE_BATCH_WINDOW_MS}. */
  private readonly iceBatch = new Map<string, string[]>();
  private iceTimer: NodeJS.Timeout | undefined;

  private pingTimer: NodeJS.Timeout | undefined;
  private lastServerMessageAt = 0;
  /** 01 §3.1 — STUN servers the signaling server offered on `ok`. */
  private offeredIceServers: string[] = [];
  private reconnectTimer: NodeJS.Timeout | undefined;

  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly openSocket: (url: string) => SignalingSocket;

  constructor(private readonly deps: SignalingClientDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
    this.openSocket = deps.openSocket ?? ((url) => new WsSignalingSocket(url));
  }

  get currentPhase(): SignalingPhase {
    return this.phase;
  }

  /**
   * ICE servers the signaling server offered (01 §3.1), already filtered to
   * `stun:`. Empty until an `ok` carrying them arrives, and empty for a server
   * that offers none — the caller falls back to its built-in list.
   */
  get iceServers(): readonly string[] {
    return this.offeredIceServers;
  }

  start(handlers: SignalingHandlers): void {
    this.handlers = handlers;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
    this.setPhase("idle");
  }

  /**
   * Queues a sealed envelope for `to`. `ice` is batched; everything else goes
   * out on the next flush and survives a reconnect, so a pairing step in flight
   * is not lost.
   *
   * ICE is the exception: candidates belong to the ICE session that died with
   * the socket, so {@link teardown} drops them rather than replaying stale
   * candidates into a new negotiation.
   */
  relay(to: string, kind: RelayKind, box: string, id?: string): void {
    if (kind === "ice") {
      this.queueIce(to, box);
      return;
    }
    this.enqueue({ t: "relay", to, kind, box, ...(id ? { id } : {}) } as ClientMessage);
  }

  openPairing(tokenHash: string, expiresAt: number): void {
    this.enqueue({ t: "pair.open", tokenHash, exp: expiresAt } as ClientMessage);
  }

  acceptPairing(tokenHash: string, blob2: string): void {
    this.enqueue({ t: "pair.accept", tokenHash, blob2 } as ClientMessage);
  }

  cancelPairing(tokenHash: string): void {
    this.enqueue({ t: "pair.cancel", tokenHash } as ClientMessage);
  }

  // -- connection lifecycle -------------------------------------------------

  private connect(): void {
    this.setPhase("connecting");
    let socket: SignalingSocket;
    try {
      socket = this.openSocket(this.deps.url);
    } catch (error) {
      this.failAndRetry(`시그널링 서버에 연결할 수 없습니다: ${String(error)}`);
      return;
    }
    this.socket = socket;

    socket.onOpen(() => {
      this.setPhase("authenticating");
      this.lastServerMessageAt = this.now();
      // The hello bypasses the queue: the socket is not yet usable for anything
      // else, and pacing a single message would only delay the handshake.
      this.write({
        t: "hello",
        v: PROTOCOL_VERSION,
        deviceId: this.deps.identity.deviceId,
        sigPk: toB64(this.deps.identity.sigPk),
        role: "desktop",
      } as ClientMessage);
    });

    socket.onMessage((data) => this.receive(data));
    socket.onError((error) => this.deps.log("warn", "mobile signaling socket error", { error: error.message }));
    socket.onClose((reason) => {
      if (this.stopped) {
        return;
      }
      this.failAndRetry(`시그널링 연결이 끊겼습니다: ${reason}`);
    });
  }

  private receive(data: string): void {
    this.lastServerMessageAt = this.now();
    let message: ServerMessage;
    try {
      message = decodeServerMessage(data);
    } catch (error) {
      // A message this client cannot parse means the peer is not the server
      // this protocol version expects. Surfacing beats guessing.
      this.deps.log("error", "mobile signaling: undecodable message", { error: String(error) });
      this.failAndRetry("시그널링 서버가 알 수 없는 메시지를 보냈습니다.");
      return;
    }

    switch (message.t) {
      case "challenge": {
        // `nonce` arrives as base64url TEXT. It must be decoded to bytes before
        // signing: `signSignalingAuth` also accepts a string and would hash the
        // TEXT as UTF-8, producing a signature the server rejects with
        // `auth_failed` and no hint as to why (01 §0 — never hash b64url text).
        const signature = signSignalingAuth(
          fromB64(message.nonce),
          message.serverId,
          message.ts,
          this.deps.identity.sigSk,
        );
        this.write({ t: "auth", sig: toB64(signature) } as ClientMessage);
        return;
      }
      case "ok": {
        this.offeredIceServers = acceptIceServers(
          (message as { iceServers?: unknown }).iceServers,
          (entry) => this.deps.log("warn", "mobile signaling: ignoring a non-STUN ICE server", { entry }),
        );
        this.attempt = 0;
        this.setPhase("connected");
        this.startPing();
        this.flush();
        return;
      }
      case "pong":
        return;
      case "relay":
        this.handlers?.onRelay(message.from, message.kind, message.box);
        return;
      case "pair.join":
        this.handlers?.onPairJoin(message.tokenHash, message.blob1);
        return;
      case "pair.accept":
        this.handlers?.onPairAccept?.(message.tokenHash, message.blob2);
        return;
      case "pair.done":
        this.handlers?.onPairDone(message.tokenHash, message.blob3);
        return;
      case "pair.closed":
        this.handlers?.onPairClosed(message.tokenHash, message.reason);
        return;
      case "err":
        this.handleServerError(message.code, message.message);
        return;
      default:
        return;
    }
  }

  /**
   * `auth_failed` and `unsupported_version` are terminal: retrying cannot make
   * a rejected identity acceptable, and a silent retry loop would hide the
   * reason the phone never connects.
   */
  private handleServerError(code: string, detail?: string): void {
    const message = `시그널링 서버 오류(${code})${detail ? `: ${detail}` : ""}`;
    this.deps.log("warn", "mobile signaling server error", { code, detail });
    if (code === "auth_failed" || code === "unsupported_version") {
      this.teardown();
      this.setPhase("failed", { error: message });
      return;
    }
    if (code === "replaced") {
      // Another socket for this deviceId won (01 §3.1). Reconnecting would
      // fight it; a later reconnect is the caller's decision.
      this.teardown();
      this.setPhase("failed", { error: "같은 기기 ID로 다른 연결이 열려 이 연결이 대체되었습니다." });
      return;
    }
    this.handlers?.onPhaseChange(this.phase, { error: message });
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = this.setTimer(() => {
      if (this.now() - this.lastServerMessageAt > PING_TIMEOUT_MS) {
        this.failAndRetry("시그널링 서버가 응답하지 않습니다.");
        return;
      }
      this.write({ t: "ping" } as ClientMessage);
      this.startPing();
    }, PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      this.clearTimer(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private failAndRetry(reason: string): void {
    this.teardown();
    if (this.stopped) {
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.setPhase("backoff", { error: reason });
    this.deps.log("info", "mobile signaling reconnecting", { reason, delay, attempt: this.attempt });
    this.reconnectTimer = this.setTimer(() => this.connect(), delay);
  }

  private teardown(): void {
    this.clearPing();
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.iceTimer) {
      this.clearTimer(this.iceTimer);
      this.iceTimer = undefined;
    }
    if (this.flushTimer) {
      this.clearTimer(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.dropPendingIce();
    try {
      this.socket?.close();
    } catch {
      // Already closing; the close handler has run or will not run.
    }
    this.socket = undefined;
  }

  /**
   * Discards candidates for the negotiation that just died — both the ones
   * still inside the batch window and the ones already queued for sending.
   * Replaying them after a reconnect would feed a new PeerConnection candidates
   * from an old one, which is worse than having none.
   */
  private dropPendingIce(): void {
    const batched = [...this.iceBatch.values()].reduce((total, boxes) => total + boxes.length, 0);
    this.iceBatch.clear();
    let queued = 0;
    for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
      const message = this.outbox[index];
      if (message.t === "relay" && message.kind === "ice") {
        this.outbox.splice(index, 1);
        queued += 1;
      }
    }
    if (batched + queued > 0) {
      this.deps.log("info", "mobile signaling dropped stale ICE candidates", { batched, queued });
    }
  }

  private setPhase(phase: SignalingPhase, detail: { error?: string } = {}): void {
    this.phase = phase;
    this.handlers?.onPhaseChange(phase, detail);
  }

  // -- outbound pacing ------------------------------------------------------

  /**
   * ICE candidates are produced in bursts. They are collected per peer for one
   * window and sent as a batch, which is what keeps the burst under the
   * server's per-socket rate limit (01 §3.4).
   */
  private queueIce(to: string, box: string): void {
    const pending = this.iceBatch.get(to);
    if (pending) {
      pending.push(box);
    } else {
      this.iceBatch.set(to, [box]);
    }
    if (this.iceTimer) {
      return;
    }
    this.iceTimer = this.setTimer(() => {
      this.iceTimer = undefined;
      for (const [peer, boxes] of this.iceBatch) {
        for (const box of boxes) {
          this.enqueue({ t: "relay", to: peer, kind: "ice", box } as ClientMessage);
        }
      }
      this.iceBatch.clear();
    }, ICE_BATCH_WINDOW_MS);
  }

  private enqueue(message: ClientMessage): void {
    this.outbox.push(message);
    this.flush();
  }

  /** Sends as many queued messages as the rate allows, then schedules the rest. */
  private flush(): void {
    if (this.phase !== "connected" || !this.socket) {
      return;
    }
    const now = this.now();
    if (now - this.windowStartedAt >= 1_000) {
      this.windowStartedAt = now;
      this.sentInWindow = 0;
    }
    while (this.outbox.length > 0 && this.sentInWindow < MAX_MESSAGES_PER_SECOND) {
      const message = this.outbox.shift();
      if (!message) {
        break;
      }
      this.write(message);
      this.sentInWindow += 1;
    }
    if (this.outbox.length > 0 && !this.flushTimer) {
      const wait = Math.max(1, 1_000 - (this.now() - this.windowStartedAt));
      this.flushTimer = this.setTimer(() => {
        this.flushTimer = undefined;
        this.flush();
      }, wait);
    }
  }

  /** Raw write, bypassing the queue. Only for handshake and keepalive. */
  private write(message: ClientMessage): void {
    if (!this.socket) {
      throw new Error("mobile signaling: write attempted with no socket");
    }
    this.socket.send(encodeSignalingMessage(message));
  }
}

/**
 * 01 §3.1 — the server may offer ICE servers, and only `stun:` is allowed.
 *
 * A `turn:`/`turns:` entry is dropped rather than used: this system routes no
 * media through anyone else's server (00 §원칙 2), so honouring one would
 * quietly undo that guarantee at the request of a semi-trusted party
 * (02 §신뢰 경계). Dropping is logged, never silent.
 */
export function acceptIceServers(value: unknown, onRejected?: (entry: string) => void): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const accepted: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    if (/^stun:/i.test(entry)) {
      accepted.push(entry);
    } else {
      onRejected?.(entry);
    }
  }
  return accepted;
}

/** Real `ws` adapter. Isolated so the client itself stays socket-agnostic. */
class WsSignalingSocket implements SignalingSocket {
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }

  onOpen(fn: () => void): void {
    this.ws.on("open", fn);
  }

  onMessage(fn: (data: string) => void): void {
    this.ws.on("message", (data) => fn(typeof data === "string" ? data : data.toString("utf8")));
  }

  onClose(fn: (reason: string) => void): void {
    this.ws.on("close", (code, reason) => fn(`${code} ${reason.toString("utf8")}`.trim()));
  }

  onError(fn: (error: Error) => void): void {
    this.ws.on("error", fn);
  }
}
