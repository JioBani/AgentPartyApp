import type { GateFailureLayer } from "../shared/messageGate";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { ClaudeAdapter } from "../core/claudeAdapter";
import { CodexAdapter, resolvePartyMcpServerScript, spawnableNodeCommand } from "../core/codexAdapter";
import { partyMcpRuntimeEnv } from "../core/partyMcpRuntime";
import { GrokAdapter } from "../core/grokAdapter";
import { agentPartyCodexSqliteHome } from "../core/codexSqliteHome";
import { CursorAdapter } from "../core/cursorAdapter";
import { prepareCursorPartyRuntime } from "../core/cursorPartyPlugin";
import type { PartyBridge, PartyIdentity } from "../core/partyBridge";
import { ClaudeNormalizedEvent, ClaudeSessionSnapshot } from "../core/events";
import { ModelRouteConfig, inferModelProvider } from "../core/modelRegistry";
import { discoverCodexModels } from "../core/codexModelDiscovery";
import { EmbeddedHarnessRouter } from "../core/routerShim";
import { CreateSessionInput, ResumableSessionInfo, SessionView, harnessDefaultsOf } from "../shared/types";
import type { CodexModelDiscoveryState } from "../shared/codexModels";
import { CODEX_MODELS_PENDING } from "../shared/codexModels";
import type { CodexPolicy } from "../shared/codexPolicy";
import type { CursorPolicy } from "../shared/cursorPolicy";
import type { ImageAttachment } from "../shared/attachments";
import type { McpAuthResult, McpServerSnapshot } from "../shared/mcp";
import { mergeProviderUsage, providerOfHarness, reconcileUsageTargets, restoreUsageSnapshot, USAGE_PROVIDER_ORDER, type UsageLimitsSnapshot, type UsageProviderId } from "../shared/usageLimits";
import { HarnessSession } from "./harness/types";
import { MockHarnessSession } from "./harness/mockHarness";
import { UsageLedger } from "./usageLedger";
import type { TokenTrigger, TurnUsageRecord } from "../shared/tokenUsage";
import { isE2E } from "./runtimeMode";
import { getSettings } from "./settings";
import { log } from "./logger";
import { executionModelFor } from "../shared/modelIdentity";
import type { CodexAuthenticationApplyResult, CodexAuthenticationUpdate } from "../shared/codexAuthentication";
import { CodexAuthenticationStore } from "./codexAuthenticationStore";
import { DEEPSEEK_API_KEY_ENV } from "../shared/deepseekDefaults";

/**
 * Status strings that begin or end a turn. Used only by idle sleep's
 * "conversational activity" clock — the statuses in between (and the ambient
 * usage/diagnostic traffic a session emits on a timer) deliberately do not count.
 */
const TURN_BOUNDARY_STATUSES = new Set(["sent", "requesting", "responding", "interrupted"]);

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
  /**
   * Last CONVERSATIONAL activity, for idle sleep.
   *
   * Deliberately not {@link lastActivityAt}: that one answers "has the harness
   * produced anything", which the account-usage poller satisfies every 60s all
   * by itself. Idle sleep asking the same question could never see a member
   * quiet for longer than one poll, so no member ever slept — the feature
   * reported success and reclaimed nothing. Ambient bookkeeping does not count
   * as someone using the member.
   */
  lastTurnActivityAt: number;
  turnActive: boolean;
  /**
   * Wall-clock start of the in-flight turn (ms), stamped when a turn transitions
   * idle→active. Recorded as {@link TurnUsageRecord.atStart} so the usage ledger
   * can measure real active time (the design's rate/utilization metrics), not
   * just turn counts. Cleared when the turn's usage is recorded.
   */
  turnStartedAt?: number;
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
  /** Party/member identity (present for member sessions) — attributes ledger records. */
  identity?: PartyIdentity;
  /** Latest harness snapshot — the source of model/effort/sessionId for the ledger. */
  lastSnapshot?: ClaudeSessionSnapshot;
  /**
   * Why the in-flight turn was started, set by the initiator (user send /
   * party-message delivery / compact). Consumed and cleared when the turn
   * completes; a turn with no known origin records `"unknown"`, never a guess.
   */
  pendingTrigger?: TokenTrigger;
}

