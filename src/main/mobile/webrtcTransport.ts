import {
  buildSdpPayload,
  verifySdpPayload,
  type IcePayload,
  type Identity,
  type SdpPayload,
} from "@agentparty/protocol";
import { MOBILE_STUN_SERVERS, type TransportKind, type TransportState } from "../../shared/mobileProtocol";
import type { MobileGatewayDeps } from "./index";
import { TransportSecurityError, TransportUnavailableError, type Transport } from "./transport";

/**
 * WebRTC DataChannel transport (01 §6, `directViaRendezvous`).
 *
 * STUN only — there is deliberately no TURN and no relay fallback (00 §원칙 2).
 * A connection that cannot be made directly fails with a reason the diagnostics
 * screen can explain, rather than silently routing traffic through someone
 * else's server.
 *
 * The security-critical step is `acceptOffer`: the peer's SDP fingerprint is
 * checked against its signature BEFORE `setRemoteDescription`. A signaling
 * server that swapped the fingerprint would otherwise complete a DTLS handshake
 * with itself in the middle (02 §T1). Verification failure is terminal.
 *
 * The desktop is the answerer: the phone dials, because only it knows when the
 * user opened the app.
 */

/** Minimal slice of node-datachannel this module uses. */
interface NativePeerConnection {
  setRemoteDescription(sdp: string, type: "offer" | "answer"): void;
  addRemoteCandidate(candidate: string, mid: string): void;
  localDescription(): { type: string; sdp: string } | null;
  state(): string;
  close(): void;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onStateChange(cb: (state: string) => void): void;
  onGatheringStateChange(cb: (state: string) => void): void;
  onDataChannel(cb: (channel: NativeDataChannel) => void): void;
}

interface NativeDataChannel {
  sendMessageBinary(buffer: Uint8Array): boolean;
  close(): void;
  isOpen(): boolean;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (error: string) => void): void;
  onMessage(cb: (message: string | Buffer | ArrayBuffer) => void): void;
}

interface NativeModule {
  PeerConnection: new (name: string, config: { iceServers: string[] }) => NativePeerConnection;
}

export interface WebrtcTransportDeps {
  sessionId: string;
  identity: Identity;
  /** Trusted peer's signing key; every SDP payload is checked against it. */
  peerSigPk: Uint8Array;
  /** Sends a signed SDP payload to the peer over signaling (caller seals it). */
  sendSdp: (payload: SdpPayload, kind: "offer" | "answer") => void;
  /** Sends one ICE candidate. The signaling client paces and batches these. */
  sendIce: (payload: IcePayload) => void;
  log: MobileGatewayDeps["log"];
  /** Injected in tests so the native module is not required. */
  loadNative?: () => NativeModule;
  iceServers?: string[];
}

/**
 * 01 §3.3 (develop, master 7c1fee0) — candidates travel as JSEP
 * `RTCIceCandidateInit`. libdatachannel reports a `mid`, which maps to
 * `sdpMid`; `sdpMLineIndex` is always 0 because a data-channel-only SDP has a
 * single m-section. Getting these names wrong makes the peer discard every
 * remote candidate and time out, which is why the schema rejects any other
 * shape instead of accepting it quietly.
 */
const DATA_CHANNEL_M_LINE_INDEX = 0;

/** 01 §3.3 — the end-of-candidates marker. */
const END_OF_CANDIDATES = "";

export class WebrtcTransport implements Transport {
  readonly kind: TransportKind = "directViaRendezvous";

  private pc: NativePeerConnection | undefined;
  private channel: NativeDataChannel | undefined;
  private frameListener: ((frame: Uint8Array) => void) | undefined;
  private stateListener: ((state: TransportState, detail: { error?: string }) => void) | undefined;
  private currentState: TransportState = "connecting";
  private closed = false;
  /** Frames handed to `send()` before the channel opened. */
  private readonly pending: Uint8Array[] = [];

