import type { TransportKind, TransportState } from "../../shared/mobileProtocol";

/**
 * 01 §6 — what carries secure-session frames between the two devices.
 *
 * The layers above (secure session, RPC, event bridge) depend only on this, so
 * swapping `directViaRendezvous` for `lanDirect` or a user-owned relay changes
 * nothing above it. Frames are opaque bytes here: this layer never inspects or
 * reorders them, and the channel underneath must be ordered and reliable
 * because the secure session treats a counter gap as fatal (01 §4.2).
 */
export interface Transport {
  readonly kind: TransportKind;
  readonly state: TransportState;

  /** Queues one already-encrypted frame. */
  send(frame: Uint8Array): void;

  /**
   * Bytes accepted by `send()` that are not on the wire yet.
   *
   * On the interface rather than on one implementation because the 2MB ceiling
   * (04 §성능·안전) is a rule about every transport, not about WebRTC: a future
   * `lanDirect` or `userRelay` that could not answer this would quietly have no
   * backpressure at all. A transport that cannot measure its backlog should say
   * so by failing to compile here, not by returning a comfortable 0.
   */
  queuedBytes(): number;

  /** Registers the frame sink. Called once by the session that owns this. */
  onFrame(listener: (frame: Uint8Array) => void): void;

  /**
   * Reports connection state. `closed` carries a reason whenever one is known —
   * a transport that dies silently is indistinguishable from an idle one.
   */
  onStateChange(listener: (state: TransportState, detail: { error?: string }) => void): void;

  close(reason?: string): void;
}

/** Thrown when a transport cannot be built at all (missing native module, …). */
export class TransportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportUnavailableError";
  }
}

/**
 * Thrown when the peer's signalling material fails verification — a substituted
 * SDP fingerprint, a bad signature (02 §T1). Never recoverable: the caller must
 * abandon the session rather than retry, because a retry would negotiate with
 * the same impostor.
 */
export class TransportSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportSecurityError";
  }
}
