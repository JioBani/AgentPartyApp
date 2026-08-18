import type {
  DiagnosticReason,
  GatewayStatus,
  MobileConnectionLockKind,
  MobileConnectionLockStatus,
  MobilePlatform,
  MobileSettings,
  NatDiagnostics,
  PairingState,
  TransportKind,
  TrustedDevice,
  ValueStream,
} from "../../shared/mobileProtocol";

/**
 * The pipe ⇄ app boundary (`07-역할-분담.md`).
 *
 * Everything below is app-domain agnostic on purpose: the gateway moves bytes,
 * proves identity, encrypts, sequences events and routes envelopes. It does not
 * know what `party.list` means, what a workspace is beyond an opaque string, or
 * what a snapshot contains. The app member registers handlers, emits events and
 * builds the UI on top; the pipe member owns everything inside
 * `src/main/mobile/`.
 *
 * Adding a member to this interface is a protocol-owner decision — request it
 * from `develop` rather than reaching into the pipe.
 */
export interface MobileGateway {
  // -- lifecycle ------------------------------------------------------------

  /**
   * Loads identity + trusted devices, then (when {@link MobileSettings.enabled}
   * is true) opens the always-on outbound signaling socket. Safe to call twice;
   * the second call resolves once the first has settled.
   *
   * Rejects when identity storage or the protocol library fails. It never
   * degrades into a "running but deaf" state — a failure here must reach the
   * user (AGENTS.md).
   */
  start(options?: MobileGatewayStartOptions): Promise<void>;

  /** Closes sessions, signaling and NAT mappings. Idempotent. */
  stop(): Promise<void>;

  // -- RPC ------------------------------------------------------------------

  /**
   * Registers the handler for one method name (01 §5.4). The pipe decrypts,
   * validates the envelope, applies the response timeout and serializes the
   * result; the handler sees plain params.
   *
   * @returns an unregister function.
   * @throws when `method` is reserved by the pipe (`sys.*`, `push.register`) or
   *   already registered — a collision is a startup error, not a silent
   *   last-writer-wins.
   */
  onRequest(method: string, handler: MobileRequestHandler): () => void;

  /** Method names currently answerable, including the pipe's reserved ones. */
  registeredMethods(): string[];

  // -- events ---------------------------------------------------------------

  /**
   * Publishes one desktop→phone event (01 §5.1). The pipe assigns `seq`, stores
   * it in the resume ring buffer and pushes it to every session subscribed to
   * `scope.workspacePath`. An event with no scope is global and reaches every
   * session.
   *
   * No-op with no allocation when no session is connected (04 §성능·안전), so
   * it is safe on the hot `broadcastToWorkspace` path.
   */
  emit(type: string, payload: unknown, scope?: MobileEventScope): void;

  /**
   * Supplies the full-state payload used when a phone's `resume` falls outside
   * the ring buffer (01 §5.3). Its content is the app member's choice — the
   * pipe only serializes and chunks it. Without a provider the pipe answers
   * such a resume with an explicit error instead of an empty snapshot.
   */
  setSnapshotProvider(provider: MobileSnapshotProvider): void;

  // -- pairing and devices --------------------------------------------------

  pairing: MobilePairingApi;

  /** Desktop-owned lock configuration. Secrets are accepted only here and are never readable back. */
  connectionLock: MobileConnectionLockApi;

  // -- sessions -------------------------------------------------------------

  /**
   * Drops one phone session immediately (04 §성능·안전 "즉시 끊기"). The phone
   * may re-dial; use {@link MobilePairingApi.revoke} to end the trust instead.
   * Unknown ids resolve without error — the session is already gone.
   */
  disconnect(sessionId: string, reason?: string): Promise<void>;

  // -- status, settings, diagnostics ---------------------------------------

  /** Synchronous read for `GET /api/mobile/status`. */
  getStatus(): GatewayStatus;

  /** Push view of the same value. `status$.current === getStatus()`. */
  status$: ValueStream<GatewayStatus>;

  /** Current persisted settings. */
  getSettings(): MobileSettings;