  constructor(private readonly deps: WebrtcTransportDeps) {
    const native = (deps.loadNative ?? loadNodeDataChannel)();
    this.pc = new native.PeerConnection(`agentparty-${deps.sessionId}`, {
      iceServers: deps.iceServers ?? [...MOBILE_STUN_SERVERS],
    });
    this.wire(this.pc);
  }

  get state(): TransportState {
    return this.currentState;
  }

  /**
   * Verifies and applies the phone's offer, then answers.
   *
   * @throws {TransportSecurityError} when the signature is invalid or the SDP's
   *   fingerprint does not match the signed one. The session must be abandoned:
   *   retrying would negotiate with the same impostor.
   */
  acceptOffer(payload: SdpPayload): void {
    const pc = this.requireOpen();
    if (payload.sessionId !== this.deps.sessionId) {
      throw new TransportSecurityError(
        `webrtc: offer is for session ${payload.sessionId}, expected ${this.deps.sessionId}`,
      );
    }
    // verifySdpPayload checks BOTH the signature and that `fp` really is the
    // SDP's fingerprint (02 §T1). Repeating the fingerprint comparison here
    // would fork that rule into a second place that can drift from the vectors.
    try {
      verifySdpPayload(payload, this.deps.peerSigPk);
    } catch (error) {
      throw new TransportSecurityError(
        `webrtc: the peer's SDP failed verification, refusing to connect (${String(error)})`,
      );
    }
    pc.setRemoteDescription(payload.sdp, "offer");
  }

  /** Applies one remote candidate. `candidate: ""` ends the remote gathering. */
  addRemoteCandidate(payload: IcePayload): void {
    if (payload.sessionId !== this.deps.sessionId) {
      this.deps.log("warn", "mobile webrtc: candidate for another session ignored", {
        session: payload.sessionId,
      });
      return;
    }
    if (payload.candidate.candidate === END_OF_CANDIDATES) {
      return;
    }
    const pc = this.requireOpen();
    pc.addRemoteCandidate(payload.candidate.candidate, payload.candidate.sdpMid);
  }

  send(frame: Uint8Array): void {
    if (this.closed) {
      throw new Error("webrtc: send on a closed transport");
    }
    if (!this.channel?.isOpen()) {
      // The DataChannel opens a beat after the answer; holding frames avoids
      // losing the session's first envelope to a race.
      this.pending.push(frame);
      return;
    }
    this.channel.sendMessageBinary(frame);
  }

  onFrame(listener: (frame: Uint8Array) => void): void {
    this.frameListener = listener;
  }

  onStateChange(listener: (state: TransportState, detail: { error?: string }) => void): void {
    this.stateListener = listener;
  }

  close(reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.pending.length = 0;
    try {
      this.channel?.close();
      this.pc?.close();
    } catch (error) {
      this.deps.log("warn", "mobile webrtc: close failed", { error: String(error) });
    }
    this.channel = undefined;
    this.pc = undefined;
    this.setState("closed", { error: reason });
  }

  // -- internals ------------------------------------------------------------

  private requireOpen(): NativePeerConnection {
    if (!this.pc || this.closed) {
      throw new Error("webrtc: the peer connection is closed");
    }
    return this.pc;
  }

