import { EVENT_BUFFER_MAX_COUNT, PAIR_TTL_MS, RESERVED_METHODS, isReservedMethod, type RpcEvent } from "@agentparty/protocol";
import {
  DIAGNOSTIC_REASONS,
  MOBILE_SETTINGS_DEFAULTS,
  type DiagnosticReason,
  type GatewayStatus,
  type MobilePlatform,
  type MobileSettings,
  type NatDiagnostics,
  type PairingState,
  type TransportKind,
  type TrustedDevice,
  type ValueStream,
} from "../../shared/mobileProtocol";
import type {
  MobileEventScope,
  MobileGateway,
  MobileGatewayStartOptions,
  MobilePairingApi,
  MobilePushApi,
  MobileRequestHandler,
  MobileSnapshotProvider,
  PairingSession,
  RequestContext,
} from "./mobileGateway";
import { MutableValueStream } from "./valueStream";

/**
 * In-memory {@link MobileGateway} with no sockets, no crypto and no phone.
 *
 * It exists so the app member can build the pairing/diagnostics/device UI, the
 * automation routes and the method handlers before the real pipe exists, and so
 * QA can drive those paths deterministically afterwards. Every value is
 * synthetic and visibly marked (`mock-…` ids) — the mock must never be mistaken
 * for a working link.
 *
 * The extra {@link MockMobileGateway.mock} surface is the phone simulator: it
 * is what a real phone would do, expressed as direct calls.
 */
export interface MockMobileGateway extends MobileGateway {
  mock: MockControls;
}

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
  deliveredTo(sessionId: string): RpcEvent[];
  /** Every event emitted, regardless of subscription. */
  emitted(): RpcEvent[];
  /** Sets what {@link MobileGateway.diagnostics} will report. */
  setDiagnostics(reason: DiagnosticReason, patch?: Partial<NatDiagnostics>): void;
  /** Clears sessions, devices, events and pairing without restarting. */
  reset(): void;
}

export interface MockMobileGatewayOptions {
  settings?: Partial<MobileSettings>;
  /** Devices present before any pairing happens (QA fixtures). */
  devices?: TrustedDevice[];
  /** Fixed confirmation code so UI tests can assert on it. */
  confirmCode?: string;
}

interface MockSession {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  transport: TransportKind;
  startedAt: number;
  workspaces: string[];
  lastDeliveredSeq: number;
  inFlightRequests: number;
  lastRequestAt: number | undefined;
  lastRequestMethod: string | undefined;
  delivered: RpcEvent[];
}

const MOCK_BOOT_ID = "mock-boot";
const MOCK_DEVICE_ID = "mock-desktop-000000000";

export function createMockMobileGateway(options: MockMobileGatewayOptions = {}): MockMobileGateway {
  return new MockGateway(options);
}

class MockGateway implements MockMobileGateway {
  private readonly handlers = new Map<string, MobileRequestHandler>();
  private readonly devicesById = new Map<string, TrustedDevice>();
  private readonly sessions = new Map<string, MockSession>();
  private readonly events: RpcEvent[] = [];
  private readonly statusStream: MutableValueStream<GatewayStatus>;
  private readonly pairingStream: MutableValueStream<PairingState>;
  private readonly codeStream = new MutableValueStream<string>("");
  private readonly confirmCode: string;

  private settings: MobileSettings;
  private snapshotProvider: MobileSnapshotProvider | undefined;
  private diagnosticsResult: NatDiagnostics;
  private running = false;
  private seq = 0;
  private counter = 0;
  private pendingPairing: { resolve: (device: TrustedDevice) => void; reject: (error: Error) => void } | undefined;