  /**
   * Applies a settings patch and persists it. Toggling `enabled` or changing
   * `signalingUrl` reconnects; live sessions survive a URL change until they
   * drop on their own.
   */
  updateSettings(patch: Partial<MobileSettings>): Promise<MobileSettings>;

  /**
   * Runs STUN probes plus a port-mapping attempt and returns the verdict
   * (04 §NAT 매핑·진단). Concurrent calls share one in-flight run.
   */
  diagnostics(): Promise<NatDiagnostics>;

  push: MobilePushApi;
}

export interface MobileConnectionLockApi {
  status(): MobileConnectionLockStatus;
  configure(kind: MobileConnectionLockKind, secret: string): Promise<MobileConnectionLockStatus>;
  clear(): Promise<MobileConnectionLockStatus>;
}

export interface MobileGatewayStartOptions {
  /**
   * Overrides the persisted signaling URL for this run (QA points it at a local
   * server). Not written back to settings.
   */
  signalingUrl?: string;
  /** Overrides the persisted push relay URL for this run. */
  pushUrl?: string;
  /**
   * Starts even when {@link MobileSettings.enabled} is false. Used by QA to
   * exercise the pipe without flipping the user's setting.
   */
  force?: boolean;
  /**
   * Overrides the QR lifetime for this run. **Development only.**
   *
   * The QR is the pairing capability itself, so its validity window is the
   * window in which a leaked screenshot still works (02 §T3). Two minutes is
   * the protocol value and the default; anything longer is announced through
   * `onSecurityWarning` and capped, and must never ship enabled.
   */
  pairingTtlMs?: number;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export type MobileRequestHandler = (params: unknown, context: RequestContext) => Promise<unknown> | unknown;

/** What the pipe knows about one incoming request. */
export interface RequestContext {
  /** Paired phone that sent it — already identity-verified by the pipe. */
  deviceId: string;
  /** Human-facing name from the trust record. */
  deviceName: string;
  /** Live session the request arrived on; pass to {@link MobileGateway.disconnect}. */
  sessionId: string;
  /** Envelope `id`, for correlating logs with the phone. */
  requestId: string;
  method: string;
  /**
   * Lifted from a string `workspacePath` field in the request params, when
   * present (04 §3). The pipe does not interpret the value — the app routes it
   * through `engineFor(workspacePath)`.
   */
  workspacePath: string | undefined;
  transport: TransportKind;
  receivedAt: number;
  /**
   * Aborts when the phone disconnects or the response deadline passes, so a
   * long handler can stop work nobody will receive.
   */
  signal: AbortSignal;
  /**
   * The event `seq` at the moment it is called. The phone takes it to mean
   * "this answer already includes everything up to N" and applies only later
   * events.
   *
   * A FUNCTION, not a value, so the CALLER chooses the instant — and which
   * instant is right depends on what the handler returns.
   *
   * A handler that READS STATE (a transcript, a member list) must call it
   * BEFORE the read. State and seq cannot be captured atomically, so the read
   * lands at some instant T and one of two errors is unavoidable:
   *   - seq from before the read: events in (before, T] are in the returned
   *     state and are replayed as well — DUPLICATES.
   *   - seq from after the read: events in (T, after] are NOT in the returned
   *     state, yet the phone skips them — SILENT LOSS.
   * 01 §5.3 requires zero loss, so the duplicate is chosen. `sendSnapshot`
   * makes exactly this trade for exactly this reason; a handler that reports
   * the later seq reintroduces the loss the snapshot path exists to avoid.
   *
   * A handler that reads no state has no T and may call it anywhere.
   *
   * This is the counter, NOT anything derived from the ring buffer's current
   * contents. The buffer is trimmed, so what it holds is not the history; a
   * baseline read from it could move backwards as entries are dropped, and the
   * phone would re-apply everything it had already merged.
   */
  currentSeq(): number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface MobileEventScope {
  /**
   * Restricts delivery to sessions that subscribed to this workspace
   * (01 §5.2). Omit for genuinely global events (usage, gateway status).
   */
  workspacePath?: string;
}

export type MobileSnapshotProvider = (context: SnapshotContext) => Promise<unknown> | unknown;

export interface SnapshotContext {
  deviceId: string;
  sessionId: string;
  /** Workspaces the session is subscribed to at snapshot time. */
  workspaces: string[];
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export interface MobilePairingApi {
  /**
   * Issues a single-use QR valid for two minutes (01 §2.1) and registers it
   * with the signaling server. Opening a second QR cancels the first.
   */
  openQr(): Promise<PairingSession>;

  /**
   * User pressed "the codes match". Sends blob2 and completes the handshake.
   * @throws when no pairing is awaiting confirmation.
   */
  confirm(): Promise<void>;

  /** Aborts the current pairing and invalidates its token. Idempotent. */
  cancel(): Promise<void>;

  /** Live pairing state, readable synchronously for the HTTP status route. */
  state$: ValueStream<PairingState>;

  /** Currently trusted phones. */
  devices(): TrustedDevice[];

  /**
   * Forgets a phone, bumps `trustEpoch` so its old `hello` is rejected
   * (01 §2.3), and drops any live session it holds.
   */
  revoke(deviceId: string): Promise<void>;

  /** Renames a trusted phone in the desktop's list. Does not affect identity. */
  rename(deviceId: string, name: string): Promise<void>;
}

export interface PairingSession {
  /** The `agentparty://pair?…` string to render as a QR. */
  qr: string;
  expiresAt: number;
  /**
   * Emits the 4-digit confirmation code once the phone's blob1 verifies
   * (01 §2.2). Empty string until then.
   */
  code$: ValueStream<string>;
  /**
   * Resolves when the phone is trusted, rejects on expiry, cancellation or a
   * verification failure. The rejection message is user-facing.
   */
  completed: Promise<TrustedDevice>;
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/**
 * Why a push could not be sent. Codes exist so the app can branch without
 * matching on message text — develop asked specifically for `peer_connected`,
 * and a single code would have left every other case to string matching.
 */
export type PushErrorCode =
  /** The phone is connected; it already received this over the E2E channel. */
  | "peer_connected"
  /** No trust record for that deviceId. */
  | "not_paired"
  /** Paired, but the phone has not sent `push.register` yet. */
  | "no_handle"
  /** No relay URL in settings. */
  | "not_configured"
  /** The relay applied its per-device rate limit (01 §7). */
  | "rate_limited"
  /** The relay answered, but refused. */
  | "relay_refused"
  /** The relay could not be reached at all. */
  | "transport_failed";

export class PushError extends Error {
  constructor(
    readonly code: PushErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PushError";
  }
}

export interface MobilePushApi {
  /**
   * Records a phone's push handle. Normally called by the pipe itself when the
   * phone sends `push.register` (01 §7); exposed so the app can inspect or
   * clear it.
   */
  registerHandle(deviceId: string, platform: MobilePlatform, handle: string): void;

