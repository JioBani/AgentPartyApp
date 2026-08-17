import { randomUUID } from "node:crypto";
import {
  ConnHelloSchema,
  IcePayloadSchema,
  SdpPayloadSchema,
  PAIR_TTL_MS,
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
  MOBILE_SIGNALING_FALLBACKS,
  MOBILE_STUN_SERVERS,
  type GatewayStatus,
  type MobileConnectionLockKind,
  type MobileConnectionLockStatus,
  type MobilePlatform,
  type MobileSessionStatus,
  type MobileSettings,
  type NatDiagnostics,
  type RelayRejection,
  type PairingState,
  type TrustedDevice,
  type ValueStream,
} from "../../shared/mobileProtocol";
import { NatDiagnosticsProbe } from "./diagnostics";
import { ConnectionLockStore } from "./connectionLockStore";
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
import { PushError } from "./mobileGateway";
import { PairingService } from "./pairingService";
import { RpcServer } from "./rpcServer";
import { SecureSession, newSessionEphemeral } from "./secureSession";
import { SignalingClient, signalingEndpoint, type SignalingPhase } from "./signalingClient";
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
  private connectionLockStore: ConnectionLockStore | undefined;
  private signaling: SignalingClient | undefined;
  private pairingService: PairingService | undefined;
  private eventBridge: EventBridge | undefined;
  private snapshotProviderFn: MobileSnapshotProvider | undefined;
  private settings: MobileSettings;
  private signalingPhase: SignalingPhase = "idle";
  private signalingError: string | undefined;
  /**
   * True once signaling has authenticated at least once against the CURRENT
   * url. Distinct from `signalingPhase`, which only says where the connection
   * is now: a QR opened during a brief drop is fine because `reregister()`
   * re-registers it on reconnect, whereas one opened against a host that has
   * never answered cannot be.
   */
  private signalingEverConnected = false;
  /** Retained so a settings-driven restart does not discard the run's overrides. */
  private startOptions: MobileGatewayStartOptions = {};
  private lastDiagnostics: NatDiagnostics | undefined;
  private lastRelayRejection: RelayRejection | undefined;
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
    this.connectionLock = this.buildConnectionLockApi();
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
    this.startOptions = options;
    this.signalingEverConnected = false;
    const identityStore = await IdentityStore.open({
      userDataPath: this.deps.userDataPath,
      secretCipher: this.deps.secretCipher,
      log: this.deps.log,
      onSecurityWarning: this.deps.onSecurityWarning,
    });
    this.identityStore = identityStore;
    this.connectionLockStore = await ConnectionLockStore.open({
      userDataPath: this.deps.userDataPath,
      secretCipher: this.deps.secretCipher,
      log: this.deps.log,
      onSecurityWarning: this.deps.onSecurityWarning,
    });
    this.eventBridge = new EventBridge({ bootId: this.bootId });

    // Completed here so the socket, the QR's host and the status all describe
    // the same endpoint (01 §2.1).
    const signalingUrls = this.signalingUrls();
    const signaling = new SignalingClient({
      urls: signalingUrls,
      identity: identityStore.identity,
      log: this.deps.log,
    });
    this.signaling = signaling;

    this.pairingService = new PairingService({
      identityStore,
      log: this.deps.log,
      signalingHost: () => hostOf(this.effectiveSignalingUrl()),
      desktopName: () => this.settings.deviceName,
      transport: signaling,
      pairingTtlMs: this.resolvePairingTtl(options.pairingTtlMs),
      onStateChange: (state) => {
        this.pairingStream.set(state);
        if (state.phase === "completed") {
          // The first paired phone is what makes a mapping worth holding.
          this.refreshNatMapping();
        }
        this.publish();
      },
    });

    this.pushClient = new PushClient({
      identity: identityStore.identity,
      pushUrl: () => options.pushUrl ?? this.settings.pushUrl,
      log: this.deps.log,
    });

    // Built before the disabled check on purpose: it owns no socket, and a
    // gateway that loaded fine should not report "start() has not completed"
    // when the app asks it to push.

    if (!this.settings.enabled && options.force !== true) {
      // Loaded and ready, but deliberately not dialling out. `running` stays
      // false so the UI does not claim a connection the user turned off.
      this.deps.log("info", "mobile gateway loaded but disabled", { deviceId: identityStore.deviceId });
      this.publish();
      return;
    }

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
        const reconnected = phase === "connected" && this.signalingPhase !== "connected";
        if (phase === "connected") {
          this.signalingEverConnected = true;
          this.rememberWorkingSignalingUrl();
        }
        this.signalingPhase = phase;
        this.signalingError = detail.error;
        if (reconnected) {
          // The server keeps pairing sessions in memory, so a reconnect leaves
          // an open QR registered nowhere while it still looks valid here.
          this.pairingService?.reregister();
        }
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
    // Sits on broadcastToWorkspace, so the cheap check comes first: with no
    // paired phone nothing can ever ask for this history, and recording it
    // would be pure overhead on every session event.
    //
    // A paired-but-absent phone is a different case entirely. It CAN come back
    // and rewind, so the event is recorded even with zero live sessions — that
    // window is exactly what the ring buffer is for (01 §5.3).
    if ((this.identityStore?.devices().length ?? 0) === 0) {
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
  readonly connectionLock: {
    status(): MobileConnectionLockStatus;
    configure(kind: MobileConnectionLockKind, secret: string): Promise<MobileConnectionLockStatus>;
    clear(): Promise<MobileConnectionLockStatus>;
  };

  private buildConnectionLockApi(): RealMobileGateway["connectionLock"] {
    return {
      status: (): MobileConnectionLockStatus =>
        this.connectionLockStore?.status() ?? { configured: false, kind: null },
      configure: async (kind, secret): Promise<MobileConnectionLockStatus> => {
        this.requireConnectionLock().configure(kind, secret);
        this.endAllSessions("데스크톱 연결 잠금이 변경되었습니다. 다시 연결해 주세요.");
        this.publish();
        return this.requireConnectionLock().status();
      },
      clear: async (): Promise<MobileConnectionLockStatus> => {
        this.requireConnectionLock().clear();
        this.endAllSessions("데스크톱 연결 잠금이 해제되었습니다. 다시 연결해 주세요.");
        this.publish();
        return this.requireConnectionLock().status();
      },
    };
  }

  private buildPairingApi(): MobilePairingApi {
    // `state$` is built here rather than in a field initializer: inside a
    // nested object literal `this` rebinds to the literal, so the stream is
    // captured in a local instead.
    const stream = this.pairingStream;
    return {
    openQr: async (): Promise<PairingSession> => {
      const service = this.requirePairing();
      this.requireSignalingReachable();
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
      this.connectionLockStore?.forgetDevice(deviceId);
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
          throw new PushError("not_paired", `알 수 없는 기기입니다: ${deviceId}`);
        }
        if (!device.push) {
          throw new PushError("no_handle", `${device.name}이(가) 아직 푸시 핸들을 등록하지 않았습니다.`);
        }
        if ([...this.sessions.values()].some((session) => session.device.deviceId === deviceId)) {
          // 01 §7 — push exists for a phone the desktop cannot reach. Sending
          // one to a connected phone would duplicate what the live channel
          // already delivered.
          throw new PushError("peer_connected", `${device.name}은(는) 연결되어 있어 푸시가 필요하지 않습니다.`);
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
    return this.buildStatus();
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
      // The run's start options must survive a settings-driven restart. Calling
      // start() bare dropped them, so toggling `enabled` silently moved a QA
      // run off its `--signaling` target and onto the persisted URL — the phone
      // then paired with a different server than the one under test.
      //
      // An explicit `signalingUrl` patch is the one thing that DOES override
      // the override: the caller just asked for that URL by name.
      const next = { ...this.startOptions };
      if (patch.signalingUrl !== undefined) {
        delete next.signalingUrl;
      }
      await this.stop();
      if (this.settings.enabled) {
        await this.start(next);
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
      // Cannot be answered: sealing a `bye` needs this device's kxPk and there
      // is no trust record holding one. The phone therefore sees nothing at
      // all, so the refusal is recorded in status instead — otherwise the only
      // trace is a log line a QA run cannot read.
      this.rejectRelay(from, kind, "unpaired_device", "이 데스크톱에 페어링된 기기가 아닙니다.");
      return;
    }

    let payload: unknown;
    try {
      payload = decodeRelayPayload(openRelayBox(fromB64(box), fromB64(device.kxPk), store.identity.kxSk));
    } catch (error) {
      this.rejectRelay(from, kind, "undecryptable", String(error));
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
      this.rejectRelay(from, kind, "handler_failed", reason);
      // This one CAN be answered — the device is trusted, so a `bye` can be
      // sealed to it. Without it the phone sees only a 45s ICE timeout with no
      // cause, and a real device has no access to the desktop log.
      this.sendSetupFailure(device, sessionIdOf(payload), `${kind} 처리 실패: ${reason}`);
    }
  }

  /**
   * Records a relay the pipe would not act on, and logs it.
   *
   * Kept in status because two of the three reasons cannot be answered on the
   * wire, so the phone's only symptom is silence. A QA run reading
   * `GET /status` can see which branch was taken instead of guessing from a
   * bare "internal" on the phone.
   */
  private rejectRelay(
    from: string,
    kind: string,
    reason: RelayRejection["reason"],
    detail: string,
  ): void {
    this.lastRelayRejection = { from, kind, reason, detail, at: Date.now() };
    this.deps.log("warn", "mobile gateway: relay refused", { from, kind, reason, detail });
    this.publish();
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
      // 01 §3.1 — the server's list goes first, then the built-in public
      // servers as a fallback. A server that offers none changes nothing.
      iceServers: [...(this.signaling?.iceServers ?? []), ...MOBILE_STUN_SERVERS],
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
      signalingUrl: () => this.effectiveSignalingUrl(),
      registerPush: (deviceId, platform, handle) => store.setPushHandle(deviceId, platform, handle, Date.now()),
      lockState: (deviceId) => this.requireConnectionLock().stateFor(deviceId),
      unlock: (deviceId, secret) => this.requireConnectionLock().verify(deviceId, secret),
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
    rpc.begin();

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

  private endAllSessions(reason: string): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.endSession(sessionId, reason);
    }
  }

  /**
   * Validates a development QR lifetime. Anything above the protocol default
   * is capped and surfaced: the QR is the pairing capability, so a long window
   * is a real weakening (02 §T3), not a convenience setting.
   */
  private resolvePairingTtl(requested: number | undefined): number | undefined {
    if (requested === undefined || requested <= PAIR_TTL_MS) {
      return undefined;
    }
    const capped = Math.min(requested, MAX_DEV_PAIRING_TTL_MS);
    this.deps.onSecurityWarning({
      code: "pairing_ttl_extended",
      message:
        `페어링 QR 유효시간이 ${Math.round(capped / 60_000)}분으로 늘어나 있습니다(기본 2분). ` +
        "QR은 페어링 권한 그 자체라 유출 시 그 시간 동안 누구나 페어링할 수 있습니다. 개발 중에만 쓰세요.",
    });
    this.deps.log("warn", "mobile pairing TTL extended for development", { requested, capped });
    return capped;
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

  private requireConnectionLock(): ConnectionLockStore {
    if (!this.connectionLockStore) {
      throw new Error("mobile gateway: connection lock store is not loaded");
    }
    return this.connectionLockStore;
  }

  private requirePairing(): PairingService {
    if (!this.pairingService) {
      throw new Error("mobile gateway: start() has not completed");
    }
    return this.pairingService;
  }

  /**
   * Refuses to mint a QR against a signaling host that has never answered.
   *
   * The QR carries `s=` (01 §2.1) and the phone STORES it in its trust record,
   * so this is not a retryable failure — a device paired now keeps the dead
   * address even after the desktop corrects its own setting, and the only cure
   * is unpairing and starting over. The shipped default resolves to nothing,
   * so a first-time user would otherwise walk straight into that.
   *
   * A momentary drop after a successful connection is deliberately NOT blocked:
   * `PairingService.reregister()` re-registers an open QR when signaling comes
   * back, so that window is genuinely recoverable and refusing it would only
   * make the UI feel broken.
   */
  /**
   * The signaling URL this run is actually using: the override, else settings,
   * completed to the 01 §2.1 canonical form so a bare host works exactly as it
   * does on the phone.
   */
  private effectiveSignalingUrl(): string {
    // Once connected this is whichever address answered, which is what
    // `sys.info` must report (01 ddc2563) — not the one the run started with.
    return this.signaling?.currentUrl() ?? this.signalingUrls()[0];
  }

  /**
   * Puts the address that answered at the front of the list, by making it the
   * setting (01 ddc2563 — "성공한 것을 맨 앞으로").
   *
   * Skipped while a start-time override is active: that URL belongs to one QA
   * run and writing it into the user's settings would outlive the run and
   * silently repoint the product.
   */
  private rememberWorkingSignalingUrl(): void {
    if (this.startOptions.signalingUrl !== undefined) {
      return;
    }
    const working = this.signaling?.currentUrl();
    if (!working || signalingEndpoint(this.settings.signalingUrl) === working) {
      return;
    }
    this.settings = { ...this.settings, signalingUrl: working };
    this.deps.writeSettings(this.settings);
    this.deps.log("info", "mobile signaling: promoted the address that answered", { url: working });
  }

  /**
   * The addresses to try, in order: the configured one first, then the
   * built-in operator defaults (01 ddc2563).
   *
   * A start-time override replaces the setting rather than joining the list —
   * a QA run pointed at a local server must not quietly fail over to the
   * public one and test something else entirely.
   */
  private signalingUrls(): string[] {
    const configured = this.startOptions.signalingUrl ?? this.settings.signalingUrl;
    if (this.startOptions.signalingUrl !== undefined) {
      return [signalingEndpoint(configured)];
    }
    return [...new Set([configured, ...MOBILE_SIGNALING_FALLBACKS].map((url) => signalingEndpoint(url)))];
  }

  private requireSignalingReachable(): void {
    if (this.signalingEverConnected) {
      return;
    }
    const tried = this.signalingUrls();
    throw new Error(
      `페어링을 등록할 수 있는 시그널링 서버가 없습니다(시도: ${tried.join(", ")}). ` +
        "서버에 등록되지 않은 QR은 폰이 스캔해도 완료되지 않습니다. " +
        "서버 주소를 확인하거나 연결을 기다린 뒤 다시 시도하세요.",
    );
  }

  private buildStatus(): GatewayStatus {
    const window = this.eventBridge?.window() ?? { seq: 0, minSeq: 0, maxSeq: 0, count: 0 };
    return {
      running: this.signalingPhase !== "idle",
      bootId: this.bootId,
      deviceId: this.identityStore?.deviceId ?? "",
      deviceName: this.settings.deviceName,
      signaling: this.signalingPhase === "idle" ? "disabled" : this.signalingPhase,
      // The URL actually in use, not the persisted one. During a QA override
      // these differ, and reporting the setting made the status screen name a
      // server the pipe was not talking to.
      signalingUrl: this.effectiveSignalingUrl(),
      signalingError: this.signalingError,
      sessions: [...this.sessions.values()].map((session) => this.sessionStatus(session)),
      trustedDeviceCount: this.identityStore?.devices().length ?? 0,
      connectionLock: this.connectionLockStore?.status() ?? { configured: false, kind: null },
      pairing: this.pairingStream.current,
      events: window,
      lastDiagnostics: this.lastDiagnostics,
      lastRelayRejection: this.lastRelayRejection,
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
      lockAuthenticated: session.rpc.authenticated,
      startedAt: session.startedAt,
      lastDeliveredSeq: bridge?.lastDeliveredSeqOf(session.sessionId) ?? 0,
      subscribedWorkspaces: bridge?.subscriptionOf(session.sessionId) ?? [],
      inFlightRequests: activity.inFlight,
      lastRequestAt: activity.lastRequestAt,
      lastRequestMethod: activity.lastRequestMethod,
      queuedBytes: session.transport.queuedBytes(),
      candidatePair: session.transport.selectedCandidatePair(),
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
 * 10 minutes, matching the signaling server's pairing window (develop). A QR
 * outliving that window is worse than a short one: it stays on screen looking
 * valid while `pair.join` is refused, which is harder to diagnose than a plain
 * expiry.
 */
const MAX_DEV_PAIRING_TTL_MS = 10 * 60_000;

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

