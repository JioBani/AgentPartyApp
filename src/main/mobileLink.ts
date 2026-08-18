import type { GatewayStatus, MobileConnectionLockKind, MobileConnectionLockStatus, MobileSettings, NatDiagnostics, TrustedDevice } from "../shared/mobileProtocol";
import type { MethodContext, MethodParams } from "./api/methodRegistry";
import { methodRoutes } from "./api/methodRoutes";
import type { AppController } from "./application/appController";
import { log } from "./logger";
// From the pipe's contract file, never its barrel: the barrel pulls in the
// implementations, which need `@agentparty/protocol`. Importing the contract
// directly is what lets this file compile in a build without that package
// (`docs/mobile-gateway-wiring.md` §패키지가 없을 때).
import type { MobileGateway, MobileGatewayStartOptions, MockControls, RequestContext, SnapshotContext } from "./mobile/mobileGateway";

export interface MobileLinkDeps {
  /** The pipe. Built by `createMobileGateway` in main.ts — real unless a QA run
   *  asks for the mock with `AGENTPARTY_MOBILE_PIPE=mock`. */
  gateway: MobileGateway;
  /** Workspace a phone request falls back to when it names none. */
  defaultWorkspace: () => string;
  /** Reported to a phone that asks the app to describe its own API. */
  automationBaseUrl: () => string;
  /** Pushes gateway status to the desktop windows (the 모바일 연결 tab). */
  onStatus: (status: GatewayStatus) => void;
  /**
   * Writes the accepted settings back to `settings.json`, which is the app's
   * store rather than the pipe's. The real gateway persists through the same
   * function via its own deps, so this stays a same-value write; the mock keeps
   * settings in memory only, and without this a user's choice would quietly
   * disappear on restart.
   */
  persistSettings: (settings: MobileSettings) => void;
  /** Per-run overrides — QA points the link at a local signaling server. */
  startOptions?: () => MobileGatewayStartOptions | undefined;
}

/**
 * The app ⇄ pipe seam (`07-역할-분담.md` 세 겹 규칙 layer 2).
 *
 * Deliberately thin: it hands the capability table to the pipe as RPC handlers,
 * decides what a resume snapshot contains, forwards renderer events, and
 * exposes the pairing/diagnostics surface `AppController` publishes. Anything
 * that grows past that belongs in `src/main/mobile/` (pipe) or in
 * `AppController` (app), not here.
 */
export class MobileLinkService {
  private controller: AppController | undefined;
  private unsubscribeStatus: (() => void) | undefined;
  private unregister: Array<() => void> = [];
  private bindingsActive = false;

  constructor(private readonly deps: MobileLinkDeps) {}

  /**
   * Supplies the controller a phone's requests run against. Set after
   * construction because the controller takes this service as a dependency —
   * the same two-step the Discord bridge uses.
   */
  setController(controller: AppController): void {
    this.controller = controller;
  }

  async start(): Promise<void> {
    if (!this.isEnabled()) {
      log("info", "mobile", "mobile link disabled; gateway was not started");
      return;
    }
    this.activateBindings();
    try {
      await this.deps.gateway.start(this.deps.startOptions?.());
    } catch (error) {
      this.deactivateBindings();
      throw error;
    }
    log("info", "mobile", "mobile link started", {
      methods: this.unregister.length,
      enabled: true,
    });
  }

  async stop(): Promise<void> {
    this.deactivateBindings();
    await this.deps.gateway.stop();
  }

  // --- events -------------------------------------------------------------

  /**
   * Forwards one renderer event to the phones subscribed to `workspacePath`
   * (omit it for a genuinely global event such as usage). The pipe assigns the
   * sequence number and returns immediately when no phone is connected, so this
   * is safe on the broadcast hot path.
   */
  publish(channel: string, payload: unknown, workspacePath?: string): void {
    if (!this.bindingsActive) return;
    this.deps.gateway.emit(channel, payload, workspacePath ? { workspacePath } : undefined);
  }

  /**
   * Whether any phone is connected right now. Call sites use it to skip
   * building a phone-shaped payload that nobody would receive.
   */
  hasSessions(): boolean {
    if (!this.bindingsActive) return false;
    return this.deps.gateway.getStatus().sessions.length > 0;
  }

  // --- surface published through AppController ----------------------------

  async openPairing(): Promise<{ qr: string; expiresAt: number }> {
    this.requireEnabled();
    const session = await this.deps.gateway.pairing.openQr();
    // The confirmation code and the outcome arrive later; the pairing screen
    // (and QA) read them from `getStatus().pairing`, which the pipe keeps
    // current — so nothing here has to hold the session object.
    session.completed.catch((error: unknown) => {
      log("warn", "mobile", "pairing did not complete", { error: error instanceof Error ? error.message : String(error) });
    });
    return { qr: session.qr, expiresAt: session.expiresAt };
  }

  confirmPairing(): Promise<void> {
    this.requireEnabled();
    return this.deps.gateway.pairing.confirm();
  }

  cancelPairing(): Promise<void> {
    this.requireEnabled();
    return this.deps.gateway.pairing.cancel();
  }

  devices(): TrustedDevice[] {
    this.requireEnabled();
    return this.deps.gateway.pairing.devices();
  }

  revokeDevice(deviceId: string): Promise<void> {
    this.requireEnabled();
    return this.deps.gateway.pairing.revoke(deviceId);
  }

