import {
  MAX_DESKTOP_NAME_LENGTH,
  PAIR_TTL_MS,
  createPairingOffer,
  deviceIdOf,
  equalBytes,
  fromB64,
  openBlob1,
  openBlob3,
  pairConfirmCode,
  pairSharedSecret,
  pairTranscriptHash,
  sealBlob2,
  signTranscript,
  toB64,
  verifyTranscript,
  type Blob1,
  type PairingOffer,
} from "@agentparty/protocol";
import type { PairingState, TrustedDevice } from "../../shared/mobileProtocol";
import type { IdentityStore } from "./identityStore";
import type { MobileGatewayDeps } from "./index";

/**
 * Desktop half of the pairing handshake (01 §2).
 *
 * The shape of this exchange is what stops a malicious signaling server from
 * inserting itself (02 §T2/T4): the server only ever sees `tokenHash` and
 * sealed blobs, and the two devices independently derive a confirmation code
 * from a shared secret plus a transcript hash covering every public key in the
 * exchange. If anything was substituted, the codes differ and the user sees it.
 *
 * Nothing is trusted before the user presses "the codes match": `blob2` — the
 * desktop's signature over the transcript — is not sent until then. That
 * ordering is the whole protection, so `confirm()` is the only path that can
 * release it.
 */

export interface PairingServiceDeps {
  identityStore: IdentityStore;
  log: MobileGatewayDeps["log"];
  /** Host written into the QR, e.g. `sig.agentparty.app` or `192.168.0.5:8080`. */
  signalingHost: () => string;
  /** Display name the phone stores for this desktop. */
  desktopName: () => string;
  /** Registers and releases the token with the signaling server. */
  transport: PairingTransport;
  onStateChange: (state: PairingState) => void;
  /**
   * QR lifetime. Defaults to the protocol's {@link PAIR_TTL_MS}. A longer one
   * is a DEVELOPMENT affordance only: the QR is the pairing capability itself,
   * so the window it is valid for is the window an attacker has (02 §T3).
   */
  pairingTtlMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

/** The signaling operations pairing needs; keeps the socket out of the tests. */
export interface PairingTransport {
  openPairing(tokenHash: string, expiresAt: number): void;
  acceptPairing(tokenHash: string, blob2: string): void;
  cancelPairing(tokenHash: string): void;
}

/** One pairing attempt, from QR issue to a stored trust record. */
interface ActivePairing {
  offer: PairingOffer;
  expiryTimer: NodeJS.Timeout;
  resolve: (device: TrustedDevice) => void;
  reject: (error: Error) => void;
  /** Filled once the phone's blob1 has been opened and verified. */
  peer?: {
    blob1: Blob1;
    deviceId: string;
    transcriptHash: Uint8Array;
    code: string;
  };
  /** True once blob2 has gone out and the desktop is waiting for blob3. */
  awaitingDone: boolean;
}

export interface OpenedPairing {
  qr: string;
  expiresAt: number;
  completed: Promise<TrustedDevice>;
}

export class PairingService {
  private active: ActivePairing | undefined;
  private state: PairingState = idleState();

  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;

