import { randomUUID } from "node:crypto";
import {
  ConnHelloSchema,
  IcePayloadSchema,
  SdpPayloadSchema,
  buildConnHello,
  decodeRelayPayload,
  encodeRelayPayload,
  fromB64,
  RESERVED_METHODS,
  isReservedMethod,
  openRelayBox,
  sealRelayBox,
  toB64,
  verifyConnHello,
  type RpcEvent,
} from "@agentparty/protocol";
import {
  MOBILE_SETTINGS_DEFAULTS,
  type GatewayStatus,
  type MobilePlatform,
  type MobileSessionStatus,
  type MobileSettings,
  type NatDiagnostics,
  type PairingState,
  type TrustedDevice,
  type ValueStream,
} from "../../shared/mobileProtocol";
import { NatDiagnosticsProbe } from "./diagnostics";
import { EventBridge } from "./eventBridge";
import { IdentityStore } from "./identityStore";
import { NatMapper } from "./natMapper";
import { PushClient } from "./pushClient";
import type { MobileGatewayDeps } from "./index";
import type {
  MobileEventScope,
  MobileGateway,
  MobileGatewayStartOptions,
  MobilePairingApi,
  MobilePushApi,
  MobileRequestHandler,
  MobileSnapshotProvider,
  PairingSession,
  PushPayload,
} from "./mobileGateway";
import { PairingService } from "./pairingService";
import { RpcServer } from "./rpcServer";
import { SecureSession, newSessionEphemeral } from "./secureSession";
import { SignalingClient, type SignalingPhase } from "./signalingClient";
import { MutableValueStream } from "./valueStream";
import { WebrtcTransport } from "./webrtcTransport";

/**
 * The real {@link MobileGateway}: wires identity, pairing, signaling,
 * transport, the secure session, RPC and the event bridge into one object with
 * the same surface as the mock.
 *
 * Everything protocol-shaped lives in the modules this composes. What is
 * decided here is lifecycle: when a session starts, what ends it, and what the
 * app sees while it runs.
 */

/** One connected phone: transport → secure session → RPC, plus its keys. */
interface LiveSession {
  sessionId: string;
  device: TrustedDevice;
  transport: WebrtcTransport;
  secure: SecureSession;
  rpc: RpcServer;
  startedAt: number;
  /** Kept until the peer's `hello` arrives so the keys can be derived. */
  ownEph: { publicKey: Uint8Array; privateKey: Uint8Array };
}

export class RealMobileGateway implements MobileGateway {
  private readonly handlers = new Map<string, MobileRequestHandler>();
  private readonly sessions = new Map<string, LiveSession>();
  private readonly statusStream: MutableValueStream<GatewayStatus>;
  private readonly pairingStream: MutableValueStream<PairingState>;

  private identityStore: IdentityStore | undefined;
  private signaling: SignalingClient | undefined;
  private pairingService: PairingService | undefined;
  private eventBridge: EventBridge | undefined;
  private snapshotProviderFn: MobileSnapshotProvider | undefined;
  private settings: MobileSettings;
  private signalingPhase: SignalingPhase = "idle";
  private signalingError: string | undefined;
  private lastDiagnostics: NatDiagnostics | undefined;
  private startPromise: Promise<void> | undefined;
  private readonly bootId = randomUUID();
  private readonly diagnosticsProbe: NatDiagnosticsProbe;
  private natMapper: NatMapper | undefined;
  private pushClient: PushClient | undefined;

  constructor(private readonly deps: MobileGatewayDeps) {
    this.settings = { ...MOBILE_SETTINGS_DEFAULTS, ...deps.readSettings() };
    if (!this.settings.deviceName) {
      this.settings = { ...this.settings, deviceName: deps.defaultDeviceName };
    }
    this.pairingStream = new MutableValueStream<PairingState>(idlePairing());
    this.statusStream = new MutableValueStream<GatewayStatus>(this.buildStatus());
    this.diagnosticsProbe = new NatDiagnosticsProbe({
      log: deps.log,
      portMapping: () => this.natMapper?.current(),
    });
    this.pairing = this.buildPairingApi();
    this.push = this.buildPushApi();
  }