  constructor(options: MockMobileGatewayOptions) {
    this.settings = { ...MOBILE_SETTINGS_DEFAULTS, deviceName: "Mock Desktop", ...options.settings };
    this.confirmCode = options.confirmCode ?? "4213";
    for (const device of options.devices ?? []) {
      this.devicesById.set(device.deviceId, device);
    }
    this.diagnosticsResult = mockDiagnostics("ok_direct");
    this.pairingStream = new MutableValueStream<PairingState>(idlePairing());
    this.statusStream = new MutableValueStream<GatewayStatus>(this.buildStatus());
  }

  // -- lifecycle ------------------------------------------------------------

  async start(options?: MobileGatewayStartOptions): Promise<void> {
    if (options?.signalingUrl) {
      this.settings = { ...this.settings, signalingUrl: options.signalingUrl };
    }
    if (options?.pushUrl) {
      this.settings = { ...this.settings, pushUrl: options.pushUrl };
    }
    this.running = this.settings.enabled || options?.force === true;
    this.publish();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.sessions.clear();
    this.publish();
  }

  // -- RPC ------------------------------------------------------------------

  onRequest(method: string, handler: MobileRequestHandler): () => void {
    if (isReservedMethod(method)) {
      throw new Error(`mobile gateway: "${method}" is answered by the pipe and cannot be overridden`);
    }
    if (this.handlers.has(method)) {
      throw new Error(`mobile gateway: a handler for "${method}" is already registered`);
    }
    this.handlers.set(method, handler);
    return () => {
      if (this.handlers.get(method) === handler) {
        this.handlers.delete(method);
      }
    };
  }

  registeredMethods(): string[] {
    return [...this.handlers.keys(), ...RESERVED_METHODS].sort();
  }

  // -- events ---------------------------------------------------------------

  emit(type: string, payload: unknown, scope?: MobileEventScope): void {
    // Matches the real gateway: recorded whenever a phone is paired, even if
    // none is currently connected (01 §5.3). Only an unpaired desktop no-ops.
    if (this.devicesById.size === 0) {
      return;
    }
    const event: RpcEvent = { k: "evt", seq: ++this.seq, type, d: payload, ts: Date.now() };
    this.events.push(event);
    if (this.events.length > EVENT_BUFFER_MAX_COUNT) {
      this.events.shift();
    }
    for (const session of this.sessions.values()) {
      if (scope?.workspacePath && !session.workspaces.includes(scope.workspacePath)) {
        continue;
      }
      session.delivered.push(event);
      session.lastDeliveredSeq = event.seq;
    }
    this.publish();
  }

  setSnapshotProvider(provider: MobileSnapshotProvider): void {
    this.snapshotProvider = provider;
  }

  // -- pairing --------------------------------------------------------------

  pairing: MobilePairingApi = {
    openQr: async (): Promise<PairingSession> => {
      this.pendingPairing?.reject(new Error("페어링이 새 QR 발행으로 취소되었습니다."));
      const expiresAt = Date.now() + PAIR_TTL_MS;
      const qr = mockQr(expiresAt);
      this.codeStream.set("");
      this.pairingStream.set({ ...idlePairing(), phase: "awaitingScan", qr, expiresAt });
      const completed = new Promise<TrustedDevice>((resolve, reject) => {
        this.pendingPairing = { resolve, reject };
      });
      this.publish();
      return { qr, expiresAt, code$: this.codeStream.readable(), completed };
    },

    confirm: async (): Promise<void> => {
      const state = this.pairingStream.current;
      if (state.phase !== "awaitingConfirm" || !state.peerDeviceId) {
        throw new Error("확인을 기다리는 페어링이 없습니다.");
      }
      const device: TrustedDevice = {
        deviceId: state.peerDeviceId,
        sigPk: `mock-sig-${state.peerDeviceId}`,
        kxPk: `mock-kx-${state.peerDeviceId}`,
        name: state.peerName ?? "Mock Phone",
        pairedAt: Date.now(),
        epoch: 1,
        lastSeenAt: 0,
        push: undefined,
      };
      this.devicesById.set(device.deviceId, device);
      this.pairingStream.set({ ...state, phase: "completed", qr: undefined, code: undefined });
      this.pendingPairing?.resolve(device);
      this.pendingPairing = undefined;
      this.publish();
    },

    cancel: async (): Promise<void> => {
      if (this.pairingStream.current.phase === "idle") {
        return;
      }
      this.pairingStream.set({ ...idlePairing(), phase: "cancelled" });
      this.pendingPairing?.reject(new Error("페어링이 취소되었습니다."));
      this.pendingPairing = undefined;
      this.publish();
    },

    state$: this.pairingStreamView(),

    devices: (): TrustedDevice[] => [...this.devicesById.values()],

    revoke: async (deviceId: string): Promise<void> => {
      const device = this.devicesById.get(deviceId);
      if (!device) {
        throw new Error(`알 수 없는 기기입니다: ${deviceId}`);
      }
      this.devicesById.delete(deviceId);
      for (const [sessionId, session] of [...this.sessions]) {
        if (session.deviceId === deviceId) {
          this.sessions.delete(sessionId);
        }
      }
      this.publish();
    },

    rename: async (deviceId: string, name: string): Promise<void> => {
      const device = this.devicesById.get(deviceId);
      if (!device) {
        throw new Error(`알 수 없는 기기입니다: ${deviceId}`);
      }
      this.devicesById.set(deviceId, { ...device, name });
      this.publish();
    },
  };