  /**
   * Seals `payload` to the phone's `kx` key, signs the request and POSTs it to
   * the push relay.
   *
   * @throws {PushError} with a {@link PushErrorCode}. `peer_connected` is not
   *   really a failure — the phone already has this over the live channel — so
   *   the app should treat it as "already delivered" rather than surface it.
   */
  notify(deviceId: string, payload: PushPayload): Promise<void>;
}

/**
 * 01 §7 — the only notification the protocol defines. `type` is a literal
 * rather than a free string because the phone's NSE validates it against the
 * shared schema: anything else would be sealed, delivered, and then dropped
 * unopened on the device.
 */
export interface PushPayload {
  type: "approval";
  title: string;
  body: string;
  /** Correlates the notification with the E2E request the phone will confirm. */
  requestId: string;
  /** Unix ms after which the phone should stop showing it. */
  expiresAt: number;
}

/**
 * Everything the real pipe needs from the host app. Kept to primitives and
 * narrow function types so `src/main/mobile/` stays testable without Electron
 * and portable across Windows/macOS/Linux (06 §데스크톱).
 */
export interface MobileGatewayDeps {
  /** Directory for the identity blob and trust store (Electron `userData`). */
  userDataPath: string;
  /**
   * OS keychain wrapper, normally Electron's `safeStorage`. When encryption is
   * unavailable (a Linux box with no libsecret/kwallet), the pipe stores the
   * identity unencrypted **and** reports it through `onSecurityWarning` — it
   * does not fail silently and does not pretend to be encrypted (06).
   */
  secretCipher: SecretCipher;
  /** Structured logger; the pipe never writes to the console directly. */
  log: (level: "debug" | "info" | "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
  /** Surfaces a degraded-security condition to the user (AGENTS.md). */
  onSecurityWarning: (warning: { code: string; message: string }) => void;
  /** Persisted settings, owned by the app's settings store. */
  readSettings: () => MobileSettings;
  writeSettings: (settings: MobileSettings) => void;
  /** Default `deviceName` when the user has not set one (e.g. the hostname). */
  defaultDeviceName: string;
  /** App version reported in `sys.info`. */
  appVersion: string;
  /**
   * Supplies the `node-datachannel` module. Electron main is CommonJS, where
   * the pipe requires it itself, so this is normally omitted. A host that
   * bundles the pipe to ESM MUST provide it: an external `require` left in ESM
   * output fails with "Dynamic require ... is not supported", which looks like
   * a missing install but is not.
   */
  loadWebrtcModule?: () => unknown;
}

/**
 * Structurally identical to Electron's `safeStorage`, so it can be passed
 * straight through. The API is string-oriented, so the pipe base64-encodes key
 * bytes before handing them over rather than inventing a Buffer variant that
 * the platform does not offer.
 */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

export interface MockMobileGatewayOptions {
  settings?: Partial<MobileSettings>;
  /** Devices present before any pairing happens (QA fixtures). */
  devices?: TrustedDevice[];
  /** Fixed confirmation code so UI tests can assert on it. */
  confirmCode?: string;
}

export interface CreateMobileGatewayOptions {
  /**
   * `"mock"` selects the in-memory simulator. There is no automatic fallback:
   * asking for `"real"` and getting a mock would hide a broken pipe behind a
   * UI that looks connected.
   */
  implementation: "real" | "mock";
  deps?: MobileGatewayDeps;
  /**
   * Seeds the mock's settings and fixtures at construction, so the caller does
   * not have to follow `createMobileGateway` with an `updateSettings()` call
   * that the real gateway would not need (it reads {@link
   * MobileGatewayDeps.readSettings} itself). Ignored by the real gateway.
   */
  mock?: MockMobileGatewayOptions;
}

/**
 * The mock's phone simulator as the APP sees it, for `/api/qa/mobile/*`.
 *
 * It lives in this file — the pipe's protocol-free contract — rather than
 * beside the mock, because the app must be able to type against it in a build
 * that has no `@agentparty/protocol` and therefore never compiles the mock at
 * all (`docs/mobile-gateway-wiring.md` §패키지가 없을 때).
 *
 * The event lists are `unknown[]` for the same reason: the app only forwards
 * them as JSON, so the wire shape stays owned by `@agentparty/protocol`, and
 * `MockPhoneControls` restates them at their real type for the pipe.
 */
export interface MockControls {
  /** Stands in for the phone scanning the open QR. Moves pairing to `awaitingConfirm`. */
  scanQr(options?: { deviceName?: string; deviceId?: string }): void;
  /** Fails the pairing the way a bad code or expiry would. */
  failPairing(error: string): void;
  /** Connects a trusted device, returning the new session id. */
  connect(options?: { deviceId?: string; transport?: TransportKind; workspaces?: string[] }): string;
  /** 01 §5.2 — replaces a session's workspace subscription set. */
  subscribe(sessionId: string, workspaces: string[]): void;
  /** Dispatches a request exactly as an incoming envelope would. */
  request(method: string, params?: unknown, options?: { sessionId?: string }): Promise<unknown>;
  /** Invokes the registered snapshot provider, as an out-of-window `resume` would. */
  snapshot(sessionId?: string): Promise<unknown>;
  /** Events the app has emitted, in order, after workspace filtering is applied. */
  deliveredTo(sessionId: string): unknown[];
  /** Every event emitted, regardless of subscription. */
  emitted(): unknown[];
  /** Sets what {@link MobileGateway.diagnostics} will report. */
  setDiagnostics(reason: DiagnosticReason, patch?: Partial<NatDiagnostics>): void;
  /** Clears sessions, devices, events and pairing without restarting. */
  reset(): void;
}
