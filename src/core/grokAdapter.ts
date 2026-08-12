/**
 * Grok Build harness adapter — runs the official `grok` CLI as a member.
 *
 * The turn surface maps cleanly onto ACP, but three things this harness cannot
 * do are surfaced as diagnostics at session start instead of being quietly
 * absent. All three were measured against grok 1.0.0 (3cd0d0cbce) on
 * 2026-08-10 and are xAI-side, so the app cannot fix them:
 *
 *  - Its native execution modes are only normal/plan. ACP permission requests
 *    are therefore resolved here according to the app's permission setting.
 *  - Reasoning effort cannot be set. `--reasoning-effort` is ignored (the
 *    session keeps reporting `high`), `session/set_config_option` answers
 *    -32601 for every configId, and `/effort` is TUI-only.
 *  - It loads the user's Claude Code hooks and permission rules from ~/.claude
 *    regardless of every documented opt-out (env vars, `[compat.claude]`, an
 *    isolated GROK_HOME, even a redirected USERPROFILE).
 */
import { EventEmitter } from "node:events";
import { ClaudeNormalizedEvent, ClaudeSessionSnapshot } from "./events";
import {
  GrokAcpSession,
  type GrokAcpMcpServer,
  type GrokAcpPermissionOption,
  type GrokAcpPermissionOutcome,
  type GrokAcpPermissionRequest,
  type GrokAcpToolCall,
} from "./grokAcp";
import { resolveGrokCli } from "./grokAgentCli";
import { grokUsageWindow, type GrokBillingResult } from "./grokUsage";

export interface GrokAdapterOptions {
  sessionId: string;
  cwd: string;
  /** Settings override for the `grok` executable; resolved when absent. */
  executablePath?: string;
  /** Persisted Grok ACP thread id supplied by party restore. */
  resumeSessionId?: string;
  model?: string;
  permissionMode?: string;
  /** Party tool relay and any other MCP servers this member should see. */
  mcpServers?: GrokAcpMcpServer[];
  /** Test seam for lifecycle QA; production always launches the real Grok ACP session. */
  sessionFactory?: () => GrokSession;
  /** Stamped on usage_limit events for the SessionManager's fan-in filter. */
  usageSourceId?: string;
}

type GrokSession = Pick<GrokAcpSession,
  "start" | "availableModels" | "model" | "acpSessionId" | "setModel" | "setMode" | "prompt" | "cancel" | "dispose"
> & { billingUsage?: () => Promise<GrokBillingResult> };

const now = (): string => new Date().toISOString();

export class GrokAdapter extends EventEmitter {
  private session: GrokSession | undefined;
  private snapshot: ClaudeSessionSnapshot;
  private starting: Promise<void> | undefined;
  private queued: string[] = [];
  private turnActive = false;
  private disposed = false;
  /** True from the user's Stop request until Grok closes (or force-releases) that turn. */
  private interruptRequested = false;
  /** ACP updates are sparse; keep the call's initial machine name instead of later human-readable titles. */
  private readonly toolNames = new Map<string, string>();
  private readonly pendingApprovals = new Map<string, {
    request: GrokAcpPermissionRequest;
    resolve: (outcome: GrokAcpPermissionOutcome) => void;
  }>();
  private usageRefreshTimer?: NodeJS.Timeout;
  private lastUsageStatus = "";

  constructor(private readonly options: GrokAdapterOptions) {
    super();
    this.snapshot = {
      id: options.sessionId,
      harnessAlive: false,
      cwd: options.cwd,
      model: options.model || "grok-4.5",
      permissionMode: options.permissionMode || "default",
      status: "starting",
      turnState: "idle",
      startedAt: now(),
      debugMode: false,
      turnCount: 0,
      queuedTurnCount: 0,
      pendingApprovalCount: 0,
      backgroundTaskCount: 0,
    } as ClaudeSessionSnapshot;
  }