  renameDevice(deviceId: string, name: string): Promise<void> {
    this.requireEnabled();
    return this.deps.gateway.pairing.rename(deviceId, name);
  }

  disconnectSession(sessionId: string, reason?: string): Promise<void> {
    this.requireEnabled();
    return this.deps.gateway.disconnect(sessionId, reason);
  }

  connectionLockStatus(): MobileConnectionLockStatus {
    this.requireEnabled();
    return this.deps.gateway.connectionLock.status();
  }

  configureConnectionLock(kind: MobileConnectionLockKind, secret: string): Promise<MobileConnectionLockStatus> {
    this.requireEnabled();
    return this.deps.gateway.connectionLock.configure(kind, secret);
  }

  clearConnectionLock(): Promise<MobileConnectionLockStatus> {
    this.requireEnabled();
    return this.deps.gateway.connectionLock.clear();
  }

  status(): GatewayStatus {
    this.requireEnabled();
    return this.deps.gateway.getStatus();
  }

  isEnabled(): boolean {
    return this.deps.gateway.getSettings().enabled;
  }

  settings(): MobileSettings {
    return this.deps.gateway.getSettings();
  }

  async updateSettings(patch: Partial<MobileSettings>): Promise<MobileSettings> {
    const enabling = !this.isEnabled() && patch.enabled === true;
    if (enabling) this.activateBindings();
    let settings: MobileSettings;
    try {
      settings = await this.deps.gateway.updateSettings(patch);
    } catch (error) {
      if (enabling) this.deactivateBindings();
      throw error;
    }
    this.deps.persistSettings(settings);
    if (!settings.enabled) this.deactivateBindings();
    return settings;
  }

  diagnostics(): Promise<NatDiagnostics> {
    this.requireEnabled();
    return this.deps.gateway.diagnostics();
  }

  /**
   * The mock gateway's phone simulator, for `/api/qa/mobile/*`. Throws on the
   * real gateway: a QA run that thinks it scanned a QR but silently did nothing
   * would report green on a link it never exercised.
   */
  mockControls(): MockControls {
    const controls = (this.deps.gateway as { mock?: MockControls }).mock;
    if (!controls) {
      throw new Error("모바일 파이프가 목이 아닙니다 — 폰 시뮬레이터를 사용할 수 없습니다.");
    }
    return controls;
  }

  /** QA visibility into whether app RPC handlers are attached to the pipe. */
  registeredMethods(): string[] {
    return this.deps.gateway.registeredMethods();
  }

  // --- internals ----------------------------------------------------------

  private requireEnabled(): void {
    if (!this.isEnabled() || !this.bindingsActive) {
      throw new Error("모바일 연결이 비활성화되어 있습니다. POST /api/mobile/settings에 {\"enabled\":true}를 보내 먼저 활성화하세요.");
    }
  }

  private activateBindings(): void {
    if (this.bindingsActive) return;
    this.registerMethods();
    this.deps.gateway.setSnapshotProvider((context) => this.snapshot(context));
    this.unsubscribeStatus = this.deps.gateway.status$.subscribe(this.deps.onStatus);
    this.bindingsActive = true;
  }

  private deactivateBindings(): void {
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = undefined;
    for (const off of this.unregister.splice(0)) off();
    this.bindingsActive = false;
  }

  /**
   * Publishes the capability table to the phone. Every entry that is not marked
   * `remote: false` becomes an RPC method running the SAME handler the HTTP
   * endpoint runs, so the two transports cannot diverge.
   */
  private registerMethods(): void {
    for (const route of methodRoutes.remoteRoutes()) {
      this.unregister.push(this.deps.gateway.onRequest(route.name, (params, context) =>
        route.handler(this.paramsOf(params), this.contextOf(context))));
    }
  }

  private paramsOf(params: unknown): MethodParams {
    return params && typeof params === "object" ? (params as MethodParams) : {};
  }

  /**
   * A phone owns no desktop window, so window-scoped resolution is absent and
   * the workspace comes from the request itself (04 §3). Party pinning likewise
   * stays unset: that header exists to keep an in-session agent inside its own
   * party, while a phone is a user acting on the workspace's current party.
   */
  private contextOf(context: RequestContext): MethodContext {
    return {
      controller: this.requireController(),
      workspace: context.workspacePath || this.deps.defaultWorkspace(),
      apiBaseUrl: this.deps.automationBaseUrl(),
      // Only the phone gets one: an HTTP caller receives no events, so it has
      // no position in the stream to report.
      currentSeq: () => context.currentSeq(),
    };
  }

  /**
   * Full state for a phone whose `resume` fell outside the pipe's ring buffer.
   * One `state.get` payload per subscribed workspace — the same body the phone
   * would receive by calling `state.get` itself, so it has one shape to parse.
   */
  private async snapshot(context: SnapshotContext): Promise<unknown> {
    const controller = this.requireController();
    const workspaces = context.workspaces.length ? context.workspaces : [this.deps.defaultWorkspace()];
    return {
      capturedAt: Date.now(),
      workspaces: await Promise.all(workspaces.map(async (workspacePath) => ({
        workspacePath,
        state: await controller.getState(workspacePath),
      }))),
    };
  }

  private requireController(): AppController {
    if (!this.controller) {
      // Reaching here means a phone request arrived before wiring finished —
      // answer with the real reason rather than an empty result.
      throw new Error("Mobile link is not attached to the app controller yet.");
    }
    return this.controller;
  }
}