  // -- sessions -------------------------------------------------------------

  async disconnect(sessionId: string): Promise<void> {
    if (this.sessions.delete(sessionId)) {
      this.publish();
    }
  }

  // -- status / settings / diagnostics --------------------------------------

  /** Built fresh, matching the real gateway (see its getStatus). */
  getStatus(): GatewayStatus {
    return this.buildStatus();
  }

  get status$(): ValueStream<GatewayStatus> {
    return this.statusStream.readable();
  }

  getSettings(): MobileSettings {
    return this.settings;
  }

  async updateSettings(patch: Partial<MobileSettings>): Promise<MobileSettings> {
    this.settings = { ...this.settings, ...patch };
    if (patch.enabled === false) {
      this.running = false;
      this.sessions.clear();
    } else if (patch.enabled === true) {
      this.running = true;
    }
    this.publish();
    return this.settings;
  }

  async diagnostics(): Promise<NatDiagnostics> {
    this.diagnosticsResult = { ...this.diagnosticsResult, ranAt: Date.now() };
    this.publish();
    return this.diagnosticsResult;
  }

  push: MobilePushApi = {
    registerHandle: (deviceId: string, platform: MobilePlatform, handle: string): void => {
      const device = this.devicesById.get(deviceId);
      if (!device) {
        throw new Error(`알 수 없는 기기입니다: ${deviceId}`);
      }
      this.devicesById.set(deviceId, { ...device, push: { platform, handle, registeredAt: Date.now() } });
      this.publish();
    },
    notify: async (deviceId: string): Promise<void> => {
      const device = this.devicesById.get(deviceId);
      if (!device?.push) {
        throw new Error(`푸시 핸들이 등록되지 않은 기기입니다: ${deviceId}`);
      }
    },
  };

  // -- mock controls --------------------------------------------------------

