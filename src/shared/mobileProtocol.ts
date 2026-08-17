/**
 * Mobile link protocol contract — the TypeScript half of
 * `AgentPartyMobile/docs/아키텍처/01-프로토콜.md`.
 *
 * This module is the single source for every value the desktop and the phone
 * must agree on byte-for-byte, plus the renderer-facing shapes of the mobile
 * settings/status/diagnostics screens. It is imported by the main process, the
 * renderer, and the automation API, so it must stay free of Node and Electron
 * imports.
 *
 * Wire-format definitions do NOT live here. Envelopes, reserved method names,
 * key derivation, sealing, framing and every byte-level constant come from
 * `@agentparty/protocol`, which the phone's Dart pipe is held to by the same
 * test vectors. Restating any of it here would create a second source of truth
 * that drifts silently. This file holds only what that package does not own:
 * the desktop's own status, settings and diagnostics shapes.
 */

/** 01 §6 — STUN only. There is deliberately no TURN entry. */
export const MOBILE_STUN_SERVERS = [
  "stun:stun.cloudflare.com:3478",
  "stun:stun.l.google.com:19302",
] as const;

/**
 * Built-in operator signaling addresses, tried after the user's own setting
 * (01 ddc2563).
 *
 * The signaling address is NOT part of trust: a desktop may move between
 * these without any phone re-pairing. The list exists so an operator
 * migration, or a host that simply stops answering, costs one backoff step
 * instead of a permanent outage.
 */
export const MOBILE_SIGNALING_FALLBACKS = ["wss://sig.agentparty.app/v1/ws"] as const;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * 04 §NAT 매핑·진단 — why a direct connection is (or is not) expected to work.
 * The Korean guidance text for each code belongs to the renderer, not here.
 */
export const DIAGNOSTIC_REASONS = [
  "ok_direct",
  "no_upnp",
  "double_nat",
  "cgnat_100_64",
  "private_wan",
  "symmetric_nat",
  "ipv6_only",
  "unknown",
] as const;
export type DiagnosticReason = (typeof DIAGNOSTIC_REASONS)[number];

/** Observed NAT mapping behaviour, derived from two STUN probes. */
export type NatMappingKind = "endpointIndependent" | "addressDependent" | "portDependent" | "blocked" | "unknown";

export interface NatPortMapping {
  protocol: "udp";
  internalPort: number;
  externalPort: number;
  externalAddress: string | undefined;
  /** Which mapping protocol answered. */
  via: "upnp" | "nat-pmp" | "pcp";
  expiresAt: number;
}

export interface NatDiagnostics {
  /** Primary verdict shown to the user. */
  reason: DiagnosticReason;
  ranAt: number;
  /** STUN-reflexive address of this machine, if any probe answered. */
  wanAddress: string | undefined;
  /** True when `wanAddress` is RFC1918/CGNAT/link-local rather than public. */
  wanIsPrivate: boolean;
  /** True when the local interface address differs from `wanAddress`. */
  behindNat: boolean;
  mappingKind: NatMappingKind;
  ipv6Available: boolean;
  /** Result of the port-mapping attempt; `undefined` when none was tried. */
  portMapping: NatPortMapping | undefined;
  /** Per-probe detail for the diagnostics screen and for bug reports. */
  probes: NatDiagnosticProbe[];
  /** Populated when a step failed; never swallowed silently (AGENTS.md). */
  errors: string[];
}

