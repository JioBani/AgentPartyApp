import {
  buildSdpPayload,
  verifySdpPayload,
  type IcePayload,
  type Identity,
  type SdpPayload,
} from "@agentparty/protocol";
import {
  MOBILE_LIMITS,
  MOBILE_STUN_SERVERS,
  type IceCandidatePair,
  type TransportKind,
  type TransportState,
} from "../../shared/mobileProtocol";
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
  getSelectedCandidatePair(): { local: NativeCandidateInfo; remote: NativeCandidateInfo } | null;
}

interface NativeCandidateInfo {
  address: string;
  port: number;
  type: string;
  transportType: string;
}

interface NativeDataChannel {
  sendMessageBinary(buffer: Uint8Array): boolean;
  close(): void;
  isOpen(): boolean;
  /** Bytes handed to the stack that have not left the machine yet. */
  bufferedAmount(): number;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (error: string) => void): void;
  onMessage(cb: (message: string | Buffer | ArrayBuffer) => void): void;
}

interface NativeModule {
  PeerConnection: new (
    name: string,
    config: { iceServers: string[]; portRangeBegin?: number; portRangeEnd?: number },
  ) => NativePeerConnection;
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
  /**
   * Overrides the 01 §6 recovery window. Exists so a test can watch the timeout
   * fire without waiting 10 real seconds — the same seam `PairingService` uses
   * for its TTL. Production never passes it.
   */
  iceRestartGraceMs?: number;
  /**
   * A router port mapping to advertise (01 §3.3, develop 1ccfadf). ICE is then
   * pinned to `internalPort` and the external `address:port` is offered as an
   * extra server-reflexive candidate, so a peer can reach this machine through
   * the mapping without any change to the hello schema.
   */
  mappedCandidate?: { internalPort: number; address: string; externalPort: number };
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

/**
 * RFC 8445 priority for a server-reflexive candidate:
 * (2^24)·type-preference + (2^8)·local-preference + (256 − component).
 * Type preference 100 is the conventional srflx value, which keeps this
 * candidate below host and above relay in the peer's checklist.
 */
const SRFLX_PRIORITY = 100 * 2 ** 24 + 65535 * 2 ** 8 + 255;

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
  private pendingBytes = 0;
  private announcedMapping = false;
  /** True once a remote offer has been applied — a further one is a restart. */
  private negotiated = false;
  private iceRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Mid libdatachannel used for the data channel; candidates must match it. */
  private dataChannelMid = "0";

  constructor(private readonly deps: WebrtcTransportDeps) {
    const native = (deps.loadNative ?? loadNodeDataChannel)();
    const mapped = deps.mappedCandidate;
    this.pc = new native.PeerConnection(`agentparty-${deps.sessionId}`, {
      iceServers: deps.iceServers ?? [...MOBILE_STUN_SERVERS],
      // Pinning ICE to the mapped local port is what makes the advertised
      // external port actually reach this socket; a random port would make the
      // extra candidate point at nothing.
      ...(mapped ? { portRangeBegin: mapped.internalPort, portRangeEnd: mapped.internalPort } : {}),
    });
    this.wire(this.pc);
  }

  get state(): TransportState {
    return this.currentState;
  }

  /**
   * The ICE pair in use, once ICE has settled. `undefined` before that and
   * after close — reporting a stale pair would misdescribe a dead session.
   */
  selectedCandidatePair(): IceCandidatePair | undefined {
    if (!this.pc || this.closed) {
      return undefined;
    }
    try {
      const pair = this.pc.getSelectedCandidatePair();
      if (!pair) {
        return undefined;
      }
      return { local: describeCandidate(pair.local), remote: describeCandidate(pair.remote) };
    } catch (error) {
      // Querying a connection that is tearing down can throw; that is not
      // worth failing a status read over.
      this.deps.log("debug", "mobile webrtc: candidate pair unavailable", { error: String(error) });
      return undefined;
    }
  }

