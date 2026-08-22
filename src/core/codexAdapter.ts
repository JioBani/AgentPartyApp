import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RawLogger } from "./rawLogger";
import { EnvironmentBlockedError, errorEventPayload, isSpawnFailure } from "./environmentError";
import { CodexSubagentTracker, codexWebSearchQuery, type SubagentEmit } from "./subagentTracker";
import type { ClaudeEffort, ClaudeNormalizedEvent, ClaudeSessionSnapshot, HarnessCommand } from "./events";
import { codexExecutable, codexExtraArgs, resolveCodexExecutable } from "./codexExec";
import { terminateProcessTree } from "./processTree";
import { DefaultTurnCostResolver } from "./costing";
import type { TurnUsage } from "./costing";
import type { TurnTokenBreakdown } from "../shared/tokenUsage";
import { imageContentResult } from "./imageFile";
import type { PartyBridge, PartyIdentity } from "./partyBridge";
import { buildPartyDynamicToolSpec, buildPartyPrimer, invokePartyTool, partyToolNameOf, PARTY_MCP_SERVER, PARTY_TOOL_NAMES, PARTY_TOOL_PREFIX } from "./partyBridge";
import type { CodexPolicy, SandboxMode } from "../shared/codexPolicy";
import { codexPolicyFromPermissionMode } from "../shared/codexPolicy";
import {
  CODEX_CLAUDE_SUBSCRIPTION_PROVIDER,
  CODEX_DEEPSEEK_PROVIDER,
  CODEX_OPENROUTER_PROVIDER,
  codexProviderConfigArgs,
  codexProviderForModel,
  type CodexCustomProvider,
} from "../shared/codexProviders";
import { assertSubscriptionModelAvailable, subscriptionProxyConfig } from "./subscriptionProxy";
import { pricingForModel, visionForModel } from "./modelRegistry";
import { resolveCatalogModel } from "../shared/modelCatalog";
import type { ImageAttachment } from "../shared/attachments";
import { approvalResult, codexDecisionOf } from "../shared/codexApproval";
import { partyMcpRuntimeEnv, spawnablePartyMcpCommand } from "./partyMcpRuntime";
import { approvalAnswers, codexApprovalFields } from "../shared/approvalRequest";
import { fileEditsFrom, planStepsFrom, toolSourceLabel } from "../shared/codexItems";
import type { CodexFileEdit } from "../shared/codexItems";
import { pluginCommands, skillCommands } from "../shared/codexDiscovery";
import { classifyDiagnostic } from "../shared/codexDiagnostics";
import { toEpochMs, type UsageWindow, type UsageWindowKind } from "../shared/usageLimits";
import { emptyMcpSnapshot } from "../shared/mcp";
import type { McpAuthResult, McpServerInfo, McpServerSnapshot, McpServerState } from "../shared/mcp";
import { currentSpawnHost, shortCwd, spawnFailureSummary } from "../shared/sessionSpawn";

export interface CodexAdapterOptions {
  id: string;
  cwd: string;
  model: string;
  effort: ClaudeEffort;
  permissionMode?: string;
  /** Explicit two-axis safety model; falls back to deriving from permissionMode. */
  policy?: CodexPolicy;
  debugEnabled: boolean;
  /** Base dir for the raw JSON-RPC debug trace (a `logs/` subdir is created). */
  storageDir: string;
  /** Dedicated SQLite runtime directory; CODEX_HOME remains shared for auth/config/rollouts. */
  sqliteHome?: string;
  executablePath?: string;
  executableArgs?: string[];
  resumeSessionId?: string;
  /**
   * Identifies which usage FAN-IN source this adapter's `usage_limit` events
   * belong to. SessionManager keeps one active source per provider and drops
   * events from any other, so a background poller and a foreground session cannot
   * fight over the meter. Stamped onto every emitted `usage_limit`; when absent
   * the event carries no source and the filter lets it through unchanged.
   */
  usageSourceId?: string;
  partyBridge?: PartyBridge;
  partyIdentity?: PartyIdentity;
  /**
   * The primer text for this member, already resolved against the user's
   * Settings → 파티 프롬프트 customization. Absent = the built-in primer.
   */
  partyPrimer?: string;
  automationBaseUrl?: string;
  /**
   * OpenRouter API key. When the model routes through a custom provider whose
   * env var is this key, it is placed on the app-server process env so the
   * provider authenticates (Phase 2 — codexProviders.ts). Absent = account
   * catalog (openai) only.
   */
  openRouterApiKey?: string;
  deepseekApiKey?: string;
  /** Local CLIProxyAPI connection used for Claude OAuth cross-routing. */
  subscriptionProxyBaseUrl?: string;
  subscriptionProxyApiKey?: string;
  /** Authentication generation already present before this process starts. */
  authenticationGeneration?: string;
}

type JsonRpcId = string;
type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

type PendingApproval = {
  method: string;
  input: unknown;
};

const CODEX_COMMANDS: HarnessCommand[] = [
  { name: "model", description: "Switch model", source: "built-in" },
  { name: "approvals", description: "Change approval mode", source: "built-in" },
  { name: "new", description: "Start a new conversation", source: "built-in" },
  { name: "init", description: "Create an AGENTS.md for this repo", source: "built-in" },
  { name: "compact", description: "Summarize to free context", source: "built-in" },
  { name: "diff", description: "Show working-tree diff", source: "built-in" },
  { name: "mention", description: "Mention a file", argumentHint: "<path>", source: "built-in" },
  { name: "status", description: "Show session status", source: "built-in" },
  { name: "mcp", description: "List MCP servers", source: "built-in" },
];