  private wire(pc: NativePeerConnection): void {
    pc.onLocalDescription((sdp, type) => {
      if (type !== "answer") {
        // The desktop only ever answers in this flow; an offer here would mean
        // the negotiation roles got crossed.
        this.deps.log("warn", "mobile webrtc: unexpected local description", { type });
        return;
      }
      // buildSdpPayload extracts and signs the fingerprint itself.
      this.deps.sendSdp(
        buildSdpPayload({ sessionId: this.deps.sessionId, sdp }, this.deps.identity.sigSk),
        "answer",
      );
    });

    pc.onLocalCandidate((candidate, mid) => {
      this.deps.sendIce({
        sessionId: this.deps.sessionId,
        candidate: { candidate, sdpMid: mid, sdpMLineIndex: DATA_CHANNEL_M_LINE_INDEX },
      });
    });

    pc.onGatheringStateChange((state) => {
      if (state !== "complete") {
        return;
      }
      // 01 §3.3 — tell the peer no more candidates are coming, so it can stop
      // waiting instead of sitting out the full ICE timeout.
      this.deps.sendIce({
        sessionId: this.deps.sessionId,
        candidate: { candidate: END_OF_CANDIDATES, sdpMid: "0", sdpMLineIndex: DATA_CHANNEL_M_LINE_INDEX },
      });
    });

    pc.onStateChange((state) => {
      switch (state) {
        case "connecting":
          this.setState("connecting", {});
          return;
        case "connected":
          // `connected` is the ICE/DTLS layer; frames only flow once the
          // DataChannel itself opens, which onOpen reports.
          return;
        case "disconnected":
          this.setState("reconnecting", {});
          return;
        case "failed":
          // STUN only: there is no relay to fall back to (00 §원칙 2).
          this.close("직결에 실패했습니다. 네트워크 환경 때문에 P2P 연결을 만들 수 없습니다.");
          return;
        case "closed":
          this.close();
          return;
        default:
          return;
      }
    });

    pc.onDataChannel((channel) => this.adoptChannel(channel));
  }

  /** The phone creates the channel; the desktop adopts whichever one arrives. */
  private adoptChannel(channel: NativeDataChannel): void {
    this.channel = channel;

    channel.onOpen(() => {
      for (const frame of this.pending.splice(0)) {
        channel.sendMessageBinary(frame);
      }
      this.setState("connected", {});
    });

    channel.onMessage((message) => {
      if (typeof message === "string") {
        // 01 §4.2 frames are binary. A text message means the peer is speaking
        // a different protocol, so it is reported rather than ignored.
        this.deps.log("warn", "mobile webrtc: text message on a binary channel discarded", {
          length: message.length,
        });
        return;
      }
      const frame = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message);
      this.frameListener?.(frame);
    });

    channel.onError((error) => {
      this.deps.log("error", "mobile webrtc: data channel error", { error });
      this.close(`데이터 채널 오류: ${error}`);
    });

    channel.onClosed(() => this.close("상대가 연결을 닫았습니다."));

    if (channel.isOpen()) {
      channel.onOpen(() => undefined);
      this.setState("connected", {});
    }
  }

  private setState(state: TransportState, detail: { error?: string }): void {
    if (this.currentState === state && !detail.error) {
      return;
    }
    this.currentState = state;
    this.stateListener?.(state, detail);
  }
}

/**
 * `node-datachannel` is an optional NATIVE dependency, so it is required at
 * runtime rather than bundled. A failure here is reported, never worked around —
 * there is no non-WebRTC path that would silently take over (00 §원칙 2).
 *
 * The Electron main process is compiled to CommonJS, where this `require` is
 * the correct call. A consumer that bundles this module to ESM must inject
 * {@link WebrtcTransportDeps.loadNative} instead: esbuild leaves an external
 * `require` in place and ESM rejects it with "Dynamic require ... is not
 * supported", which has nothing to do with the module being installed.
 */
function loadNodeDataChannel(): NativeModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("node-datachannel") as NativeModule;
  } catch (error) {
    const detail = String(error);
    const cause = detail.includes("Dynamic require")
      ? "이 모듈이 ESM으로 번들되어 런타임 require를 쓸 수 없습니다. 호출 측에서 loadNative를 주입하세요."
      : "선택 의존성이 설치되지 않았을 수 있습니다. npm install로 네이티브 모듈을 설치하세요.";
    throw new TransportUnavailableError(`모바일 직결에 필요한 node-datachannel을 불러올 수 없습니다. ${cause} (${detail})`);
  }
}