  start(): void {
    if (this.starting) {
      return;
    }
    this.starting = this.launch().catch((error) => {
      this.emitEvent({ type: "error", message: error instanceof Error ? error.message : String(error), at: now() });
      this.patch({ status: "error", harnessAlive: false });
    });
  }

  private async launch(): Promise<void> {
    this.emitEvent({ type: "status", status: "spawning", at: now() });
    const cli = this.options.sessionFactory ? undefined : await resolveGrokCli(this.options.executablePath);
    const session = this.options.sessionFactory?.() ?? new GrokAcpSession({
      command: cli!.command,
      cwd: this.options.cwd,
      resumeSessionId: this.options.resumeSessionId,
      mcpServers: this.options.mcpServers,
      // Turns off the vendor scanners that DO respond to configuration, so a
      // member does not silently inherit the user's Claude/Cursor instructions.
      // Hooks and permission rules ignore every one of these — see below.
      env: {
        GROK_CLAUDE_AGENTS_ENABLED: "0",
        GROK_CLAUDE_RULES_ENABLED: "0",
        GROK_CLAUDE_SKILLS_ENABLED: "0",
        GROK_CURSOR_AGENTS_ENABLED: "0",
        GROK_CURSOR_RULES_ENABLED: "0",
        GROK_CURSOR_SKILLS_ENABLED: "0",
      },
    });
    await session.start();
    this.session = session;

    const model = this.options.model && session.availableModels.some((m) => m.modelId === this.options.model)
      ? this.options.model
      : session.model;
    if (model !== session.model) {
      await session.setModel(model);
    }
    await this.applyPermissionMode(this.options.permissionMode || "default");

    this.patch({
      harnessAlive: true,
      status: "idle",
      sessionId: session.acpSessionId,
      model,
      contextTokens: session.availableModels.find((m) => m.modelId === model)?.contextTokens,
    });
    this.emitEvent({
      type: "session",
      sessionId: session.acpSessionId,
      model,
      permissionMode: this.snapshot.permissionMode,
      at: now(),
    });
    this.warnAboutHarnessLimits(cli?.version || "test");
    void this.refreshUsageLimits();
    this.startUsagePolling();
    this.drain();
  }

  /** Vendor-side boundaries that the ACP permission bridge cannot change. */
  private warnAboutHarnessLimits(version: string): void {
    this.emitEvent({
      type: "diagnostic",
      severity: "warning",
      category: "harness",
      title: "Grok Build permission scope differs",
      detail:
        `AgentParty handles Grok Build ${version} ACP permission requests using this member's permission setting. ` +
        "Grok still loads Claude Code hooks and permission rules from ~/.claude, which xAI provides no way to disable.",
      recovery: "Use default mode when tool calls should wait for explicit approval.",
      at: now(),
    });
  }