  mock: MockControls = {
    scanQr: (options): void => {
      const state = this.pairingStream.current;
      if (state.phase !== "awaitingScan") {
        throw new Error("열려 있는 QR이 없습니다.");
      }
      const deviceId = options?.deviceId ?? `mock-phone-${this.devicesById.size + 1}`;
      this.codeStream.set(this.confirmCode);
      this.pairingStream.set({
        ...state,
        phase: "awaitingConfirm",
        code: this.confirmCode,
        peerDeviceId: deviceId,
        peerName: options?.deviceName ?? "Mock Phone",
      });
      this.publish();
    },

    failPairing: (error: string): void => {
      this.pairingStream.set({ ...idlePairing(), phase: "failed", error });
      this.pendingPairing?.reject(new Error(error));
      this.pendingPairing = undefined;
      this.publish();
    },

    connect: (options): string => {
      const deviceId = options?.deviceId ?? [...this.devicesById.keys()][0];
      const device = deviceId ? this.devicesById.get(deviceId) : undefined;
      if (!device) {
        throw new Error("연결할 신뢰 기기가 없습니다. 먼저 페어링하세요.");
      }
      const sessionId = `mock-session-${++this.counter}`;
      this.sessions.set(sessionId, {
        sessionId,
        deviceId: device.deviceId,
        deviceName: device.name,
        transport: options?.transport ?? "directViaRendezvous",
        startedAt: Date.now(),
        workspaces: options?.workspaces ?? [],
        lastDeliveredSeq: this.seq,
        inFlightRequests: 0,
        lastRequestAt: undefined,
        lastRequestMethod: undefined,
        delivered: [],
      });
      this.devicesById.set(device.deviceId, { ...device, lastSeenAt: Date.now() });
      this.publish();
      return sessionId;
    },

    subscribe: (sessionId, workspaces): void => {
      const session = this.requireSession(sessionId);
      session.workspaces = [...workspaces];
      this.publish();
    },

    request: async (method, params, options): Promise<unknown> => {
      const session = options?.sessionId ? this.requireSession(options.sessionId) : this.anySession();
      const handler = this.handlers.get(method);
      if (!handler) {
        throw new Error(`method_not_found: ${method}`);
      }
      session.inFlightRequests += 1;
      session.lastRequestAt = Date.now();
      session.lastRequestMethod = method;
      this.publish();
      try {
        return await handler(params, this.contextFor(session, method));
      } finally {
        session.inFlightRequests -= 1;
        this.publish();
      }
    },

    snapshot: async (sessionId): Promise<unknown> => {
      if (!this.snapshotProvider) {
        throw new Error("스냅샷 제공자가 등록되지 않았습니다 (setSnapshotProvider).");
      }
      const session = sessionId ? this.requireSession(sessionId) : this.anySession();
      return this.snapshotProvider({
        deviceId: session.deviceId,
        sessionId: session.sessionId,
        workspaces: [...session.workspaces],
      });
    },

    deliveredTo: (sessionId): RpcEvent[] => [...this.requireSession(sessionId).delivered],

    emitted: (): RpcEvent[] => [...this.events],

    setDiagnostics: (reason, patch): void => {
      this.diagnosticsResult = { ...mockDiagnostics(reason), ...patch };
      this.publish();
    },

    reset: (): void => {
      this.handlers.clear();
      this.devicesById.clear();
      this.sessions.clear();
      this.events.length = 0;
      this.seq = 0;
      this.counter = 0;
      this.snapshotProvider = undefined;
      this.pendingPairing?.reject(new Error("게이트웨이가 초기화되었습니다."));
      this.pendingPairing = undefined;
      this.pairingStream.set(idlePairing());
      this.codeStream.set("");
      this.publish();
    },
  };

  // -- internals ------------------------------------------------------------

  private pairingStreamView(): ValueStream<PairingState> {
    // `pairing` is a field initializer, so it runs before `pairingStream` is
    // assigned; the view defers the read to subscribe/current time.
    const owner = this;
    return {
      get current(): PairingState {
        return owner.pairingStream.current;
      },
      subscribe: (listener) => owner.pairingStream.subscribe(listener),
    };
  }

