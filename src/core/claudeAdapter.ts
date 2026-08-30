import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type {
  CanUseTool,
  McpServerStatus,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeCliMissingMessage, isInstalledApp, resolveClaudeCli } from "./claudeCli";
import { EnvironmentBlockedError, errorEventPayload } from "./environmentError";
import { emptyMcpSnapshot } from "../shared/mcp";
import type { McpServerInfo, McpServerSnapshot, McpServerState } from "../shared/mcp";
import { DefaultTurnCostResolver, TurnUsage } from "./costing";
import { tokenBreakdownFromClaudeUsage } from "./claudeUsage";
import type { TurnTokenBreakdown } from "../shared/tokenUsage";
import { ClaudeEffort, ClaudeNormalizedEvent, ClaudeSessionSnapshot, HarnessCommand } from "./events";
import { buildModelRoutes, displayModelFor, inferModelProvider, ModelProviderId, ModelRoute, ModelRouteConfig, runtimeModelFor, visionForModel } from "./modelRegistry";
import type { ImageAttachment } from "../shared/attachments";
import { catalogModelById, catalogModelByRuntime, resolveCatalogModel, routerTargetForModel } from "../shared/modelCatalog";
import { backendFor } from "../shared/modelIdentity";
import { deriveSubagentAction } from "../shared/subagentActivity";
import { toEpochMs, type UsageWindow, type UsageWindowKind } from "../shared/usageLimits";
import { ClaudeSubagentTracker, type SubagentEmit } from "./subagentTracker";
import { BackgroundTaskTracker } from "./backgroundTasks";
import { RawLogger } from "./rawLogger";
import { approvalAnswers, claudeApprovalFields, extractToolFilePath, withFilePath } from "../shared/approvalRequest";
import type { RouterTurnUsage } from "./routerShim";
import { buildPartyPrimer, buildPartyToolDefs, PARTY_MCP_SERVER, PARTY_TOOL_NAMES, PARTY_TOOL_PREFIX } from "./partyBridge";
import type { PartyBridge, PartyIdentity } from "./partyBridge";
import { probeClaudeNativeAuth, type ClaudeNativeAuthState } from "./claudeNativeAuth";
import { currentSpawnHost, shortCwd, spawnFailureSummary } from "../shared/sessionSpawn";

export interface ClaudeAdapterOptions {
  id: string;
  cwd: string;
  executablePath?: string;
  model: string;
  providerId?: ModelProviderId;
  effort: ClaudeEffort;
  /** Thinking mode override (adaptive|enabled|disabled); falls back to the model's catalog default. */
  thinking?: string;
  thinkingBudget?: number;
  permissionMode?: PermissionMode;
  maxBudgetUsd?: number;
  safeMode: boolean;
  debugEnabled: boolean;
  storageDir: string;
  customModelRoutes: ModelRouteConfig[];
  routerBaseUrl: string;
  routerAuthToken: string;
  routerAccountingKey?: string;
  resetRouterTurnUsage?: (accountingKey: string) => void;
  consumeRouterTurnUsage?: (accountingKey: string) => RouterTurnUsage | undefined;
  resumeSessionId?: string;
  /**
   * Identifies which usage FAN-IN source this adapter's `usage_limit` events
   * belong to. SessionManager keeps one active source per provider and drops
   * events from any other, so a background poller and a foreground session cannot
   * fight over the meter. Stamped onto every emitted `usage_limit`; when absent
   * the event carries no source and the filter lets it through unchanged.
   */
  usageSourceId?: string;
  /**
   * When this session represents a party member, the bridge + identity that
   * expose the in-process party tools (send / member-create / …) to its agent.
   * Both must be present for the `agentparty-app` MCP server to be attached.
   */
  partyBridge?: PartyBridge;
  partyIdentity?: PartyIdentity;
  /**
   * The primer text to append to the system prompt for this member, already
   * resolved against the user's Settings → 파티 프롬프트 customization. Absent =
   * the built-in primer (the host did not customize it).
   */
  partyPrimer?: string;
  /**
   * Supplies the Claude Agent SDK module. Production leaves this unset and the
   * real package is imported. QA passes a fake so adapter behaviour can be
   * driven without a harness process — `scripts/qa-*.mjs` already relied on this
   * seam, and without it those tests were quietly exercising the real SDK.
   */
  sdkLoader?: () => Promise<SdkModule>;
  /** QA seam; production warns after 15 seconds without a matching hook response. */
  hookStallMs?: number;
  /** QA seam for native Claude auth preflight. Production probes the real CLI. */
  nativeAuthProbe?: () => Promise<ClaudeNativeAuthState>;
}

type SdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

class AsyncInputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private readonly waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  close(): void {
    this.closed = true;
    for (;;) {
      const waiter = this.waiters.shift();
      if (!waiter) {
        break;
      }
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) {
          return Promise.resolve({ done: false, value });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

/** A queued user turn (text plus any image attachments), awaiting the active turn. */
interface QueuedTurn {
  text: string;
  attachments?: ImageAttachment[];
}

export class ClaudeAdapter extends EventEmitter {
  private logger: RawLogger | undefined;
  private input = new AsyncInputQueue();
  private query: Query | undefined;
  private abortController: AbortController | undefined;
  private started = false;
  private currentStatus = "created";
  /**
   * Where a compaction this adapter asked for has got to.
   *
   * Success is reported TWICE and differently — `compact_boundary` carries the
   * numbers, a `status` with `compact_result` carries only "success" — and
   * neither is guaranteed. Tracking the phase means whichever lands first
   * settles the card, and the second cannot overwrite a measured card with an
   * empty one. Without it a missing boundary leaves "압축 중" spinning forever.
   *
   * It also gates the noise suppression below: `/compact` is an ordinary user
   * turn to the SDK, so this is the only way to tell the echo of OUR request
   * from a user genuinely typing `/compact` — whose message must still show.
   */
  private compactPhase: "idle" | "running" | "settled" = "idle";
  private turnState: string | undefined;
  /** True once a live rate_limit_event has fed the usage meter (real windows). */
  private hasLiveUsageWindows = false;
  /**
   * Latest weekly reading PER VARIANT (`seven_day`, `seven_day_sonnet`, …).
   * Claude reports several weekly buckets; folding whichever arrived last onto
   * one "weekly" meter made the number flap between variants on every event or
   * refresh. The meter instead always shows the MOST CONSTRAINED variant.
   */
  private readonly weeklyVariants = new Map<string, UsageWindow>();
  private sessionId = "";
  /**
   * Whether this adapter has ever been started. `started` alone cannot answer
   * "is the harness alive": it is also false BEFORE the first start, and a
   * not-yet-started session is not a dead one.
   */
  private hasStarted = false;
  private permissionMode: PermissionMode = "default";
  private model: string;
  private runtimeModel: string;
  private providerId: ModelProviderId;
  private effort: ClaudeEffort;
  private thinkingMode: string | undefined;
  private thinkingBudget: number | undefined;
  private resumeSessionId: string | undefined;
  /** Guards the one-shot fresh-restart recovery when a resume id is unresolvable. */
  private resumeRecoveryTried = false;
  /**
   * True after Stop / interrupt-on-send asked the harness to halt the live turn.
   * The SDK often closes that turn with is_error: true ("Request interrupted
   * by user" / error_during_execution). That is an intentional outcome (R-90),
   * not a session failure (R-91) — see {@link emitInterruptedNotice}.
   */
  private interruptRequested = false;
  private turnCount = 0;
  /** Last reported context-window occupancy (tokens); see getSnapshot. */
  private contextTokens: number | undefined;
  private lastEventAt: string | undefined;
  private lastUserMessageAt: string | undefined;
  private lastAssistantMessageAt: string | undefined;
  /** Whether the CURRENT assistant message already arrived as text deltas. */
  private streamedAssistantText = false;
  private lastError: string | undefined;
  private supportedSlashCommands: HarnessCommand[] = [];
  private supportedModels: ModelRoute[] = [];
  private currentRoute: ModelRoute | undefined;
  private readonly costResolver = new DefaultTurnCostResolver();
  private debugMode: boolean;
  private readonly queuedUserTurns: QueuedTurn[] = [];
  private lastStatusKey: string | undefined;
  private lastStatusAt = 0;
  private readonly pendingApprovals = new Map<
    string,
    {
      resolve: (result: PermissionResult) => void;
      toolName: string;
      input: Record<string, unknown>;
      toolUseID: string;
      /** The SDK's own "always allow" updates, handed back on that choice. */
      suggestions?: PermissionUpdate[];
    }
  >();
  private readonly activeTools = new Map<string, { id: string; name: string; input?: unknown; parentId?: string; subagent?: boolean }>();
  // Attributes subagent activity from `task_*` events + `Agent`/`Task` tool_use
  // blocks (verified against recorded real traffic). Nested content tagged with a
  // known subagent's id as `parent_tool_use_id` is routed to it, keeping subagent
  // output out of the parent transcript.
  private subagentTracker = new ClaudeSubagentTracker();
  /** Claude hook processes can wedge after `hook_started` (observed with two
   * concurrent subagent Stop hooks). Track them separately so the user sees the
   * actual blocker long before the harness-general two-minute stall warning. */
  private readonly pendingHooks = new Map<string, { name: string; timer: NodeJS.Timeout }>();
  /**
   * Harness tasks still in flight, INCLUDING the ones the subagent dock drops
   * (backgrounded shells, workflows, MCP monitors). Reported on the snapshot so
   * idle-sleep can refuse to tear down a session whose turn ended while work
   * kept running.
   */
  private readonly backgroundTasks = new BackgroundTaskTracker();
  private readonly startedAt = new Date().toISOString();
  private usageRefreshTimer: NodeJS.Timeout | undefined;
  private lastUsageStatus = "";
  private lastRateLimitNotice = "";

  constructor(private readonly options: ClaudeAdapterOptions) {
    super();
    this.model = displayModelFor(options.model);
    this.runtimeModel = runtimeModelFor(options.model, options.customModelRoutes);
    this.providerId = options.providerId || inferModelProvider(options.model, options.customModelRoutes);
    this.currentRoute = this.resolveCurrentRoute();
    this.effort = options.effort;
    this.thinkingMode = options.thinking;
    this.thinkingBudget = options.thinkingBudget;
    this.permissionMode = options.permissionMode || "default";
    this.resumeSessionId = options.resumeSessionId;
    this.debugMode = options.debugEnabled;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.hasStarted = true;
    this.currentStatus = "starting";
    // The card the user sees for this attempt opens HERE, before any probing —
    // a start that dies during the auth probe still has a card to fail into,
    // instead of appearing only if it got far enough to reach the harness.
    this.emitSessionSpawn("starting");
    this.abortController = new AbortController();
    this.input = new AsyncInputQueue();
    this.ensureLogger();

    void this.run();
  }

  sendUserTurn(text: string, attachments?: ImageAttachment[]): void {
    // Text-only safety net (no-silent-drop policy): if this model is known not to
    // accept images, refuse the turn with a visible error instead of dropping the
    // image. The composer already gates this; this guards the HTTP/agent paths.
    if (attachments?.length && this.imageInputUnsupported()) {
      this.emitVisionUnsupported(attachments.length);
      return;
    }
    if (!this.started) {
      this.start();
    }
    if (this.isTurnActive()) {
      this.queuedUserTurns.push({ text, attachments });
      this.emitEvent({ type: "status", status: "queued", detail: `${this.queuedUserTurns.length} message(s) queued`, at: now() });
      return;
    }
    this.dispatchUserTurn(text, attachments);
  }

  /** True only when the effective model is KNOWN to reject image input. */
  private imageInputUnsupported(): boolean {
    const routeVision = this.currentRoute?.capabilities.vision.image;
    if (routeVision !== undefined) {
      return routeVision === false;
    }
    return visionForModel(this.runtimeModel || this.model).image === false;
  }

  private emitVisionUnsupported(count: number): void {
    this.emitEvent({
      type: "diagnostic",
      severity: "error",
      category: "vision",
      title: "이 모델은 이미지 입력을 지원하지 않습니다",
      detail: `${this.model}은(는) 텍스트 전용 모델입니다. 이미지 ${count}개를 보내지 못했습니다.`,
      recovery: "이미지 없이 다시 보내거나, 이미지(비전)를 지원하는 모델로 전환하세요.",
      at: now(),
    });
  }

  /**
   * Requests a turn interrupt — the normal Stop control.
   *
   * "interrupting" is cleared when the SDK delivers the turn's `result`; resolving
   * `query.interrupt()` only means the REQUEST was accepted. A turn the CLI already
   * broke (observed: `[ede_diagnostic] ... stop_reason=tool_use`) never produces
   * that result, so this status can persist — and because `isTurnActive()` counts
   * it, every later send would queue and never dispatch. {@link forceStop} is the
   * user's escape hatch for exactly that; nothing here escalates on a timer,
   * because a slow-but-healthy interrupt must not be torn out from under the
   * harness.
   */
  interrupt(): void {
    if (!this.query) {
      // No query means no turn in flight — if a previous interrupt left the turn
      // state behind, this is the point where it is provably safe to clear it.
      this.forceStop();
      this.emitEvent({ type: "status", status: "interrupt", detail: "no active query", at: now() });
      return;
    }
    this.interruptRequested = true;
    this.currentStatus = "interrupting";
    this.turnState = "interrupting";
    void this.query.interrupt().then(
      () => this.emitEvent({ type: "status", status: "interrupt", detail: "requested", at: now() }),
      (error) => {
        // The interrupt REQUEST itself failed — that is a real failure (R-91).
        this.interruptRequested = false;
        this.emitError(error);
      },
    );
    this.emit("snapshot", this.getSnapshot());
  }

  /**
   * Releases a turn the harness will never close — the manual "강제 종료" the UI
   * offers once a Stop has gone unanswered.
   *
   * Deliberately local: it returns THIS session to idle and flushes anything
   * queued behind the dead turn, but does not kill the harness or touch the
   * conversation. That makes it cheap and non-destructive; if the harness itself
   * is gone, the member's restart (respawn) is the stronger remedy.
   */
  forceStop(): void {
    if (!this.isTurnActive()) {
      return;
    }
    this.log("force_stop", { status: this.currentStatus, turnState: this.turnState });
    this.interruptRequested = false;
    this.currentStatus = "idle";
    this.turnState = undefined;
    this.drainQueuedTurn();
  }

  private dispatchUserTurn(text: string, attachments?: ImageAttachment[]): void {
    this.resetRouterTurnUsage();
    // Anthropic content blocks: text first, then one image block per attachment.
    // The router shim (OpenRouter backend) translates these image blocks into
    // OpenAI `image_url` parts, so the same block shape covers both backends.
    const content: any[] = [{ type: "text", text }];
    for (const image of attachments || []) {
      content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.dataBase64 } });
    }
    this.input.push({
      type: "user",
      message: {
        role: "user",
        content,
      },
      parent_tool_use_id: null,
      session_id: this.sessionId || undefined,
      timestamp: now(),
    });
    this.turnCount += 1;
    this.lastUserMessageAt = now();
    this.turnState = "submitted";
    this.currentStatus = "requesting";
    this.log("stdin", { type: "user", text });
    // The `/compact` WE submit is plumbing, not something the user said. Its
    // echo used to open the raw run of log lines the compact card replaces.
    // A user who types `/compact` themselves still sees their message: this
    // only fires between our own request and the harness settling it.
    if (this.compactPhase === "running" && text === "/compact") {
      return;
    }
    this.emitEvent({ type: "status", status: "sent", detail: text, at: now() });
  }

  compact(): void {
    // The block goes in BEFORE the harness is asked, so the card is what the
    // user sees from the first moment rather than after the round trip.
    this.emitEvent({ type: "compact_state", state: "running", trigger: "manual", at: now() });
    this.compactPhase = "running";
    this.sendUserTurn("/compact");
  }

  setModel(model: string, providerId?: string, runtimeModel?: string): void {
    const previousUsesRouter = this.usesRouterBackend();
    this.model = displayModelFor(model);
    this.providerId = asModelProviderId(providerId) || inferModelProvider(model, this.options.customModelRoutes);
    this.runtimeModel = claudeRuntimeModelFor(model, this.providerId, runtimeModel, this.options.customModelRoutes);
    this.currentRoute = this.resolveCurrentRoute();
    if (this.query && previousUsesRouter !== this.usesRouterBackend()) {
      this.emitEvent({
        type: "status",
        status: "model",
        detail: `route changed to ${this.providerId}; restarting Claude Code harness (new session — cross-backend resume is not supported)`,
        at: now(),
      });
      this.restart(false);
      return;
    }
    if (!this.query) {
      return;
    }
    void this.query.setModel(this.runtimeModel).then(
      () => this.emitEvent({ type: "status", status: "model", detail: this.model, at: now() }),
      (error) => this.emitError(error),
    );
  }

  setEffort(effort: string): void {
    this.effort = effort as ClaudeEffort;
    if (!this.query) {
      this.emitEvent({ type: "status", status: "effort", detail: `updated to ${effort}; it will be used when the session starts`, at: now() });
      return;
    }
    void this.query.applyFlagSettings({ effortLevel: effort } as any).then(
      () => this.emitEvent({ type: "status", status: "effort", detail: `updated to ${effort}; applies to subsequent responses`, at: now() }),
      (error) => {
        this.emitEvent({ type: "status", status: "effort", detail: `failed to update to ${effort}; restart may be required`, at: now() });
        this.emitError(error);
      },
    );
  }

  setThinking(mode: string, budget?: number): void {
    this.thinkingMode = mode;
    this.thinkingBudget = typeof budget === "number" ? budget : this.thinkingBudget;
    if (!this.query) {
      this.emitEvent({ type: "status", status: "thinking", detail: `set to ${mode}; applies when the session starts`, at: now() });
      return;
    }
    // thinking is a query-construction option; resume the current session so the
    // new config takes effect without losing the conversation.
    this.emitEvent({ type: "status", status: "thinking", detail: `set to ${mode}; restarting to apply`, at: now() });
    this.restart(true);
  }

  /** Resolves the thinking config sent to the harness: explicit override, else the model's catalog default. */
  private resolveThinking(): { type: "adaptive" } | { type: "enabled"; budgetTokens: number } | { type: "disabled" } | undefined {
    const spec = (catalogModelById(this.model) || catalogModelByRuntime(this.runtimeModel))?.reasoning?.thinking;
    const mode = this.thinkingMode ?? spec?.default;
    if (!mode) {
      return undefined;
    }
    if (mode === "disabled") {
      return { type: "disabled" };
    }
    if (typeof this.thinkingBudget === "number" && this.thinkingBudget > 0) {
      return { type: "enabled", budgetTokens: this.thinkingBudget };
    }
    return { type: "adaptive" };
  }

  setPermissionMode(permissionMode: string): void {
    this.permissionMode = permissionMode as PermissionMode;
    if (!this.query) {
      return;
    }
    // Every session is launched bypass-capable (see the query options), so any
    // mode — including bypassPermissions — applies live without a restart.
    void this.query.setPermissionMode(this.permissionMode).then(
      () => this.emitEvent({ type: "status", status: "permission", detail: permissionMode, at: now() }),
      (error) => this.emitError(error),
    );
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
    if (enabled) {
      this.ensureLogger();
    } else {
      this.logger?.close();
      this.logger = undefined;
    }
    this.emitEvent({ type: "status", status: "debug", detail: enabled ? "enabled" : "disabled", at: now() });
  }

  // --- MCP (external servers this member connects to as a client) ----------
  // Backed by the live SDK query surface: mcpServerStatus() / reconnectMcpServer()
  // / toggleMcpServer(). OAuth is NOT SDK-exposed (interactive `/mcp` only), so
  // `authenticateMcpServer` is intentionally absent and needs-auth is surfaced
  // with a note instead of a dead button.

  async listMcpServers(): Promise<McpServerSnapshot> {
    if (!this.query) {
      return emptyMcpSnapshot("claude-code", "세션이 아직 시작되지 않았습니다 — 멤버를 시작한 뒤 확인하세요.");
    }
    if (this.options.safeMode) {
      return emptyMcpSnapshot("claude-code", "Safe 모드에서는 외부 MCP 서버(user/project/local 설정)를 불러오지 않습니다.");
    }
    try {
      const statuses = await this.query.mcpServerStatus();
      const servers = (statuses || []).map((status) => this.toNeutralMcpServer(status));
      const note = servers.some((server) => server.state === "needs-auth")
        ? "인증이 필요한 서버는 대화형 Claude에서 `/mcp` → Authenticate 로 로그인하세요 (SDK는 OAuth를 노출하지 않습니다)."
        : undefined;
      return { supported: true, harness: "claude-code", servers, note };
    } catch (error) {
      return { supported: true, harness: "claude-code", servers: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async reconnectMcpServer(name: string): Promise<void> {
    if (!this.query) {
      throw new Error("세션이 시작되지 않아 MCP 서버를 재연결할 수 없습니다.");
    }
    await this.query.reconnectMcpServer(name);
    this.emitEvent({ type: "status", status: "mcp", detail: `reconnect ${name}`, at: now() });
  }

  async setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
    if (!this.query) {
      throw new Error("세션이 시작되지 않아 MCP 서버를 토글할 수 없습니다.");
    }
    await this.query.toggleMcpServer(name, enabled);
    this.emitEvent({ type: "status", status: "mcp", detail: `${enabled ? "enable" : "disable"} ${name}`, at: now() });
  }

  private toNeutralMcpServer(status: McpServerStatus): McpServerInfo {
    const config = status.config as { type?: string; url?: string } | undefined;
    const transport = config?.type === "stdio" || config?.type === "http" || config?.type === "sse" ? config.type : "unknown";
    return {
      name: status.name,
      state: mapClaudeMcpState(status.status),
      transport,
      scope: status.scope,
      url: config?.url,
      version: status.serverInfo?.version,
      error: status.error,
      tools: (status.tools || []).map((tool) => ({ name: tool.name, description: tool.description })),
      canReconnect: true,
      canToggle: true,
      // The SDK has no programmatic OAuth; needs-auth is resolved in the interactive client.
      canAuthenticate: false,
    };
  }

  respondApproval(requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      this.emitEvent({ type: "error", message: `No pending permission request for ${requestId}.`, at: now() });
      return false;
    }

    // `updatedInput` doubles as a control envelope: the card sends
    // `{ __approvalScope: "always" }` for "always allow". It must be stripped,
    // because anything left here is handed to the SDK as the TOOL's input.
    const control = asRecord(updatedInput);
    const scope = control?.__approvalScope;
    const rest = control ? Object.fromEntries(Object.entries(control).filter(([key]) => key !== "__approvalScope")) : undefined;
    const toolInput = rest && Object.keys(rest).length ? rest : pending.input;

    // "always allow" means handing the SDK's own suggestions back as
    // `updatedPermissions`, which is how a rule gets stored (the SDK's words:
    // "if presenting the user an option 'always allow'… return this full set").
    // Without it every approval was permanently "just this once", even though
    // the request arrived carrying a ready-made prefix rule.
    const always = scope === "always" && pending.suggestions?.length ? pending.suggestions : undefined;

    const result: PermissionResult =
      behavior === "allow"
        ? {
            behavior: "allow",
            updatedInput: toolInput,
            ...(always ? { updatedPermissions: always } : {}),
            toolUseID: pending.toolUseID,
            decisionClassification: always ? "user_permanent" : "user_temporary",
          }
        : {
            behavior: "deny",
            message: message || "Denied by user",
            toolUseID: pending.toolUseID,
            decisionClassification: "user_reject",
          };

    this.emitEvent({ type: "approval_resolved", requestId, decision: behavior, answers: approvalAnswers(updatedInput), at: now() });
    this.pendingApprovals.delete(requestId);
    this.log("permission_response", { requestId, result });
    pending.resolve(result);
    this.emitEvent({
      type: "tool_call",
      id: pending.toolUseID,
      name: pending.toolName,
      input: pending.input,
      status: behavior === "allow" ? "started" : "failed",
      result,
      at: now(),
    });
    return true;
  }

  restart(resumeCurrentSession = false): void {
    if (resumeCurrentSession) {
      // Only a TURN-COMMITTED conversation can be resumed. The harness reports a
      // session id as soon as the query opens, but it does not persist the
      // conversation until a turn completes — so adopting that id here made the
      // next start resume something that does not exist ("No conversation found
      // with session ID ..."), which is the error users hit when they adjusted a
      // member's settings right after creating it (#17). With no committed turn
      // there is nothing to continue, so keep whatever we were already
      // continuing (a genuinely resumed thread, or nothing at all).
      // `SessionManager.harnessSessionId` gates the persisted id on the same
      // condition; this is that rule applied to the in-process restart.
      if (this.turnCount > 0) {
        this.resumeSessionId = this.sessionId || this.resumeSessionId;
      }
    } else {
      this.resumeSessionId = this.options.resumeSessionId;
    }
    this.dispose();
    this.sessionId = "";
    this.started = false;
    this.pendingApprovals.clear();
    this.activeTools.clear();
    this.subagentTracker = new ClaudeSubagentTracker();
    // The old query's tasks died with it; carrying their ids forward would pin
    // the member as "busy in the background" forever and it could never sleep.
    this.backgroundTasks.reset();
    this.queuedUserTurns.length = 0;
    // A restart tears down the old query and starts a FRESH one with no turn in
    // flight — so any in-flight turn state MUST be cleared. Otherwise a restart
    // triggered mid-turn (e.g. a cross-backend model change) leaves `turnState`
    // stuck at "responding"/"submitted"; `isTurnActive()` then stays true forever
    // and every later turn queues without ever dispatching — a bricked member
    // (feedback #4). The in-flight request rejects with a benign "Query closed"
    // that we intentionally swallow, so nothing else resets it.
    this.turnState = undefined;
    this.currentStatus = "idle";
    // A fresh restart (no resume id) begins an empty conversation, so the old
    // occupancy is stale — clear it. A resume keeps the thread's context, so the
    // last number stays valid until the next turn reports a fresh one.
    if (!this.resumeSessionId) {
      this.contextTokens = undefined;
    }
    this.start();
  }

  getSnapshot(): ClaudeSessionSnapshot {
    return {
      id: this.options.id,
      // One SDK query serves the whole session, so the harness is alive exactly
      // while that query loop is running. `started` drops when the stream ends
      // (run's finally) or on dispose — but it is also false before the first
      // start, which is "not yet", not "dead".
      harnessAlive: !this.hasStarted || this.started,
      cwd: this.options.cwd,
      sessionId: this.sessionId || undefined,
      model: this.model,
      effort: this.effort,
      thinkingMode: this.thinkingMode,
      thinkingBudget: this.thinkingBudget,
      permissionMode: this.permissionMode,
      status: this.currentStatus,
      turnState: this.turnState,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      lastUserMessageAt: this.lastUserMessageAt,
      lastAssistantMessageAt: this.lastAssistantMessageAt,
      logPath: this.debugMode ? this.logger?.filePath : undefined,
      debugMode: this.debugMode,
      lastError: this.lastError,
      turnCount: this.turnCount,
      queuedTurnCount: this.queuedUserTurns.length,
      pendingApprovalCount: this.pendingApprovals.size,
      backgroundTaskCount: this.backgroundTasks.count,
      slashCommands: this.supportedSlashCommands,
      contextTokens: this.contextTokens,
    };
  }

  dispose(): void {
    this.stopUsagePolling();
    this.input.close();
    this.abortController?.abort();
    this.query?.close();
    this.query = undefined;
    this.started = false;
    this.currentStatus = "closed";
    this.clearHookWatchdogs();
    this.logger?.close();
  }

  private async run(): Promise<void> {
    let activeQuery: Query | undefined;
    try {
      if (!this.usesRouterBackend() && (!this.options.sdkLoader || this.options.nativeAuthProbe)) {
        const auth = await (this.options.nativeAuthProbe?.() || probeClaudeNativeAuth({
          workspacePath: this.options.cwd,
          executablePath: this.options.executablePath,
        }));
        if (auth.status === "auth_required") {
          this.currentStatus = "auth_required";
          this.lastError = auth.detail;
          this.emitEvent({ type: "status", status: "auth_required", detail: auth.detail, at: now() });
          this.emitEvent({
            type: "error",
            ...errorEventPayload(new EnvironmentBlockedError(auth.detail, "harness.claude-code")),
            at: now(),
          });
          this.log("auth_required", { host: auth.host.label, workspace: auth.workspace, executable: auth.executable });
          // Not-signed-in ends the attempt as surely as a crash does; the card
          // must not be left reading "시작 중". The environment card next to it
          // is what carries the remedy.
          this.emitSessionSpawn("failed", new Error("auth required"));
          return;
        }
        if (!auth.authenticated) {
          throw new EnvironmentBlockedError(auth.detail, "harness.claude-code");
        }
      }
      const sdk = await (this.options.sdkLoader ?? loadSdk)();
      const executable = resolveClaudeExecutable(this.options.executablePath);
      if (this.usesRouterBackend() && !isRoutableRouterModel(this.runtimeModel)) {
        throw new Error(`No explicit AgentParty router mapping for '${this.model}' (${this.runtimeModel}). Refusing to fall back to another model.`);
      }
      if (this.usesRouterBackend()) {
        this.emitEvent({ type: "status", status: "router-check", detail: this.options.routerBaseUrl, at: now() });
        await assertRouterReachable(this.options.routerBaseUrl, this.runtimeModel);
      }
      const env = {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
        CLAUDE_AGENT_SDK_CLIENT_APP: "agentparty-native-vscode/0.0.1",
      };
      if (this.usesRouterBackend()) {
        Object.assign(env, this.routerEnv());
      }
      const options: Parameters<SdkModule["query"]>[0]["options"] = {
        cwd: this.options.cwd,
        pathToClaudeCodeExecutable: executable,
        env,
        model: this.runtimeModel,
        effort: this.effort,
        thinking: this.resolveThinking(),
        permissionMode: this.permissionMode,
        // Always launch bypass-CAPABLE (this only grants the ability; the active
        // permissionMode still governs behavior). The SDK ties bypassPermissions
        // to a launch-time capability that a resumed session inherits, so without
        // this a member started in any other mode can never switch to bypass
        // ("...session was not launched with --dangerously-skip-permissions").
        allowDangerouslySkipPermissions: true,
        resume: this.resumeSessionId,
        // Declare the app's own party tools as permitted for member sessions.
        // They are schema-validated, scoped to the calling member, and routed
        // through AppController; inbound Discord is whitelist-only, so an
        // unlisted sender never reaches the model at all. Stating this as a
        // permission rule (not only inside canUseTool) is what makes a member's
        // reporting tools usable in every permission mode.
        allowedTools: this.options.partyIdentity ? PARTY_TOOL_NAMES.map((name) => `${PARTY_TOOL_PREFIX}${name}`) : undefined,
        canUseTool: this.canUseTool,
        includePartialMessages: true,
        includeHookEvents: true,
        enableFileCheckpointing: true,
        tools: { type: "preset", preset: "claude_code" },
        ...this.partyMcpServers(sdk),
        ...this.partySystemPrompt(),
        settingSources: this.options.safeMode ? [] : ["user", "project", "local"],
        extraArgs: {
          ...(this.debugMode ? { "debug-to-stderr": null } : {}),
          "enable-auth-status": null,
          "replay-user-messages": null,
        },
        stderr: (text: string) => {
          this.log("stderr", text);
          if (this.debugMode) {
            this.emitEvent({ type: "status", status: "stderr", detail: text.trim(), at: now() });
          }
        },
        abortController: this.abortController,
        hooks: {
          PreToolUse: [
            {
              matcher: "Edit|Write|MultiEdit",
              hooks: [
                async (input: any) => {
                  this.emitEvent({
                    type: "file_change",
                    filePath: extractToolFilePath(input.tool_input),
                    toolName: input.tool_name,
                    input: withFilePath(input.tool_input),
                    at: now(),
                  });
                  return { continue: true };
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: "Edit|Write|MultiEdit",
              hooks: [
                async (input: any) => {
                  this.emitEvent({
                    type: "file_change",
                    filePath: extractToolFilePath(input.tool_input),
                    toolName: input.tool_name,
                    input: withFilePath(input.tool_input),
                    result: input.tool_response,
                    at: now(),
                  });
                  return { continue: true };
                },
              ],
            },
          ],
        },
      };
      if (this.options.maxBudgetUsd && this.options.maxBudgetUsd > 0) {
        options.maxBudgetUsd = this.options.maxBudgetUsd;
      }

      this.log("spawn_sdk_query", {
        executable,
        cwd: this.options.cwd,
        model: this.model,
        runtimeModel: this.runtimeModel,
        providerId: this.providerId,
        effort: this.effort,
        permissionMode: this.permissionMode,
        safeMode: this.options.safeMode,
        resume: this.resumeSessionId,
        router: this.usesRouterBackend() ? { baseUrl: this.options.routerBaseUrl } : undefined,
      });
      this.query = sdk.query({ prompt: this.input, options });
      activeQuery = this.query;
      this.currentStatus = "spawned";
      // `executable` — an absolute path to the harness binary — stays in the
      // debug log above and out of the conversation. The card says the session
      // is running; which file on disk serves it is not the user's question.
      this.emitSessionSpawn("running");

      void this.initializeQueryMetadata();
      for await (const message of this.query) {
        this.log("sdk_message", message);
        await this.normalize(message);
      }
      this.currentStatus = "closed";
      this.emitEvent({ type: "status", status: "closed", at: now() });
      this.clearInFlightTurn(activeQuery);
    } catch (error) {
      // A throw before the query came up is a FAILED START, so the open card
      // has to reach its terminal state rather than sit on "시작 중" forever.
      // After it is up, the same throw is an ordinary turn error and the card
      // stays as it is — the session did start.
      if (this.currentStatus !== "spawned" && this.currentStatus !== "closed") {
        this.emitSessionSpawn("failed", error);
      }
      this.emitError(error);
      this.clearInFlightTurn(activeQuery);
    } finally {
      this.stopUsagePolling();
      this.started = false;
      this.logger?.close();
    }
  }

  /**
   * A terminated query has no turn in flight. When the CLI kills a turn (e.g.
   * it believes the plan limit is exhausted) the loop exits with `turnState`
   * still "submitted"/"responding" and possibly unresolved approvals — both keep
   * isTurnActive() true forever, so every later send queued without dispatching:
   * input was effectively blocked. Rate limits must never gate input; clear the
   * in-flight state so the next send restarts the session and dispatches. The
   * instance guard keeps a slow teardown of an OLD query from clobbering the
   * state of an already-restarted one.
   */
  private clearInFlightTurn(query: Query | undefined): void {
    if (query !== this.query) {
      return;
    }
    this.turnState = undefined;
    this.pendingApprovals.clear();
  }

  /**
   * Builds the `agentparty-app` in-process MCP server (Boundary 2 of
   * the party-communication design) when this session is a party member. The tool
   * handlers run in *this* process and call the injected bridge directly; the
   * caller's identity is closure-bound so `from` is never agent-supplied.
   * Returns `{}` (no servers) for non-member sessions.
   */
  private partyMcpServers(sdk: SdkModule): { mcpServers?: Record<string, ReturnType<SdkModule["createSdkMcpServer"]>> } {
    const bridge = this.options.partyBridge;
    const identity = this.options.partyIdentity;
    if (!bridge || !identity) {
      return {};
    }
    const tools = buildPartyToolDefs(sdk.tool as never, bridge, identity) as Parameters<SdkModule["createSdkMcpServer"]>[0]["tools"];
    const server = sdk.createSdkMcpServer({
      name: PARTY_MCP_SERVER,
      version: "0.1.0",
      tools,
      // Party coordination must never depend on Claude finding these tools via
      // ToolSearch. In particular, a woken/resumed member has to be able to
      // reply on its very first turn even when tool search is enabled.
      alwaysLoad: true,
    });
    return { mcpServers: { [PARTY_MCP_SERVER]: server } };
  }

  /**
   * Appends the AgentParty primer to the claude_code system prompt for member
   * sessions, so the model knows the app, its identity, the protocol, and which
   * tool surface to use — instead of relying on memory and confusing our
   * `agentparty-app` tools with legacy `agentparty` servers. Returns `{}` for
   * non-member sessions (keeps the default system prompt untouched).
   */
  private partySystemPrompt(): { systemPrompt?: { type: "preset"; preset: "claude_code"; append: string } } {
    const identity = this.options.partyIdentity;
    if (!identity) {
      return {};
    }
    return { systemPrompt: { type: "preset", preset: "claude_code", append: this.options.partyPrimer || buildPartyPrimer(identity) } };
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    // Party tools are first-class app capabilities the member is meant to drive
    // freely (coordination shouldn't require a human approval prompt). They are
    // schema-validated and routed through AppController, so auto-allow them.
    if (toolName.startsWith(PARTY_TOOL_PREFIX)) {
      return { behavior: "allow", updatedInput: input };
    }
    const requestId = options.toolUseID || `permission-${Date.now()}`;

    return await new Promise<PermissionResult>((resolve) => {
      this.pendingApprovals.set(requestId, { resolve, toolName, input, toolUseID: options.toolUseID, suggestions: options.suggestions });
      this.log("permission_request", { requestId, toolName, input, options: scrubPermissionOptions(options) });
      this.emitEvent({
        type: "approval_request",
        requestId,
        ...claudeApprovalFields(toolName, input, options),
        at: now(),
      });
      this.emit("snapshot", this.getSnapshot());
      options.signal.addEventListener(
        "abort",
        () => {
          if (!this.pendingApprovals.delete(requestId)) {
            return;
          }
          resolve({
            behavior: "deny",
            message: "Permission request cancelled.",
            toolUseID: options.toolUseID,
            decisionClassification: "user_reject",
          });
        },
        { once: true },
      );
    });
  };

  private async initializeQueryMetadata(): Promise<void> {
    if (!this.query) {
      return;
    }
    try {
      const init = await this.query.initializationResult();
      this.log("initialization", init);
      this.supportedSlashCommands = toHarnessCommands(init.commands);
      try {
        this.supportedModels = buildModelRoutes(this.model, await this.query.supportedModels(), this.options.customModelRoutes);
      } catch {
        this.supportedModels = buildModelRoutes(this.model, init.models || [], this.options.customModelRoutes);
      }
      this.currentStatus = "initialized";
      this.emitEvent({
        type: "session",
        sessionId: this.sessionId || this.options.id,
        model: this.model,
        permissionMode: this.permissionMode,
        tools: [],
        slashCommands: this.supportedSlashCommands,
        models: this.supportedModels,
        at: now(),
      });
      // Push a snapshot too: the renderer's per-member view caches the snapshot
      // (incl. the slash-command inventory) from `snapshot` broadcasts, not from
      // this `session` event. Without this the command palette stays on its
      // static fallback until the next status-change snapshot.
      this.emit("snapshot", this.getSnapshot());
      this.startUsagePolling();
      void this.refreshUsageLimits();
    } catch (error) {
      this.emitError(error);
    }
  }

  /**
   * Reads the `/usage` data once at session initialization. Claude also emits
   * `rate_limit_event` updates later; this prevents the global usage indicator
   * from waiting indefinitely on a passive event when the SDK can answer now.
   */
  async refreshUsageLimits(): Promise<void> {
    if (!this.query) {
      return;
    }
    const usageFn = (this.query as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof usageFn !== "function") {
      this.emitUsageStatus("Claude SDK usage read is not available in this version.");
      return;
    }
    try {
      const usage = await usageFn.call(this.query);
      const rateLimitsAvailable = usage?.rate_limits_available;
      // Seed the per-variant weekly state so this read and later live
      // rate_limit_events agree on the same most-constrained-variant meter.
      for (const [variant, window] of weeklyVariantWindows(usage?.rate_limits)) {
        this.weeklyVariants.set(variant, window);
      }
      const windows = claudeUsageWindows(usage?.rate_limits);
      if (windows.length) {
        this.emitEvent({ type: "usage_limit", provider: "claude", windows, available: true, at: now(), sourceId: this.options.usageSourceId });
        this.lastUsageStatus = "";
        return;
      }
      // The proactive read answered without usable windows. Once live
      // rate_limit_events have fed the meter this read adds nothing — stay
      // quiet. (Clearing lastUsageStatus unconditionally before this branch
      // used to defeat the dedupe, so the same "not available for this auth
      // mode" info block re-posted on every 60s poll tick.)
      if (this.hasLiveUsageWindows) {
        return;
      }
      this.emitEvent({ type: "usage_limit", provider: "claude", windows: [], available: rateLimitsAvailable !== false, at: now(), sourceId: this.options.usageSourceId });
      this.emitUsageStatus(
        rateLimitsAvailable === false
          ? "Claude plan rate limits are not available for this auth mode."
          : "Claude usage read returned no usable rate-limit windows.",
      );
    } catch (error) {
      this.emitUsageStatus(`Claude usage read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private emitUsageStatus(detail: string): void {
    if (detail === this.lastUsageStatus) {
      return;
    }
    this.lastUsageStatus = detail;
    this.emitEvent({ type: "diagnostic", severity: "info", category: "rate-limit", title: "사용량 정보를 읽을 수 없습니다", detail, at: now() });
  }

  /**
   * Chat-visible rate-limit notice, mirroring the Codex classifier's policy:
   * surface only at ≥90% or when the limit is hit, once per level change.
   */
  private maybeEmitRateLimitDiagnostic(info: any, window: UsageWindow): void {
    const pct = Math.round(window.utilization);
    const exhausted = String(info?.status || "") === "rejected" || pct >= 100;
    if (!exhausted && pct < 90) {
      this.lastRateLimitNotice = "";
      return;
    }
    const title = exhausted ? "사용량 한도 도달" : `사용량 한도 임박 (${pct}%)`;
    if (title === this.lastRateLimitNotice) {
      return;
    }
    this.lastRateLimitNotice = title;
    this.emitEvent({
      type: "diagnostic",
      severity: exhausted ? "error" : "warning",
      category: "rate-limit",
      title,
      detail: window.resetsAt ? `${window.kind === "weekly" ? "주간" : "5시간"} 한도 · ${new Date(window.resetsAt).toLocaleString()} 초기화` : undefined,
      at: now(),
    });
  }

  private startUsagePolling(): void {
    if (this.usageRefreshTimer) {
      return;
    }
    this.usageRefreshTimer = setInterval(() => {
      void this.refreshUsageLimits();
    }, 60_000);
  }

  private stopUsagePolling(): void {
    if (!this.usageRefreshTimer) {
      return;
    }
    clearInterval(this.usageRefreshTimer);
    this.usageRefreshTimer = undefined;
  }

  private async normalize(message: SDKMessage): Promise<void> {
    if ((message as any).session_id) {
      this.sessionId = (message as any).session_id || this.sessionId;
      // A live session is established (resume succeeded or a fresh start): allow a
      // future stale-resume to recover once more.
      this.resumeRecoveryTried = false;
    }

    if (message.type === "system") {
      this.normalizeSystem(message as any);
      return;
    }

    // The SDK envelope tags nested (subagent) content with the parent Agent/Task
    // tool_use id; the normalizers use it to route output to the right subagent.
    const parentToolUseId = (message as any).parent_tool_use_id as string | undefined;

    if (message.type === "stream_event") {
      this.normalizeStreamEvent((message as any).event, parentToolUseId);
      return;
    }

    if (message.type === "assistant") {
      this.lastAssistantMessageAt = now();
      this.normalizeAssistantSnapshot((message as any).message, parentToolUseId);
      return;
    }

    if (message.type === "user") {
      this.normalizeUserSnapshot((message as any).message, parentToolUseId);
      return;
    }

    if (message.type === "result") {
      this.currentStatus = "idle";
      this.turnState = "complete";
      if ((message as any).is_error) {
        const errorMessage = Array.isArray((message as any).errors) && (message as any).errors.length > 0
          ? (message as any).errors.join("; ")
          : (message as any).result || (message as any).subtype || "Claude returned an error result.";
        // Intended stop: the SDK marks interrupted turns as is_error. Paint guidance
        // (R-90), not a red failure — real failures still take the error path (R-91).
        if (this.interruptRequested || isUserInterruptMessage(errorMessage)) {
          this.emitInterruptedNotice(errorMessage);
          this.drainQueuedTurn();
          return;
        }
        this.lastError = errorMessage;
        this.emitEvent({ type: "error", message: errorMessage, at: now() });
        this.drainQueuedTurn();
        return;
      }
      if (this.interruptRequested) {
        this.emitInterruptedNotice(String((message as any).subtype || "interrupted"));
        this.drainQueuedTurn();
        return;
      }
      const harnessCostUsd = typeof (message as any).total_cost_usd === "number" ? (message as any).total_cost_usd : undefined;
      const routerUsage = this.consumeRouterTurnUsage();
      const usage = mergeUsage(extractUsage(message), routerUsage);
      const cost = await this.costResolver.resolve({
        providerId: this.providerId,
        model: this.model,
        runtimeModel: this.runtimeModel,
        pricing: this.currentRoute?.pricing,
        harnessCostUsd,
        usage,
      });
      this.emitEvent({
        type: "turn_complete",
        result: (message as any).result || "",
        costUsd: cost.amountUsd ?? harnessCostUsd,
        cost,
        stopReason: (message as any).stop_reason || undefined,
        // `context` = the live occupancy meter (this.contextTokens, updated per
        // streamed message so it drops after /compact) — NOT the cumulative turn
        // total, which grows with tool round-trips and would misrepresent the
        // context window actually held. input/cacheRead/... stay cumulative (cost).
        usage: withContextOccupancy(
          tokenBreakdownFromRouterOrHarness((message as any).usage, routerUsage),
          this.contextTokens,
        ),
        at: now(),
      });
      this.drainQueuedTurn();
      return;
    }

    if (message.type === "rate_limit_event") {
      const info = (message as any).rate_limit_info;
      // The raw payload already lands in the debug log via log("sdk_message");
      // the transcript only gets a diagnostic at (near-)exhaustion — every-tick
      // JSON dumps in the chat were the "rate-limit logs in chat" bug. The
      // titlebar meter consumes the structured usage_limit event on every tick.
      const window = rateLimitWindowFrom(info);
      if (window) {
        this.hasLiveUsageWindows = true;
        const stable = window.kind === "weekly"
          ? this.stableWeeklyWindow(String(info?.rateLimitType || "seven_day"), window)
          : window;
        this.emitEvent({ type: "usage_limit", provider: "claude", windows: [stable], available: true, at: now(), sourceId: this.options.usageSourceId });
        this.maybeEmitRateLimitDiagnostic(info, stable);
      }
    }
  }

  /** Folds one variant's fresh reading in and returns the most constrained weekly window. */
  private stableWeeklyWindow(variant: string, window: UsageWindow): UsageWindow {
    this.weeklyVariants.set(variant, window);
    let max = window;
    for (const candidate of this.weeklyVariants.values()) {
      if (candidate.utilization > max.utilization) {
        max = candidate;
      }
    }
    return max;
  }

  private normalizeSystem(message: any): void {
    if (message.subtype === "hook_started") {
      this.watchHook(message);
      return;
    }
    if (message.subtype === "hook_response") {
      this.finishHook(message.hook_id);
      return;
    }
    if (message.subtype === "init") {
      this.sessionId = message.session_id || this.sessionId;
      this.runtimeModel = message.model || this.runtimeModel;
      this.model = displayModelFor(this.runtimeModel);
      this.providerId = inferModelProvider(this.runtimeModel, this.options.customModelRoutes);
      this.currentRoute = this.resolveCurrentRoute();
      // The app-side permission mode is authoritative: a RESUMED session's init
      // reports the SDK's own recorded mode (often "default"), which used to
      // clobber the mode the user last chose (e.g. "auto") on every restart.
      // Instead of adopting the reported value, re-assert ours to the SDK.
      const reportedPermissionMode = message.permissionMode as PermissionMode | undefined;
      if (reportedPermissionMode && reportedPermissionMode !== this.permissionMode && this.query) {
        void this.query.setPermissionMode(this.permissionMode).catch((error) => this.emitError(error));
      }
      this.currentStatus = "initialized";
      this.emitEvent({
        type: "session",
        sessionId: this.sessionId,
        model: this.model,
        permissionMode: this.permissionMode,
        tools: message.tools,
        slashCommands: this.supportedSlashCommands.length ? this.supportedSlashCommands : toHarnessCommands(message.slash_commands),
        models: this.supportedModels,
        at: now(),
      });
      return;
    }

    if (message.subtype === "status" || message.subtype === "session_state_changed") {
      this.currentStatus = message.status || message.state || "idle";
      this.turnState = message.state || this.turnState;
      // A compaction outcome must be ATTRIBUTED, not folded into a generic
      // "idle: failed" line where it reads like a turn failure. Surface the
      // harness's own result/error verbatim (never dropped) under a clear label:
      // success → a "compacted" status, failure → a warning diagnostic that names
      // compaction and carries whatever reason the harness gave (even a terse
      // "failed" — e.g. nothing to compact on a short session).
      if (message.compact_error) {
        // The card carries the failure now. The diagnostic stays because it is
        // the durable, filterable record — the card is a transcript affordance,
        // not a log — but the raw "compacted: …" status line is gone.
        this.compactPhase = "settled";
        this.emitEvent({ type: "compact_state", state: "failed", reason: String(message.compact_error), at: now() });
        this.emitEvent({ type: "diagnostic", severity: "warning", category: "compact", title: "Compaction failed", detail: String(message.compact_error), at: now() });
        return;
      }
      if (message.compact_result) {
        // Success arrives here WITHOUT numbers; the numbers come separately on
        // `compact_boundary`. Whichever lands first settles the card — this one
        // only reports done if the boundary has not already done it with real
        // figures, so a measured card is never replaced by an empty one.
        if (this.compactPhase === "running") {
          this.compactPhase = "settled";
          this.emitEvent({ type: "compact_state", state: "done", at: now() });
        }
        return;
      }
      this.emitStatus(this.currentStatus, message.permissionMode);
      return;
    }

    if (message.subtype === "thinking_tokens") {
      this.emitEvent({ type: "thinking_tokens", estimatedTokens: message.estimated_tokens || 0, delta: message.estimated_tokens_delta, at: now() });
      return;
    }

    if (message.subtype === "commands_changed") {
      this.supportedSlashCommands = toHarnessCommands(message.commands);
      this.emit("snapshot", this.getSnapshot());
      this.emitStatus("commands_changed", `${this.supportedSlashCommands.length} slash commands`);
      return;
    }

    if (message.subtype === "permission_denied") {
      // Denied, not failed. Nothing malfunctioned — the call was refused — and
      // the transcript has to be able to say which of the two happened.
      this.emitEvent({ type: "tool_call", id: message.tool_use_id, name: message.tool_name, input: withFilePath(message.tool_input), status: "denied", result: message.message, at: now() });
      return;
    }

    // Subagent (`Task`/`Agent`) lifecycle + live activity. These carry the real
    // per-subagent signal (task_id / tool_use_id / last_tool_name / patch.status)
    // and are attributed to the subagent dock — NOT dumped into the parent chat
    // (the earlier `emitStatus` flooded the transcript with these). Verified
    // against recorded traffic in scripts/fixtures/subagents.
    //
    // The same four events also drive `backgroundTasks`, which counts EVERY
    // in-flight task rather than only dock-worthy subagents. The dock keeps
    // `local_agent` rows; a backgrounded shell or workflow is discarded there
    // but is precisely the work that must not be killed when the member looks
    // idle. See src/core/backgroundTasks.ts.
    if (message.subtype === "task_started") {
      this.backgroundTasks.started(message);
      this.emitSubagents(this.subagentTracker.taskStarted(message));
      return;
    }
    if (message.subtype === "task_progress") {
      this.emitSubagents(this.subagentTracker.taskProgress(message));
      return;
    }
    if (message.subtype === "task_updated") {
      this.backgroundTasks.updated(message);
      this.emitSubagents(this.subagentTracker.taskUpdated(message));
      return;
    }
    if (message.subtype === "task_notification") {
      // Ambient subagent notification — suppressed from the parent transcript.
      this.backgroundTasks.notified(message);
      return;
    }

    if (message.subtype === "compact_boundary") {
      // Structured, not `JSON.stringify(metadata)`. `preserved_messages` has no
      // count of its own — it carries the kept UUIDs, so N is their length, and
      // it is absent entirely when the compaction summarized everything.
      this.compactPhase = "settled";
      const meta = message.compact_metadata || {};
      const kept = Array.isArray(meta.preserved_messages?.uuids) ? meta.preserved_messages.uuids.length : undefined;
      this.emitEvent({
        type: "compact_state",
        state: "done",
        trigger: meta.trigger === "auto" ? "auto" : "manual",
        preTokens: numberOrUndefined(meta.pre_tokens),
        postTokens: numberOrUndefined(meta.post_tokens),
        durationMs: numberOrUndefined(meta.duration_ms),
        keptCount: kept,
        at: now(),
      });
    }
  }

  private watchHook(message: any): void {
    const hookId = typeof message?.hook_id === "string" ? message.hook_id : "";
    if (!hookId) {
      return;
    }
    this.finishHook(hookId);
    const name = typeof message?.hook_name === "string" ? message.hook_name : "Claude";
    const timer = setTimeout(() => {
      const pending = this.pendingHooks.get(hookId);
      if (!pending) {
        return;
      }
      this.pendingHooks.delete(hookId);
      this.emitEvent({
        type: "diagnostic",
        severity: "warning",
        category: "hook",
        title: `Claude hook이 끝나지 않았습니다: ${pending.name}`,
        detail: `${Math.round((this.options.hookStallMs ?? 15_000) / 1000)}초 동안 hook 응답이 없습니다. 외부 Claude hook 프로세스가 멈추면 서브에이전트가 완료되어도 부모 턴이 계속 작업 중으로 남을 수 있습니다.`,
        recovery: "세션을 다시 시작하세요. 반복되면 Claude 설정의 해당 hook을 비활성화하거나 hook 프로그램을 점검하세요.",
        at: now(),
      });
    }, this.options.hookStallMs ?? 15_000);
    timer.unref?.();
    this.pendingHooks.set(hookId, { name, timer });
  }

  private finishHook(hookId: unknown): void {
    if (typeof hookId !== "string") {
      return;
    }
    const pending = this.pendingHooks.get(hookId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingHooks.delete(hookId);
    }
  }

  private clearHookWatchdogs(): void {
    for (const pending of this.pendingHooks.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingHooks.clear();
  }

  private normalizeStreamEvent(event: any, parentToolUseId?: string): void {
    if (!event) {
      return;
    }
    if (event.type === "message_start") {
      this.currentStatus = "responding";
      this.turnState = "responding";
      this.emitEvent({ type: "status", status: "responding", at: now() });
      return;
    }
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      const tool = {
        id: event.content_block.id || `tool-${event.index}`,
        name: event.content_block.name || "tool",
        input: withFilePath(event.content_block.input),
        parentId: this.subagentTracker.isAgent(String(parentToolUseId)) ? parentToolUseId : undefined,
        subagent: false,
      };
      // A subagent spawn (`Agent`/`Task`) at the top level: track it and emit a
      // spawn lifecycle instead of a parent-transcript tool box.
      if (!tool.parentId && isSubagentSpawnTool(tool.name)) {
        tool.subagent = true;
        this.emitSubagents(this.subagentTracker.spawn(tool.id, tool.input));
      } else if (!tool.parentId) {
        this.emitEvent({ type: "tool_call", id: tool.id, name: tool.name, input: tool.input, status: "started", at: now() });
      }
      // A child tool of a subagent is held until content_block_stop, then emitted
      // as a subagent block (kept out of the parent transcript).
      this.activeTools.set(String(event.index), tool);
      return;
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta;
      const subagentId = this.subagentTracker.isAgent(String(parentToolUseId)) ? String(parentToolUseId) : undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        if (subagentId) {
          // Subagent text — route to the subagent, never the parent transcript.
          this.emitEvent({ type: "subagent", agentId: subagentId, block: { kind: "assistant", text: delta.text }, at: now() });
        } else {
          this.lastAssistantMessageAt = now();
          this.streamedAssistantText = true;
          this.emitEvent({ type: "assistant_text_delta", text: delta.text, blockIndex: event.index, at: now() });
        }
      } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && !subagentId) {
        this.emitEvent({ type: "reasoning_delta", text: delta.thinking, blockIndex: event.index, at: now() });
      } else if (delta?.type === "input_json_delta") {
        const tool = this.activeTools.get(String(event.index));
        if (tool) {
          tool.input = appendJsonDelta(tool.input, delta.partial_json);
        }
      }
      return;
    }
    if (event.type === "content_block_stop") {
      const tool = this.activeTools.get(String(event.index));
      if (tool) {
        if (tool.subagent) {
          // Input finished streaming: fill in the subagent's label/role/task.
          this.emitSubagents(this.subagentTracker.spawn(tool.id, tool.input));
        } else if (tool.parentId) {
          this.emitSubagentToolBlock(tool.parentId, tool.name, tool.input, "completed");
        } else {
          this.emitEvent({ type: "tool_call", id: tool.id, name: tool.name, input: tool.input, status: "completed", at: now() });
        }
        this.activeTools.delete(String(event.index));
      }
    }
  }

  private normalizeAssistantSnapshot(message: any, parentToolUseId?: string): void {
    const subagentId = this.subagentTracker.isAgent(String(parentToolUseId)) ? String(parentToolUseId) : undefined;
    // Track context occupancy from the PARENT assistant turn only — a subagent's
    // usage reflects its own isolated context, not the main thread's, so folding
    // it in would misreport the member's meter. The prompt footprint that
    // occupies the window = fresh input + cache (read+creation) + this turn's
    // output; non-cumulative, so it correctly drops after a /compact.
    if (!subagentId) {
      const contextTokens = contextTokensFromUsage((message as any)?.usage);
      if (contextTokens !== undefined) {
        this.contextTokens = contextTokens;
      }
    }
    for (const item of message?.content || []) {
      if (item?.type === "tool_use") {
        // A top-level Agent/Task spawn, or a nested tool of a known subagent.
        if (!subagentId && isSubagentSpawnTool(item.name)) {
          this.emitSubagents(this.subagentTracker.spawn(item.id || item.name, withFilePath(item.input)));
        } else if (subagentId) {
          this.emitSubagentToolBlock(subagentId, item.name || "tool", withFilePath(item.input), "completed");
        } else {
          this.emitEvent({ type: "tool_call", id: item.id || item.name || `tool-${Date.now()}`, name: item.name || "tool", input: withFilePath(item.input), status: "started", at: now() });
        }
      } else if (item?.type === "text" && typeof item.text === "string") {
        if (subagentId) {
          this.emitEvent({ type: "subagent", agentId: subagentId, block: { kind: "assistant", text: item.text }, at: now() });
        } else if (!this.streamedAssistantText) {
          // The snapshot is the ONLY source of the reply when the SDK could not
          // stream. Measured 2026-08-10 on Grok via the xAI route: the SDK
          // logged "Error streaming, falling back to non-streaming mode:
          // Content block not found", delivered `message_start` and nothing
          // else, and the finished text arrived only here — so the member
          // completed its turn (`end_turn`) with an empty transcript. Guarded on
          // the streaming flag because the normal path already emitted this
          // text delta by delta, and emitting it again would double the reply.
          this.lastAssistantMessageAt = now();
          this.emitEvent({ type: "assistant_text_delta", text: item.text, at: now() });
        }
      } else if (item?.type === "tool_result") {
        this.normalizeToolResult(item, subagentId);
      }
    }
    // One snapshot ends one assistant message; the next one streams afresh.
    this.streamedAssistantText = false;
  }

  private normalizeUserSnapshot(message: any, parentToolUseId?: string): void {
    const subagentId = this.subagentTracker.isAgent(String(parentToolUseId)) ? String(parentToolUseId) : undefined;
    for (const item of message?.content || []) {
      if (item?.type === "tool_result") {
        this.normalizeToolResult(item, subagentId);
      }
    }
  }

  /**
   * A tool_result. If it closes a subagent SPAWN (its tool_use_id is a tracked
   * Agent/Task), it marks that subagent done/failed. If it belongs INSIDE a
   * subagent, it appends to that subagent. Otherwise it's a normal parent tool.
   */
  private normalizeToolResult(item: any, subagentId?: string): void {
    const failed = Boolean(item.is_error);
    if (this.subagentTracker.isAgent(item.tool_use_id)) {
      this.emitSubagents(this.subagentTracker.toolResult(item.tool_use_id, failed));
      return;
    }
    if (subagentId) {
      this.emitEvent({ type: "subagent", agentId: subagentId, block: { kind: "status", text: failed ? "failed" : "completed" }, at: now() });
      return;
    }
    this.emitEvent({ type: "tool_call", id: item.tool_use_id || `tool-result-${Date.now()}`, name: "tool_result", status: failed ? "failed" : "completed", result: item.content, at: now() });
  }

  /** Emits the `subagent` events the tracker produced from a raw signal. */
  private emitSubagents(emits: SubagentEmit[]): void {
    for (const e of emits) {
      this.emitEvent({ type: "subagent", agentId: e.agentId, lifecycle: e.lifecycle, activity: e.activity, block: e.block, at: now() });
    }
  }

  /** Emits a subagent's nested tool as a block (+ derived live activity). */
  private emitSubagentToolBlock(agentId: string, name: string, input: unknown, status: "started" | "completed" | "failed"): void {
    const arg = subagentToolArg(input);
    this.emitEvent({
      type: "subagent",
      agentId,
      activity: deriveSubagentAction(name, arg),
      block: { kind: "tool", name, arg, status },
      at: now(),
    });
  }

  /**
   * R-90: an intentional interrupt is a normal path. Tell the member what happened
   * and what to do next — never a red error block (that is R-91's job for real
   * failures: interrupt request rejected, or a turn that failed without a stop).
   */
  private emitInterruptedNotice(rawDetail?: string): void {
    this.interruptRequested = false;
    this.lastError = undefined;
    this.currentStatus = "idle";
    this.turnState = "complete";
    this.emitEvent({
      type: "diagnostic",
      severity: "info",
      category: "interrupt",
      title: "턴이 중단되었습니다",
      detail: "사용자 또는 다른 멤버의 요청으로 진행 중이던 작업이 멈췄습니다. 실패가 아닙니다."
        + (rawDetail ? (" (하네스: " + rawDetail + ")") : ""),
      recovery: "이어서 도착하는 메시지가 있으면 그것을 먼저 처리하세요.",
      at: now(),
    });
    this.log("interrupted_notice", rawDetail || "interrupted");
  }

  /**
   * Reports this session's start as STRUCTURED facts (src/shared/sessionSpawn.ts).
   *
   * Deliberately narrow: harness, model, host and a shortened cwd. The spawn
   * command, the executable path, the SDK options and the router endpoint are
   * all logged for debugging and none of them are passed here — a card cannot
   * leak a field it was never given. A failure is classified into a fixed
   * sentence before it travels, so an OS error carrying the command line cannot
   * arrive as "detail".
   */
  private emitSessionSpawn(state: "starting" | "running" | "failed", error?: unknown): void {
    const failure = state === "failed" ? spawnFailureSummary(error) : undefined;
    this.emitEvent({
      type: "session_spawn",
      state,
      harness: "claude-code",
      model: this.model,
      host: currentSpawnHost(),
      cwd: shortCwd(this.options.cwd),
      reason: failure?.reason,
      retryable: failure?.retryable,
      at: now(),
    });
  }

  private emitError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    // Benign: the SDK rejects a pending request with this generic message when we
    // deliberately close/restart the query (model/thinking change, resume
    // recovery). It isn't a session failure — surface it as a quiet status, not a
    // red error block. A real failure carries its own message and still errors.
    if (/Query closed before response received/i.test(message)) {
      this.emitEvent({ type: "status", status: "restarted", detail: "이전 요청이 재시작으로 종료됨", at: now() });
      this.log("query_closed_benign", message);
      return;
    }
    // A resume that references a session the harness no longer has ("No
    // conversation found with session ID ...") — e.g. a persisted thread that was
    // never turn-committed, or that the SDK has since dropped — would otherwise
    // brick the member. Recover once: drop the resume id and restart a FRESH
    // session. Surfaced (not silent), and the prior transcript stays on screen.
    if (this.resumeSessionId && !this.resumeRecoveryTried && isResumeNotFound(message)) {
      this.resumeRecoveryTried = true;
      this.log("resume_recover", { failedResume: this.resumeSessionId, message });
      this.emitEvent({
        type: "diagnostic",
        severity: "warning",
        category: "resume",
        title: "이전 대화를 이어갈 수 없습니다",
        detail: "저장된 세션을 찾을 수 없어(하네스가 정리했거나 아직 커밋되지 않음) 새 세션으로 다시 시작합니다.",
        recovery: "그대로 대화를 계속하면 됩니다. 이전 기록은 화면에 남아 있습니다.",
        at: now(),
      });
      // Clear both the live and the option resume id so no restart re-resumes it.
      this.options.resumeSessionId = undefined;
      this.resumeSessionId = undefined;
      this.sessionId = "";
      this.restart(false);
      return;
    }
    this.lastError = message;
    this.currentStatus = "error";
    // A missing Claude Code install travels with its environment check so the
    // transcript shows one card with an install button instead of the same
    // failure text on every turn.
    this.emitEvent({ type: "error", ...errorEventPayload(error), at: now() });
    this.log("error", message);
  }

  private emitEvent(event: ClaudeNormalizedEvent): void {
    this.lastEventAt = event.at;
    this.emit("event", event);
    this.emit("snapshot", this.getSnapshot());
  }

  private emitStatus(status: string | null, detail?: string): void {
    const key = `${status || ""}\u0000${detail || ""}`;
    const atMs = Date.now();
    if (key === this.lastStatusKey && atMs - this.lastStatusAt < 5000) {
      return;
    }
    this.lastStatusKey = key;
    this.lastStatusAt = atMs;
    this.emitEvent({ type: "status", status, detail, at: new Date(atMs).toISOString() });
  }

  private usesRouterBackend(): boolean {
    // Native vs router is DATA, derived from the catalog entry — not a hardcoded
    // model-name list. Any Anthropic catalog entry (present or future) resolves
    // to `claude-native` automatically; only an uncatalogued custom route falls
    // back to the explicit providerId. This is the seam where adding a model
    // used to require editing a parallel string list (and routing broke when it
    // was missed).
    const backend = backendFor(this.runtimeModel, "claude-code") ?? backendFor(this.model, "claude-code");
    return backend ? backend.kind !== "claude-native" : this.providerId !== "anthropic";
  }

  private routerEnv(): Record<string, string> {
    return {
      ANTHROPIC_BASE_URL: this.options.routerBaseUrl || "http://127.0.0.1:3455",
      ANTHROPIC_AUTH_TOKEN: this.options.routerAuthToken || "dummy",
      ANTHROPIC_CUSTOM_MODEL_OPTION: this.runtimeModel,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    };
  }

  private resetRouterTurnUsage(): void {
    if (!this.usesRouterBackend() || !this.options.routerAccountingKey || !this.options.resetRouterTurnUsage) {
      return;
    }
    this.options.resetRouterTurnUsage(this.options.routerAccountingKey);
  }

  private consumeRouterTurnUsage(): RouterTurnUsage | undefined {
    if (!this.usesRouterBackend() || !this.options.routerAccountingKey || !this.options.consumeRouterTurnUsage) {
      return undefined;
    }
    return this.options.consumeRouterTurnUsage(this.options.routerAccountingKey);
  }

  private resolveCurrentRoute(): ModelRoute | undefined {
    return buildModelRoutes(this.model, [], this.options.customModelRoutes).find(
      (route) => route.model === this.model || route.runtimeModel === this.runtimeModel,
    );
  }

  private log(direction: string, payload: unknown): void {
    this.logger?.write(direction, payload);
  }

  private isTurnActive(): boolean {
    return (
      this.currentStatus === "requesting" ||
      this.currentStatus === "responding" ||
      this.currentStatus === "interrupting" ||
      this.turnState === "submitted" ||
      this.turnState === "responding" ||
      this.turnState === "interrupting" ||
      this.pendingApprovals.size > 0
    );
  }

  private drainQueuedTurn(): void {
    const next = this.queuedUserTurns.shift();
    if (!next) {
      this.emit("snapshot", this.getSnapshot());
      return;
    }
    this.emitEvent({ type: "status", status: "dequeued", detail: `${this.queuedUserTurns.length} message(s) remaining`, at: now() });
    this.dispatchUserTurn(next.text, next.attachments);
  }

  private ensureLogger(): void {
    if (!this.debugMode || this.logger) {
      return;
    }
    this.logger = RawLogger.open({
      baseDir: path.join(this.options.storageDir, "logs"),
      sessionId: this.options.id,
      maxFiles: 10,
      maxBytes: 2 * 1024 * 1024,
      onDisabled: (detail) => this.reportRawLogDisabled(detail),
    });
  }

  /**
   * Raw logging stopped. Reported rather than swallowed: debug mode still reads
   * as ON, so someone would otherwise keep looking for a file that quietly
   * stopped growing. A warning, not an error — the session is unaffected.
   */
  private reportRawLogDisabled(detail: string): void {
    this.logger = undefined;
    this.emitEvent({
      type: "diagnostic",
      severity: "warning",
      category: "debug-log",
      title: "디버그 원본 로그를 더 기록하지 못합니다",
      detail,
      recovery: "저장 공간과 폴더 접근 권한을 확인한 뒤 디버그 로그를 다시 켜세요. 대화 자체는 영향받지 않습니다.",
      at: now(),
    });
  }
}

/**
 * Resolves the model id that is safe to hand to the Claude harness.
 *
 * Renderer/API callers include `runtimeModel` so router-backed aliases can be
 * selected explicitly. That value is transport metadata, though, and must not
 * override the native id of a catalogued Anthropic model. In particular an old
 * or cross-harness route can carry `anthropic/claude-opus-4.8`; forwarding that
 * verbatim makes the Claude adapter enter router mode and reject Opus even
 * though the user selected the native Claude Code route. Codex->OpenRouter is
 * handled by CodexAdapter and is intentionally unaffected by this boundary.
 */
export function claudeRuntimeModelFor(
  model: string,
  providerId: ModelProviderId,
  requestedRuntimeModel: string | undefined,
  customRoutes: ModelRouteConfig[] = [],
): string {
  const catalogued = resolveCatalogModel(model) || (requestedRuntimeModel ? resolveCatalogModel(requestedRuntimeModel) : undefined);
  if (providerId === "anthropic" && catalogued?.provider === "anthropic") {
    return catalogued.runtimeModel || catalogued.id;
  }
  return requestedRuntimeModel || runtimeModelFor(model, customRoutes);
}

async function loadSdk(): Promise<SdkModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<SdkModule>;
  return await dynamicImport("@anthropic-ai/claude-agent-sdk");
}

/**
 * Resolution lives in {@link ../core/claudeCli} so the environment screen and
 * this spawn can never disagree about which binary is in play.
 *
 * `undefined` lets the Agent SDK resolve its own copy — correct in a dev tree
 * and inside a WSL distro, where one sits next to the SDK. An INSTALLED app
 * ships none, so there the same `undefined` would send the SDK hunting for a
 * file that does not exist and fail far from the cause; it is turned into an
 * environment blocker instead, which the transcript renders with an install
 * button.
 */
function resolveClaudeExecutable(configured: string | undefined): string | undefined {
  const resolved = resolveClaudeCli(configured)?.command;
  if (!resolved && isInstalledApp()) {
    throw new EnvironmentBlockedError(claudeCliMissingMessage(), "harness.claude-code");
  }
  return resolved;
}

function now(): string {
  return new Date().toISOString();
}

/** SDK MCP status → neutral state. `pending` is an in-progress connect. */
function mapClaudeMcpState(status: McpServerStatus["status"]): McpServerState {
  switch (status) {
    case "connected":
      return "connected";
    case "pending":
      return "connecting";
    case "needs-auth":
      return "needs-auth";
    case "disabled":
      return "disabled";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

/**
 * Normalizes the harness's reported commands into `HarnessCommand[]`. Accepts
 * either the rich SDK `SlashCommand` objects (init / commands_changed) or the
 * bare name strings carried by the `system:init` message.
 */
function toHarnessCommands(commands: unknown): HarnessCommand[] {
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands
    .map((command): HarnessCommand | undefined => {
      if (typeof command === "string") {
        return command ? { name: command } : undefined;
      }
      const record = asRecord(command);
      const name = record ? stringValue(record.name) ?? stringValue(record.command) : undefined;
      if (!name) {
        return undefined;
      }
      return {
        name,
        description: record ? stringValue(record.description) : undefined,
        argumentHint: record ? stringValue(record.argumentHint) ?? stringValue(record.argument_hint) : undefined,
        aliases: record && Array.isArray(record.aliases) ? record.aliases.filter((a): a is string => typeof a === "string") : undefined,
      };
    })
    .filter((command): command is HarnessCommand => Boolean(command));
}

function appendJsonDelta(current: unknown, delta: string | undefined): unknown {
  if (!delta) {
    return current;
  }
  if (typeof current === "string") {
    return current + delta;
  }
  if (current === undefined) {
    return delta;
  }
  return current;
}

/**
 * The context-window footprint of one assistant turn, from its raw `usage`
 * block: fresh input + cache read + cache creation (the prompt the model saw)
 * plus this turn's output (which lands in the next turn's context). Returns
 * undefined when the block carries no recognizable token counts.
 */
/**
 * Splits a Claude result `usage` block into the ledger's per-turn token
 * breakdown. The result `usage` is CUMULATIVE across every internal API round
 * trip of the turn, so input/cacheRead/cacheWrite/output are the turn's billed
 * totals (correct for cost). It deliberately does NOT derive `context` from this
 * sum — that would balloon with the number of tool round-trips and misrepresent
 * context-window occupancy. The caller stamps `context` from the live occupancy
 * meter ({@link contextTokensFromUsage}, non-cumulative) instead. Returns
 * undefined when the harness reported no token counts — a missing field must
 * read as "not reported", never zero.
 */
/**
 * The harness's own token report, or the gateway's measurement when the harness
 * reports nothing usable.
 *
 * Claude Code returns an all-zero `result.usage` for router-backed models, which
 * put Grok turns in the ledger as 0 in / 0 out while each request really carried
 * ~100k tokens — the dashboard looked idle while a subscription drained. The
 * gateway counts what actually crossed the wire, so it is the honest source
 * whenever the harness has nothing; a harness that does report keeps precedence,
 * since it also sees requests the gateway never proxied.
 */
function tokenBreakdownFromRouterOrHarness(
  harnessUsage: unknown,
  routerUsage: RouterTurnUsage | undefined,
): TurnTokenBreakdown | undefined {
  const fromHarness = tokenBreakdownFromClaudeUsage(harnessUsage);
  const reported = (fromHarness?.input ?? 0) + (fromHarness?.output ?? 0)
    + (fromHarness?.cacheRead ?? 0) + (fromHarness?.cacheWrite ?? 0);
  if (reported > 0 || !routerUsage?.tokens) {
    return fromHarness;
  }
  return {
    input: routerUsage.tokens.input,
    output: routerUsage.tokens.output,
    cacheRead: routerUsage.tokens.cacheRead,
    cacheWrite: routerUsage.tokens.cacheWrite,
  };
}

/**
 * Stamps the honest context-window occupancy onto a turn breakdown. `occupancy`
 * is the adapter's last live meter reading (non-cumulative); when it is absent we
 * leave `context` undefined rather than fall back to the cumulative sum — an
 * unknown occupancy must read as "not reported", never as an inflated total.
 */
function withContextOccupancy(
  breakdown: TurnTokenBreakdown | undefined,
  occupancy: number | undefined,
): TurnTokenBreakdown | undefined {
  if (!breakdown) {
    return breakdown;
  }
  return { ...breakdown, context: occupancy };
}

function contextTokensFromUsage(usage: unknown): number | undefined {
  const record = asRecord(usage);
  if (!record) {
    return undefined;
  }
  const input = numberValue(record.input_tokens) ?? 0;
  const cacheRead = numberValue(record.cache_read_input_tokens) ?? 0;
  const cacheCreation = numberValue(record.cache_creation_input_tokens) ?? 0;
  const output = numberValue(record.output_tokens) ?? 0;
  const total = input + cacheRead + cacheCreation + output;
  return total > 0 ? total : undefined;
}

function extractUsage(message: unknown): TurnUsage | undefined {
  const record = asRecord(message);
  const usage = asRecord(record?.usage) || asRecord(record?.message_usage) || asRecord(record?.token_usage);
  const generationId =
    stringValue(record?.generation_id) ||
    stringValue(record?.generationId) ||
    stringValue(usage?.generation_id) ||
    stringValue(usage?.generationId) ||
    stringValue(record?.id) ||
    stringValue(asRecord(record?.response)?.id);
  if (!usage && !generationId) {
    return undefined;
  }
  return {
    inputTokens: numberValue(usage?.input_tokens),
    outputTokens: numberValue(usage?.output_tokens),
    promptTokens: numberValue(usage?.prompt_tokens),
    completionTokens: numberValue(usage?.completion_tokens),
    totalTokens: numberValue(usage?.total_tokens),
    costUsd: numberValue(usage?.cost),
    generationId,
    costUnavailableReason: stringValue(usage?.cost_unavailable_reason),
  };
}

function mergeUsage(base: TurnUsage | undefined, routerUsage: RouterTurnUsage | undefined): TurnUsage | undefined {
  if (!routerUsage) {
    return base;
  }
  return {
    ...base,
    costUsd: routerUsage.costUsd,
    generationId: routerUsage.generationId || base?.generationId,
    costUnavailableReason: routerUsage.costUnavailableReason || base?.costUnavailableReason,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * The Claude Code subagent tool. `Task` was renamed `Agent` in v2.1.63, so both
 * must match (per the SDK subagents docs / Item 08).
 */
function isSubagentSpawnTool(name: string | undefined): boolean {
  return name === "Agent" || name === "Task";
}

/** A short arg summary (path/command/pattern/query) for a subagent tool block. */
function subagentToolArg(input: unknown): string {
  const record = asRecord(input);
  if (!record) {
    return "";
  }
  const candidate = record.pattern ?? record.query ?? record.command ?? record.path ?? record.file ?? record.filePath ?? record.file_path;
  return typeof candidate === "string" ? candidate : "";
}

/** Non-empty string or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function scrubPermissionOptions(options: Parameters<CanUseTool>[2]): Record<string, unknown> {
  return {
    toolUseID: options.toolUseID,
    title: options.title,
    displayName: options.displayName,
    description: options.description,
    decisionReason: options.decisionReason,
    blockedPath: options.blockedPath,
    suggestions: options.suggestions,
    agentID: options.agentID,
  };
}

function asModelProviderId(value: unknown): ModelProviderId | undefined {
  return value === "anthropic" || value === "openrouter" || value === "openai" || value === "custom" ? value : undefined;
}

/**
 * Maps a Claude `SDKRateLimitInfo` (one window per event) to a {@link UsageWindow}.
 * `five_hour` → 5-hour window; any `seven_day*` variant → weekly. The `overage`
 * type and events without a numeric utilization/type carry no meter and are
 * skipped (returns undefined) rather than fabricating a value.
 */
function rateLimitWindowFrom(info: any): UsageWindow | undefined {
  if (!info || typeof info.utilization !== "number" || !isFinite(info.utilization)) {
    return undefined;
  }
  const type = String(info.rateLimitType || "");
  const kind: UsageWindowKind | undefined = type === "five_hour" ? "five_hour" : type.startsWith("seven_day") ? "weekly" : undefined;
  if (!kind) {
    return undefined;
  }
  return { kind, utilization: Math.max(0, Math.min(100, info.utilization)), resetsAt: toEpochMs(info.resetsAt) };
}

const CLAUDE_WEEKLY_VARIANTS = ["seven_day", "seven_day_sonnet", "seven_day_opus", "seven_day_oauth_apps"] as const;

/** Every weekly variant the `/usage` read reports, keyed by variant name. */
function weeklyVariantWindows(rateLimits: any): Array<[string, UsageWindow]> {
  if (!rateLimits || typeof rateLimits !== "object") {
    return [];
  }
  const variants: Array<[string, UsageWindow]> = [];
  for (const variant of CLAUDE_WEEKLY_VARIANTS) {
    const window = claudeUsageWindow("weekly", rateLimits[variant]);
    if (window) {
      variants.push([variant, window]);
    }
  }
  return variants;
}

/**
 * Maps the Claude SDK `/usage` response's rate_limits object to display windows.
 * The weekly meter is the MOST CONSTRAINED variant — picking "the first present
 * one" while live events fed whichever variant just ticked made the displayed
 * weekly number change on every refresh.
 */
function claudeUsageWindows(rateLimits: any): UsageWindow[] {
  if (!rateLimits || typeof rateLimits !== "object") {
    return [];
  }
  const windows: UsageWindow[] = [];
  const five = claudeUsageWindow("five_hour", rateLimits.five_hour);
  if (five) {
    windows.push(five);
  }
  let weekly: UsageWindow | undefined;
  for (const [, window] of weeklyVariantWindows(rateLimits)) {
    if (!weekly || window.utilization > weekly.utilization) {
      weekly = window;
    }
  }
  if (weekly) {
    windows.push(weekly);
  }
  return windows;
}

function claudeUsageWindow(kind: UsageWindowKind, value: any): UsageWindow | undefined {
  if (!value || typeof value !== "object" || typeof value.utilization !== "number" || !isFinite(value.utilization)) {
    return undefined;
  }
  return {
    kind,
    utilization: Math.max(0, Math.min(100, value.utilization)),
    resetsAt: toEpochMs(Date.parse(String(value.resets_at || ""))),
  };
}

/**
 * Whether an SDK error means the resume target session no longer exists — the
 * signal to recover with a fresh session. Matches the Claude Agent SDK's
 * "No conversation found with session ID ..." and close variants.
 */
/** True when the harness wording means a user/party stop, not a session crash. */
/** A finite number, or nothing — so an absent SDK field never renders as 0. */
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isUserInterruptMessage(message: string): boolean {
  return /interrupted by user|interrupted by client|request interrupted|harness request interrupted/i.test(message);
}

function isResumeNotFound(message: string): boolean {
  return /no conversation found|conversation not found|session .*not found|resume.*not found|unknown session/i.test(message);
}

function isRoutableRouterModel(model: string): boolean {
  return Boolean(routerTargetForModel(model));
}

async function assertRouterReachable(baseUrl: string, model: string): Promise<void> {
  const target = parseRouterTarget(baseUrl);
  const kind = routerTargetForModel(model)?.kind;
  // A router-backed model depends on a CHAIN, and naming only the first link
  // left users unable to act: a GPT/Codex-subscription model on the Claude Code
  // harness is served by the router forwarding to a local CLIProxyAPI, so
  // "router is not reachable" pointed at the wrong thing when the real problem
  // was that the proxy was never started or signed in. Each message now names
  // the component that actually has to be running for THIS model.
  const dependency = kind === "codex-subscription" || kind === "cursor-subscription"
    ? " This model is served by the router forwarding to the local CLIProxyAPI (subscription proxy), so both must be running."
    : "";
  const ok = await canConnect(target.host, target.port, 1200);
  if (!ok) {
    throw new Error(
      `AgentParty router is not reachable at ${target.host}:${target.port} (${baseUrl}). ` +
        "Start the local router before using router-backed models such as MiniMax M3; refusing to let Claude Code retry against an unavailable backend." +
        dependency,
    );
  }
  const health = await readRouterHealth(baseUrl);
  if (kind === "openrouter" && health && health.openRouterConfigured === false) {
    throw new Error(
      "AgentParty Native embedded router is running, but OpenRouter is not configured. " +
        "Set agentpartyNative.router.openRouterApiKey or OPENROUTER_API_KEY before using router-backed models such as MiniMax M3.",
    );
  }
  // The router itself answers with whether the subscription proxy is configured.
  // Reporting that here turns a downstream "backend does not work" into a stated
  // cause the user can fix.
  if ((kind === "codex-subscription" || kind === "cursor-subscription") && health && health.subscriptionProxyConfigured === false) {
    throw new Error(
      `AgentParty router is running, but the local CLIProxyAPI (subscription proxy) it forwards '${model}' to is not configured` +
        `${health.subscriptionProxyBaseUrl ? ` at ${health.subscriptionProxyBaseUrl}` : ""}. ` +
        "Start CLIProxyAPI and connect the subscription in Settings → Authentication; refusing to let Claude Code retry against a backend that cannot answer.",
    );
  }
}

function parseRouterTarget(baseUrl: string): { host: string; port: number } {
  try {
    const url = new URL(baseUrl || "http://127.0.0.1:3455");
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return { host: url.hostname || "127.0.0.1", port };
  } catch {
    throw new Error(`Invalid AgentParty router URL '${baseUrl}'.`);
  }
}

function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function readRouterHealth(baseUrl: string): Promise<{ openRouterConfigured?: boolean; subscriptionProxyConfigured?: boolean; subscriptionProxyBaseUrl?: string } | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(new URL("/health", baseUrl), { signal: controller.signal });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as { openRouterConfigured?: boolean; subscriptionProxyConfigured?: boolean; subscriptionProxyBaseUrl?: string };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