/** Pairs a party member's bridge with its identity for in-process tool access. */
export interface SessionPartyBinding {
  bridge: PartyBridge;
  identity: PartyIdentity;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  /** Append-only per-turn usage ledger backing the Token Usage dashboard. */
  private ledger = new UsageLedger();
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
  private readonly codexAuthenticationStore: CodexAuthenticationStore;
  private codexAuthenticationGeneration = "";
  private codexAuthenticationApply: Promise<unknown> = Promise.resolve();
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
   *   under plain node. See the WSL remote-engine design.
   */
  constructor(
    private readonly router: EmbeddedHarnessRouter,
    private readonly userDataDir: string,
    /** Stable host/workspace identity; separates helpers owned by parallel WSL engines. */
    private readonly runtimeScope = "host",
  ) {
    super();
    this.usageLimits = this.loadUsageLimits();
    this.codexAuthenticationStore = new CodexAuthenticationStore(
      userDataDir,
      process.env.AGENTPARTY_NATIVE_CODEX_HOME || undefined,
    );
  }

  /**
   * Applies the desktop-selected Codex account on this engine host, then
   * reconnects live account-catalog sessions without discarding their threads.
   * The same method runs natively inside WSL through EngineConnection RPC.
   */
  setCodexAuthentication(update: CodexAuthenticationUpdate): Promise<CodexAuthenticationApplyResult> {
    const task = this.codexAuthenticationApply.then(() => this.applyCodexAuthentication(update));
    this.codexAuthenticationApply = task.catch(() => undefined);
    return task;
  }

  private async applyCodexAuthentication(update: CodexAuthenticationUpdate): Promise<CodexAuthenticationApplyResult> {
    const changed = await this.codexAuthenticationStore.apply(update);
    if (!changed) {
      return {
        changed: false,
        generation: update.generation,
        connected: Boolean(update.credential),
        restartedSessions: 0,
        deferredSessions: 0,
      };
    }
    this.codexAuthenticationGeneration = update.generation;
    let restartedSessions = 0;
    let deferredSessions = 0;
    for (const session of this.sessions.values()) {
      const outcome = session.adapter.authenticationChanged?.(update.generation);
      if (outcome === "restarted") restartedSessions += 1;
      if (outcome === "deferred") deferredSessions += 1;
    }
    for (const adapter of this.usageAdapters.values()) {
      adapter.authenticationChanged?.(update.generation);
    }
    this.codexModels = CODEX_MODELS_PENDING;
    this.codexDiscovery = undefined;
    void this.refreshCodexModels();
    return {
      changed: true,
      generation: update.generation,
      connected: Boolean(update.credential),
      restartedSessions,
      deferredSessions,
    };
  }

  createSession(input?: string | CreateSessionInput, resumeSessionId?: string, binding?: SessionPartyBinding): SessionView {
    const settings = getSettings();
    const id = resumeSessionId ? `resume-${Date.now()}` : `session-${Date.now()}`;
    const request = normalizeCreateSessionInput(input);
    const workspace = request.workspacePath || settings.workspacePath || process.cwd();
    // The session id doubles as its usage sourceId: registerSession claims the
    // active-usage slot under this id, and the fan-in filter compares event
    // sourceIds against that slot. Unstamped foreground events used to bypass
    // the filter entirely, letting every live session overwrite the meter
    // (the "usage changes on every refresh" bug).
    const adapter = this.createAdapter(id, workspace, resumeSessionId, request, binding, id);
    const requestedHarness = request.selectedHarnessId || settings.selectedHarnessId;
    const provider = providerOfHarness(requestedHarness);
    return this.registerSession(id, workspace, adapter, provider, binding?.identity);
  }