  constructor(private readonly deps: PairingServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  get currentState(): PairingState {
    return this.state;
  }

  /**
   * Issues a single-use QR valid for {@link PAIR_TTL_MS} and registers its
   * hash with the signaling server. Opening a second QR cancels the first —
   * two live tokens would make the confirmation code ambiguous.
   */
  open(): OpenedPairing {
    this.abort("페어링이 새 QR 발행으로 취소되었습니다.", "cancelled");

    const offer = createPairingOffer(this.deps.identityStore.identity, this.deps.signalingHost(), {
      now: this.now(),
      ttlMs: this.deps.pairingTtlMs ?? PAIR_TTL_MS,
    });
    let resolve!: (device: TrustedDevice) => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<TrustedDevice>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A rejection is reported through onStateChange as well; this keeps an
    // unhandled rejection from crashing the main process when the caller only
    // watches the state stream.
    completed.catch(() => undefined);

    this.active = {
      offer,
      resolve,
      reject,
      awaitingDone: false,
      expiryTimer: this.setTimer(() => {
        this.abort("페어링 시간이 만료되었습니다. QR을 다시 발행하세요.", "expired");
      }, Math.max(0, offer.expiresAt - this.now())),
    };

    this.deps.transport.openPairing(offer.tokenHash, offer.expiresAt);
    this.publish({ ...idleState(), phase: "awaitingScan", qr: offer.qr, expiresAt: offer.expiresAt });
    this.deps.log("info", "mobile pairing opened", { expiresAt: offer.expiresAt });

    return { qr: offer.qr, expiresAt: offer.expiresAt, completed };
  }

  /**
   * The phone joined with its sealed `blob1` (01 §2.2). Opens it, checks the
   * token it echoes back, and derives the confirmation code both sides display.
   *
   * A failure here aborts the pairing rather than waiting: the token is
   * single-use, so there is no second attempt to wait for.
   */
  handlePairJoin(tokenHash: string, sealedBlob1: string): void {
    const active = this.active;
    if (!active) {
      this.deps.log("warn", "mobile pairing: join for no open pairing", { tokenHash });
      return;
    }
    if (tokenHash !== active.offer.tokenHash) {
      this.deps.log("warn", "mobile pairing: join for a different token", { tokenHash });
      return;
    }
    if (active.peer) {
      // 01 §2.2 — the server rejects a second phone with `pair_busy`, so this
      // means the same phone sent blob1 twice. Re-deriving would change the
      // displayed code out from under the user.
      this.deps.log("warn", "mobile pairing: duplicate blob1 ignored", { tokenHash });
      return;
    }

    let blob1: Blob1;
    try {
      blob1 = openBlob1(fromB64(sealedBlob1), active.offer.ephPk, active.offer.ephSk);
    } catch (error) {
      this.abort(`페어링 요청을 열 수 없습니다: ${String(error)}`, "failed");
      return;
    }

    if (!equalBytes(blob1.t, active.offer.token)) {
      // The blob opened but carries someone else's token: it was not produced
      // from this QR (02 §T4).
      this.abort("페어링 요청의 토큰이 이 QR과 일치하지 않습니다.", "failed");
      return;
    }

    const desktop = this.deps.identityStore.identity;
    const sharedSecret = pairSharedSecret(active.offer.ephSk, blob1.e);
    const transcriptHash = pairTranscriptHash({
      desktopSigPk: desktop.sigPk,
      desktopKxPk: desktop.kxPk,
      desktopEphPk: active.offer.ephPk,
      phoneSigPk: blob1.sig,
      phoneKxPk: blob1.kx,
      phoneEphPk: blob1.e,
      token: active.offer.token,
    });
    const code = pairConfirmCode(sharedSecret, transcriptHash);
    const deviceId = deviceIdOf(blob1.sig);

    active.peer = { blob1, deviceId, transcriptHash, code };
    this.publish({
      ...this.state,
      phase: "awaitingConfirm",
      code,
      peerName: blob1.name,
      peerDeviceId: deviceId,
    });
    this.deps.log("info", "mobile pairing awaiting confirmation", { deviceId, name: blob1.name });
  }

  /**
   * The user compared the codes and pressed "match". Only now does the
   * desktop's transcript signature leave the machine (01 §2.2).
   */
  confirm(): void {
    const active = this.active;
    if (!active?.peer) {
      throw new Error("확인을 기다리는 페어링이 없습니다.");
    }
    if (active.awaitingDone) {
      return;
    }

    const desktop = this.deps.identityStore.identity;
    const blob2 = sealBlob2(
      {
        sigOfTh: signTranscript(active.peer.transcriptHash, desktop.sigSk),
        epoch: this.deps.identityStore.trustEpoch,
        name: this.deps.desktopName().slice(0, MAX_DESKTOP_NAME_LENGTH),
      },
      active.peer.blob1.e,
    );

    active.awaitingDone = true;
    this.deps.transport.acceptPairing(active.offer.tokenHash, toB64(blob2));
    this.publish({ ...this.state, phase: "confirmed" });
  }

  /**
   * The phone's `blob3` — its own signature over the same transcript. This is
   * what proves the phone holds the signing key its `blob1` claimed, so the
   * trust record is written only after it verifies.
   */
  handlePairDone(tokenHash: string, sealedBlob3: string): void {
    const active = this.active;
    if (!active?.peer || tokenHash !== active.offer.tokenHash) {
      this.deps.log("warn", "mobile pairing: unexpected pair.done", { tokenHash });
      return;
    }
    if (!active.awaitingDone) {
      // blob3 before the user confirmed means the phone skipped a step.
      this.abort("페어링 순서가 올바르지 않습니다.", "failed");
      return;
    }

    let signature: Uint8Array;
    try {
      signature = openBlob3(fromB64(sealedBlob3), active.offer.ephPk, active.offer.ephSk).sigOfTh;
    } catch (error) {
      this.abort(`페어링 완료 메시지를 열 수 없습니다: ${String(error)}`, "failed");
      return;
    }
    if (!verifyTranscript(active.peer.transcriptHash, signature, active.peer.blob1.sig)) {
      this.abort("폰의 서명이 유효하지 않습니다. 페어링을 중단했습니다.", "failed");
      return;
    }

    const device: TrustedDevice = {
      deviceId: active.peer.deviceId,
      sigPk: toB64(active.peer.blob1.sig),
      kxPk: toB64(active.peer.blob1.kx),
      name: active.peer.blob1.name,
      pairedAt: this.now(),
      epoch: this.deps.identityStore.trustEpoch,
      lastSeenAt: 0,
      push: undefined,
    };
    this.deps.identityStore.addDevice(device);

    const resolve = active.resolve;
    this.finish();
    this.publish({ ...idleState(), phase: "completed", peerDeviceId: device.deviceId, peerName: device.name });
    this.deps.log("info", "mobile pairing completed", { deviceId: device.deviceId });
    resolve(device);
  }

  /** 01 §2.2 — the server dropped the pairing session. */
  handlePairClosed(tokenHash: string, reason: string): void {
    if (!this.active || tokenHash !== this.active.offer.tokenHash) {
      return;
    }
    if (reason === "done") {
      // Expected: `handlePairDone` already finished, or is about to.
      return;
    }
    this.abort(pairClosedMessage(reason), reason === "expired" ? "expired" : "failed");
  }

  cancel(): void {
    this.abort("페어링이 취소되었습니다.", "cancelled");
  }

  // -- internals ------------------------------------------------------------

  /**
   * Ends the active pairing without storing anything (01 §2.2: "검증 실패·만료·
   * 코드 불일치 → 즉시 중단, 아무것도 저장하지 않음").
   */
  private abort(message: string, phase: "cancelled" | "expired" | "failed"): void {
    const active = this.active;
    if (!active) {
      return;
    }
    this.deps.transport.cancelPairing(active.offer.tokenHash);
    const reject = active.reject;
    this.finish();
    this.publish({ ...idleState(), phase, error: phase === "failed" ? message : undefined });
    this.deps.log(phase === "failed" ? "warn" : "info", "mobile pairing ended", { phase, message });
    reject(new Error(message));
  }

  /** Clears the attempt and its ephemeral keys (02 §키 수명). */
  private finish(): void {
    if (this.active) {
      this.clearTimer(this.active.expiryTimer);
      this.active.offer.ephSk.fill(0);
      this.active.offer.token.fill(0);
    }
    this.active = undefined;
  }

  private publish(state: PairingState): void {
    this.state = state;
    this.deps.onStateChange(state);
  }
}

function idleState(): PairingState {
  return {
    phase: "idle",
    qr: undefined,
    expiresAt: undefined,
    code: undefined,
    peerName: undefined,
    peerDeviceId: undefined,
    error: undefined,
  };
}

function pairClosedMessage(reason: string): string {
  switch (reason) {
    case "expired":
      return "페어링 시간이 만료되었습니다. QR을 다시 발행하세요.";
    case "peer_gone":
      return "폰과의 연결이 끊겨 페어링을 완료하지 못했습니다.";
    case "cancelled":
      return "페어링이 취소되었습니다.";
    default:
      return `페어링이 종료되었습니다(${reason}).`;
  }
}
