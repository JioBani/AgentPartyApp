import {
  SecureSession as ProtocolSecureSession,
  deriveSessionKeys,
  generateSessionEphemeral,
  type SessionRole,
} from "@agentparty/protocol";
import type { MobileGatewayDeps } from "./index";
import type { Transport } from "./transport";

/**
 * The E2E layer between {@link Transport} and the RPC server (01 §4).
 *
 * All of the byte-level work — key derivation, the AEAD frame, the send
 * counter, replay rejection and the fatal-gap rule — belongs to
 * `@agentparty/protocol`'s `SecureSession`, which the Dart pipe is held to by
 * the same vectors. This class only binds it to a transport and turns its
 * outcomes into events the session owner can act on.
 *
 * Two failure modes are deliberately different:
 *
 * - a **replayed** frame (counter already seen) is dropped and counted. It is
 *   not fatal because a retransmit is a normal network event.
 * - a **counter gap** is fatal. The channel is ordered and reliable, so a gap
 *   means frames were lost or injected; continuing would let an attacker choose
 *   which messages the peer sees. The session ends and the phone rebuilds it,
 *   recovering through `resume`.
 */

export interface SecureSessionDeps {
  transport: Transport;
  role: SessionRole;
  /** This session's ephemeral key pair, already announced in `hello`. */
  ownEph: { publicKey: Uint8Array; privateKey: Uint8Array };
  peerEphPk: Uint8Array;
  log: MobileGatewayDeps["log"];
  /** Called with each decrypted payload, in order. */
  onPayload: (payload: unknown) => void;
  /** Called once when the session can no longer be trusted or used. */
  onFatal: (reason: string) => void;
}

export class SecureSession {
  private readonly session: ProtocolSecureSession;
  private closed = false;
  private replayedFrames = 0;

  constructor(private readonly deps: SecureSessionDeps) {
    this.session = new ProtocolSecureSession(
      deps.role,
      deriveSessionKeys(deps.role, deps.ownEph.publicKey, deps.ownEph.privateKey, deps.peerEphPk),
    );
    deps.transport.onFrame((frame) => this.receive(frame));
  }

  /** Frames dropped as replays. Surfaced in diagnostics, never hidden. */
  get replayCount(): number {
    return this.replayedFrames;
  }

  /**
   * Encrypts and sends one JSON-serializable envelope.
   *
   * @throws when the payload exceeds the protocol's frame ceiling. The RPC
   *   layer must chunk before calling this (01 §5.6); reaching here with an
   *   oversize payload is a bug, not a runtime condition to absorb.
   */
  send(payload: unknown): void {
    if (this.closed) {
      throw new Error("secure session: send after close");
    }
    this.deps.transport.send(this.session.sealJson(payload));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.session.close();
  }

  // -- internals ------------------------------------------------------------

  private receive(frame: Uint8Array): void {
    if (this.closed) {
      return;
    }
    let payload: unknown;
    try {
      payload = this.session.openJson(frame);
    } catch (error) {
      // A gap, a forged frame, or a payload that is not the JSON both sides
      // agreed on. The protocol session has already closed itself.
      this.fail(`보안 세션 프레임을 처리할 수 없어 세션을 종료했습니다: ${String(error)}`);
      return;
    }
    if (payload === null) {
      // 01 §4.2 — a counter at or below the last one seen. Normal on a
      // retransmit; counted so a flood is visible rather than invisible.
      this.replayedFrames += 1;
      this.deps.log("debug", "mobile secure session dropped a replayed frame", {
        replayed: this.replayedFrames,
      });
      return;
    }
    this.deps.onPayload(payload);
  }

  private fail(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.deps.log("error", "mobile secure session failed", { reason });
    this.deps.onFatal(reason);
  }
}

/**
 * Creates the ephemeral key pair for a new session (01 §4.1). Kept here so the
 * session owner never touches the raw key API and the pair is always generated
 * the same way.
 */
export function newSessionEphemeral(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  return generateSessionEphemeral();
}