  /**
   * Verifies and applies the phone's offer, then answers.
   *
   * A SECOND offer on the same session is the phone's `restartIce()` (01 §6).
   * It is applied to the same PeerConnection on purpose: an ICE restart is the
   * same session with the same keys (01 §4.1), so the secure session's counter
   * and the RPC state above it carry straight over and nothing needs replaying.
   * Building a new connection here would silently invalidate both.
   *
   * @throws {TransportSecurityError} when the signature is invalid or the SDP's
   *   fingerprint does not match the signed one. The session must be abandoned:
   *   retrying would negotiate with the same impostor. This is checked on a
   *   restart exactly as on the first offer — a restart is an unauthenticated
   *   moment otherwise, and the peer's key is the only thing that makes it safe.
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
    if (this.negotiated) {
      // The peer discards every candidate it knew when it restarts (new
      // ice-ufrag), so the router mapping has to be offered again — it is not
      // something ICE re-gathers on its own.
      this.announcedMapping = false;
      this.deps.log("info", "mobile webrtc: accepting an ICE restart on the same session", {
        session: this.deps.sessionId,
      });
    }
    this.negotiated = true;
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
      this.pendingBytes += frame.byteLength;
      this.enforceSendCeiling();
      return;
    }
    this.channel.sendMessageBinary(frame);
    this.enforceSendCeiling();
  }

  /**
   * Bytes accepted from above but not yet on the wire: frames still held for an
   * unopened channel, plus whatever the stack has buffered.
   */
  queuedBytes(): number {
    if (this.closed) {
      return 0;
    }
    let buffered = 0;
    try {
      buffered = this.channel?.bufferedAmount() ?? 0;
    } catch (error) {
      // A channel being torn down can refuse the query. The pending count alone
      // is still a truthful lower bound, so the status read survives; it is
      // logged rather than swallowed because a persistently unreadable channel
      // would make the ceiling below unenforceable.
      this.deps.log("debug", "mobile webrtc: bufferedAmount unavailable", { error: String(error) });
    }
    return this.pendingBytes + buffered;
  }