  private requireSession(sessionId: string): MockSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`알 수 없는 세션입니다: ${sessionId}`);
    }
    return session;
  }

  private anySession(): MockSession {
    const session = [...this.sessions.values()][0];
    if (!session) {
      throw new Error("연결된 세션이 없습니다. mock.connect()를 먼저 호출하세요.");
    }
    return session;
  }

  private contextFor(session: MockSession, method: string): RequestContext {
    return {
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      sessionId: session.sessionId,
      requestId: `mock-req-${++this.counter}`,
      method,
      workspacePath: session.workspaces[0],
      transport: session.transport,
      receivedAt: Date.now(),
      signal: new AbortController().signal,
      // Live read, matching the real gateway: a handler that emits and then
      // reads must see its own emit reflected. Sampled at call time rather
      // than captured here, so the handler chooses when to read it.
      currentSeq: () => this.seq,
    };
  }

  private buildStatus(): GatewayStatus {
    const buffered = this.events;
    return {
      running: this.running,
      bootId: MOCK_BOOT_ID,
      deviceId: MOCK_DEVICE_ID,
      deviceName: this.settings.deviceName,
      signaling: this.running ? "connected" : "disabled",
      signalingUrl: this.settings.signalingUrl,
      signalingError: undefined,
      sessions: [...this.sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        deviceName: session.deviceName,
        transport: session.transport,
        state: "connected",
        startedAt: session.startedAt,
        lastDeliveredSeq: session.lastDeliveredSeq,
        subscribedWorkspaces: [...session.workspaces],
        inFlightRequests: session.inFlightRequests,
        lastRequestAt: session.lastRequestAt,
        lastRequestMethod: session.lastRequestMethod,
        // The mock has no wire, so there is genuinely nothing queued. This is a
        // truthful 0, not the placeholder the real gateway used to return
        // before it reported the transport's actual backlog.
        queuedBytes: 0,
        // The mock has no ICE; a fabricated pair would let a UI look verified
        // when nothing was ever negotiated.
        candidatePair: undefined,
      })),
      trustedDeviceCount: this.devicesById.size,
      pairing: this.pairingStream.current,
      events: {
        seq: this.seq,
        minSeq: buffered[0]?.seq ?? 0,
        maxSeq: buffered[buffered.length - 1]?.seq ?? 0,
        count: buffered.length,
      },
      lastDiagnostics: this.diagnosticsResult,
    };
  }

  private publish(): void {
    this.statusStream.set(this.buildStatus());
  }
}

function idlePairing(): PairingState {
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

/**
 * Shaped like a real QR (01 §2.1 field order) so the renderer's QR component
 * and length assumptions are exercised, but the key material is filler.
 */
function mockQr(expiresAt: number): string {
  const filler = (marker: string) => marker.repeat(43).slice(0, 43);
  return (
    `agentparty://pair?v=1&d=${filler("D")}&x=${filler("X")}&e=${filler("E")}` +
    `&t=${filler("T").slice(0, 22)}&s=mock.signaling.local&exp=${expiresAt}`
  );
}

function mockDiagnostics(reason: DiagnosticReason): NatDiagnostics {
  if (!DIAGNOSTIC_REASONS.includes(reason)) {
    throw new Error(`알 수 없는 진단 사유 코드입니다: ${reason}`);
  }
  const direct = reason === "ok_direct";
  return {
    reason,
    ranAt: Date.now(),
    wanAddress: reason === "ipv6_only" ? undefined : "203.0.113.7",
    wanIsPrivate: reason === "cgnat_100_64" || reason === "private_wan",
    behindNat: true,
    mappingKind: reason === "symmetric_nat" ? "portDependent" : "endpointIndependent",
    ipv6Available: reason === "ipv6_only",
    portMapping: direct
      ? { protocol: "udp", internalPort: 51820, externalPort: 51820, externalAddress: "203.0.113.7", via: "upnp", expiresAt: Date.now() + 3_600_000 }
      : undefined,
    probes: [
      { name: "stun:primary", ok: reason !== "ipv6_only", detail: "mock probe", elapsedMs: 12 },
      { name: "portMapping", ok: direct, detail: direct ? "mock upnp mapping" : `mock: ${reason}`, elapsedMs: 30 },
    ],
    errors: direct ? [] : [`mock diagnostics reporting ${reason}`],
  };
}