export class CodexAdapter extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | undefined;
  private lineReader: readline.Interface | undefined;
  private started = false;
  private disposed = false;
  private initializing: Promise<void> | undefined;
  private status = "created";
  private turnState: string | undefined;
  private sessionId = "";
  private activeTurnId: string | undefined;
  private turnCount = 0;
  private queuedTurns: QueuedCodexTurn[] = [];
  /** Temp dir holding images written for `localImage` inputs; removed on dispose. */
  private imageTempDir?: string;
  private activeTurn = false;
  private lastEventAt: string | undefined;
  private lastUserMessageAt: string | undefined;
  private lastAssistantMessageAt: string | undefined;
  private lastError: string | undefined;
  private lastUsage: TurnUsage | undefined;
  /** Last reported context-window occupancy (tokens) and, if Codex sends it, window size. */
  private contextTokens: number | undefined;
  private contextWindow: number | undefined;
  private authenticationGeneration = "";
  private pendingAuthenticationGeneration: string | undefined;
  private requestSeq = 0;
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  /** Raw `RequestId` per pending server request — see `respond()` for why. */
  private readonly wireIds = new Map<string, string | number>();
  /** File edits per item id, so a file-change approval can show its diff. */
  private readonly fileChangesByItem = new Map<string, CodexFileEdit[]>();
  private readonly startedAt = now();
  private readonly costResolver = new DefaultTurnCostResolver();
  private policy: CodexPolicy;
  /** Raw JSON-RPC trace (inbound notifications/responses + outbound requests),
   *  written only in debug mode — the Codex counterpart to ClaudeAdapter's log. */
  private logger: RawLogger | undefined;
  private debugMode: boolean;
  private stderrTail = "";
  /** Attributes collab-agent activity: each child runs on its own thread and its
   *  `item/*` notifications carry that `threadId` (verified against recordings). */
  private readonly subagentTracker = new CodexSubagentTracker();
  /** Live palette inventory: built-in commands + discovered skills/plugins. */
  private inventory: HarnessCommand[] = CODEX_COMMANDS;
  /** Live per-server MCP startup state (name → state) from startupStatus/updated. */
  private readonly mcpStartup = new Map<string, { status: string; error?: string; failureReason?: string }>();
  private usageRefreshTimer: NodeJS.Timeout | undefined;
  private lastUsageStatus = "";

  constructor(private readonly options: CodexAdapterOptions) {
    super();
    this.sessionId = options.resumeSessionId || "";
    this.debugMode = options.debugEnabled;
    this.policy = options.policy ?? codexPolicyFromPermissionMode(options.permissionMode);
    this.authenticationGeneration = options.authenticationGeneration || "";
  }

  /**
   * The custom provider the current model routes through (OpenRouter etc.), or
   * undefined for the built-in openai account catalog. Derived from the model
   * slug via the shared catalog so no extra plumbing is threaded through the
   * session layers. See codexProviders.ts.
   */
  private currentProvider(): CodexCustomProvider | undefined {
    const provider = codexProviderForModel(this.options.model);
    if (provider?.id !== CODEX_CLAUDE_SUBSCRIPTION_PROVIDER.id) {
      return provider;
    }
    return { ...provider, baseUrl: this.subscriptionProxy().baseUrl };
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.status = "starting";
    this.emitSessionSpawn("starting");
    this.emitEvent({
      type: "session",
      sessionId: this.sessionId || this.options.id,
      model: this.options.model,
      permissionMode: this.options.permissionMode,
      slashCommands: this.inventory,
      at: now(),
    });
    this.initializing = this.ensureThread();
    this.initializing.catch((error) => this.finishWithError(error));
    this.emit("snapshot", this.getSnapshot());
  }

  sendUserTurn(text: string, attachments?: ImageAttachment[]): void {
    if (this.disposed) {
      return;
    }
    // Text-only safety net (no-silent-drop policy): refuse an image turn on a
    // model known to reject images, with a visible error. The composer gates
    // this in the UI; this guards the HTTP/agent paths.
    if (attachments?.length && visionForModel(this.options.model).image === false) {
      this.emitEvent({
        type: "diagnostic",
        severity: "error",
        category: "vision",
        title: "이 모델은 이미지 입력을 지원하지 않습니다",
        detail: `${this.options.model}은(는) 텍스트 전용 모델입니다. 이미지 ${attachments.length}개를 보내지 못했습니다.`,
        recovery: "이미지 없이 다시 보내거나, 이미지(비전)를 지원하는 모델로 전환하세요.",
        at: now(),
      });
      return;
    }
    if (!this.started) {
      this.start();
    }
    if (this.activeTurn) {
      this.queuedTurns.push({ text, attachments });
      this.emitEvent({ type: "status", status: "queued", detail: `${this.queuedTurns.length} message(s) queued`, at: now() });
      return;
    }
    void this.runTurn(text, attachments);
  }

  /**
   * Requests a turn interrupt — the normal Stop control.
   *
   * Accepting the `turn/interrupt` request is NOT the turn ending; only a turn
   * completion or a failure clears "interrupting". When the app-server dies
   * mid-turn (the 2026-07-09 handoff's stuck `survey4`) neither ever arrives, so
   * the member reads "작업중" indefinitely and later sends queue behind a turn
   * that is already gone. {@link forceStop} is the user's escape hatch for that.
   */
  interrupt(): void {
    if (!this.sessionId || !this.activeTurnId) {
      // No turn in flight — safe to release anything a past interrupt stranded.
      this.forceStop();
      this.emitEvent({ type: "status", status: "interrupt", detail: "no active codex turn", at: now() });
      return;
    }
    this.status = "interrupting";
    this.turnState = "interrupting";
    void this.request("turn/interrupt", { threadId: this.sessionId, turnId: this.activeTurnId }).catch((error) => this.finishWithError(error));
    this.emitEvent({ type: "status", status: "interrupt", detail: "requested", at: now() });
  }

  /**
   * Releases a turn Codex will never close — the manual "강제 종료" offered once a
   * Stop has gone unanswered. Local only: it frees this session and flushes the
   * queue without killing the app-server or discarding the thread.
   */
  forceStop(): void {
    if (!this.activeTurn && this.status !== "interrupting") {
      return;
    }
    this.log("force_stop", { status: this.status, turnState: this.turnState });
    this.status = "idle";
    this.turnState = undefined;
    this.activeTurnId = undefined;
    this.drainQueuedTurn();
  }

  restart(): void {
    this.shutdownProcess();
    this.sessionId = "";
    this.activeTurnId = undefined;
    this.activeTurn = false;
    this.queuedTurns = [];
    this.turnState = undefined;
    this.status = "created";
    this.started = false;
    this.initializing = undefined;
    // A Codex restart clears the thread id → a fresh (empty) thread, so the old
    // occupancy is stale. The window repopulates from the next tokenUsage update.
    this.contextTokens = undefined;
    this.contextWindow = undefined;
    this.start();
  }

  /**
   * Reconnects an account-catalog session to newly synchronized native Codex
   * credentials while retaining its thread id and therefore conversation.
   */
  authenticationChanged(generation: string): "ignored" | "restarted" | "deferred" {
    if (this.currentProvider() || generation === this.authenticationGeneration) {
      return "ignored";
    }
    this.authenticationGeneration = generation;
    this.emitEvent({
      type: "diagnostic",
      severity: "warning",
      category: "auth",
      title: "Codex 인증이 변경되었습니다",
      detail: this.activeTurn
        ? "현재 응답이 끝난 뒤 대화 내용을 유지한 채 세션을 자동으로 다시 연결합니다."
        : this.status === "starting"
          ? "현재 연결 준비가 끝난 뒤 대화 내용을 유지한 채 새 인증으로 다시 연결합니다."
        : "대화 내용을 유지한 채 세션을 새 인증으로 자동 재연결합니다.",
      at: now(),
    });
    if (this.activeTurn) {
      this.pendingAuthenticationGeneration = generation;
      return "deferred";
    }
    if (this.status === "starting" && this.initializing) {
      const initializing = this.initializing;
      this.pendingAuthenticationGeneration = generation;
      const scheduleReload = () => {
        if (
          this.pendingAuthenticationGeneration === generation
          && this.initializing === initializing
          && !this.disposed
        ) {
          this.pendingAuthenticationGeneration = undefined;
          void this.reloadAuthentication();
        }
      };
      void initializing.then(scheduleReload, scheduleReload);
      return "deferred";
    }
    void this.reloadAuthentication();
    return "restarted";
  }

  compact(): void {
    if (!this.sessionId) {
      this.sendUserTurn("/compact");
      return;
    }
    // Surface the compaction — otherwise the app-server compacts silently and the
    // only visible effect is a context number that quietly drops, which reads as
    // unexplained. Announce start, then the outcome (done / failed), never dropped.
    // Measured: `thread/compact/start` reports only that it finished — no token
    // counts, no duration, no kept-message list. So the card renders here with
    // none of those, rather than inventing figures Codex never sent.
    this.emitEvent({ type: "compact_state", state: "running", trigger: "manual", at: now() });
    void this.request("thread/compact/start", { threadId: this.sessionId })
      .then(() => this.emitEvent({ type: "compact_state", state: "done", at: now() }))
      .catch((error) => {
        const detail = String(error?.message || error);
        this.emitEvent({ type: "compact_state", state: "failed", reason: detail, at: now() });
        this.emitEvent({ type: "diagnostic", severity: "warning", category: "compact", title: "Compaction failed", detail, at: now() });
      });
  }

  /** Writes one raw JSON-RPC frame to the debug trace (no-op unless debug on). */
  private log(direction: string, payload: unknown): void {
    this.logger?.write(direction, payload);
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

  /** See ClaudeAdapter.reportRawLogDisabled — debug mode still reads as ON, so say so. */
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

  dispose(): void {
    this.disposed = true;
    this.stopUsagePolling();
    this.logger?.close();
    this.logger = undefined;
    this.shutdownProcess();
    if (this.imageTempDir) {
      try { fs.rmSync(this.imageTempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      this.imageTempDir = undefined;
    }
    this.removeAllListeners();
  }

  getSnapshot(): ClaudeSessionSnapshot {
    return {
      id: this.options.id,
      pid: this.process?.pid,
      // The app-server is spawned once and lives for the whole session, so once
      // we have started, holding no process IS death — including the exit-while
      // -idle case, which deliberately changes no status (see handleExit) and so
      // was invisible to anything reading `status` alone.
      harnessAlive: !this.disposed && (!this.started || Boolean(this.process)),
      cwd: this.options.cwd,
      sessionId: this.sessionId || undefined,
      model: this.options.model,
      effort: this.options.effort,
      permissionMode: this.options.permissionMode,
      status: this.status,
      turnState: this.turnState,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      lastUserMessageAt: this.lastUserMessageAt,
      lastAssistantMessageAt: this.lastAssistantMessageAt,
      logPath: this.debugMode ? this.logger?.filePath : undefined,
      debugMode: this.debugMode,
      lastError: this.lastError,
      turnCount: this.turnCount,
      queuedTurnCount: this.queuedTurns.length,
      pendingApprovalCount: this.pendingApprovals.size,
      slashCommands: this.inventory,
      codexPolicy: this.policy,
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
    };
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
    if (enabled) {
      this.ensureLogger();
    } else {
      this.logger?.close();
      this.logger = undefined;
    }
    this.emit("snapshot", this.getSnapshot());
  }

  setModel(model: string): void {
    const previousProvider = this.currentProvider()?.id;
    (this.options as { model: string }).model = model;
    const nextProvider = this.currentProvider()?.id;
    if (previousProvider !== nextProvider && this.started) {
      this.emitEvent({
        type: "status",
        status: "model-provider",
        detail: `provider changed from ${previousProvider || "openai-account"} to ${nextProvider || "openai-account"}; restarting Codex app-server with a fresh thread`,
        at: now(),
      });
      this.restart();
      return;
    }
    this.emitEvent({ type: "status", status: "model", detail: model, at: now() });
  }

  setEffort(effort: string): void {
    (this.options as { effort: ClaudeEffort }).effort = effort as ClaudeEffort;
    this.emitEvent({ type: "status", status: "effort", detail: effort, at: now() });
  }

  setThinking(_mode: string, _budget?: number): void {
    this.emitEvent({ type: "status", status: "thinking", detail: "Codex app-server manages reasoning internally.", at: now() });
  }

  setPermissionMode(permissionMode: string): void {
    (this.options as { permissionMode?: string }).permissionMode = permissionMode;
    this.policy = codexPolicyFromPermissionMode(permissionMode);
    this.emitEvent({ type: "status", status: "permission", detail: permissionMode, at: now() });
  }

  /**
   * Updates the two-axis safety model live; takes effect on the next turn's
   * params. Surfaced as a status event (no silent change) — the header/transcript
   * must show the member's current sandbox/approval/guardian.
   */
  setCodexPolicy(policy: CodexPolicy): void {
    this.policy = policy;
    const detail = `sandbox=${policy.sandbox} approval=${policy.approval}${policy.guardian ? " guardian=on" : ""}`;
    this.emitEvent({ type: "status", status: "codex-policy", detail, at: now() });
  }

  // --- MCP (external servers this member connects to as a client) ----------
  // Backed by the app-server v2 surface: mcpServerStatus/list (config + tools +
  // auth), live startup state from mcpServer/startupStatus/updated, reconnect via
  // config/mcpServer/reload, and OAuth via mcpServer/oauth/login. There is no
  // live enable/disable RPC (config-file driven), so canToggle is false.

  async listMcpServers(): Promise<McpServerSnapshot> {
    const partyServer = this.partyMcpServerInfo();
    if (!this.process) {
      if (partyServer) {
        const snapshot = emptyMcpSnapshot("codex", "Codex session has not started yet.");
        return { ...snapshot, servers: [partyServer] };
      }
      return emptyMcpSnapshot("codex", "세션이 아직 시작되지 않았습니다 — 멤버를 시작한 뒤 확인하세요.");
    }
    try {
      const params: Record<string, unknown> = { detail: "full" };
      if (this.sessionId) {
        params.threadId = this.sessionId;
      }
      const response = await this.request("mcpServerStatus/list", params);
      const data: any[] = Array.isArray(response?.data) ? response.data : [];
      const servers = data.map((entry) => this.toNeutralMcpServer(entry));
      if (partyServer && !servers.some((server) => server.name === PARTY_MCP_SERVER)) {
        servers.unshift(partyServer);
      }
      return { supported: true, harness: "codex", servers };
    } catch (error) {
      return { supported: true, harness: "codex", servers: partyServer ? [partyServer] : [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  private partyMcpServerInfo(): McpServerInfo | undefined {
    if (!this.options.partyBridge || !this.options.partyIdentity) {
      return undefined;
    }
    return {
      name: PARTY_MCP_SERVER,
      state: "connected",
      transport: "unknown",
      scope: "session",
      version: "0.1.0",
      tools: PARTY_TOOL_NAMES.map((name) => ({ name: `${PARTY_TOOL_PREFIX}${name}` })),
      canReconnect: false,
      canToggle: false,
      canAuthenticate: false,
    };
  }

  async reconnectMcpServer(name: string): Promise<void> {
    // The app-server exposes a config reload (re-reads config.toml and refreshes
    // loaded servers) rather than a per-server reconnect — the closest action.
    await this.request("config/mcpServer/reload", {});
    this.emitEvent({ type: "status", status: "mcp", detail: `reload (${name})`, at: now() });
  }

  async authenticateMcpServer(name: string): Promise<McpAuthResult> {
    const params: Record<string, unknown> = { name };
    if (this.sessionId) {
      params.threadId = this.sessionId;
    }
    const response = await this.request("mcpServer/oauth/login", params);
    const authorizationUrl = typeof response?.authorizationUrl === "string" ? response.authorizationUrl : undefined;
    this.emitEvent({ type: "status", status: "mcp", detail: `oauth ${name}`, at: now() });
    return { authorizationUrl, note: authorizationUrl ? "브라우저에서 인증을 완료하세요." : undefined };
  }

  private toNeutralMcpServer(entry: any): McpServerInfo {
    const name = String(entry?.name || "");
    const authStatus = String(entry?.authStatus || "");
    const startup = this.mcpStartup.get(name);
    const toolsMap = entry?.tools && typeof entry.tools === "object" ? entry.tools : {};
    const tools = Object.values(toolsMap).map((tool: any) => ({ name: String(tool?.name || ""), description: typeof tool?.description === "string" ? tool.description : undefined }));
    let state = mapCodexMcpState(startup?.status, authStatus);
    if (state === "unknown" && tools.length > 0) {
      // The app-server only lists tools for connected servers.
      state = "connected";
    }
    const canAuthenticate = authStatus === "notLoggedIn" || authStatus === "oAuth" || startup?.failureReason === "reauthenticationRequired";
    return {
      name,
      state,
      transport: "unknown",
      version: typeof entry?.serverInfo?.version === "string" ? entry.serverInfo.version : undefined,
      error: startup?.error,
      tools,
      canReconnect: true,
      canToggle: false,
      canAuthenticate,
    };
  }

  /**
   * Answers a server approval/input request. The user-facing choice (once /
   * session / always / decline) rides in `updatedInput.codexDecision`; the coarse
   * `behavior` is the allow/deny fallback. Each request method maps to its own
   * protocol response shape (command/file/permissions/user-input/elicitation).
   */
  respondApproval(requestId: string, behavior?: "allow" | "deny", updatedInput?: unknown, _message?: string): boolean {
    const approval = this.pendingApprovals.get(requestId);
    if (!approval) {
      this.emitEvent({ type: "error", message: `Unknown Codex approval request '${requestId}'.`, at: now() });
      return false;
    }
    const decision = codexDecisionOf(behavior, updatedInput);
    const params = (approval.input || {}) as Record<string, any>;
    const result = approvalResult(approval.method, decision, params, updatedInput);
    this.respond(requestId, result);
    this.pendingApprovals.delete(requestId);
    this.emitEvent({ type: "approval_resolved", requestId, decision: decision === "decline" ? "deny" : "allow", answers: approvalAnswers(updatedInput), at: now() });
    return true;
  }

  /**
   * How far THIS session's start got, so a later failure can tell a failed
   * start from a failed turn: only the former closes the session card.
   */
  private spawnState: "starting" | "running" | "failed" = "starting";

  private async ensureThread(): Promise<void> {
    if (this.currentProvider()?.id === CODEX_CLAUDE_SUBSCRIPTION_PROVIDER.id) {
      await assertSubscriptionModelAvailable(this.options.model, "claude", this.subscriptionProxy());
    }
    this.ensureProcess();
    await this.initializeServer();
    if (this.sessionId) {
      await this.resumeThread();
    } else {
      await this.startThread();
    }
  }

  private ensureProcess(): void {
    if (this.process) {
      return;
    }
    this.ensureLogger();
    this.stderrTail = "";
    const requested = codexExecutable(this.options.executablePath);
    const resolved = resolveCodexExecutable(requested);
    // Define only the selected custom provider inline (never touching the
    // user's ~/.codex/config.toml). Provider changes restart this process.
    const provider = this.currentProvider();
    const providerArgs = codexProviderConfigArgs(provider);
    const partyArgs = this.partyMcpConfigArgs();
    const credentialArgs = this.currentProvider() ? [] : ["-c", 'cli_auth_credentials_store="file"'];
    const spawnArgs = [...resolved.argsPrefix, ...codexExtraArgs(this.options.executableArgs), ...credentialArgs, ...providerArgs, ...partyArgs, "app-server"];
    if (this.options.sqliteHome) {
      // Fail here with the concrete filesystem path instead of letting Codex
      // collapse it into the generic "failed to initialize state runtime".
      fs.mkdirSync(this.options.sqliteHome, { recursive: true });
    }
    const env = {
      ...process.env,
      ...(provider?.id === CODEX_OPENROUTER_PROVIDER.id && this.options.openRouterApiKey
        ? { [CODEX_OPENROUTER_PROVIDER.envKey]: this.options.openRouterApiKey }
        : {}),
      ...(provider?.id === CODEX_DEEPSEEK_PROVIDER.id && this.options.deepseekApiKey
        ? { [CODEX_DEEPSEEK_PROVIDER.envKey]: this.options.deepseekApiKey }
        : {}),
      ...(provider?.id === CODEX_CLAUDE_SUBSCRIPTION_PROVIDER.id
        ? { [CODEX_CLAUDE_SUBSCRIPTION_PROVIDER.envKey]: this.subscriptionProxy().apiKey }
        : {}),
      ...(process.env.AGENTPARTY_NATIVE_CODEX_HOME
        ? { CODEX_HOME: process.env.AGENTPARTY_NATIVE_CODEX_HOME }
        : {}),
      ...(this.options.sqliteHome
        ? { CODEX_SQLITE_HOME: this.options.sqliteHome }
        : {}),
      ...this.partyMcpEnv(),
    };
    this.process = spawn(resolved.command, spawnArgs, {
      cwd: this.options.cwd,
      env,
      windowsHide: true,
      // A bare `codex` on Windows is a `.cmd` shim; resolve to a concrete file,
      // or fall back to shell resolution. Without this, spawn fails ENOENT.
      shell: resolved.shell,
    });
    this.lineReader = readline.createInterface({ input: this.process.stdout });
    this.lineReader.on("line", (line) => this.readMessage(line));
    this.process.stderr.on("data", (chunk) => this.readStderr(String(chunk)));
    this.process.on("error", (error) => this.finishWithError(error));
    this.process.on("exit", (code, signal) => this.handleExit(code, signal));
    // The command line — node's absolute path, the party MCP `-c` wiring with
    // its automation URL and port, the party/member ids, the auth-store setting
    // — is written to this session's debug log by `ensureLogger`, and goes
    // nowhere near the conversation. The card states that the session is up.
    this.emitSessionSpawn("running");
  }

  private partyMcpConfigArgs(): string[] {
    if (!this.options.partyBridge || !this.options.partyIdentity || !this.options.automationBaseUrl) {
      return [];
    }
    const serverScript = resolvePartyMcpServerScript();
    const nodeCommand = spawnableNodeCommand();
    const runtimeEnv = partyMcpRuntimeEnv();
    return [
      "-c", `mcp_servers.${PARTY_MCP_SERVER}.command=${tomlString(nodeCommand)}`,
      "-c", `mcp_servers.${PARTY_MCP_SERVER}.args=[${tomlString(serverScript)}]`,
      "-c", `mcp_servers.${PARTY_MCP_SERVER}.enabled=true`,
      "-c", `mcp_servers.${PARTY_MCP_SERVER}.startup_timeout_sec=10`,
      "-c", `mcp_servers.${PARTY_MCP_SERVER}.tool_timeout_sec=30`,
      "-c", `mcp_servers.${PARTY_MCP_SERVER}.default_tools_approval_mode="approve"`,
      "-c", `mcp_servers.${PARTY_MCP_SERVER}.env.AGENTPARTY_AUTOMATION_BASE_URL=${tomlString(this.options.automationBaseUrl || "")}`,
      "-c", `mcp_servers.${PARTY_MCP_SERVER}.env.AGENTPARTY_MEMBER=${tomlString(this.options.partyIdentity.member)}`,
      "-c", `mcp_servers.${PARTY_MCP_SERVER}.env.AGENTPARTY_PARTY=${tomlString(this.options.partyIdentity.party)}`,
      ...Object.entries(runtimeEnv).flatMap(([name, value]) => ["-c", `mcp_servers.${PARTY_MCP_SERVER}.env.${name}=${tomlString(value)}`]),
      ...(process.env.AGENTPARTY_CODEX_MCP_OUT ? ["-c", `mcp_servers.${PARTY_MCP_SERVER}.env.AGENTPARTY_CODEX_MCP_OUT=${tomlString(process.env.AGENTPARTY_CODEX_MCP_OUT)}`] : []),
    ];
  }

  private partyMcpEnv(): NodeJS.ProcessEnv {
    if (!this.options.partyBridge || !this.options.partyIdentity || !this.options.automationBaseUrl) {
      return {};
    }
    return {
      AGENTPARTY_MEMBER: this.options.partyIdentity.member,
      AGENTPARTY_PARTY: this.options.partyIdentity.party,
      AGENTPARTY_AUTOMATION_BASE_URL: this.options.automationBaseUrl || "",
    };
  }

  private async initializeServer(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "agentparty",
        title: "AgentParty",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          "command/exec/outputDelta",
          "item/agentMessage/delta",
          "item/plan/delta",
          "item/fileChange/outputDelta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
        ],
      },
    });
    this.notify("initialized", {});
  }

  private async startThread(): Promise<void> {
    const result = await this.request("thread/start", {
      model: this.options.model,
      modelProvider: this.resolveModelProvider(),
      cwd: this.options.cwd,
      approvalPolicy: this.policy.approval,
      approvalsReviewer: this.policy.guardian ? "auto_review" : "user",
      sandbox: this.policy.sandbox,
      config: this.partyToolConfig(),
      developerInstructions: this.partyDeveloperInstructions(),
    });
    this.applyThreadResult(result);
  }

  private async resumeThread(): Promise<void> {
    const result = await this.request("thread/resume", {
      threadId: this.sessionId,
      model: this.options.model,
      modelProvider: this.resolveModelProvider(),
      cwd: this.options.cwd,
      approvalPolicy: this.policy.approval,
      approvalsReviewer: this.policy.guardian ? "auto_review" : "user",
      sandbox: this.policy.sandbox,
      config: this.partyToolConfig(),
      developerInstructions: this.partyDeveloperInstructions(),
    });
    this.applyThreadResult(result);
  }

  /**
   * Installs the member identity and party protocol once as thread-scoped
   * developer instructions. Keeping it out of `turn/start.input` prevents a
   * fresh copy of the multi-page primer from becoming user-visible history on
   * every turn. Resume supplies the same override once when the app-server
   * session is rebuilt, without adding another conversation item.
   */
  private partyDeveloperInstructions(): string | undefined {
    if (!this.options.partyIdentity) {
      return undefined;
    }
    return this.options.partyPrimer || buildPartyPrimer(this.options.partyIdentity);
  }

  private partyToolConfig(): Record<string, unknown> | undefined {
    if (!this.options.partyBridge || !this.options.partyIdentity) {
      return undefined;
    }
    return { dynamic_tools: [buildPartyDynamicToolSpec()] };
  }

  /**
   * The `modelProvider` id for the current model, or undefined for the built-in
   * openai account catalog. Throws when the model needs a custom provider but
   * its key is missing — a routed model must not silently fall back to the
   * account default (project no-silent-fallback rule).
   */
  private resolveModelProvider(): string | undefined {
    const provider = this.currentProvider();
    if (!provider) {
      return undefined;
    }
    if (provider.id === CODEX_DEEPSEEK_PROVIDER.id && !this.options.deepseekApiKey) {
      throw new Error(
        `Model '${this.options.model}' routes through DeepSeek's own API, but no DeepSeek API key is configured. Add the key in Settings before starting this Codex member.`,
      );
    }
    if (provider.id === CODEX_OPENROUTER_PROVIDER.id && !this.options.openRouterApiKey) {
      throw new Error(
        `Model '${this.options.model}' routes through OpenRouter, but no OpenRouter API key is configured. Add the key in Settings before starting this Codex member.`,
      );
    }
    return provider.id;
  }

  private subscriptionProxy() {
    return subscriptionProxyConfig({
      baseUrl: this.options.subscriptionProxyBaseUrl,
      apiKey: this.options.subscriptionProxyApiKey,
    });
  }

  private applyThreadResult(result: any): void {
    this.sessionId = String(result?.thread?.id || result?.thread?.sessionId || this.sessionId || this.options.id);
    // The request response is the authoritative root identity. `thread/started`
    // is a notification and is not guaranteed to arrive before this response
    // (and a resumed thread may not announce itself again at all). Leaving the
    // tracker dependent on that notification makes every child thread look like
    // parent activity, so the subagent dock stays empty on those valid orders.
    this.subagentTracker.setRoot(this.sessionId);
    this.status = "initialized";
    this.turnState = undefined;
    this.emitEvent({
      type: "session",
      sessionId: this.sessionId,
      model: String(result?.model || this.options.model),
      permissionMode: this.options.permissionMode,
      slashCommands: this.inventory,
      at: now(),
    });
    // Discover the real command/skill/plugin inventory (async, best-effort).
    void this.refreshInventory();
    this.startUsagePolling();
    void this.refreshUsageLimits();
  }

  /**
   * Reads the current account rate-limit snapshot once at session start. The
   * app-server also pushes `account/rateLimits/updated`; this closes the gap
   * where the UI otherwise sits on "loading" until the first provider tick.
   */
  async refreshUsageLimits(): Promise<void> {
    if (!this.process?.stdin.writable) {
      return;
    }
    try {
      const result = await this.request("account/rateLimits/read", {});
      const rateLimits = result?.rateLimits || result;
      const windows = codexRateLimitWindows(rateLimits);
      if (windows.length) {
        this.emitEvent({ type: "usage_limit", provider: "codex", windows, available: true, at: now(), sourceId: this.options.usageSourceId });
        this.lastUsageStatus = "";
      } else {
        // An EMPTY report still must reach the aggregator: without it the
        // snapshot stays undefined and the indicator shows "불러오는 중…"
        // forever (the Codex perpetual-loading bug). Prior good windows are
        // preserved by the merge; a first empty read renders "데이터 없음".
        this.emitEvent({ type: "usage_limit", provider: "codex", windows: [], at: now(), sourceId: this.options.usageSourceId });
        this.emitUsageStatus("Codex rate limit read returned no usable windows.");
      }
    } catch (error) {
      this.emitEvent({ type: "usage_limit", provider: "codex", windows: [], at: now(), sourceId: this.options.usageSourceId });
      this.emitUsageStatus(`Codex rate limit read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private emitUsageStatus(detail: string): void {
    if (detail === this.lastUsageStatus) {
      return;
    }
    this.lastUsageStatus = detail;
    this.emitEvent({ type: "diagnostic", severity: "info", category: "rate-limit", title: "사용량 정보를 읽을 수 없습니다", detail, at: now() });
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

  /**
   * Queries the app-server for skills (skills/list) and installed plugins
   * (plugin/installed) and merges them into the palette inventory alongside the
   * built-in commands, tagged by source with a disabled reason when unavailable.
   * Best-effort: a failed query is surfaced as a status, never fatal.
   */
  private async refreshInventory(): Promise<void> {
    const [skills, plugins] = await Promise.all([
      this.request("skills/list", { cwds: [this.options.cwd] }).catch((error) => this.noteDiscoveryError("skills", error)),
      this.request("plugin/installed", {}).catch((error) => this.noteDiscoveryError("plugins", error)),
    ]);
    const merged = [...CODEX_COMMANDS, ...skillCommands(skills), ...pluginCommands(plugins)];
    // Dedupe by name, keeping the first (built-ins win over same-named skills).
    const seen = new Set<string>();
    this.inventory = merged.filter((command) => (seen.has(command.name) ? false : seen.add(command.name)));
    this.emitEvent({
      type: "session",
      sessionId: this.sessionId,
      model: this.options.model,
      permissionMode: this.options.permissionMode,
      slashCommands: this.inventory,
      at: now(),
    });
  }

  private noteDiscoveryError(kind: string, error: unknown): undefined {
    this.emitEvent({
      type: "diagnostic",
      severity: "info",
      category: "config",
      title: `${kind === "skills" ? "스킬" : "플러그인"} 목록을 불러오지 못했습니다`,
      detail: error instanceof Error ? error.message : String(error),
      at: now(),
    });
    return undefined;
  }

  private async runTurn(text: string, attachments?: ImageAttachment[]): Promise<void> {
    this.activeTurn = true;
    this.turnState = "submitted";
    this.status = "requesting";
    this.lastError = undefined;
    this.lastUsage = undefined;
    this.lastUserMessageAt = now();
    this.emitEvent({ type: "status", status: "sent", detail: text, at: now() });

    try {
      await this.initializing;
      if (!this.sessionId) {
        throw new Error("Codex app-server did not provide a thread id.");
      }
      // The app-server `turn/start` input is an internally-tagged item list.
      // Images are `localImage` items pointing at a temp file (verified variant
      // in the codex binary), which codex reads and forwards to the model.
      const input: Array<Record<string, unknown>> = [{ type: "text", text, text_elements: [] }];
      for (const image of attachments || []) {
        input.push({ type: "localImage", path: this.writeTempImage(image) });
      }
      const result = await this.request("turn/start", {
        threadId: this.sessionId,
        input,
        cwd: this.options.cwd,
        approvalPolicy: this.policy.approval,
        approvalsReviewer: this.policy.guardian ? "auto_review" : "user",
        sandboxPolicy: sandboxPolicyObject(this.policy.sandbox),
        model: this.options.model,
        effort: effortFor(this.options.model, this.options.effort),
      });
      this.activeTurnId = String(result?.turn?.id || this.activeTurnId || "");
    } catch (error) {
      this.finishWithError(error);
    }
  }

  private request(method: string, params: unknown): Promise<any> {
    if (!this.process?.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running."));
    }
    const id = `agentparty-${++this.requestSeq}`;
    const message = { id, method, params };
    const promise = new Promise<any>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
    this.log("out", message);
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  }

  private notify(method: string, params: unknown): void {
    if (!this.process?.stdin.writable) {
      return;
    }
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  /**
   * Answers a server→client request, echoing its id back with the ORIGINAL type.
   *
   * The app-server's `RequestId` is `string | number` and it really does send
   * numbers (measured: every approval in codex-cli 0.145.0 arrives as `id: 0`).
   * Everything above this line keys approvals by a string, so the raw id is
   * looked up here instead of being reconstructed: replying `"0"` to a request
   * whose id was `0` leaves the server waiting forever — the command never runs
   * and the turn never ends. Recorded proof of both outcomes is in
   * scripts/fixtures/approvals/codex-command-once{,-stringid-hang}.jsonl.
   */
  private respond(id: string, result: unknown): void {
    if (!this.process?.stdin.writable) {
      return;
    }
    const wireId = this.wireIds.get(id);
    this.wireIds.delete(id);
    const message = { id: wireId ?? id, result };
    this.log("out", message);
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private readMessage(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      // Non-JSON stdout is JSON-RPC framing noise, not conversation content:
      // always capture it in the debug log, but only show it in the transcript
      // when debug mode is on (it used to flood the chat unconditionally).
      this.log("stdout", line);
      if (this.debugMode) {
        this.emitEvent({ type: "status", status: "stdout", detail: line, at: now() });
      }
      return;
    }
    this.log("in", message);
    // `hasId`, not a truthiness check: `RequestId` is `string | number` and the
    // app-server numbers its requests from ZERO. `message.id && …` therefore
    // dropped every first server request of a session — which is the approval
    // prompt. Nothing was emitted and nothing was answered, so the card never
    // appeared and the turn waited forever on a reply that could not come.
    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && this.pendingRequests.has(String(message.id))) {
      this.completeRequest(String(message.id), message);
      return;
    }
    if (hasId && message.method) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method) {
      this.normalizeNotification(message);
    }
  }

  private completeRequest(id: string, message: any): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(id);
    if (message.error) {
      pending.reject(new Error(String(message.error.message || JSON.stringify(message.error))));
      return;
    }
    pending.resolve(message.result);
  }

  private handleServerRequest(message: any): void {
    const requestId = String(message.id);
    const method = String(message.method);
    const params = message.params || {};
    this.wireIds.set(requestId, message.id);
    if (method === "item/tool/call") {
      void this.handleDynamicToolCall(requestId, params);
      return;
    }
    this.pendingApprovals.set(requestId, { method, input: params });
    this.emitEvent({
      type: "approval_request",
      requestId,
      ...codexApprovalFields(method, params, this.fileChangesByItem.get(String(params?.itemId ?? ""))),
      at: now(),
    });
  }

  private async handleDynamicToolCall(requestId: string, params: any): Promise<void> {
    const namespace = typeof params?.namespace === "string" ? params.namespace : undefined;
    const rawTool = String(params?.tool || "");
    const toolName = partyToolNameOf(rawTool);
    const isPartyTool = namespace === PARTY_MCP_SERVER || Boolean(toolName);
    if (!isPartyTool) {
      const result = { ok: false, error: `Unknown dynamic tool '${namespace ? `${namespace}/` : ""}${rawTool}'.` };
      this.respondDynamicTool(requestId, false, result);
      this.emitEvent({ type: "error", message: result.error, at: now() });
      return;
    }
    const bridge = this.options.partyBridge;
    const identity = this.options.partyIdentity;
    if (!bridge || !identity) {
      const result = { ok: false, error: "AgentParty tool call received, but this Codex session has no party binding." };
      this.respondDynamicTool(requestId, false, result);
      this.emitEvent({ type: "error", message: result.error, at: now() });
      return;
    }
    const normalized = toolName || partyToolNameOf(rawTool.replace(`${PARTY_MCP_SERVER}/`, "")) || rawTool;
    this.emitEvent({
      type: "tool_call",
      id: String(params?.callId || requestId),
      name: `${PARTY_TOOL_PREFIX}${normalized}`,
      input: params?.arguments,
      status: "started",
      source: "mcp",
      at: now(),
    });
    try {
      const result = await invokePartyTool(bridge, identity, String(normalized), params?.arguments);
      this.respondDynamicTool(requestId, result.ok, result.data ?? { ok: result.ok, error: result.error });
      this.emitEvent({
        type: "tool_call",
        id: String(params?.callId || requestId),
        name: `${PARTY_TOOL_PREFIX}${normalized}`,
        input: params?.arguments,
        status: result.ok ? "completed" : "failed",
        result: result.data ?? result.error,
        source: "mcp",
        at: now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = { ok: false, error: message };
      this.respondDynamicTool(requestId, false, result);
      this.emitEvent({
        type: "tool_call",
        id: String(params?.callId || requestId),
        name: `${PARTY_TOOL_PREFIX}${normalized}`,
        input: params?.arguments,
        status: "failed",
        result,
        source: "mcp",
        at: now(),
      });
    }
  }

  private respondDynamicTool(requestId: string, success: boolean, payload: unknown): void {
    this.respond(requestId, {
      success,
      contentItems: [{ type: "inputText", text: JSON.stringify(payload) }],
    });
  }

  private normalizeNotification(message: any): void {
    const method = String(message.method);
    const params = message.params || {};
    // Every notification is tagged with the thread it belongs to. Activity on a
    // collab child thread is attributed to that subagent (dock/detail) instead of
    // the parent transcript — this is what keeps subagent output separated.
    const threadId = String(params.threadId || "");
    const isSub = this.subagentTracker.isSubagentThread(threadId);
    if (method === "thread/started") {
      const id = String(params.thread?.id || params.thread?.sessionId || this.sessionId);
      // The root thread (no parent) owns the session; child threads are subagents.
      if (!params.thread?.parentThreadId) {
        this.sessionId = id;
        this.subagentTracker.setRoot(id);
        this.emitEvent({ type: "session", sessionId: this.sessionId, model: this.options.model, permissionMode: this.options.permissionMode, slashCommands: this.inventory, at: now() });
      }
      return;
    }
    if (method === "thread/status/changed") {
      if (isSub) {
        this.emitSubagents(this.subagentTracker.threadStatus(threadId, params.status?.type));
        return;
      }
      const status = String(params.status?.type || "unknown");
      this.status = status === "active" ? "responding" : status;
      this.emitEvent({ type: "status", status: this.status, at: now() });
      return;
    }
    if (method === "turn/started") {
      // A child thread's turn is the subagent working, not the parent turn.
      if (isSub) {
        this.emitSubagents(this.subagentTracker.threadStatus(threadId, "active"));
        return;
      }
      this.activeTurnId = String(params.turn?.id || this.activeTurnId || "");
      this.status = "responding";
      this.turnState = "responding";
      this.emitEvent({ type: "status", status: "responding", at: now() });
      return;
    }
    if (method === "turn/completed") {
      // A child turn completing marks that subagent done; only the ROOT turn ends
      // the parent turn (and closes any still-open subagents as a safety net).
      if (isSub) {
        this.emitSubagents(this.subagentTracker.threadStatus(threadId, "idle"));
        return;
      }
      this.activeTurnId = undefined;
      this.emitSubagents(this.subagentTracker.turnComplete());
      void this.emitTurnComplete(params.turn);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      if (isSub) {
        return;
      }
      // Cost billing wants per-turn usage (falls back to cumulative `total`);
      // the context meter instead wants CURRENT occupancy — the last turn's full
      // prompt+generation, which is `last` only. Never fall back to `total` for
      // the meter: cumulative session tokens overflow the window and would
      // misreport occupancy far above 100%.
      this.lastUsage = normalizeCodexUsage(params.tokenUsage?.last || params.tokenUsage?.total);
      const last = normalizeCodexUsage(params.tokenUsage?.last);
      const occupancy = last?.totalTokens ?? ((last?.inputTokens ?? 0) + (last?.outputTokens ?? 0) || undefined);
      if (occupancy && occupancy > 0) {
        this.contextTokens = occupancy;
      }
      // Codex may report the model's window numerically; prefer it when present.
      const window = numberValue(params.tokenUsage?.contextWindow) ?? numberValue(params.contextWindow);
      if (window && window > 0) {
        this.contextWindow = window;
      }
      this.emit("snapshot", this.getSnapshot());
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      if (isSub) {
        this.emitSubagents(this.subagentTracker.item(threadId, params.item, method === "item/started" ? "started" : "completed"));
        return;
      }
      this.normalizeItem(params.item, method === "item/started" ? "started" : "completed");
      return;
    }
    if (method === "item/agentMessage/delta") {
      // A child's streaming text belongs to the subagent, not the parent chat.
      if (isSub) {
        return;
      }
      const text = String(params.delta || params.text || "");
      if (text) {
        this.lastAssistantMessageAt = now();
        this.emitEvent({ type: "assistant_text_delta", text, at: now() });
      }
      return;
    }
    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      if (isSub) {
        return;
      }
      const text = String(params.delta || params.text || "");
      if (text) {
        this.emitEvent({ type: "reasoning_delta", text, at: now() });
      }
      return;
    }
    if (method === "turn/plan/updated") {
      this.emitEvent({ type: "plan", steps: planStepsFrom(params.plan), explanation: params.explanation || undefined, at: now() });
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      // A child's command output belongs to the subagent, not the parent shell card.
      if (isSub) {
        return;
      }
      const delta = String(params.delta || "");
      if (delta) {
        this.emitEvent({ type: "tool_call", id: String(params.itemId || ""), name: "shell", status: "started", source: "shell", outputDelta: delta, at: now() });
      }
      return;
    }
    if (method === "error") {
      const message = String(params.error?.message || params.error || "Codex app-server error.");
      if (params.willRetry === true) {
        const additionalDetails = typeof params.error?.additionalDetails === "string"
          ? params.error.additionalDetails
          : undefined;
        this.emitEvent({
          type: "diagnostic",
          severity: "warning",
          category: "provider",
          title: "Model provider reconnecting",
          detail: additionalDetails ? `${message} ${additionalDetails}` : message,
          recovery: "The active turn is still running and will continue automatically if the provider reconnects.",
          at: now(),
        });
        return;
      }
      this.finishWithError(new Error(message));
      return;
    }
    if (method === "skills/changed" || method === "app/list/updated") {
      // The skill/plugin inventory changed — re-discover so the palette updates.
      void this.refreshInventory();
      return;
    }
    // Reroute / rate-limit / warnings must never be silently dropped (project
    // "no silent fallback" rule): classify with a severity/category and surface.
    if (
      method === "model/rerouted" ||
      method === "account/rateLimits/updated" ||
      method === "guardianWarning" ||
      method === "warning" ||
      method === "configWarning" ||
      method === "deprecationNotice" ||
      method === "windows/worldWritableWarning" ||
      method === "mcpServer/startupStatus/updated"
    ) {
      if (method === "mcpServer/startupStatus/updated") {
        // Record the live connect state so listMcpServers() reflects it (the
        // static mcpServerStatus/list carries auth+tools but not startup state).
        const serverName = String(params?.name || params?.server || "");
        if (serverName) {
          this.mcpStartup.set(serverName, {
            status: String(params?.status || params?.state || ""),
            error: typeof params?.error === "string" ? params.error : undefined,
            failureReason: typeof params?.failureReason === "string" ? params.failureReason : undefined,
          });
        }
      }
      const diagnostic = classifyDiagnostic(method, params, {
        modelProvider: this.currentProvider()?.id,
      });
      if (diagnostic) {
        this.emitEvent({ type: "diagnostic", ...diagnostic, at: now() });
      }
      // The diagnostic above surfaces ONLY at (near-)exhaustion (no noise); the
      // titlebar indicator needs every tick, so emit a structured usage-limit
      // event on each rate-limit update regardless of level.
      if (method === "account/rateLimits/updated") {
        const windows = codexRateLimitWindows(params?.rateLimits);
        if (windows.length) {
          this.emitEvent({ type: "usage_limit", provider: "codex", windows, available: true, at: now(), sourceId: this.options.usageSourceId });
        }
      }
      return;
    }
  }

  private normalizeItem(item: any, status: "started" | "completed"): void {
    if (!item || typeof item !== "object") {
      return;
    }
    const id = String(item.id || `${item.type || "item"}-${Date.now()}`);
    // codex reports the same message/reasoning item at multiple lifecycle points
    // (item/started, updates, item/completed) all sharing one item id. Buffered
    // providers (e.g. OpenRouter via the responses wire) carry the FULL text on
    // item/started already, then repeat it on item/completed — emitting on both
    // would render (and cost-display) the text twice. Deltas are opted out, so
    // nothing streams before completion: emit exactly once, on item/completed.
    // (The model generated once — same item id, single token bill — so this is a
    // display de-dup, not a content change.)
    if (item.type === "agentMessage") {
      if (status === "completed" && typeof item.text === "string" && item.text) {
        this.lastAssistantMessageAt = now();
        this.emitEvent({ type: "assistant_text_delta", text: item.text, at: now() });
      }
      return;
    }
    if (item.type === "reasoning") {
      if (status === "completed") {
        const text = [...stringArray(item.summary), ...stringArray(item.content)].join("\n");
        if (text) {
          this.emitEvent({ type: "reasoning_delta", text, at: now() });
        }
      }
      return;
    }
    if (item.type === "plan") {
      // A plan item is free text; structured steps arrive via turn/plan/updated
      // and update the same card. Show the text until steps exist.
      if (typeof item.text === "string" && item.text.trim()) {
        this.emitEvent({ type: "plan", steps: [], explanation: item.text, at: now() });
      }
      return;
    }
    if (item.type === "commandExecution") {
      const failed = item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
      this.emitEvent({
        type: "tool_call",
        id,
        name: "shell",
        input: item.command,
        status: status === "completed" && failed ? "failed" : status,
        result: item.aggregatedOutput ?? undefined,
        source: toolSourceLabel(item),
        cwd: typeof item.cwd === "string" ? item.cwd : undefined,
        exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
        durationMs: typeof item.durationMs === "number" ? item.durationMs : undefined,
        at: now(),
      });
      return;
    }
    if (item.type === "fileChange") {
      const changes = fileEditsFrom(item.changes);
      // Remembered so the approval card can show WHAT is being changed. The
      // approval request itself carries no diff (measured: reason and grantRoot
      // both null, nothing else), but it names an `itemId`, and that is this
      // item — which does carry the changes. Without the join the card is a
      // title and three buttons, asking the user to approve an edit they cannot
      // see. See scripts/fixtures/approvals/codex-file-change.jsonl.
      if (id) {
        this.fileChangesByItem.set(id, changes);
      }
      this.emitEvent({ type: "file_change", changes, status: typeof item.status === "string" ? item.status : undefined, at: now() });
      return;
    }
    if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
      const failed = Boolean(item.error) || item.status === "failed" || item.success === false;
      this.emitEvent({
        type: "tool_call",
        id,
        name: item.tool || item.server || "tool",
        input: item.arguments,
        status: status === "completed" && failed ? "failed" : status,
        result: item.error || item.result || item.contentItems,
        source: toolSourceLabel(item),
        durationMs: typeof item.durationMs === "number" ? item.durationMs : undefined,
        at: now(),
      });
      return;
    }
    if (item.type === "webSearch") {
      this.emitEvent({ type: "tool_call", id, name: "web_search", input: { query: codexWebSearchQuery(item) }, status, source: "web", at: now() });
      return;
    }
    if (item.type === "imageGeneration") {
      this.emitEvent({ type: "tool_call", id, name: "image_generation", input: { revisedPrompt: item.revisedPrompt }, status, result: item.savedPath || item.result, source: "image", at: now() });
      return;
    }
    if (item.type === "imageView") {
      // Carry the PICTURE, not just the path. A tool block already renders any
      // image content block in its `result` (that is how screenshots show up),
      // and the persist path externalises those bytes into the image store — so
      // attaching the file here is the whole fix, with no new block kind.
      //
      // Read only on completion: the started event fires before the file is
      // necessarily written, and reading twice would double the work for a
      // picture that cannot have changed. Done HERE because this code runs in
      // the member's process — a WSL member's path exists only inside the distro.
      this.emitEvent({
        type: "tool_call",
        id,
        name: "image_view",
        input: { path: item.path },
        status,
        result: status === "completed" ? imageContentResult(item.path) : undefined,
        source: "image",
        at: now(),
      });
      return;
    }
    if (item.type === "subAgentActivity") {
      // Optional lifecycle marker (absent in observed runs); the tracker keys on
      // the child threadId already, so this only nudges phase when it appears.
      const agentId = String(item.agentThreadId || "");
      if (agentId) {
        this.emitSubagents(this.subagentTracker.threadStatus(agentId, item.kind === "interrupted" ? "idle" : "active"));
      }
      return;
    }
    if (item.type === "collabAgentToolCall") {
      // A spawn names the child threads + carries the delegated prompt; the child
      // threads' own item streams (routed by threadId) supply the live activity.
      this.emitSubagents(this.subagentTracker.collab(item));
    }
  }

  /** Emits the `subagent` events the tracker produced from a raw signal. */
  private emitSubagents(emits: SubagentEmit[]): void {
    for (const e of emits) {
      this.emitEvent({ type: "subagent", agentId: e.agentId, lifecycle: e.lifecycle, activity: e.activity, block: e.block, at: now() });
    }
  }

  private readStderr(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) {
        continue;
      }
      this.log("stderr", text);
      this.stderrTail = `${this.stderrTail}${this.stderrTail ? "\n" : ""}${text}`.slice(-4000);
      // The app-server is very chatty on stderr (rmcp transport logs, tool-router
      // lines, even echoed command output). Dumping every line floods the parent
      // transcript, so only surface it in debug; genuine failures arrive via turn
      // errors / the `error` notification, not raw stderr.
      if (this.debugMode) {
        this.emitEvent({ type: "status", status: "stderr", detail: text, at: now() });
      }
    }
  }

  private async emitTurnComplete(turn: any): Promise<void> {
    // The terminal status is COMPUTED here but not published until the
    // `turn_complete` event below. Flipping `this.status` to idle before the
    // cost await let any snapshot in that window (tokenUsage/updated arrives
    // right at turn end) show "idle" while the app-side turn lifecycle still
    // read active — which consumed the party queue's busy→idle drain edge and
    // stranded an interrupt-queued message without delivery.
    const failed = turn?.status === "failed";
    if (turn?.error) {
      this.lastError = String(turn.error.message || JSON.stringify(turn.error));
    }
    if (!failed) {
      this.turnCount += 1;
    }
    // Account-catalog turns are subscription-billed; OpenRouter-routed turns
    // (Phase 2) bill per token against the OpenRouter key, so cost is estimated
    // from the model's catalog pricing + reported token usage.
    const provider = this.currentProvider();
    const cost = await this.costResolver.resolve(
      provider?.id === CODEX_OPENROUTER_PROVIDER.id
        ? {
            providerId: "openrouter",
            model: this.options.model,
            runtimeModel: this.options.model,
            pricing: pricingForModel(this.options.model),
            usage: this.lastUsage,
          }
        : provider?.id === CODEX_CLAUDE_SUBSCRIPTION_PROVIDER.id
          ? {
              providerId: "anthropic",
              model: this.options.model,
              runtimeModel: this.options.model,
              pricing: { billing: "subscription", directPrice: "Claude subscription" },
              usage: this.lastUsage,
            }
          : {
            providerId: "openai",
            model: this.options.model,
            runtimeModel: this.options.model,
            pricing: { billing: "subscription", directPrice: "Codex subscription" },
            usage: this.lastUsage,
            },
    );
    this.status = failed ? "error" : "idle";
    this.turnState = failed ? "error" : "complete";
    this.activeTurn = false;
    this.emitEvent({ type: "turn_complete", result: failed ? "error" : "ok", cost, usage: codexTokenBreakdown(this.lastUsage, this.contextTokens), at: now() });
    if (this.pendingAuthenticationGeneration) {
      this.pendingAuthenticationGeneration = undefined;
      void this.reloadAuthentication();
      return;
    }
    this.drainQueuedTurn();
  }

  /**
   * Reports this session's start as STRUCTURED facts (src/shared/sessionSpawn.ts).
   *
   * Only harness, model, host and a shortened cwd travel. The spawn command and
   * every `-c` argument stay in the debug log; a failure is classified into a
   * fixed sentence first, so a spawn error that quotes the command line cannot
   * carry it onto the card.
   */
  private emitSessionSpawn(state: "starting" | "running" | "failed", error?: unknown): void {
    this.spawnState = state;
    const failure = state === "failed" ? spawnFailureSummary(error) : undefined;
    this.emitEvent({
      type: "session_spawn",
      state,
      harness: "codex",
      model: this.options.model,
      host: currentSpawnHost(),
      cwd: shortCwd(this.options.cwd),
      reason: failure?.reason,
      retryable: failure?.retryable,
      at: now(),
    });
  }

  private finishWithError(error: unknown): void {
    // A spawn that cannot find `codex` is a setup problem, not a session
    // failure: reported as an environment blocker so the transcript offers the
    // install once instead of repeating ENOENT on every turn.
    const blocked = isSpawnFailure(error)
      ? new EnvironmentBlockedError(
          "Codex CLI를 실행하지 못했습니다.",
          "harness.codex",
          error instanceof Error ? error.message : String(error),
        )
      : error;
    const message = blocked instanceof Error ? blocked.message : String(blocked);
    this.lastError = message;
    this.status = "error";
    this.turnState = "error";
    this.activeTurn = false;
    // A failure before the app-server ever came up is a failed START — close
    // the open card on it. A failure afterwards belongs to the turn, not to the
    // start, and leaves the card saying (correctly) that the session ran.
    if (this.spawnState === "starting") {
      this.emitSessionSpawn("failed", error);
    }
    this.emitEvent({ type: "error", ...errorEventPayload(blocked), at: now() });
    this.drainQueuedTurn();
  }

  private drainQueuedTurn(): void {
    this.activeTurn = false;
    const next = this.queuedTurns.shift();
    if (next) {
      void this.runTurn(next.text, next.attachments);
      return;
    }
    this.emit("snapshot", this.getSnapshot());
  }

  private async reloadAuthentication(): Promise<void> {
    if (this.disposed || !this.started) {
      return;
    }
    this.shutdownProcess();
    this.status = "starting";
    this.turnState = "auth-reconnect";
    this.initializing = this.ensureThread();
    try {
      await this.initializing;
      this.emitEvent({ type: "status", status: "auth-reconnected", detail: "Codex authentication reconnected", at: now() });
      this.drainQueuedTurn();
    } catch (error) {
      this.finishWithError(error);
    }
  }

  /**
   * Writes an image attachment to a per-session temp file and returns its path
   * for a `localImage` input item. The temp dir is removed on {@link dispose}.
   */
  private writeTempImage(image: ImageAttachment): string {
    if (!this.imageTempDir) {
      this.imageTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-codex-img-"));
    }
    const ext = extensionForMediaType(image.mediaType);
    const file = path.join(this.imageTempDir, `img-${++this.requestSeq}${ext}`);
    fs.writeFileSync(file, Buffer.from(image.dataBase64, "base64"));
    return file;
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.stopUsagePolling();
    this.process = undefined;
    this.lineReader?.close();
    this.lineReader = undefined;
    const message = this.codexExitMessage(code, signal);
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error(message));
    }
    this.pendingRequests.clear();
    if (!this.disposed && this.status !== "idle" && this.status !== "initialized") {
      this.finishWithError(new Error(message));
    }
  }

  private codexExitMessage(code: number | null, signal: NodeJS.Signals | null): string {
    const base = `Codex app-server exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`;
    return this.stderrTail ? `${base}\n${this.stderrTail}` : base;
  }

  private shutdownProcess(): void {
    this.stopUsagePolling();
    this.lineReader?.close();
    this.lineReader = undefined;
    const child = this.process;
    this.process = undefined;
    child?.removeAllListeners("error");
    child?.removeAllListeners("exit");
    if (child?.pid) terminateProcessTree(child.pid);
    const interrupted = new Error("Codex app-server stopped for session reinitialization.");
    for (const pending of this.pendingRequests.values()) {
      pending.reject(interrupted);
    }
    this.pendingRequests.clear();
    this.pendingApprovals.clear();
    this.wireIds.clear();
  }

  private emitEvent(event: ClaudeNormalizedEvent): void {
    this.lastEventAt = event.at;
    this.emit("event", event);
    this.emit("snapshot", this.getSnapshot());
  }
}

/** Maps a sandbox mode to the app-server `sandboxPolicy` object. */
/** A queued Codex user turn (text plus any image attachments). */
interface QueuedCodexTurn {
  text: string;
  attachments?: ImageAttachment[];
}

/** File extension for an image temp file, from its MIME type. */
function extensionForMediaType(mediaType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
  return map[mediaType.toLowerCase()] || ".png";
}

function sandboxPolicyObject(mode: SandboxMode): unknown {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "workspace-write") {
    return { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
  return { type: "readOnly", networkAccess: false };
}

function effortFor(model: string, effort: ClaudeEffort): string | null {
  const catalogModel = resolveCatalogModel(model);
  if (catalogModel && !catalogModel.reasoning?.effort) {
    return null;
  }
  return effort;
}

/**
 * Codex reports input/output token counts and a numeric context occupancy, but
 * no cache-read/write split — those fields stay undefined (not zero). Returns
 * undefined when nothing was reported.
 */
function codexTokenBreakdown(usage: TurnUsage | undefined, context: number | undefined): TurnTokenBreakdown | undefined {
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  if (input == null && output == null && context == null) {
    return undefined;
  }
  return { input, output, context };
}

function normalizeCodexUsage(value: unknown): TurnUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  return {
    inputTokens: numberValue(usage.inputTokens),
    outputTokens: numberValue(usage.outputTokens),
    totalTokens: numberValue(usage.totalTokens),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Maps a Codex `RateLimitSnapshot` to {@link UsageWindow}s. Codex reports two
 * rolling windows — `primary` and `secondary`. When the snapshot carries an
 * explicit window duration (`windowMinutes`/`windowDurationMins`) it decides
 * 5-hour vs weekly — a primary window that resets in days IS the weekly meter,
 * and labeling it "5시간 한도" misreports the account state. Without a duration
 * the historical primary→5-hour / secondary→weekly mapping applies. `resetsAt`
 * is epoch seconds. Windows without a numeric `usedPercent` are skipped (never
 * faked).
 */
function codexRateLimitWindows(snapshot: any): UsageWindow[] {
  if (!snapshot || typeof snapshot !== "object") {
    return [];
  }
  const pairs: Array<[UsageWindowKind, any]> = [
    ["five_hour", snapshot.primary],
    ["weekly", snapshot.secondary],
  ];
  const byKind = new Map<UsageWindowKind, UsageWindow>();
  for (const [fallbackKind, w] of pairs) {
    if (!w || typeof w.usedPercent !== "number" || !isFinite(w.usedPercent)) {
      continue;
    }
    const minutes = numberValue(w.windowMinutes) ?? numberValue(w.windowDurationMins) ?? numberValue(w.window_minutes);
    // ≥24h of window is the weekly meter; anything shorter is the 5-hour one.
    const kind: UsageWindowKind = minutes != null ? (minutes >= 24 * 60 ? "weekly" : "five_hour") : fallbackKind;
    const window: UsageWindow = { kind, utilization: Math.max(0, Math.min(100, w.usedPercent)), resetsAt: toEpochMs(w.resetsAt) };
    const existing = byKind.get(kind);
    // Two windows classifying to the same kind: keep the more constrained one.
    if (!existing || window.utilization > existing.utilization) {
      byKind.set(kind, window);
    }
  }
  return [...byKind.values()];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}


/**
 * The node executable codex should spawn for the party MCP server. On Windows,
 * codex-cli fails to launch a `command` whose path contains spaces — the default
 * node lives at "C:\\Program Files\\nodejs\\node.exe" — surfacing "MCP startup
 * failed: ... (os error 2)" and leaving the member with zero party tools. Convert
 * such a path to its space-free 8.3 short form; if 8.3 names are unavailable, fall
 * back to bare "node" (PATH-resolved). Off Windows the resolved path is used
 * verbatim (the WSL/Linux spawn is verified and must stay unchanged).
 */
export function spawnableNodeCommand(): string {
  return spawnablePartyMcpCommand();
}

export function resolvePartyMcpServerScript(): string {
  const scriptName = "agentparty-codex-mcp-server.mjs";
  const override = process.env.AGENTPARTY_CODEX_MCP_SERVER;
  if (override) {
    return override;
  }
  // This adapter is also bundled into the WSL engine as ESM, where the
  // CommonJS global __dirname does not exist. WSL deployment supplies an
  // explicit override; this fallback remains for local dev/CommonJS builds.
  const moduleDir = typeof __dirname === "string" ? __dirname : process.cwd();
  const devPath = path.resolve(moduleDir, "../../scripts", scriptName);
  if (fs.existsSync(devPath)) {
    return devPath;
  }
  const packagedPath = process.resourcesPath ? path.join(process.resourcesPath, "bin", scriptName) : "";
  if (packagedPath && fs.existsSync(packagedPath)) {
    return packagedPath;
  }
  return devPath;
}

function tomlString(value: string): string {
  if (!value.includes("'") && !/[\r\n]/.test(value)) {
    return `'${value}'`;
  }
  return JSON.stringify(value);
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Live startup state (starting/ready/failed/cancelled) + static auth status →
 * neutral MCP state. Startup wins when known; otherwise a not-logged-in server
 * reads as needs-auth. `unknown` is upgraded to `connected` by the caller when
 * the server lists tools (the app-server only lists tools once connected).
 */
function mapCodexMcpState(startup: string | undefined, authStatus: string): McpServerState {
  switch (startup) {
    case "ready":
      return "connected";
    case "starting":
      return "connecting";
    case "failed":
      return "failed";
    case "cancelled":
      return "disabled";
  }
  return authStatus === "notLoggedIn" ? "needs-auth" : "unknown";
}
