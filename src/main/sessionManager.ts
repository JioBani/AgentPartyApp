import { EventEmitter } from "node:events";
import * as path from "node:path";
import { ClaudeAdapter } from "../core/claudeAdapter";
import { CodexAdapter } from "../core/codexAdapter";
import type { PartyBridge, PartyIdentity } from "../core/partyBridge";
import { ClaudeNormalizedEvent, ClaudeSessionSnapshot } from "../core/events";
import { ModelRouteConfig, inferModelProvider } from "../core/modelRegistry";
import { discoverCodexModels } from "../core/codexModelDiscovery";
import { EmbeddedHarnessRouter } from "../core/routerShim";
import { CreateSessionInput, ResumableSessionInfo, SessionView, harnessDefaultsOf } from "../shared/types";
import type { CodexModelDiscoveryState } from "../shared/codexModels";
import { CODEX_MODELS_PENDING } from "../shared/codexModels";
import type { CodexPolicy } from "../shared/codexPolicy";
import type { ImageAttachment } from "../shared/attachments";
import type { McpAuthResult, McpServerSnapshot } from "../shared/mcp";
import { mergeProviderUsage, providerOfHarness, reconcileUsageTargets, type UsageLimitsSnapshot, type UsageProviderId } from "../shared/usageLimits";
import { HarnessSession } from "./harness/types";
import { MockHarnessSession } from "./harness/mockHarness";
import { isE2E } from "./runtimeMode";
import { getSettings } from "./settings";
import { log } from "./logger";
import { executionModelFor } from "../shared/modelIdentity";

interface ManagedSession {
  id: string;
  workspace: string;
  adapter: HarnessSession;
  /** The account-usage provider this session draws from — lets the background
   *  usage poller reuse a live session instead of spawning a duplicate. */
  provider?: UsageProviderId;
  queuedEvents: ClaudeNormalizedEvent[];
  flushTimer?: NodeJS.Timeout;
  closed?: boolean;
  /** Stall watchdog bookkeeping (harness-general; see {@link SessionManager.scanForStalls}). */
  lastActivityAt: number;
  turnActive: boolean;
  awaitingUser: boolean;
  stallNotified: boolean;
  /**
   * A compaction is in flight (set when {@link SessionManager.compact} is called,
   * cleared once the harness reports the outcome). While true, an interrupt-on-send
   * is suppressed so a member's context compaction is never torn down half-way by
   * an incoming message — the message queues behind it instead. See
   * {@link SessionManager.isCompacting}.
   */
  compacting?: boolean;
}

/** Pairs a party member's bridge with its identity for in-process tool access. */
export interface SessionPartyBinding {
  bridge: PartyBridge;
  identity: PartyIdentity;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  /**
   * Latest account/provider-scoped rate-limit usage, merged across every session
   * (rate limits are account-global, not per-session). Fed by `usage_limit`
   * events; broadcast to all windows via the "usage" emit. See usageLimits.ts.
   */
  private usageLimits: UsageLimitsSnapshot = {};
  /**
   * Background usage poller: one lightweight, turn-less harness connection per
   * provider, kept alive so the account-usage indicator stays fresh EVEN WITH NO
   * open member session (the adapters self-poll every 60s). Only providers the
   * user actually uses (they have members) and that lack a live session are
   * polled — a live session already reports usage, so it is reused not duplicated.
   * See {@link setUsageProviders} / {@link reconcileUsageAdapters}.
   */
  private usageAdapters = new Map<UsageProviderId, HarnessSession>();
  /** Per-provider "don't retry a failed background connect before this epoch ms". */
  private usageBackoffUntil = new Map<UsageProviderId, number>();
  /** Providers whose usage should stay fresh (union of party-member providers). */
  private desiredUsageProviders = new Set<UsageProviderId>();
  private usageReconcileTimer?: NodeJS.Timeout;
  private static readonly USAGE_BACKOFF_MS = 10 * 60_000;
  /**
   * Per-provider active source for the `usage_limit` event fan-in. Only the
   * active source's emissions are merged into {@link usageLimits}; events from
   * other sources are dropped. Prevents the multi-session race where several
   * live Claude/Codex sessions (and the background poller) each read the same
   * account endpoint and overwrite each other's last-write-wins values.
   *
   * Source ids:
   *   - `session-${ts}`         — a foreground session (one per member)
   *   - `usage-${provider}-${ts}` — the background poller for that provider
   *   - `remote-${provider}`    — a remote engine's aggregated snapshot (WSL)
   *   - `qa`                    — reserved for QA/test injection (always passes)
   */
  private activeUsageSource = new Map<UsageProviderId, string>();
  private static readonly USAGE_SOURCE_BG = (p: UsageProviderId) => `bg-${p}`;
  private static readonly USAGE_SOURCE_REMOTE = (p: UsageProviderId) => `remote-${p}`;
  private static readonly USAGE_SOURCE_QA = "qa";
  /**
   * Resolves the LIVE automation-API base URL (the ACTUAL bound port) for a Codex
   * member's party MCP server. Injected by the desktop host once the API server
   * binds; absent in the headless engine-server / tests, where the configured
   * port is used instead. See {@link codexAutomationBaseUrl}.
   */
  private automationBaseUrlProvider?: () => string | undefined;
  private codexModels: CodexModelDiscoveryState = CODEX_MODELS_PENDING;
  private codexDiscovery: Promise<CodexModelDiscoveryState> | undefined;
  /**
   * Stall watchdog: a turn that goes silent for this long (no event of any kind
   * from the harness, and not waiting on the user for an approval) is flagged so
   * the UI stops showing an indefinite "responding" spinner. A warning, never an
   * auto-kill — the model may just be slow — so the user decides (wait / stop /
   * restart). Harness-general: it observes the normalized event stream every
   * adapter emits, so a new harness needs no watchdog code of its own.
   */
  private static readonly STALL_MS = 120_000;
  private static readonly WATCHDOG_INTERVAL_MS = 20_000;
  private watchdog: NodeJS.Timeout | undefined;