  /**
   * Signals that a workspace's party state changed out-of-band (e.g. a member
   * drove a party tool). Re-broadcast by the main process; see
   * the party-communication design §8.
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
    // A manual refresh is the user explicitly asking "read it again NOW" —
    // clear any failure backoff and revive missing background pollers first,
    // or the refresh button silently does nothing for up to 10 minutes after
    // a failed connect (e.g. the provider CLI just got logged in).
    this.usageBackoffUntil.clear();
    this.reconcileUsageAdapters();
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
    this.persistUsageLimits();
    this.emit("usage", this.usageLimits);
  }

  /**
   * Restores only still-valid account windows. Claude can return no proactive
   * windows until its first turn, so preserving the last provider-confirmed
   * reading prevents an app restart from regressing to permanent unknown.
   */
  private loadUsageLimits(): UsageLimitsSnapshot {
    try {
      return restoreUsageSnapshot(JSON.parse(fs.readFileSync(this.usageCachePath(), "utf8")), Date.now());
    } catch {
      return {};
    }
  }

  private persistUsageLimits(): void {
    const file = this.usageCachePath();
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(this.usageLimits), "utf8");
      fs.renameSync(temp, file);
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch {}
      log("warn", "usage", "failed to persist usage snapshot", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private usageCachePath(): string {
    return path.join(this.userDataDir, "usage-limits.json");
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
    this.persistUsageLimits();
    this.emit("usage", this.usageLimits);
  }

  // --- Background usage poller ---------------------------------------------

  /**
   * Declares which titlebar providers should stay fresh even with no open session.
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
    for (const p of ["claude", "codex", "cursor", "grok"] as UsageProviderId[]) {
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
        selectedHarnessId:
          provider === "codex" ? "codex" :
          provider === "cursor" ? "cursor" :
          provider === "grok" ? "grok" : "claude-code",
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
    // Release source ownership but preserve its last valid account snapshot
    // while the foreground session performs its immediate replacement read.
    if (this.activeUsageSource.get(provider) === SessionManager.USAGE_SOURCE_BG(provider)) {
      this.activeUsageSource.delete(provider);
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
    if (wasActive || !this.usageLimits[provider]) {
      // Adapter is gone with no replacement queued (backoff window). Drop any
      // stale reading, but leave an explicit EMPTY report in its place: a
      // missing snapshot renders "불러오는 중…", and nothing is loading during
      // the backoff — the honest state is "데이터 없음" until a poller returns.
      this.clearUsageForProvider(provider);
      this.usageLimits = {
        ...this.usageLimits,
        [provider]: { provider, windows: [], updatedAt: Date.now() },
      };
      this.persistUsageLimits();
      this.emit("usage", this.usageLimits);
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
    for (const provider of USAGE_PROVIDER_ORDER) {
      const incoming = snapshot?.[provider];
      if (incoming && (incoming.windows?.length || incoming.available !== undefined)) {
        // A live LOCAL foreground session outranks the remote reader: both
        // poll the same account, and letting each adopt the active slot in
        // turn made the meter alternate between two readings taken at
        // different moments ("differs by process"). Remote may replace the
        // background poller — but only with REAL windows: adopting on an
        // empty report would trade the local poller's live meter for a
        // remote host whose read has nothing (e.g. its CLI lacks the usage
        // API). A remote-active slot keeps accepting remote reports as before.
        const active = this.activeUsageSource.get(provider);
        const remoteId = SessionManager.USAGE_SOURCE_REMOTE(provider);
        if (active && active !== remoteId) {
          const isBackground = active === SessionManager.USAGE_SOURCE_BG(provider);
          if (!isBackground || !incoming.windows?.length) {
            continue;
          }
        }
        this.activeUsageSource.set(provider, remoteId);
        this.usageLimits = {
          ...this.usageLimits,
          [provider]: mergeProviderUsage(this.usageLimits[provider], {
            provider,
            windows: incoming.windows,
            available: incoming.available,
            updatedAt: incoming.updatedAt,
          }),
        };
        this.persistUsageLimits();
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
      const models = await discoverCodexModels({
        cwd: this.userDataDir,
        sqliteHome: agentPartyCodexSqliteHome(this.userDataDir, `${this.runtimeScope}:model-discovery`),
      });
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
  createMockSession(input?: string | CreateSessionInput, options?: { autoReply?: boolean; identity?: PartyIdentity }): SessionView {
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
      cursorPolicy: request.cursorPolicy || selectedDefaults.cursorPolicy,
      autoReply: options?.autoReply,
      harness: selectedHarness,
    });
    return this.registerSession(id, workspace, adapter, provider, options?.identity);
  }

  injectMockEvent(id: string, event: unknown): void {
    const adapter = this.mockAdapter(id);
    adapter.inject(event as any);
  }

  setMockStatus(id: string, status: string): void {
    const session = this.sessions.get(id);
    if (!session || !(session.adapter instanceof MockHarnessSession)) {
      throw new Error(`Mock session '${id}' not found`);
    }
    session.adapter.setStatus(status);
    // QA's status control represents the same lifecycle state as a real
    // normalized status event. Keep the canonical flag in sync so product E2E
    // does not accidentally test only the presentation snapshot.
    if (status === "sent" || status === "requesting" || status === "responding") {
      if (!session.turnActive) session.turnStartedAt = Date.now();
      session.turnActive = true;
      session.awaitingUser = false;
    } else if (status === "idle" || status === "interrupted") {
      session.turnActive = false;
      session.awaitingUser = false;
      session.compacting = false;
    }
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

  private registerSession(id: string, workspace: string, adapter: HarnessSession, provider?: UsageProviderId, identity?: PartyIdentity): SessionView {
    const session: ManagedSession = { id, workspace, adapter, provider, identity, queuedEvents: [], lastActivityAt: Date.now(), lastTurnActivityAt: Date.now(), turnActive: false, awaitingUser: false, stallNotified: false };
    this.sessions.set(id, session);
    this.bind(session);
    this.ensureWatchdog();
    // Claim the provider's usage fan-in slot BEFORE start(). Cursor/Claude/Codex
    // adapters emit `usage_limit` from start() (and the Cursor poller can fire
    // almost immediately). Claiming after start() left `bg-${provider}` active,
    // so the new session's first readings were dropped ("dropped usage_limit
    // from non-active source") and the titlebar kept the background poller's
    // empty/not-logged-in state.
    if (provider) {
      this.activeUsageSource.set(provider, id);
    }
    adapter.start();
    this.emit("sessions", this.listSessions());
    if (provider) {
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
    // Idle sleep measures from TURN BOUNDARIES, not from "the harness said
    // something". A session emits ambient traffic on its own — the 60s account
    // usage poll and the status lines around it — and treating any of it as use
    // kept `quietMs` resetting before it could ever reach the threshold, so no
    // member slept. Per-event precision is not needed either: while a turn runs
    // `turnActive` already blocks sleep, so the only moments that matter are
    // when one starts, ends, or parks on the user.
    const startsOrEndsTurn = event.type === "turn_complete"
      || event.type === "error"
      || event.type === "approval_request"
      || event.type === "approval_resolved"
      || event.type === "queue_dequeued"
      // A compaction bounds a turn exactly as the old `compacted` STATUS did.
      // Dropping it here would leave a long compaction looking like silence to
      // the stall watchdog, which is precisely when it must not fire.
      || event.type === "compact_state"
      || (event.type === "status" && TURN_BOUNDARY_STATUSES.has(String((event as { status?: unknown }).status || "")));
    if (startsOrEndsTurn) {
      session.lastTurnActivityAt = session.lastActivityAt;
    }
    switch (event.type) {
      case "turn_complete":
      case "error":
        session.turnActive = false;
        session.awaitingUser = false;
        session.compacting = false;
        break;
      case "approval_request":
        if (!session.turnActive) session.turnStartedAt = Date.now();
        session.turnActive = true;
        session.awaitingUser = true;
        break;
      case "approval_resolved":
        session.awaitingUser = false;
        break;
      case "status": {
        const status = String((event as { status?: unknown }).status || "");
        if (status === "sent" || status === "requesting" || status === "responding") {
          if (!session.turnActive) session.turnStartedAt = Date.now();
          session.turnActive = true;
        }
        // A stopped turn is a FINISHED turn. Claude/Codex close it with a
        // result, but Cursor's one-process-per-turn CLI is killed outright and
        // reports only this — without it the app-side turn stayed open forever,
        // so the stall watchdog could never flag a genuinely stuck Cursor member
        // and the usage ledger measured the next turn from the stopped one.
        if (status === "interrupted") {
          session.turnActive = false;
          session.awaitingUser = false;
          session.compacting = false;
        }
        break;
      }
      // The compaction outcome. This used to ride on a `compacted` STATUS line,
      // which was also the raw text shown in the transcript; now that the card
      // replaced it, the flag follows the structured event instead. Both
      // terminal states clear it — a failed compaction is not still in flight.
      case "compact_state":
        if (String((event as { state?: unknown }).state || "") !== "running") {
          session.compacting = false;
        }
        break;
      case "diagnostic":
        if (String((event as { category?: unknown }).category || "") === "compact") {
          session.compacting = false;
        }
        // An intentional stop (R-90) ends the turn the same way Cursor's old
        // `status: interrupted` did — without this the member stays mid-turn.
        if (String((event as { category?: unknown }).category || "") === "interrupt") {
          session.turnActive = false;
          session.awaitingUser = false;
          session.compacting = false;
        }
        break;
      default:
        break;
    }
  }

  /**
   * Sessions quiet for at least `thresholdMs` that hold nothing THIS layer knows
   * would be destroyed by ending them.
   *
   * Deliberately answers only about the session: a turn in flight, a prompt the
   * user has not answered, a compaction, and work the harness detached from its
   * turn. Member policy — an explicit keep-awake, a queued message, which
   * harness it is — belongs to the caller, which owns member state.
   *
   * `backgroundTaskCount` is read from the adapter rather than the last
   * broadcast snapshot: a task can be backgrounded without anything else
   * changing, and acting on a stale count is exactly the mistake that would
   * destroy running work.
   */
  idleCandidates(thresholdMs: number): { id: string; identity?: PartyIdentity; quietMs: number }[] {
    const now = Date.now();
    const candidates: { id: string; identity?: PartyIdentity; quietMs: number }[] = [];
    for (const session of this.sessions.values()) {
      const quietMs = now - session.lastTurnActivityAt;
      if (quietMs < thresholdMs || this.sleepBlocker(session.id)) {
        continue;
      }
      candidates.push({ id: session.id, identity: session.identity, quietMs });
    }
    return candidates;
  }

  /** Per-session quiet time and blocker, for diagnosing a member that never sleeps. */
  describeIdleState(): { id: string; member?: string; quietMs: number; blocker?: string }[] {
    const now = Date.now();
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      member: session.identity?.member,
      quietMs: now - session.lastTurnActivityAt,
      blocker: this.sleepBlocker(session.id),
    }));
  }

  /**
   * What this session would LOSE if its process ended now, or undefined if
   * nothing would. The single place the session-level answer is decided, so the
   * timed sweep and a hand-driven sleep cannot disagree — and a hand-driven
   * sleep is exactly when someone is most likely to destroy running work.
   *
   * `backgroundTaskCount` is read from the adapter rather than the last
   * broadcast snapshot: a task can be backgrounded without anything else
   * changing, and acting on a stale count is the mistake that destroys work.
   */
  sleepBlocker(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      return undefined;
    }
    if (session.turnActive) {
      return "a turn is in flight";
    }
    if (session.awaitingUser) {
      return "it is waiting on an approval";
    }
    if (session.compacting) {
      return "a compaction is in flight";
    }
    const snapshot = session.adapter.getSnapshot();
    const background = Number(snapshot.backgroundTaskCount || 0);
    if (background > 0) {
      return `${background} background task(s) are still running`;
    }
    // Turns buffered inside the adapter are lost on dispose, and unlike the
    // app-level queue nothing can hand them back. An idle session should hold
    // none — adapters buffer only while a turn runs — so this guards against
    // being wrong about that, not an expected case.
    if (Number(snapshot.queuedTurnCount || 0) > 0) {
      return "turns are buffered in the harness";
    }
    return undefined;
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

  sendUserTurn(id: string, text: string, attachments?: ImageAttachment[], trigger: TokenTrigger = "user"): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    // Tag the in-flight turn's origin so the usage ledger can attribute its cost
    // by trigger (person vs member-to-member message vs …). Consumed on
    // turn_complete; see {@link recordTurnUsage}.
    session.pendingTrigger = trigger;
    session.adapter.sendUserTurn(text, attachments);
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * Publishes an app-authored event on a session's stream, so it reaches the
   * renderer (and the persisted transcript) through the exact same path harness
   * events take. Used by the message queue to announce a delivery the harness
   * itself cannot describe: it sees an ordinary turn and has no idea the text
   * waited in a queue first.
   *
   * Returns false when the session is gone — the caller must surface that rather
   * than assume the event landed.
   */
  emitAppEvent(id: string, event: ClaudeNormalizedEvent): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    this.queueEvent(session, event);
    return true;
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

  /** Manual escape hatch: releases a turn the harness will never close. */
  forceStop(id: string): void {
    this.sessions.get(id)?.adapter.forceStop();
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
    if (!session.turnActive) session.turnStartedAt = Date.now();
    session.adapter.compact();
  }

  /** True while a compaction is in flight (see {@link ManagedSession.compacting}). */
  isCompacting(id: string): boolean {
    return Boolean(this.sessions.get(id)?.compacting);
  }

  /**
   * Whether a real model turn is in flight right now.
   *
   * Do not infer this from the adapter's display status: a stale `responding`
   * or a process being woken can outlive the actual turn boundary. Interrupt
   * routing needs the lifecycle flag maintained by {@link trackTurnActivity}.
   */
  isTurnActive(id: string): boolean {
    const session = this.sessions.get(id);
    return Boolean(session && !session.closed && session.turnActive);
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
    // Release source ownership but preserve the account-global value while
    // another live session or the background poller takes over immediately.
    if (session.provider && this.activeUsageSource.get(session.provider) === id) {
      this.activeUsageSource.delete(session.provider);
      // If another member for the same account remains open, hand ownership to
      // it now instead of waiting up to 60s for its next polling tick.
      const replacement = Array.from(this.sessions.values()).find(
        (candidate) => !candidate.closed && candidate.provider === session.provider,
      );
      if (replacement) {
        this.activeUsageSource.set(session.provider, replacement.id);
        void replacement.adapter.refreshUsageLimits?.();
      }
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
    const adapterHarness = adapter instanceof CodexAdapter ? "codex" : adapter instanceof CursorAdapter ? "cursor" : "claude-code";
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

  setCursorPolicy(id: string, policy: CursorPolicy): void {
    const adapter = this.sessions.get(id)?.adapter;
    if (!adapter?.setCursorPolicy) {
      throw new Error(`Session '${id}' does not support a Cursor policy (not a Cursor harness).`);
    }
    adapter.setCursorPolicy(policy);
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
    if (selectedHarness === "cursor") {
      const partyRuntime = binding
        ? prepareCursorPartyRuntime({
            baseDir: path.join(this.userDataDir, "cursor-plugins"),
            sessionId: id,
            automationBaseUrl: this.codexAutomationBaseUrl(settings.automationApiPort),
            identity: binding.identity,
          })
        : undefined;
      return new CursorAdapter({
        id,
        cwd,
        executablePath: settings.cursorExecutablePath,
        model: selectedModel,
        effort: request.effort || harnessDefaults.effort,
        serviceTier: request.serviceTier || harnessDefaults.serviceTier,
        permissionMode: request.permissionMode || harnessDefaults.permissionMode,
        cursorPolicy: request.cursorPolicy || harnessDefaults.cursorPolicy,
        debugEnabled: settings.debugEnabled,
        storageDir: path.join(this.userDataDir, "logs"),
        resumeSessionId,
        pluginDir: partyRuntime?.pluginDir,
        partyPrimer: partyRuntime?.primer,
        usageSourceId,
      });
    }
    if (selectedHarness === "grok") {
      // Grok Build takes MCP servers as a session/new parameter, so the party
      // tool relay is injected per session — nothing is written into the user's
      // ~/.grok/config.toml or into the repo's .grok/, unlike the Codex and
      // Cursor paths which have to place files on disk.
      const automationBaseUrl = this.codexAutomationBaseUrl(settings.automationApiPort);
      const partyServers = binding && automationBaseUrl
        ? [{
            name: "agentparty-app",
            command: spawnableNodeCommand(),
            args: [resolvePartyMcpServerScript()],
            env: [
              ...Object.entries(partyMcpRuntimeEnv()).map(([name, value]) => ({ name, value })),
              { name: "AGENTPARTY_AUTOMATION_BASE_URL", value: automationBaseUrl },
              { name: "AGENTPARTY_MEMBER", value: binding.identity.member },
              { name: "AGENTPARTY_PARTY", value: binding.identity.party },
            ],
          }]
        : undefined;
      return new GrokAdapter({
        sessionId: id,
        cwd,
        executablePath: settings.grokExecutablePath,
        resumeSessionId,
        model: selectedModel,
        effort: request.effort || harnessDefaults.effort,
        permissionMode: request.permissionMode || harnessDefaults.permissionMode,
        mcpServers: partyServers,
        usageSourceId,
      }) as unknown as HarnessSession;
    }
    if (selectedHarness === "codex") {
      const adapterScope = binding
        ? `party:${binding.identity.party}:member:${binding.identity.member}`
        : usageSourceId
          ? `usage:${usageSourceId}`
          : resumeSessionId
            ? `thread:${resumeSessionId}`
            : `session:${id}`;
      const sqliteScope = `${this.runtimeScope}:${adapterScope}`;
      return new CodexAdapter({
        id,
        cwd,
        model: executionModelFor(selectedModel, "codex"),
        effort: request.effort || harnessDefaults.effort,
        permissionMode: request.permissionMode || harnessDefaults.permissionMode,
        policy: request.codexPolicy || harnessDefaults.codexPolicy,
        debugEnabled: settings.debugEnabled,
        storageDir: path.join(this.userDataDir, "logs"),
        sqliteHome: agentPartyCodexSqliteHome(this.userDataDir, sqliteScope),
        resumeSessionId,
        partyBridge: binding?.bridge,
        partyIdentity: binding?.identity,
        automationBaseUrl: this.codexAutomationBaseUrl(settings.automationApiPort),
        // Enables Codex→OpenRouter routing for OpenRouter-slug models; absent =
        // account catalog (openai) only. See codexProviders.ts.
        openRouterApiKey: settings.openRouterApiKey || process.env.OPENROUTER_API_KEY || undefined,
        deepseekApiKey: settings.deepseekApiKey || process.env[DEEPSEEK_API_KEY_ENV] || undefined,
        authenticationGeneration: this.codexAuthenticationGeneration,
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
      if (event.type === "turn_complete") {
        this.recordTurnUsage(session, event);
      }
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
      session.lastSnapshot = snapshot;
      this.emit("snapshot", { sessionId: session.id, workspace: session.workspace, snapshot });
      this.emit("sessions", this.listSessions());
    });
  }

  /**
   * Appends one {@link TurnUsageRecord} to the per-workspace usage ledger on
   * every completed turn. Identity/model/effort come from the session binding
   * and the latest harness snapshot; the token split and cost come from the
   * event. The trigger is the initiator's tag (see {@link sendUserTurn} /
   * {@link compact}), or `"compact"` when a compaction was in flight, and
   * `"unknown"` when neither is known — never fabricated.
   */
  private recordTurnUsage(session: ManagedSession, event: Extract<ClaudeNormalizedEvent, { type: "turn_complete" }>): void {
    const snapshot = session.lastSnapshot;
    const trigger: TokenTrigger = session.pendingTrigger ?? (session.compacting ? "compact" : "unknown");
    session.pendingTrigger = undefined;
    const startedAt = session.turnStartedAt;
    session.turnStartedAt = undefined;
    const record: TurnUsageRecord = {
      at: event.at || new Date().toISOString(),
      atStart: startedAt ? new Date(startedAt).toISOString() : undefined,
      partyId: session.identity?.party,
      member: session.identity?.member,
      sessionId: snapshot?.sessionId,
      appSessionId: session.id,
      provider: session.provider,
      model: snapshot?.model,
      effort: snapshot?.effort,
      trigger,
      tokens: event.usage || {},
      costUsd: event.cost?.amountUsd ?? event.costUsd,
      costBasis: event.cost?.basis,
      costSource: event.cost?.source,
    };
    this.ledger.append(session.workspace, record);
  }

  /**
   * Records one Message Gate review as a `gate-review` ledger turn. The reviewer
   * is a headless router call (not a session), so its overhead would otherwise be
   * invisible; this attributes its measured token spend + verdict to the party so
   * the dashboard can price the gate and compute its reject rate honestly.
   */
  recordGateReview(workspace: string, input: {
    partyId?: string;
    member?: string;
    model?: string;
    /** Set when the review reached a decision. Omit when it failed open. */
    verdict?: "allow" | "reject";
    /** Set INSTEAD of `verdict` when the review failed and the gate let the
     *  message through unreviewed. Without this the failure left no trace. */
    failure?: { layer: GateFailureLayer; detail?: string };
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  }): void {
    const record: TurnUsageRecord = {
      at: new Date().toISOString(),
      partyId: input.partyId,
      member: input.member,
      appSessionId: `gate-review:${input.partyId || "?"}:${input.member || "?"}`,
      provider: "claude",
      model: input.model,
      trigger: "gate-review",
      tokens: {
        input: input.usage?.input,
        output: input.usage?.output,
        cacheRead: input.usage?.cacheRead,
        cacheWrite: input.usage?.cacheWrite,
      },
      costBasis: "subscription",
      costSource: "estimate",
      gate: input.failure ? { failure: input.failure } : { verdict: input.verdict },
    };
    this.ledger.append(workspace, record);
  }

  /**
   * Reads and range-scans the per-workspace usage ledger. The main-process
   * query surface for the Token Usage dashboard (see AppController); aggregation
   * lives in the pure {@link import("../shared/tokenUsage")} module.
   */
  readUsageLedger(workspace: string, fromMs: number, toMs: number): TurnUsageRecord[] {
    return this.ledger.read(workspace, fromMs, toMs);
  }

  /** Total ledger record count for a workspace (0 ⇒ no samples yet). */
  usageLedgerCount(workspace: string): number {
    return this.ledger.count(workspace);
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