  // -- lifecycle ------------------------------------------------------------

  start(options: MobileGatewayStartOptions = {}): Promise<void> {
    // Concurrent starts share one attempt; the app calls this from both the
    // window lifecycle and the automation API.
    this.startPromise ??= this.doStart(options).catch((error) => {
      this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  private async doStart(options: MobileGatewayStartOptions): Promise<void> {
    const identityStore = await IdentityStore.open({
      userDataPath: this.deps.userDataPath,
      secretCipher: this.deps.secretCipher,
      log: this.deps.log,
      onSecurityWarning: this.deps.onSecurityWarning,
    });
    this.identityStore = identityStore;
    this.eventBridge = new EventBridge({ bootId: this.bootId });

    const signalingUrl = options.signalingUrl ?? this.settings.signalingUrl;
    const signaling = new SignalingClient({
      url: signalingUrl,
      identity: identityStore.identity,
      log: this.deps.log,
    });
    this.signaling = signaling;

    this.pairingService = new PairingService({
      identityStore,
      log: this.deps.log,
      signalingHost: () => hostOf(signalingUrl),
      desktopName: () => this.settings.deviceName,
      transport: signaling,
      onStateChange: (state) => {
        this.pairingStream.set(state);
        if (state.phase === "completed") {
          // The first paired phone is what makes a mapping worth holding.
          this.refreshNatMapping();
        }
        this.publish();
      },
    });

    if (!this.settings.enabled && options.force !== true) {
      // Loaded and ready, but deliberately not dialling out. `running` stays
      // false so the UI does not claim a connection the user turned off.
      this.deps.log("info", "mobile gateway loaded but disabled", { deviceId: identityStore.deviceId });
      this.publish();
      return;
    }

    this.pushClient = new PushClient({
      identity: identityStore.identity,
      pushUrl: () => options.pushUrl ?? this.settings.pushUrl,
      log: this.deps.log,
    });

    this.natMapper = new NatMapper({
      log: this.deps.log,
      // Stable per desktop so renewals reuse one router entry instead of
      // leaving a trail of stale mappings behind.
      port: mappingPortFor(identityStore.deviceId),
    });
    this.refreshNatMapping();

    signaling.start({
      onRelay: (from, kind, box) => this.onRelay(from, kind, box),
      onPairJoin: (tokenHash, blob1) => this.pairingService?.handlePairJoin(tokenHash, blob1),
      onPairDone: (tokenHash, blob3) => this.pairingService?.handlePairDone(tokenHash, blob3),
      onPairClosed: (tokenHash, reason) => this.pairingService?.handlePairClosed(tokenHash, reason),
      onPhaseChange: (phase, detail) => {
        this.signalingPhase = phase;
        this.signalingError = detail.error;
        this.publish();
      },
    });
    this.publish();
  }

  async stop(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      this.endSession(sessionId, "데스크톱이 모바일 연결을 종료했습니다.");
    }
    this.pairingService?.cancel();
    void this.natMapper?.stop();
    this.pushClient = undefined;
    this.natMapper = undefined;
    this.signaling?.stop();
    this.signaling = undefined;
    this.startPromise = undefined;
    this.signalingPhase = "idle";
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
    // Sits on broadcastToWorkspace: return before touching anything when no
    // phone is connected (04 §성능·안전).
    if (this.sessions.size === 0) {
      return;
    }
    this.eventBridge?.publish(type, payload, scope?.workspacePath);
  }

  setSnapshotProvider(provider: MobileSnapshotProvider): void {
    this.snapshotProviderFn = provider;
  }

  // -- pairing --------------------------------------------------------------

  readonly pairing: MobilePairingApi;
  readonly push: MobilePushApi;

  private buildPairingApi(): MobilePairingApi {
    // `state$` is built here rather than in a field initializer: inside a
    // nested object literal `this` rebinds to the literal, so the stream is
    // captured in a local instead.
    const stream = this.pairingStream;
    return {
    openQr: async (): Promise<PairingSession> => {
      const service = this.requirePairing();
      const opened = service.open();
      const codeStream = new MutableValueStream<string>("");
      const unsubscribe = this.pairingStream.subscribe((state) => codeStream.set(state.code ?? ""));
      void opened.completed.then(
        () => unsubscribe(),
        () => unsubscribe(),
      );
      return { qr: opened.qr, expiresAt: opened.expiresAt, code$: codeStream.readable(), completed: opened.completed };
    },
    confirm: async (): Promise<void> => this.requirePairing().confirm(),
    cancel: async (): Promise<void> => this.requirePairing().cancel(),
    state$: {
      get current(): PairingState {
        return stream.current;
      },
      subscribe: (listener: (value: PairingState) => void) => stream.subscribe(listener),
    },
    devices: (): TrustedDevice[] => this.identityStore?.devices() ?? [],
    revoke: async (deviceId: string): Promise<void> => {
      const store = this.requireIdentity();
      store.revokeDevice(deviceId);
      this.refreshNatMapping();
      for (const session of [...this.sessions.values()]) {
        if (session.device.deviceId === deviceId) {
          this.endSession(session.sessionId, "이 기기의 연결 권한이 해제되었습니다.");
        }
      }
      this.publish();
    },
    rename: async (deviceId: string, name: string): Promise<void> => {
      this.requireIdentity().renameDevice(deviceId, name);
      this.publish();
    },
    };
  }

  private buildPushApi(): MobilePushApi {
    return {
      registerHandle: (deviceId: string, platform: MobilePlatform, handle: string): void => {
        this.requireIdentity().setPushHandle(deviceId, platform, handle, Date.now());
        this.publish();
      },
      notify: async (deviceId: string, payload: PushPayload): Promise<void> => {
        const client = this.pushClient;
        if (!client) {
          throw new Error("mobile gateway: start() has not completed");
        }
        const device = this.requireIdentity().find(deviceId);
        if (!device) {
          throw new Error(`알 수 없는 기기입니다: ${deviceId}`);
        }
        if (!device.push) {
          throw new Error(`${device.name}이(가) 아직 푸시 핸들을 등록하지 않았습니다.`);
        }
        if ([...this.sessions.values()].some((session) => session.device.deviceId === deviceId)) {
          // 01 §7 — push exists for a phone the desktop cannot reach. Sending
          // one to a connected phone would duplicate what the live channel
          // already delivered.
          throw new Error(`${device.name}은(는) 연결되어 있어 푸시가 필요하지 않습니다.`);
        }
        await client.notify(
          {
            deviceId,
            platform: device.push.platform,
            handle: device.push.handle,
            kxPk: fromB64(device.kxPk),
          },
          {
            v: 1,
            type: payload.type,
            deviceId: this.requireIdentity().deviceId,
            requestId: payload.requestId,
            title: payload.title,
            body: payload.body,
            exp: payload.expiresAt,
          },
        );
      },
    };
  }

  // -- sessions -------------------------------------------------------------

  async disconnect(sessionId: string, reason?: string): Promise<void> {
    this.endSession(sessionId, reason ?? "데스크톱에서 연결을 끊었습니다.");
  }

  // -- status / settings / diagnostics --------------------------------------

  getStatus(): GatewayStatus {
    return this.statusStream.current;
  }

  get status$(): ValueStream<GatewayStatus> {
    return this.statusStream.readable();
  }

  getSettings(): MobileSettings {
    return this.settings;
  }

  async updateSettings(patch: Partial<MobileSettings>): Promise<MobileSettings> {
    const previous = this.settings;
    this.settings = { ...previous, ...patch };
    this.deps.writeSettings(this.settings);

    const restart =
      previous.enabled !== this.settings.enabled || previous.signalingUrl !== this.settings.signalingUrl;
    if (restart) {
      await this.stop();
      if (this.settings.enabled) {
        await this.start();
      }
    }
    this.publish();
    return this.settings;
  }

  async diagnostics(): Promise<NatDiagnostics> {
    const result = await this.diagnosticsProbe.run();
    this.lastDiagnostics = result;
    this.publish();
    return result;
  }

  // -- signaling inbound ----------------------------------------------------

  /**
   * A sealed envelope arrived from a peer. Everything here runs against the
   * trust record: an unknown device, a stale epoch or a bad signature is
   * refused before any of it reaches the WebRTC stack.
   */
  private onRelay(from: string, kind: string, box: string): void {
    const store = this.identityStore;
    if (!store) {
      return;
    }
    const device = store.find(from);
    if (!device) {
      this.deps.log("warn", "mobile gateway: relay from an unpaired device ignored", { from });
      return;
    }

    let payload: unknown;
    try {
      payload = decodeRelayPayload(openRelayBox(fromB64(box), fromB64(device.kxPk), store.identity.kxSk));
    } catch (error) {
      this.deps.log("warn", "mobile gateway: relay could not be opened", { from, error: String(error) });
      return;
    }

    try {
      switch (kind) {
        case "hello":
          this.onHello(device, ConnHelloSchema.parse(payload));
          return;
        case "offer":
          this.onOffer(device, SdpPayloadSchema.parse(payload));
          return;
        case "ice":
          this.onIce(IcePayloadSchema.parse(payload));
          return;
        case "bye": {
          const sessionId = (payload as { sessionId?: string }).sessionId;
          if (sessionId) {
            this.endSession(sessionId, "폰이 연결을 종료했습니다.");
          }
          return;
        }
        default:
          this.deps.log("warn", "mobile gateway: unknown relay kind", { kind });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.log("error", "mobile gateway: relay handling failed", { from, kind, error: reason });
      // Tell the peer why. Without this the phone sees only a 45s ICE timeout
      // with no cause, and a real device has no access to the desktop log.
      this.sendSetupFailure(device, sessionIdOf(payload), `${kind} 처리 실패: ${reason}`);
    }
  }

  /** 01 §3.3 — the phone opens a session; the desktop answers with its own hello. */
  private onHello(device: TrustedDevice, hello: unknown): void {
    const store = this.requireIdentity();
    const parsed = hello as { sessionId: string; epoch: number };
    const peerEphPk = verifyConnHello(hello as never, fromB64(device.sigPk));
    store.requireTrusted(device.deviceId, parsed.epoch);

    const ownEph = newSessionEphemeral();
    this.sendRelay(
      device,
      "hello",
      buildConnHello(
        { sessionId: parsed.sessionId, eph: ownEph.publicKey, epoch: device.epoch, ts: Date.now() },
        store.identity.sigSk,
      ) as unknown as Record<string, unknown>,
    );

    // The transport is built now so ICE can start before the offer lands.
    this.beginSession(parsed.sessionId, device, ownEph, peerEphPk);
  }

  private beginSession(
    sessionId: string,
    device: TrustedDevice,
    ownEph: { publicKey: Uint8Array; privateKey: Uint8Array },
    peerEphPk: Uint8Array,
  ): void {
    const store = this.requireIdentity();
    const bridge = this.requireBridge();

    const transport = new WebrtcTransport({
      sessionId,
      identity: store.identity,
      peerSigPk: fromB64(device.sigPk),
      log: this.deps.log,
      loadNative: this.deps.loadWebrtcModule as never,
      mappedCandidate: this.mappedCandidateForTransport(),
      sendSdp: (payload) => this.sendRelay(device, "answer", payload as unknown as Record<string, unknown>),
      sendIce: (payload) => this.sendRelay(device, "ice", payload as unknown as Record<string, unknown>),
    });

    const rpc = new RpcServer({
      link: {
        sessionId,
        deviceId: device.deviceId,
        deviceName: device.name,
        transport: transport.kind,
        send: (envelope) => secure.send(envelope),
        close: (reason) => this.endSession(sessionId, reason),
      },
      eventBridge: bridge,
      handlers: () => this.handlers,
      snapshotProvider: () => this.snapshotProviderFn,
      appName: this.settings.deviceName,
      appVersion: this.deps.appVersion,
      registerPush: (deviceId, platform, handle) => store.setPushHandle(deviceId, platform, handle, Date.now()),
      log: this.deps.log,
    });

    // The phone sent `hello` first, so by 01 §4.1 it is the kx client and this
    // side is the server.
    const secure = new SecureSession({
      transport,
      role: "server",
      ownEph,
      peerEphPk,
      log: this.deps.log,
      onPayload: (payload) => rpc.handle(payload),
      onFatal: (reason) => this.endSession(sessionId, reason),
    });

    transport.onStateChange((state, detail) => {
      if (state === "closed") {
        this.endSession(sessionId, detail.error ?? "연결이 종료되었습니다.");
        return;
      }
      this.publish();
    });

    bridge.attach({ sessionId, deliver: (event: RpcEvent) => rpc.deliver(event) });
    this.sessions.set(sessionId, {
      sessionId,
      device,
      transport,
      secure,
      rpc,
      startedAt: Date.now(),
      ownEph,
    });
    store.touch(device.deviceId, Date.now());
    this.publish();
  }

  private onOffer(device: TrustedDevice, payload: { sessionId: string }): void {
    const session = this.sessions.get(payload.sessionId);
    if (!session) {
      // An offer with no `hello` first means the phone skipped session setup;
      // there are no keys to decrypt anything it would send.
      this.deps.log("warn", "mobile gateway: offer for an unknown session", {
        session: payload.sessionId,
        from: device.deviceId,
      });
      return;
    }
    session.transport.acceptOffer(payload as never);
  }

  private onIce(payload: { sessionId: string }): void {
    this.sessions.get(payload.sessionId)?.transport.addRemoteCandidate(payload as never);
  }

  /**
   * Reports a session-setup failure to the peer as a `bye` (01 §3.3). Best
   * effort: if even this cannot be sent the cause is already logged, and
   * throwing here would replace one silent failure with another.
   */
  private sendSetupFailure(device: TrustedDevice, sessionId: string, reason: string): void {
    try {
      this.sendRelay(device, "bye", { sessionId, reason });
    } catch (error) {
      this.deps.log("warn", "mobile gateway: could not report the failure to the peer", { error: String(error) });
    }
  }

  private sendRelay(device: TrustedDevice, kind: string, payload: Record<string, unknown>): void {
    const store = this.requireIdentity();
    const box = sealRelayBox(encodeRelayPayload(payload as never), fromB64(device.kxPk), store.identity.kxSk);
    this.signaling?.relay(device.deviceId, kind as never, toB64(box));
  }

  private endSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionId);
    this.eventBridge?.detach(sessionId);
    session.rpc.dispose();
    session.secure.close();
    session.transport.close(reason);
    session.ownEph.privateKey.fill(0);
    this.deps.log("info", "mobile session ended", { sessionId, reason });
    this.publish();
  }

  /**
   * The router mapping, in the shape the transport advertises (01 §3.3). Absent
   * until a mapping exists, and absent for good when none can be obtained —
   * announcing a port that is not mapped would just add a candidate that never
   * answers, slowing every connection attempt down.
   */
  private mappedCandidateForTransport(): { internalPort: number; address: string; externalPort: number } | undefined {
    const mapping = this.natMapper?.current();
    if (!mapping?.externalAddress) {
      return undefined;
    }
    return {
      internalPort: mapping.internalPort,
      address: mapping.externalAddress,
      externalPort: mapping.externalPort,
    };
  }

  /**
   * 02 §T6 — a mapping exists only while at least one phone is paired. An open
   * port on a desktop nothing can connect to is attack surface for no benefit.
   */
  private refreshNatMapping(): void {
    const mapper = this.natMapper;
    if (!mapper || !this.settings.natMappingEnabled) {
      return;
    }
    if ((this.identityStore?.devices().length ?? 0) > 0) {
      void mapper.start();
    } else {
      void mapper.stop();
    }
  }

  // -- internals ------------------------------------------------------------

  private requireIdentity(): IdentityStore {
    if (!this.identityStore) {
      throw new Error("mobile gateway: start() has not completed");
    }
    return this.identityStore;
  }

  private requireBridge(): EventBridge {
    if (!this.eventBridge) {
      throw new Error("mobile gateway: start() has not completed");
    }
    return this.eventBridge;
  }

  private requirePairing(): PairingService {
    if (!this.pairingService) {
      throw new Error("mobile gateway: start() has not completed");
    }
    return this.pairingService;
  }

  private buildStatus(): GatewayStatus {
    const window = this.eventBridge?.window() ?? { seq: 0, minSeq: 0, maxSeq: 0, count: 0 };
    return {
      running: this.signalingPhase !== "idle",
      bootId: this.bootId,
      deviceId: this.identityStore?.deviceId ?? "",
      deviceName: this.settings.deviceName,
      signaling: this.signalingPhase === "idle" ? "disabled" : this.signalingPhase,
      signalingUrl: this.settings.signalingUrl,
      signalingError: this.signalingError,
      sessions: [...this.sessions.values()].map((session) => this.sessionStatus(session)),
      trustedDeviceCount: this.identityStore?.devices().length ?? 0,
      pairing: this.pairingStream.current,
      events: window,
      lastDiagnostics: this.lastDiagnostics,
    };
  }

  private sessionStatus(session: LiveSession): MobileSessionStatus {
    const activity = session.rpc.activity;
    const bridge = this.eventBridge;
    return {
      sessionId: session.sessionId,
      deviceId: session.device.deviceId,
      deviceName: session.device.name,
      transport: session.transport.kind,
      state: session.transport.state,
      startedAt: session.startedAt,
      lastDeliveredSeq: bridge?.lastDeliveredSeqOf(session.sessionId) ?? 0,
      subscribedWorkspaces: bridge?.subscriptionOf(session.sessionId) ?? [],
      inFlightRequests: activity.inFlight,
      lastRequestAt: activity.lastRequestAt,
      lastRequestMethod: activity.lastRequestMethod,
      queuedBytes: 0,
    };
  }

  private publish(): void {
    this.statusStream.set(this.buildStatus(), (error) =>
      this.deps.log("warn", "mobile gateway status listener threw", { error: String(error) }),
    );
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
 * A stable UDP port per desktop identity, in the ephemeral range. Deriving it
 * from the deviceId keeps renewals on one router entry instead of leaving a
 * trail of stale mappings after every restart.
 */
function mappingPortFor(deviceId: string): number {
  let hash = 0;
  for (const char of deviceId) {
    hash = (hash * 31 + char.charCodeAt(0)) % 16384;
  }
  return 49152 + hash;
}

/** Best-effort sessionId from a payload whose handling threw before validation. */
function sessionIdOf(payload: unknown): string {
  const value = (payload as { sessionId?: unknown } | null)?.sessionId;
  return typeof value === "string" ? value : "";
}

/** `wss://host:port/path` → `host:port`, which is what the QR carries. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new Error(`mobile gateway: "${url}" is not a valid signaling URL`);
  }
}