export interface NatDiagnosticProbe {
  name: string;
  ok: boolean;
  detail: string;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Devices, sessions, status
// ---------------------------------------------------------------------------

export type MobilePlatform = "android" | "ios";

/** 01 §2.3 — one paired phone as the desktop stores it. */
export interface TrustedDevice {
  deviceId: string;
  /** base64url Ed25519 public key. */
  sigPk: string;
  /** base64url X25519 public key. */
  kxPk: string;
  name: string;
  pairedAt: number;
  epoch: number;
  lastSeenAt: number;
  /** Push handle registered by the phone through `push.register` (01 §7). */
  push: { platform: MobilePlatform; handle: string; registeredAt: number } | undefined;
}

/** 01 §6 — which pipe carries the secure frames. */
export type TransportKind = "lanDirect" | "directViaRendezvous" | "userRelay";

export type TransportState = "connecting" | "connected" | "reconnecting" | "closed";

export type MobileConnectionLockKind = "pin" | "pattern";

export interface MobileConnectionLockStatus {
  configured: boolean;
  kind: MobileConnectionLockKind | null;
}

export type SignalingState = "disabled" | "connecting" | "authenticating" | "connected" | "backoff" | "failed";

/** A live phone session as the desktop sees it. */
export interface MobileSessionStatus {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  transport: TransportKind;
  state: TransportState;
  /** True only after this secure session has passed the desktop connection lock. */
  lockAuthenticated: boolean;
  startedAt: number;
  /** Last event `seq` acknowledged as delivered to this session. */
  lastDeliveredSeq: number;
  /** Workspaces this session subscribed to; empty means it receives no events. */
  subscribedWorkspaces: string[];
  /** 04 §성능·안전 — drives the desktop's "mobile is driving this app" badge. */
  inFlightRequests: number;
  lastRequestAt: number | undefined;
  lastRequestMethod: string | undefined;
  /** Bytes queued but not yet handed to the transport (backpressure view). */
  queuedBytes: number;
  /**
   * The ICE pair actually carrying this session, once one is selected. The
   * `type` pair is what tells a diagnosis apart: host/host is a LAN, srflx or
   * prflx means a NAT was traversed, and relay would mean a TURN server —
   * which this system does not use, so it should never appear.
   */
  candidatePair: IceCandidatePair | undefined;
}

export interface IceCandidateInfo {
  address: string;
  port: number;
  /** `host` | `srflx` | `prflx` | `relay`. */
  type: string;
  transportType: string;
}

export interface IceCandidatePair {
  local: IceCandidateInfo;
  remote: IceCandidateInfo;
}

export type PairingPhase =
  | "idle"
  | "awaitingScan"
  | "awaitingConfirm"
  | "confirmed"
  | "completed"
  | "expired"
  | "cancelled"
  | "failed";

/** Everything the pairing screen needs, readable at any time over HTTP. */
export interface PairingState {
  phase: PairingPhase;
  /** The `agentparty://pair?…` string; only present while a QR is open. */
  qr: string | undefined;
  expiresAt: number | undefined;
  /** 4-digit confirmation code, once the phone's blob1 has been verified. */
  code: string | undefined;
  /** Name the phone announced in blob1. */
  peerName: string | undefined;
  peerDeviceId: string | undefined;
  /** Set when `phase` is `failed`; surfaced verbatim in the UI. */
  error: string | undefined;
}

export interface GatewayStatus {
  /** False until `start()` resolves and after `stop()`. */
  running: boolean;
  /** Changes every desktop process start; the phone keys `resume` on it (01 §5.2). */
  bootId: string;
  /** This desktop's identity, derived from its Ed25519 public key (01 §1). */
  deviceId: string;
  deviceName: string;
  signaling: SignalingState;
  signalingUrl: string;
  /** Populated while `signaling` is `backoff` or `failed`. */
  signalingError: string | undefined;
  sessions: MobileSessionStatus[];
  trustedDeviceCount: number;
  connectionLock: MobileConnectionLockStatus;
  pairing: PairingState;
  /** Ring buffer window, mirrored in `sys.info`. */
  events: { seq: number; minSeq: number; maxSeq: number; count: number };
  /** Last completed diagnostics run; `undefined` until one has run. */
  lastDiagnostics: NatDiagnostics | undefined;
  /**
   * The most recent relay the pipe refused to act on, or `undefined` if none.
   *
   * These refusals cannot be answered: a relay from a device the desktop does
   * not trust cannot be replied to, because sealing a `bye` needs that
   * device's `kxPk` and there is no trust record to take it from. So the phone
   * sees no response at all and reports a bare "internal" failure. Without
   * this field the only trace is a desktop log line a QA run cannot read, and
   * the two ends disagree about whether anything happened.
   */
  lastRelayRejection: RelayRejection | undefined;
}

export interface RelayRejection {
  /** Sender deviceId as the server reported it. */
  from: string;
  /** Relay kind (`hello`, `offer`, …) — never the sealed contents. */
  kind: string;
  reason: "unpaired_device" | "undecryptable" | "handler_failed";
  detail: string;
  at: number;
}

/** User-editable gateway settings (04 §5 `POST /api/mobile/settings`). */
export interface MobileSettings {
  /** Master switch. When false the gateway never opens an outbound socket. */
  enabled: boolean;
  /** `wss://…` rendezvous server. */
  signalingUrl: string;
  /** `https://…` push relay base URL (01 §7). */
  pushUrl: string;
  /** Name shown on the phone for this desktop. */
  deviceName: string;
  /** 04 §NAT — attempt UPnP/NAT-PMP/PCP mapping when a phone is paired. */
  natMappingEnabled: boolean;
}

export const MOBILE_SETTINGS_DEFAULTS: MobileSettings = {
  enabled: false,
  signalingUrl: "wss://sig.agentparty.app",
  pushUrl: "https://push.agentparty.app",
  deviceName: "",
  natMappingEnabled: true,
};

/**
 * Limits the pipe enforces itself. Everything the WIRE defines (frame size,
 * chunking, ring-buffer depth) lives in `@agentparty/protocol` instead — these
 * two are desktop-side policy, and restating wire limits here is how the two
 * copies drift apart.
 */
export const MOBILE_LIMITS = {
  /**
   * 04 §성능·안전 — bytes accepted for one phone but not yet on the wire. Past
   * this the session is dropped rather than buffered further: holding more
   * would trade bounded memory for an unbounded queue on a link that is
   * evidently not draining. The phone loses nothing, because it rewinds on
   * reconnect and the ring buffer replays what it missed (01 §5.3). That
   * rewind is precisely what makes dropping safe here.
   */
  sessionSendQueueMaxBytes: 2 * 1024 * 1024,
  /**
   * 01 §6 — how long ICE may sit `disconnected` before the session is given
   * up. Recovering in place keeps the session keys (01 §4.1: an ICE restart is
   * the SAME session); past this the phone is expected to build a new session
   * from §3.3 and rewind, so holding the old one open only delays that.
   */
  iceRestartGraceMs: 10_000,
} as const;

/**
 * Convention (NOT part of the wire envelope): a request whose params carry a
 * string `workspacePath` is routed by the app to that workspace's engine
 * (04 §3). The pipe only lifts the field into `RequestContext`; it never
 * interprets the value, and the protocol package knows nothing about it.
 */
export const WORKSPACE_PARAM_FIELD = "workspacePath";

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/**
 * Minimal push-value contract used instead of an RxJS `Observable`. The app
 * repository has no reactive dependency and the mobile pipe is not a good
 * reason to add one; `current` keeps synchronous HTTP reads (`GET
 * /api/mobile/status`) a plain property access.
 */
export interface ValueStream<T> {
  /** The latest value. Always defined — streams are seeded at construction. */
  readonly current: T;
  /** Invokes `listener` on every subsequent value. Returns an unsubscribe fn. */
  subscribe(listener: (value: T) => void): () => void;
}