  /**
   * 04 §성능·안전 — past the 2MB ceiling the session is dropped instead of
   * buffered further. See `MOBILE_LIMITS.sessionSendQueueMaxBytes` for why
   * dropping is the safe choice: the phone rewinds and loses nothing.
   */
  private enforceSendCeiling(): void {
    const queued = this.queuedBytes();
    if (queued <= MOBILE_LIMITS.sessionSendQueueMaxBytes) {
      return;
    }
    this.deps.log("warn", "mobile webrtc: send queue over the ceiling, dropping the session", {
      session: this.deps.sessionId,
      queued,
      ceiling: MOBILE_LIMITS.sessionSendQueueMaxBytes,
    });
    this.close(
      `보내지 못한 데이터가 ${Math.round(queued / 1024)}KB를 넘어 연결을 끊었습니다. ` +
        "폰이 다시 연결하면 놓친 내용부터 이어받습니다.",
    );
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
    this.pendingBytes = 0;
    this.clearIceRecoveryTimer();
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
      // Remember the mid the stack actually used, so the mapped candidate is
      // attached to the same m-section rather than an assumed "0".
      this.dataChannelMid = mid;
      this.deps.sendIce({
        sessionId: this.deps.sessionId,
        candidate: { candidate, sdpMid: mid, sdpMLineIndex: DATA_CHANNEL_M_LINE_INDEX },
      });
    });

    pc.onGatheringStateChange((state) => {
      if (state !== "complete") {
        return;
      }
      // The router mapping is not something ICE can discover on its own, so it
      // is announced as an ordinary srflx candidate (develop 1ccfadf). No schema
      // change: the peer treats it like any other remote candidate, and a check
      // arriving through it shows up on this side as peer-reflexive.
      this.announceMappedCandidate();
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
          // `connected` is the ICE/DTLS layer; on the FIRST connect frames only
          // flow once the DataChannel opens, which onOpen reports. After a
          // recovery the channel never closed, so onOpen will not fire again and
          // this is the only signal that the session is usable — without it the
          // status would stay "reconnecting" for a link that is working.
          this.clearIceRecoveryTimer();
          if (this.channel?.isOpen()) {
            this.setState("connected", {});
          }
          return;
        case "disconnected":
          this.setState("reconnecting", {});
          this.startIceRecoveryTimer();
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

  /**
   * 01 §6 — ICE may sit `disconnected` for `iceRestartGraceMs` before the
   * session is given up. The phone's `restartIce()` is the opportunistic path
   * that recovers within this window; when it does not (a hard handover, where
   * the old interface is simply gone) the confirmed normal path is a new
   * session plus a §5.3 rewind, so this closes to let that start rather than
   * holding a dead connection open indefinitely.
   */
  private startIceRecoveryTimer(): void {
    if (this.iceRecoveryTimer) {
      return;
    }
    const graceMs = this.deps.iceRestartGraceMs ?? MOBILE_LIMITS.iceRestartGraceMs;
    this.iceRecoveryTimer = setTimeout(() => {
      this.iceRecoveryTimer = undefined;
      if (this.closed || this.currentState !== "reconnecting") {
        return;
      }
      this.deps.log("info", "mobile webrtc: ICE did not recover in time, ending the session", {
        session: this.deps.sessionId,
        graceMs,
      });
      this.close("네트워크가 바뀌어 연결이 끊어졌습니다. 폰이 다시 연결하면 이어집니다.");
    }, graceMs);
    // Node keeps the process alive for a pending timer; a grace window is not a
    // reason for the app to refuse to exit.
    this.iceRecoveryTimer.unref?.();
  }

  private clearIceRecoveryTimer(): void {
    if (this.iceRecoveryTimer) {
      clearTimeout(this.iceRecoveryTimer);
      this.iceRecoveryTimer = undefined;
    }
  }

  /**
   * Offers the router mapping as a server-reflexive candidate. Sent once, after
   * gathering completes, so it cannot be mistaken for something ICE found.
   */
  private announceMappedCandidate(): void {
    const mapped = this.deps.mappedCandidate;
    if (!mapped || this.announcedMapping) {
      return;
    }
    this.announcedMapping = true;
    const candidate =
      `candidate:ap${mapped.externalPort} 1 udp ${SRFLX_PRIORITY} ` +
      `${mapped.address} ${mapped.externalPort} typ srflx raddr 0.0.0.0 rport 0`;
    this.deps.sendIce({
      sessionId: this.deps.sessionId,
      candidate: { candidate, sdpMid: this.dataChannelMid, sdpMLineIndex: DATA_CHANNEL_M_LINE_INDEX },
    });
    this.deps.log("info", "mobile webrtc advertised the router mapping", {
      address: mapped.address,
      port: mapped.externalPort,
    });
  }

  /** The phone creates the channel; the desktop adopts whichever one arrives. */
  private adoptChannel(channel: NativeDataChannel): void {
    this.channel = channel;

    const flushPending = () => {
      for (const frame of this.pending.splice(0)) {
        channel.sendMessageBinary(frame);
      }
      // The bytes moved from `pending` into the stack's own buffer, which
      // `queuedBytes()` reads directly — leaving the count here would double it.
      this.pendingBytes = 0;
      this.setState("connected", {});
    };

    channel.onOpen(flushPending);

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
      // The native channel may already be open when it is handed to us. The
      // mandatory first ctl.lock frame is queued before that hand-off, so only
      // setting the state here strands the frame forever and the phone times
      // out waiting for it. Use the exact same flush path as the callback.
      flushPending();
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

function describeCandidate(info: NativeCandidateInfo) {
  return { address: info.address, port: info.port, type: info.type, transportType: info.transportType };
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