  /**
   * @param userDataDir base dir for harness debug logs (Electron's userData on
   *   the desktop; an engine-chosen dir when running headless, e.g. in WSL).
   *   Injected rather than read from `electron.app` so the engine core runs
   *   under plain node. See docs/WSL_REMOTE.md.
   */
  constructor(private readonly router: EmbeddedHarnessRouter, private readonly userDataDir: string) {
    super();
  }

  createSession(input?: string | CreateSessionInput, resumeSessionId?: string, binding?: SessionPartyBinding): SessionView {
    const settings = getSettings();
    const id = resumeSessionId ? `resume-${Date.now()}` : `session-${Date.now()}`;
    const request = normalizeCreateSessionInput(input);
    const workspace = request.workspacePath || settings.workspacePath || process.cwd();
    const adapter = this.createAdapter(id, workspace, resumeSessionId, request, binding);
    const requestedHarness = request.selectedHarnessId || settings.selectedHarnessId;
    const provider = providerOfHarness(requestedHarness);
    return this.registerSession(id, workspace, adapter, provider);
  }

  /**
   * Signals that a workspace's party state changed out-of-band (e.g. a member
   * drove a party tool). Re-broadcast by the main process; see
   * docs/PARTY_COMMUNICATION.md §8.
   */
  notifyPartyChanged(workspace: string): void {
    this.emit("party", { workspace });
  }

  /** Live embedded-router base URL (actual bound port) for headless helper calls (Message Gate reviewer). */
  routerBaseUrl(): string {
    return this.router.baseUrl;
  }