  /**
   * Reads the authenticated account credit period exposed by the official
   * Grok Build CLI's `_x.ai/billing` ACP extension. This is the same source
   * displayed by `/usage`; no subscription credential leaves the CLI process.
   * Per-turn spend remains separate and lands in the Token Usage ledger.
   * still recorded — it lands in the Token Usage ledger.
   */
  async refreshUsageLimits(): Promise<void> {
    if (this.disposed || !this.session) return;
    if (!this.session.billingUsage) {
      this.emitUsageUnavailable("This Grok session does not expose account billing usage.");
      return;
    }
    try {
      const payload = await this.session.billingUsage();
      if (this.disposed) return;
      const window = grokUsageWindow(payload);
      if (!window) {
        this.emitUsageUnavailable("Grok billing returned no usable subscription-credit period.");
        return;
      }
      this.emitEvent({
        type: "usage_limit",
        provider: "grok",
        windows: [window],
        available: true,
        sourceId: this.options.usageSourceId,
        at: now(),
      });
      this.lastUsageStatus = "";
    } catch (error) {
      if (!this.disposed) {
        this.emitUsageUnavailable(`Grok usage read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private emitUsageUnavailable(detail: string): void {
    this.emitEvent({
      type: "usage_limit",
      provider: "grok",
      windows: [],
      sourceId: this.options.usageSourceId,
      at: now(),
    });
    if (detail === this.lastUsageStatus) return;
    this.lastUsageStatus = detail;
    this.emitEvent({
      type: "diagnostic",
      severity: "info",
      category: "rate-limit",
      title: "Grok usage could not be read",
      detail,
      at: now(),
    });
  }

  private startUsagePolling(): void {
    if (this.usageRefreshTimer) return;
    this.usageRefreshTimer = setInterval(() => void this.refreshUsageLimits(), 60_000);
    this.usageRefreshTimer.unref?.();
  }

  sendUserTurn(text: string): void {
    if (this.disposed) {
      return;
    }
    this.queued.push(text);
    this.patch({ queuedTurnCount: this.queued.length });
    this.drain();
  }

  private drain(): void {
    if (this.turnActive || !this.session || this.queued.length === 0) {
      return;
    }
    const text = this.queued.shift() as string;
    this.turnActive = true;
    // `requesting`/`responding` are the app-wide busy states. Using Grok's
    // private-looking `running` value made the UI and party interrupt endpoint
    // both classify an active Grok turn as idle, so Stop never reached ACP.
    this.patch({ queuedTurnCount: this.queued.length, status: "requesting", turnState: "running", lastUserMessageAt: now() });
    this.emitEvent({ type: "status", status: "requesting", at: now() });

    this.session
      .prompt(text, {
        onText: (chunk) => {
          this.markResponding();
          this.emitEvent({ type: "assistant_text_delta", text: chunk, at: now() });
        },
        onThought: (chunk) => {
          this.markResponding();
          this.emitEvent({ type: "reasoning_delta", text: chunk, at: now() });
        },
        onToolCall: (call) => {
          this.markResponding();
          const name = grokToolName(call);
          this.toolNames.set(call.toolCallId, name);
          this.emitEvent({
            type: "tool_call",
            id: call.toolCallId,
            name,
            input: call.rawInput,
            status: grokToolStatus(call.status),
            at: now(),
          });
        },
        onToolCallUpdate: (call) => {
          const name = this.toolNames.get(call.toolCallId) || grokToolName(call);
          const result = grokToolResult(call);
          const status = result.exitCode !== undefined && result.exitCode !== 0 ? "failed" : grokToolStatus(call.status);
          this.emitEvent({
            type: "tool_call",
            id: call.toolCallId,
            name,
            input: call.rawInput,
            status,
            result: result.text ?? result.detail,
            cwd: result.cwd,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            at: now(),
          });
          if (status !== "started") {
            this.toolNames.delete(call.toolCallId);
          }
        },
        onCommands: (commands) =>
          this.patch({ slashCommands: commands.map((command) => ({ name: command.name, description: command.description })) as any }),
        onContextTokens: (tokens) => this.patch({ contextTokens: tokens }),
        onPermissionRequest: (request) => this.handlePermissionRequest(request),
      })
      .then((result) => {
        const interrupted = this.interruptRequested || /cancel/i.test(String(result.stopReason || ""));
        this.interruptRequested = false;
        this.patch({
          status: "idle",
          turnState: "complete",
          turnCount: (this.snapshot.turnCount || 0) + 1,
          lastAssistantMessageAt: now(),
        });
        if (interrupted) {
          this.emitInterruptedNotice(result.stopReason);
        }
        this.emitEvent({
          type: "turn_complete",
          result: result.text,
          stopReason: result.stopReason,
          usage: result.usage
            ? {
                input: result.usage.input,
                output: result.usage.output,
                cacheRead: result.usage.cacheRead,
                cacheWrite: result.usage.cacheWrite,
                context: this.snapshot.contextTokens,
              }
            : undefined,
          cost: { source: "grok", basis: "subscription", label: "Grok subscription" },
          costUsd: result.costUsd,
          at: now(),
        });
      })
      .catch((error) => {
        if (this.interruptRequested && /cancel|interrupt/i.test(error instanceof Error ? error.message : String(error))) {
          this.interruptRequested = false;
          this.patch({ status: "idle", turnState: "complete" });
          this.emitInterruptedNotice(error instanceof Error ? error.message : String(error));
          return;
        }
        this.interruptRequested = false;
        this.patch({ status: "idle", turnState: "complete" });
        this.emitEvent({ type: "error", message: error instanceof Error ? error.message : String(error), at: now() });
      })
      .finally(() => {
        this.turnActive = false;
        this.toolNames.clear();
        this.drain();
      });
  }

  interrupt(): void {
    if (!this.session || !this.turnActive) {
      this.forceStop();
      this.emitEvent({ type: "status", status: "interrupt", detail: "no active Grok turn", at: now() });
      return;
    }
    this.interruptRequested = true;
    this.cancelPendingApprovals();
    this.patch({ status: "interrupting", turnState: "interrupting" });
    this.session.cancel();
    this.emitEvent({ type: "status", status: "interrupt", detail: "requested", at: now() });
  }

  /** Local release only — the harness keeps running, matching the other adapters. */
  forceStop(): void {
    this.interruptRequested = false;
    this.cancelPendingApprovals();
    this.turnActive = false;
    this.patch({ status: "idle", turnState: "complete" });
    this.drain();
  }

  restart(): void {
    this.cancelPendingApprovals();
    this.session?.dispose("restarting");
    this.session = undefined;
    this.starting = undefined;
    this.turnActive = false;
    this.interruptRequested = false;
    this.patch({ harnessAlive: false, status: "starting" });
    this.start();
  }

  /** `/compact` is a real Grok Build command, delivered the way the TUI does. */
  compact(): void {
    this.sendUserTurn("/compact");
  }

  dispose(): void {
    this.disposed = true;
    if (this.usageRefreshTimer) {
      clearInterval(this.usageRefreshTimer);
      this.usageRefreshTimer = undefined;
    }
    this.interruptRequested = false;
    this.cancelPendingApprovals();
    this.session?.dispose("session closed");
    this.session = undefined;
    this.patch({ harnessAlive: false, status: "closed" });
  }

  getSnapshot(): ClaudeSessionSnapshot {
    return this.snapshot;
  }

  setDebugMode(enabled: boolean): void {
    this.patch({ debugMode: enabled });
  }

  setModel(model: string): void {
    void this.session
      ?.setModel(model)
      .then(() => this.patch({ model }))
      .catch((error) => this.emitEvent({ type: "error", message: error.message, at: now() }));
  }

  /**
   * Refused rather than accepted-and-ignored. Every route into Grok Build's
   * effort setting is a no-op on this build, so pretending otherwise would put
   * a dead knob in the UI.
   */
  setEffort(effort: string): void {
    this.emitEvent({
      type: "diagnostic",
      severity: "warning",
      category: "harness",
      title: `Grok Build ignores reasoning effort (${effort})`,
      detail:
        "Measured on grok 1.0.0: --reasoning-effort leaves the session reporting `high`, session/set_config_option answers " +
        "-32601 for every configId, and /effort is TUI-only. The setting was not applied.",
      recovery: "Run Grok through a Claude Code or Codex member if you need effort control.",
      at: now(),
    });
  }

  setThinking(mode: string): void {
    this.emitEvent({
      type: "diagnostic",
      severity: "warning",
      category: "harness",
      title: `Grok Build does not expose a thinking toggle (${mode})`,
      detail: "xAI documents grok-4.5 reasoning as always on and not disableable. The setting was not applied.",
      at: now(),
    });
  }

  setPermissionMode(permissionMode: string): void {
    void this.applyPermissionMode(permissionMode);
  }

  /** Grok owns normal/plan; AgentParty enforces the finer permission policy. */
  private async applyPermissionMode(permissionMode: string): Promise<void> {
    const plan = permissionMode === "plan";
    try {
      await this.session?.setMode(plan ? "plan" : "normal");
      this.patch({ permissionMode });
    } catch (error) {
      this.emitEvent({ type: "error", message: error instanceof Error ? error.message : String(error), at: now() });
    }
  }

  respondApproval(requestId: string, behavior: "allow" | "deny", updatedInput?: unknown): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      this.emitEvent({ type: "error", message: `No pending Grok permission request for ${requestId}.`, at: now() });
      return;
    }
    const always = Boolean(updatedInput && typeof updatedInput === "object" && (updatedInput as any).__approvalScope === "always");
    const option = selectGrokPermissionOption(pending.request.options, behavior, always);
    const outcome: GrokAcpPermissionOutcome = option
      ? { outcome: "selected", optionId: option.optionId }
      : { outcome: "cancelled" };
    this.pendingApprovals.delete(requestId);
    this.patch({ pendingApprovalCount: this.pendingApprovals.size });
    this.emitEvent({ type: "approval_resolved", requestId, decision: behavior, at: now() });
    if (!option) {
      this.emitEvent({
        type: "error",
        message: `Grok offered no ${behavior} option for permission request ${requestId}; the request was cancelled.`,
        at: now(),
      });
    }
    pending.resolve(outcome);
  }

  private handlePermissionRequest(request: GrokAcpPermissionRequest): Promise<GrokAcpPermissionOutcome> {
    const automatic = grokAutomaticPermissionDecision(this.snapshot.permissionMode, request);
    if (automatic) {
      const option = selectGrokPermissionOption(request.options, automatic, false);
      if (option) return Promise.resolve({ outcome: "selected", optionId: option.optionId });
      this.emitEvent({
        type: "error",
        message: `Grok offered no ${automatic} option for ${request.toolCall.title}; the permission request was cancelled.`,
        at: now(),
      });
      return Promise.resolve({ outcome: "cancelled" });
    }
    return new Promise((resolve) => {
      this.pendingApprovals.set(request.requestId, { request, resolve });
      this.patch({ pendingApprovalCount: this.pendingApprovals.size });
      this.emitEvent({
        type: "approval_request",
        requestId: request.requestId,
        toolName: grokToolName(request.toolCall),
        input: request.toolCall.rawInput,
        title: request.toolCall.title,
        description: `Grok permission request (${request.toolCall.kind || "other"})`,
        suggestions: request.options,
        at: now(),
      });
    });
  }

  private cancelPendingApprovals(): void {
    if (!this.pendingApprovals.size) return;
    for (const [requestId, pending] of this.pendingApprovals) {
      pending.resolve({ outcome: "cancelled" });
      this.emitEvent({ type: "approval_resolved", requestId, decision: "deny", at: now() });
    }
    this.pendingApprovals.clear();
    this.patch({ pendingApprovalCount: 0 });
  }

  private patch(next: Partial<ClaudeSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next, lastEventAt: now() } as ClaudeSessionSnapshot;
    this.emit("snapshot", this.snapshot);
  }

  private emitEvent(event: ClaudeNormalizedEvent): void {
    this.emit("event", event);
  }

  private markResponding(): void {
    // ACP may flush a final text/thought update after session/cancel. Preserve
    // `interrupting` so the composer can offer Force Stop if cancellation stalls.
    if (this.interruptRequested) return;
    if (this.snapshot.status !== "responding") {
      this.patch({ status: "responding", turnState: "running" });
    }
  }

  /** Intentional Stop is guidance, not a red harness failure. */
  private emitInterruptedNotice(rawDetail?: string): void {
    this.emitEvent({
      type: "diagnostic",
      severity: "info",
      category: "interrupt",
      title: "턴이 중단되었습니다",
      detail: "사용자 또는 다른 멤버의 요청으로 진행 중이던 작업이 멈췄습니다. 실패가 아닙니다."
        + (rawDetail ? ` (하네스: ${rawDetail})` : ""),
      recovery: "이어서 도착하는 메시지가 있으면 그것을 먼저 처리하세요.",
      at: now(),
    });
  }
}

const GROK_TOOL_NAME_ALIASES: Record<string, string> = {
  run_terminal_command: "shell",
  terminal: "shell",
  execute: "shell",
};

export function selectGrokPermissionOption(
  options: GrokAcpPermissionOption[],
  behavior: "allow" | "deny",
  always: boolean,
): GrokAcpPermissionOption | undefined {
  const preferred = behavior === "allow"
    ? (always ? "allow_always" : "allow_once")
    : (always ? "reject_always" : "reject_once");
  const fallback = behavior === "allow"
    ? (always ? "allow_once" : "allow_always")
    : (always ? "reject_once" : "reject_always");
  return options.find((option) => option.kind === preferred)
    || options.find((option) => option.kind === fallback);
}

/**
 * Party coordination is an app capability and is always allowed, matching the
 * Claude adapter. Other requests follow the member's selected permission mode.
 */
export function grokAutomaticPermissionDecision(
  permissionMode: string | undefined,
  request: GrokAcpPermissionRequest,
): "allow" | "deny" | undefined {
  const input = request.toolCall.rawInput && typeof request.toolCall.rawInput === "object"
    ? request.toolCall.rawInput as Record<string, unknown>
    : undefined;
  const delegatedTool = String(input?.tool_name || input?.toolName || "");
  if (delegatedTool.includes("agentparty-app")) return "allow";

  const mode = permissionMode || "default";
  if (mode === "auto" || mode === "bypassPermissions") return "allow";
  if (mode === "dontAsk") return "deny";

  const kind = String(request.toolCall.kind || "other");
  if (mode === "acceptEdits" && /^(edit|delete|move)$/.test(kind)) return "allow";
  if (mode === "plan") {
    return /^(read|search|fetch|think)$/.test(kind) ? "allow" : "deny";
  }
  return undefined;
}

/**
 * ACP `title` is explicitly human-readable and Grok rewrites it from
 * `run_terminal_command` to `Execute `<the whole command>``. Prefer xAI's
 * stable machine name, then a short identifier-shaped title, then the kind.
 */
export function grokToolName(call: Pick<GrokAcpToolCall, "name" | "title" | "kind">): string {
  const candidate = call.name || (/^[\w.:-]+$/.test(call.title || "") ? call.title : "") || call.kind || "tool";
  return GROK_TOOL_NAME_ALIASES[candidate] || candidate;
}

export function grokToolStatus(status?: string): "started" | "completed" | "failed" {
  const value = String(status || "").toLowerCase();
  if (/fail|error|cancel/.test(value)) return "failed";
  if (/complete|success/.test(value)) return "completed";
  return "started";
}

export function grokToolResult(call: Pick<GrokAcpToolCall, "rawOutput" | "content" | "status">): {
  text?: string;
  detail?: unknown;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  terminal: boolean;
} {
  const raw = call.rawOutput && typeof call.rawOutput === "object" ? call.rawOutput as Record<string, unknown> : undefined;
  const hasPromptOutput = typeof raw?.output_for_prompt === "string";
  let text = hasPromptOutput ? raw?.output_for_prompt as string : undefined;
  // Grok first sends an untitled update whose `content` is only the command's
  // description. Actual output updates carry a lifecycle status, so do not
  // mistake that description for terminal output.
  if (!hasPromptOutput && call.status && Array.isArray(call.content)) {
    text = call.content
      .map((item: any) => item?.content?.text ?? item?.text)
      .filter((item: unknown): item is string => typeof item === "string")
      .join("\n");
  }
  const exitCode = typeof raw?.exit_code === "number" ? raw.exit_code : undefined;
  if (text && exitCode !== undefined) {
    text = text.replace(/^exit:\s*-?\d+\r?\n/, "");
  }
  const durationMs = typeof raw?.duration_ms === "number" ? raw.duration_ms : undefined;
  return {
    text: text || undefined,
    detail: !text && grokToolStatus(call.status) === "failed" ? call.rawOutput : undefined,
    cwd: typeof raw?.current_dir === "string" ? raw.current_dir : undefined,
    exitCode,
    durationMs,
    terminal: grokToolStatus(call.status) !== "started",
  };
}
