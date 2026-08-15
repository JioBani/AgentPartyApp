import type { GatewayStatus, MobileSettings, NatDiagnostics, TrustedDevice } from "../shared/mobileProtocol";
import type { MethodContext, MethodParams } from "./api/methodRegistry";
import { methodRoutes } from "./api/methodRoutes";
import type { AppController } from "./application/appController";
import { log } from "./logger";
import type { MobileGateway, MobileGatewayStartOptions, MockControls, MockMobileGateway, RequestContext, SnapshotContext } from "./mobile";

export interface MobileLinkDeps {
  /** The pipe. Built by `createMobileGateway` in main.ts (mock until M1). */
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
  /**
   * The persisted settings to start from. `settings.json` is the app's store,
   * not the pipe's, so the link seeds the gateway from it before starting —
   * otherwise the mock (which holds settings in memory) would silently come up
   * on defaults after every restart and quietly ignore the user's server URL.
   */
  initialSettings: () => MobileSettings;
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
    await this.deps.gateway.updateSettings(this.deps.initialSettings());
    this.registerMethods();
    this.deps.gateway.setSnapshotProvider((context) => this.snapshot(context));
    this.unsubscribeStatus = this.deps.gateway.status$.subscribe(this.deps.onStatus);
    await this.deps.gateway.start(this.deps.startOptions?.());
    log("info", "mobile", "mobile link started", {
      methods: this.unregister.length,
      enabled: this.deps.gateway.getSettings().enabled,
    });
  }

  async stop(): Promise<void> {
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = undefined;
    for (const off of this.unregister.splice(0)) {
      off();
    }
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
    this.deps.gateway.emit(channel, payload, workspacePath ? { workspacePath } : undefined);
  }

  /**
   * Whether any phone is connected right now. Call sites use it to skip
   * building a phone-shaped payload that nobody would receive.
   */
  hasSessions(): boolean {
    return this.deps.gateway.getStatus().sessions.length > 0;
  }

  // --- surface published through AppController ----------------------------

  async openPairing(): Promise<{ qr: string; expiresAt: number }> {
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
    return this.deps.gateway.pairing.confirm();
  }

  cancelPairing(): Promise<void> {
    return this.deps.gateway.pairing.cancel();
  }

  devices(): TrustedDevice[] {
    return this.deps.gateway.pairing.devices();
  }

  revokeDevice(deviceId: string): Promise<void> {
    return this.deps.gateway.pairing.revoke(deviceId);
  }

  renameDevice(deviceId: string, name: string): Promise<void> {
    return this.deps.gateway.pairing.rename(deviceId, name);
  }

  disconnectSession(sessionId: string, reason?: string): Promise<void> {
    return this.deps.gateway.disconnect(sessionId, reason);
  }

  status(): GatewayStatus {
    return this.deps.gateway.getStatus();
  }

  settings(): MobileSettings {
    return this.deps.gateway.getSettings();
  }

  async updateSettings(patch: Partial<MobileSettings>): Promise<MobileSettings> {
    const settings = await this.deps.gateway.updateSettings(patch);
    this.deps.persistSettings(settings);
    return settings;
  }

  diagnostics(): Promise<NatDiagnostics> {
    return this.deps.gateway.diagnostics();
  }

  /**
   * The mock gateway's phone simulator, for `/api/qa/mobile/*`. Throws on the
   * real gateway: a QA run that thinks it scanned a QR but silently did nothing
   * would report green on a link it never exercised.
   */
  mockControls(): MockControls {
    const controls = (this.deps.gateway as Partial<MockMobileGateway>).mock;
    if (!controls) {
      throw new Error("모바일 파이프가 목이 아닙니다 — 폰 시뮬레이터를 사용할 수 없습니다.");
    }
    return controls;
  }

  // --- internals ----------------------------------------------------------

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