  /**
   * Injects a synthetic Message Gate badge into a session's transcript stream
   * (the SENDER's session), so a reject/forced/failed outcome shows inline. This
   * is a UI-only artifact — it is never added to any model's context.
   */
  emitGateBadge(
    sessionId: string,
    gate: { gate: "rejected" | "forced" | "failed"; to: string; from?: string; reason?: string; rule?: string; errcode?: string },
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      return;
    }
    this.queueEvent(session, { type: "gate", at: new Date().toISOString(), ...gate });
  }

  /**
   * Snapshot of the live Codex account catalog (`model/list`); kicks discovery
   * on first call and caches the settle for the process lifetime. `refresh`
   * re-runs discovery and awaits the fresh result. A settle (ready or error)
   * emits `"codex-models"` so the app can push updated model routes to windows —
   * a failure stays visible in the state, never silently reverts the UI.
   */
  /** The current merged usage-limit snapshot (all providers). */
  getUsageLimits(): UsageLimitsSnapshot {
    return this.usageLimits;
  }

  /** Requests every live harness to refresh account/provider usage now. */
  async refreshUsageLimits(): Promise<UsageLimitsSnapshot> {
    const tasks: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (session.closed || typeof session.adapter.refreshUsageLimits !== "function") {
        continue;
      }
      tasks.push(session.adapter.refreshUsageLimits());
    }
    // Also poke the background usage adapters, so a manual refresh works even
    // when no member session is open (the whole point of the background poller).
    for (const adapter of this.usageAdapters.values()) {
      if (typeof adapter.refreshUsageLimits === "function") {
        tasks.push(adapter.refreshUsageLimits());
      }
    }
    await Promise.allSettled(tasks);
    return this.usageLimits;
  }

  /**
   * Merges one provider's reported windows and broadcasts the new snapshot,
   * but only if the event's `sourceId` matches this provider's active source.
   * Other sources (a second Claude session, a stale background poller, etc.)
   * are dropped with a debug log — that's the "numbers change on every refresh"
   * race the active-source model fixes. Events without a `sourceId` are
   * accepted and adopted as the new active source (back-compat for code that
   * hasn't been updated yet, e.g. tests injecting raw events).
   */
  private applyUsageLimit(event: Extract<ClaudeNormalizedEvent, { type: "usage_limit" }>): void {
    const provider = event.provider;
    const eventSource = event.sourceId;
    const active = this.activeUsageSource.get(provider);
    if (
      active
      && eventSource
      && eventSource !== active
      && eventSource !== SessionManager.USAGE_SOURCE_QA
    ) {
      log("debug", "usage", "dropped usage_limit from non-active source", {
        provider,
        eventSource,
        active,
      });
      return;
    }
    if (eventSource && !active) {
      this.activeUsageSource.set(provider, eventSource);
    }
    this.usageLimits = {
      ...this.usageLimits,
      [provider]: mergeProviderUsage(this.usageLimits[provider], {
        provider,
        windows: event.windows,
        available: event.available,
        // Use the event's own timestamp (ISO `at`) — `Date.now()` would be the
        // receive time, which lags real provider time and breaks staleness math.
        updatedAt: Date.parse(event.at) || Date.now(),
      }),
    };
    this.emit("usage", this.usageLimits);
  }

  /**
   * Clears the per-provider usage snapshot when its active source goes away.
   * Used on session close, background-poller teardown, and remote-engine
   * disconnect — without it the renderer keeps showing the dead source's last
   * value forever ("stale rate limit" bug). The next active source's first
   * emit repopulates; the 60s background poll keeps that window short.
   */
  private clearUsageForProvider(provider: UsageProviderId): void {
    if (!this.usageLimits[provider]) {
      return;
    }
    const next: UsageLimitsSnapshot = { ...this.usageLimits };
    delete next[provider];
    this.usageLimits = next;
    this.emit("usage", this.usageLimits);
  }

  // --- Background usage poller ---------------------------------------------

  /**
   * Declares which providers the user actually uses (their party members'
   * providers), so their account usage stays fresh even with no open session.
   * Idempotent: reconciles the background adapters and (re)arms the periodic
   * reconcile that revives a poller after its provider's last session closes.
   */
  setUsageProviders(providers: UsageProviderId[]): void {
    this.desiredUsageProviders = new Set(providers);
    this.reconcileUsageAdapters();
    if (!this.usageReconcileTimer) {
      // A live session's polling stops when it closes; this tick brings the
      // background poller back within 60s so an idle provider never goes stale.
      this.usageReconcileTimer = setInterval(() => this.reconcileUsageAdapters(), 60_000);
      this.usageReconcileTimer.unref?.();
    }
  }

  /** True when a non-closed session already reports this provider's usage. */
  private hasLiveSessionForProvider(provider: UsageProviderId): boolean {
    for (const session of this.sessions.values()) {
      if (!session.closed && session.provider === provider) {
        return true;
      }
    }
    return false;
  }

  /** Starts/disposes background usage adapters to match desire + live sessions. */
  private reconcileUsageAdapters(): void {
    // Real harness subprocesses would destabilize the deterministic e2e/mock
    // suites (extra processes, ports); those drive usage via injectUsageLimit.
    if (isE2E()) {
      return;
    }
    const backoffUntil: Partial<Record<UsageProviderId, number>> = {};
    for (const [provider, until] of this.usageBackoffUntil) {
      backoffUntil[provider] = until;
    }
    const liveProviders: UsageProviderId[] = [];
    for (const p of ["claude", "codex"] as UsageProviderId[]) {
      if (this.hasLiveSessionForProvider(p)) {
        liveProviders.push(p);
      }
    }
    const { start, dispose } = reconcileUsageTargets({
      desired: [...this.desiredUsageProviders],
      liveProviders,
      running: [...this.usageAdapters.keys()],
      backoffUntil,
      now: Date.now(),
    });
    for (const provider of dispose) {
      this.disposeUsageAdapter(provider);
    }
    for (const provider of start) {
      this.startUsageAdapter(provider);
    }
  }

  /**
   * Spins up ONE turn-less harness connection for a provider, wired to feed only
   * usage into the shared aggregation. It is NOT registered in `this.sessions`,
   * so it stays invisible to the workbench, session list, and stall watchdog. A
   * failure (e.g. the provider is not logged in) backs the provider off rather
   * than respawning a doomed subprocess every reconcile tick.
   */
  private startUsageAdapter(provider: UsageProviderId): void {
    const settings = getSettings();
    const id = `usage-${provider}-${Date.now()}`;
    const cwd = settings.workspacePath || process.cwd();
    let adapter: HarnessSession;
    try {
      // Both the active-source tracking and the per-event `sourceId` stamp use
      // the same logical id (`bg-${provider}`) — the fan-in filter compares
      // strings, so they must agree. The adapter's runtime id (`usage-…-${ts}`)
      // stays for logs/diagnostics only.
      adapter = this.createAdapter(id, cwd, undefined, {
        selectedHarnessId: provider === "codex" ? "codex" : "claude-code",
      }, undefined, SessionManager.USAGE_SOURCE_BG(provider));
    } catch (error) {
      this.noteUsageAdapterFailure(provider, error);
      return;
    }
    // Claim the active source for this provider immediately, BEFORE start() —
    // the adapter's first `usage_limit` emit must already be accepted by the
    // fan-in filter. Only claim if no foreground session is currently the
    // source (reconcile is the single source of truth for ownership).
    if (!this.activeUsageSource.has(provider)) {
      this.activeUsageSource.set(provider, SessionManager.USAGE_SOURCE_BG(provider));
    }
    this.usageAdapters.set(provider, adapter);
    adapter.on("event", (event: ClaudeNormalizedEvent) => {
      if (event.type === "usage_limit") {
        this.applyUsageLimit(event);
        return;
      }
      const failed = event.type === "error" || (event.type === "status" && event.status === "closed");
      // Only a spontaneous death is a failure. Ignore teardown WE initiated
      // (disposeUsageAdapter already swapped this adapter out of the map), or a
      // stale backoff would block recreating the poller after a live session ends.
      if (failed && this.usageAdapters.get(provider) === adapter) {
        this.noteUsageAdapterFailure(provider, event.type === "error" ? event.message : "background usage connection closed");
      }
    });
    try {
      adapter.start();
    } catch (error) {
      this.noteUsageAdapterFailure(provider, error);
    }
  }

  private disposeUsageAdapter(provider: UsageProviderId): void {
    const adapter = this.usageAdapters.get(provider);
    if (!adapter) {
      return;
    }
    this.usageAdapters.delete(provider);
    // The adapter we're tearing down may have been this provider's active
    // source. If so, drop its snapshot — keeping it would mean showing the
    // dead background poller's last value forever.
    if (this.activeUsageSource.get(provider) === SessionManager.USAGE_SOURCE_BG(provider)) {
      this.activeUsageSource.delete(provider);
      this.clearUsageForProvider(provider);
    }
    try {
      adapter.dispose();
    } catch {
      // Best-effort teardown; a dispose error must not break reconciliation.
    }
  }

  private noteUsageAdapterFailure(provider: UsageProviderId, error: unknown): void {
    this.usageBackoffUntil.set(provider, Date.now() + SessionManager.USAGE_BACKOFF_MS);
    // Capture before disposeUsageAdapter clears the active slot, so we still
    // know whether the dying adapter was the active source.
    const wasActive = this.activeUsageSource.get(provider) === SessionManager.USAGE_SOURCE_BG(provider);
    this.disposeUsageAdapter(provider);
    if (wasActive) {
      // Adapter is gone with no replacement queued (backoff window). Drop the
      // snapshot so the renderer doesn't show its last reading as truth.
      this.clearUsageForProvider(provider);
    }
    // Surfaced, not swallowed: the pill honestly shows "데이터 없음" (never fake
    // numbers), and the reason is logged for diagnosis. Common cause: the
    // provider's CLI is not logged in.
    log("warn", "usage", "background usage poller failed; backing off", {
      provider,
      backoffMs: SessionManager.USAGE_BACKOFF_MS,
      error: error instanceof Error ? error.message : String(error ?? "unknown"),
    });
  }

  /**
   * Test-only: inject a usage-limit event through the SAME aggregation path a
   * real harness event takes, so QA/e2e can drive the indicator deterministically
   * without hitting a provider quota. The reserved `qa` source id bypasses the
   * active-source filter, so tests don't have to set up a foreground session
   * just to flip a number.
   */
  injectUsageLimit(event: Extract<ClaudeNormalizedEvent, { type: "usage_limit" }>): void {
    this.applyUsageLimit({ ...event, sourceId: SessionManager.USAGE_SOURCE_QA } as typeof event & { sourceId: string });
  }

  /**
   * Folds a remote engine's account-usage snapshot into this process's aggregate
   * and rebroadcasts. In WSL mode the harness adapters — and thus the
   * `usage_limit` events — live in the distro's engine-server, so its usage never
   * reaches these desktop windows unless the transport forwards it (see
   * engineServerEntry's "usage" channel + main's forwardRemoteEvent). Usage
   * limits are account-global, so a remote workspace's Claude/Codex reports merge
   * into the same snapshot local sessions feed, latest-per-provider winning.
   *
   * The remote engine owns its own fan-in (one source per provider over there),
   * so on this side we treat it as a single deterministic source: we adopt
   * `remote-${provider}` as the active source whenever the remote reports data,
   * and clear that slot when the snapshot is empty (WSL disconnect).
   */
  mergeRemoteUsage(snapshot: UsageLimitsSnapshot): void {
    let changed = false;
    for (const provider of ["claude", "codex"] as const) {
      const incoming = snapshot?.[provider];
      if (incoming && (incoming.windows?.length || incoming.available !== undefined)) {
        this.activeUsageSource.set(provider, SessionManager.USAGE_SOURCE_REMOTE(provider));
        this.usageLimits = {
          ...this.usageLimits,
          [provider]: mergeProviderUsage(this.usageLimits[provider], {
            provider,
            windows: incoming.windows,
            available: incoming.available,
            updatedAt: incoming.updatedAt,
          }),
        };
        changed = true;
      } else if (!incoming && this.activeUsageSource.get(provider) === SessionManager.USAGE_SOURCE_REMOTE(provider)) {
        // Remote used to be the active source and now has nothing — treat as
        // disconnect; drop the snapshot so the renderer doesn't show ghost data.
        this.activeUsageSource.delete(provider);
        this.clearUsageForProvider(provider);
        changed = true;
      }
    }
    if (changed) {
      this.emit("usage", this.usageLimits);
    }
  }

  getCodexModelState(): CodexModelDiscoveryState {
    if (!this.codexDiscovery) {
      // E2E must not reach user-owned provider APIs; discovery only runs when
      // the test supplies a fake codex binary. The skip is stated, not silent.
      if (isE2E() && !process.env.AGENTPARTY_CODEX_BIN) {
        this.codexModels = {
          status: "error",
          models: [],
          error: "Codex model discovery is disabled in E2E mode without an AGENTPARTY_CODEX_BIN override.",
          at: new Date().toISOString(),
        };
        this.codexDiscovery = Promise.resolve(this.codexModels);
      } else {
        this.codexDiscovery = this.runCodexDiscovery();
      }
    }
    return this.codexModels;
  }

  async refreshCodexModels(): Promise<CodexModelDiscoveryState> {
    this.codexDiscovery = this.runCodexDiscovery();
    return this.codexDiscovery;
  }

  private async runCodexDiscovery(): Promise<CodexModelDiscoveryState> {
    try {
      const models = await discoverCodexModels({ cwd: this.userDataDir });
      this.codexModels = { status: "ready", models, at: new Date().toISOString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.codexModels = { status: "error", models: [], error: message, at: new Date().toISOString() };
    }
    this.emit("codex-models", this.codexModels);
    return this.codexModels;
  }

  /**
   * Creates a QA mock session backed by {@link MockHarnessSession}. It performs
   * no model calls; events are driven by the QA API. Used only in QA mode.
   */
  createMockSession(input?: string | CreateSessionInput, options?: { autoReply?: boolean }): SessionView {
    const settings = getSettings();
    const id = `mock-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const request = normalizeCreateSessionInput(input);
    const selectedHarness = request.selectedHarnessId || settings.selectedHarnessId;
    const provider = providerOfHarness(selectedHarness);
    const selectedDefaults = harnessDefaultsOf(settings, selectedHarness);
    const selectedModel = request.model || selectedDefaults.model;
    const workspace = request.workspacePath || settings.workspacePath || process.cwd();
    const adapter = new MockHarnessSession({
      id,
      cwd: workspace,
      model: selectedModel,
      effort: request.effort || selectedDefaults.effort,
      permissionMode: request.permissionMode || selectedDefaults.permissionMode || "default",
      codexPolicy: request.codexPolicy || selectedDefaults.codexPolicy,
      autoReply: options?.autoReply,
      harness: selectedHarness,
    });
    return this.registerSession(id, workspace, adapter, provider);
  }

  injectMockEvent(id: string, event: unknown): void {
    const adapter = this.mockAdapter(id);
    adapter.inject(event as any);
  }

  setMockStatus(id: string, status: string): void {
    this.mockAdapter(id).setStatus(status);
  }

  isMockSession(id: string): boolean {
    return this.sessions.get(id)?.adapter instanceof MockHarnessSession;
  }

  private mockAdapter(id: string): MockHarnessSession {
    const session = this.sessions.get(id);
    if (!session || !(session.adapter instanceof MockHarnessSession)) {
      throw new Error(`Session '${id}' is not a mock session.`);
    }
    return session.adapter;
  }

  private registerSession(id: string, workspace: string, adapter: HarnessSession, provider?: UsageProviderId): SessionView {
    const session: ManagedSession = { id, workspace, adapter, provider, queuedEvents: [], lastActivityAt: Date.now(), turnActive: false, awaitingUser: false, stallNotified: false };
    this.sessions.set(id, session);
    this.bind(session);
    this.ensureWatchdog();
    adapter.start();
    this.emit("sessions", this.listSessions());
    // This session becomes the active source for its provider's account-usage
    // read — its `usage_limit` events will drive the merge, and any prior
    // background poller's emissions for the same provider will be dropped.
    if (provider) {
      this.activeUsageSource.set(provider, id);
      this.reconcileUsageAdapters();
    }
    return this.toView(session);
  }

  private ensureWatchdog(): void {
    if (this.watchdog) {
      return;
    }
    this.watchdog = setInterval(() => this.scanForStalls(), SessionManager.WATCHDOG_INTERVAL_MS);
    // Never keep the process alive on the watchdog alone.
    this.watchdog.unref?.();
  }

  /**
   * Tracks per-turn liveness from the normalized event stream so the watchdog can
   * tell "still generating" from "hung". Any real event re-arms the alarm; a turn
   * that is waiting on the user (approval) is intentionally not treated as stalled.
   */
  private trackTurnActivity(session: ManagedSession, event: ClaudeNormalizedEvent): void {
    session.lastActivityAt = Date.now();
    session.stallNotified = false;
    switch (event.type) {
      case "turn_complete":
      case "error":
        session.turnActive = false;
        session.awaitingUser = false;
        session.compacting = false;
        break;
      case "approval_request":
        session.turnActive = true;
        session.awaitingUser = true;
        break;
      case "approval_resolved":
        session.awaitingUser = false;
        break;
      case "status": {
        const status = String((event as { status?: unknown }).status || "");
        if (status === "sent" || status === "requesting" || status === "responding") {
          session.turnActive = true;
        }
        // The harness's compaction outcome (success both adapters emit) clears the
        // in-flight flag; failure arrives as a `diagnostic` handled below.
        if (status === "compacted") {
          session.compacting = false;
        }
        break;
      }
      case "diagnostic":
        if (String((event as { category?: unknown }).category || "") === "compact") {
          session.compacting = false;
        }
        break;
      default:
        break;
    }
  }

  /** Flags any active turn that has gone silent past the stall threshold (once). */
  private scanForStalls(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.closed || !session.turnActive || session.awaitingUser || session.stallNotified) {
        continue;
      }
      const idleMs = now - session.lastActivityAt;
      if (idleMs < SessionManager.STALL_MS) {
        continue;
      }
      session.stallNotified = true;
      const seconds = Math.round(idleMs / 1000);
      const event: ClaudeNormalizedEvent = {
        type: "diagnostic",
        severity: "warning",
        category: "stall",
        title: "응답이 멈춘 것 같습니다",
        detail: `${seconds}초 동안 하네스에서 아무 응답이 없습니다. 모델이 도구 호출 등에서 실패했거나 멈췄을 수 있습니다(모델이 느린 것일 수도 있습니다).`,
        recovery: "계속 기다리거나, 정지 후 다시 시도하거나, 세션을 재시작하세요.",
        at: new Date().toISOString(),
      };
      // Route through the normal event pipeline (not trackTurnActivity) so the
      // renderer shows it and the flag is not immediately re-armed.
      this.queueEvent(session, event);
      this.flushEvents(session);
      this.emit("sessions", this.listSessions());
    }
  }

  async listResumableSessions(workspacePath?: string): Promise<{ sessions: ResumableSessionInfo[]; error?: string }> {
    try {
      const sdk = await loadClaudeSdk();
      const sessions = await sdk.listSessions({ dir: workspacePath || getSettings().workspacePath, limit: 40 });
      return { sessions: sessions.map((session: any) => ({
        sessionId: String(session.sessionId || session.session_id || ""),
        customTitle: session.customTitle,
        summary: session.summary,
        firstPrompt: session.firstPrompt,
        lastModified: session.lastModified ? new Date(session.lastModified).toISOString() : undefined,
        gitBranch: session.gitBranch,
      })) };
    } catch (error) {
      return { sessions: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  resumeSession(sessionId: string, workspacePath?: string): SessionView {
    return this.createSession({ workspacePath }, sessionId);
  }

  sendUserTurn(id: string, text: string, attachments?: ImageAttachment[]): void {
    this.sessions.get(id)?.adapter.sendUserTurn(text, attachments);
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * The live harness thread id (Claude/Codex) for an app session — but only once
   * a turn has committed. A zero-turn session is not yet persisted by the harness,
   * so storing its id and resuming it later fails with "No conversation found".
   * Gating on turnCount is the root-cause prevention; the adapter's
   * resume-not-found recovery covers the residual cases (cross-run GC, expiry).
   */
  harnessSessionId(id: string): string | undefined {
    const snapshot = this.sessions.get(id)?.adapter.getSnapshot();
    if (!snapshot?.sessionId || !(snapshot.turnCount && snapshot.turnCount > 0)) {
      return undefined;
    }
    return snapshot.sessionId;
  }

  interrupt(id: string): void {
    this.sessions.get(id)?.adapter.interrupt();
  }

  restart(id: string): void {
    const existing = this.sessions.get(id);
    if (!existing) {
      return;
    }
    existing.adapter.restart();
  }

  compact(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    session.compacting = true;
    session.adapter.compact();
  }

  /** True while a compaction is in flight (see {@link ManagedSession.compacting}). */
  isCompacting(id: string): boolean {
    return Boolean(this.sessions.get(id)?.compacting);
  }

  closeSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
    }
    session.closed = true;
    session.adapter.dispose();
    this.sessions.delete(id);
    this.emit("sessions", this.listSessions());
    // The closed session may have been a provider's only live usage source.
    // Drop its snapshot (the dead-source stale-data bug) and let the
    // background poller that reconcileUsageAdapters spawns take over.
    if (session.provider && this.activeUsageSource.get(session.provider) === id) {
      this.activeUsageSource.delete(session.provider);
      this.clearUsageForProvider(session.provider);
    }
    if (session.provider) {
      this.reconcileUsageAdapters();
    }
    return true;
  }

  setModel(id: string, model: string, providerId?: string, runtimeModel?: string): void {
    const adapter = this.sessions.get(id)?.adapter;
    if (!adapter) {
      return;
    }
    const adapterHarness = adapter instanceof CodexAdapter ? "codex" : "claude-code";
    const effectiveModel = adapterHarness === "codex" ? executionModelFor(model, "codex") : model;
    adapter.setModel(effectiveModel, providerId as any, runtimeModel);
  }

  setEffort(id: string, effort: string): void {
    this.sessions.get(id)?.adapter.setEffort(effort as any);
  }

  setThinking(id: string, mode: string, budget?: number): void {
    this.sessions.get(id)?.adapter.setThinking(mode, budget);
  }

  setPermissionMode(id: string, permissionMode: string): void {
    this.sessions.get(id)?.adapter.setPermissionMode(permissionMode);
  }

  setCodexPolicy(id: string, policy: CodexPolicy): void {
    const adapter = this.sessions.get(id)?.adapter;
    if (!adapter?.setCodexPolicy) {
      throw new Error(`Session '${id}' does not support a Codex policy (not a Codex harness).`);
    }
    adapter.setCodexPolicy(policy);
  }

  // --- MCP (external servers a member connects to as a client) -------------
  private requireAdapter(id: string): HarnessSession {
    const adapter = this.sessions.get(id)?.adapter;
    if (!adapter) {
      throw new Error(`Session '${id}' not found.`);
    }
    return adapter;
  }

  listMcpServers(id: string): Promise<McpServerSnapshot> {
    const adapter = this.requireAdapter(id);
    if (!adapter.listMcpServers) {
      throw new Error(`Session '${id}' does not expose MCP status.`);
    }
    return adapter.listMcpServers();
  }

  reconnectMcpServer(id: string, name: string): Promise<void> {
    const adapter = this.requireAdapter(id);
    if (!adapter.reconnectMcpServer) {
      throw new Error(`Session '${id}' does not support reconnecting an MCP server.`);
    }
    return adapter.reconnectMcpServer(name);
  }

  setMcpServerEnabled(id: string, name: string, enabled: boolean): Promise<void> {
    const adapter = this.requireAdapter(id);
    if (!adapter.setMcpServerEnabled) {
      throw new Error(`Session '${id}' does not support enabling/disabling an MCP server (config-file driven on this harness).`);
    }
    return adapter.setMcpServerEnabled(name, enabled);
  }

  authenticateMcpServer(id: string, name: string): Promise<McpAuthResult> {
    const adapter = this.requireAdapter(id);
    if (!adapter.authenticateMcpServer) {
      throw new Error(`Session '${id}' does not support MCP OAuth here — authenticate via the interactive client.`);
    }
    return adapter.authenticateMcpServer(name);
  }

  setDebugMode(enabled: boolean): void {
    for (const session of this.sessions.values()) {
      session.adapter.setDebugMode(enabled);
    }
    this.emit("sessions", this.listSessions());
  }

  approve(id: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): void {
    this.sessions.get(id)?.adapter.respondApproval(requestId, behavior, updatedInput, message);
  }

  listSessions(): SessionView[] {
    return Array.from(this.sessions.values()).map((session) => this.toView(session));
  }

  dispose(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    if (this.usageReconcileTimer) {
      clearInterval(this.usageReconcileTimer);
      this.usageReconcileTimer = undefined;
    }
    for (const provider of [...this.usageAdapters.keys()]) {
      this.disposeUsageAdapter(provider);
    }
    for (const session of this.sessions.values()) {
      if (session.flushTimer) {
        clearTimeout(session.flushTimer);
      }
      session.adapter.dispose();
    }
    this.sessions.clear();
  }

  /**
   * Wires the live automation-API base-URL source (see {@link automationBaseUrlProvider}).
   * The desktop host calls this after the API server binds, passing a getter over
   * the server's real base URL so it always reflects the actual (possibly
   * ephemeral) port, not the configured one.
   */
  setAutomationBaseUrlProvider(provider: () => string | undefined): void {
    this.automationBaseUrlProvider = provider;
  }

  /**
   * The URL a Codex member's party MCP server fetches for every party tool. It
   * MUST be the ACTUAL bound automation-API URL: the server falls back to an
   * ephemeral port when the preferred one is taken (a second app instance or a
   * leftover process), and a Codex member baked with the stale configured port
   * fails every send/list with "fetch failed". The live provider reports the real
   * port; the env/configured port is only the headless (engine-server/test)
   * fallback. A pre-bind `:0` is ignored so a bad URL is never baked.
   */
  private codexAutomationBaseUrl(configuredPort: number): string {
    const live = this.automationBaseUrlProvider?.();
    if (live && !live.endsWith(":0")) {
      return live;
    }
    return `http://127.0.0.1:${process.env.AGENTPARTY_AUTOMATION_PORT || configuredPort}`;
  }

  private createAdapter(id: string, cwd: string, resumeSessionId: string | undefined, request: CreateSessionInput, binding?: SessionPartyBinding, usageSourceId?: string): HarnessSession {
    const settings = getSettings();
    const selectedHarness = request.selectedHarnessId || settings.selectedHarnessId;
    const harnessDefaults = harnessDefaultsOf(settings, selectedHarness);
    const selectedModel = request.model || harnessDefaults.model;
    if (selectedHarness === "codex") {
      return new CodexAdapter({
        id,
        cwd,
        model: executionModelFor(selectedModel, "codex"),
        effort: request.effort || harnessDefaults.effort,
        permissionMode: request.permissionMode || harnessDefaults.permissionMode,
        policy: request.codexPolicy || harnessDefaults.codexPolicy,
        debugEnabled: settings.debugEnabled,
        storageDir: path.join(this.userDataDir, "logs"),
        resumeSessionId,
        partyBridge: binding?.bridge,
        partyIdentity: binding?.identity,
        automationBaseUrl: this.codexAutomationBaseUrl(settings.automationApiPort),
        // Enables Codex→OpenRouter routing for OpenRouter-slug models; absent =
        // account catalog (openai) only. See codexProviders.ts.
        openRouterApiKey: settings.openRouterApiKey || process.env.OPENROUTER_API_KEY || undefined,
        usageSourceId,
      });
    }
    const storageDir = path.join(this.userDataDir, "logs");
    const routerAccountingKey = `agentparty-native-session:${id}`;
    const model = selectedModel;
    return new ClaudeAdapter({
      id,
      cwd,
      executablePath: settings.claudeExecutablePath,
      model,
      providerId: request.selectedProviderId || inferModelProvider(model),
      effort: request.effort || harnessDefaults.effort,
      thinking: request.thinking,
      thinkingBudget: request.thinkingBudget,
      permissionMode: request.permissionMode || harnessDefaults.permissionMode,
      safeMode: settings.claudeSafeMode,
      debugEnabled: settings.debugEnabled,
      storageDir,
      customModelRoutes: [] as ModelRouteConfig[],
      routerBaseUrl: this.router.baseUrl || settings.routerBaseUrl,
      routerAuthToken: routerAccountingKey,
      routerAccountingKey,
      resetRouterTurnUsage: (accountingKey) => this.router.resetTurnUsage(accountingKey),
      consumeRouterTurnUsage: (accountingKey) => this.router.consumeTurnUsage(accountingKey),
      resumeSessionId,
      partyBridge: binding?.bridge,
      partyIdentity: binding?.identity,
      usageSourceId,
    });
  }

  private bind(session: ManagedSession): void {
    session.adapter.on("event", (event: ClaudeNormalizedEvent) => {
      if (session.closed || !this.sessions.has(session.id)) {
        return;
      }
      this.trackTurnActivity(session, event);
      if (event.type === "usage_limit") {
        // Account-scoped, not a transcript block: aggregate globally and push,
        // rather than queueing it into this session's event stream.
        this.applyUsageLimit(event);
        return;
      }
      this.queueEvent(session, event);
      if (event.type === "session" || event.type === "turn_complete" || event.type === "error" || event.type === "status") {
        this.emit("sessions", this.listSessions());
      }
    });
    session.adapter.on("snapshot", (snapshot: ClaudeSessionSnapshot) => {
      if (session.closed || !this.sessions.has(session.id)) {
        return;
      }
      this.emit("snapshot", { sessionId: session.id, workspace: session.workspace, snapshot });
      this.emit("sessions", this.listSessions());
    });
  }

  private queueEvent(session: ManagedSession, event: ClaudeNormalizedEvent): void {
    session.queuedEvents.push(event);
    if (event.type === "turn_complete" || event.type === "error" || event.type === "approval_request") {
      this.flushEvents(session);
      return;
    }
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => this.flushEvents(session), 33);
    }
  }

  private flushEvents(session: ManagedSession): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = undefined;
    }
    if (!session.queuedEvents.length) {
      return;
    }
    const events = compactEvents(session.queuedEvents);
    session.queuedEvents = [];
    this.emit("events", { sessionId: session.id, workspace: session.workspace, events });
  }

  private toView(session: ManagedSession): SessionView {
    const snapshot = session.adapter.getSnapshot();
    return {
      id: session.id,
      title: snapshot.model || "Claude Code",
      workspace: session.workspace,
      snapshot,
    };
  }
}

function normalizeCreateSessionInput(input?: string | CreateSessionInput): CreateSessionInput {
  if (!input) {
    return {};
  }
  if (typeof input === "string") {
    return { workspacePath: input };
  }
  return input;
}

async function loadClaudeSdk(): Promise<typeof import("@anthropic-ai/claude-agent-sdk")> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof import("@anthropic-ai/claude-agent-sdk")>;
  return await dynamicImport("@anthropic-ai/claude-agent-sdk");
}

function compactEvents(events: ClaudeNormalizedEvent[]): ClaudeNormalizedEvent[] {
  const compacted: ClaudeNormalizedEvent[] = [];
  for (const event of events) {
    const previous = compacted[compacted.length - 1];
    if (
      previous?.type === event.type
      && (event.type === "assistant_text_delta" || event.type === "reasoning_delta")
      && previous.type === event.type
      && previous.blockIndex === event.blockIndex
    ) {
      previous.text += event.text;
      previous.at = event.at;
      continue;
    }
    compacted.push(event);
  }
  return compacted;
}
