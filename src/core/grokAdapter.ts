/**
 * Grok Build harness adapter — runs the official `grok` CLI as a member.
 *
 * The turn surface maps cleanly onto ACP, but three things this harness cannot
 * do are surfaced as diagnostics at session start instead of being quietly
 * absent. All three were measured against grok 1.0.0 (3cd0d0cbce) on
 * 2026-08-10 and are xAI-side, so the app cannot fix them:
 *
 *  - It never sends `session/request_permission`; tool calls just execute. A
 *    Grok Build member therefore behaves as always-approve no matter what the
 *    app's permission control says, which is a safety difference from every
 *    other harness and must be visible.
 *  - Reasoning effort cannot be set. `--reasoning-effort` is ignored (the
 *    session keeps reporting `high`), `session/set_config_option` answers
 *    -32601 for every configId, and `/effort` is TUI-only.
 *  - It loads the user's Claude Code hooks and permission rules from ~/.claude
 *    regardless of every documented opt-out (env vars, `[compat.claude]`, an
 *    isolated GROK_HOME, even a redirected USERPROFILE).
 */
import { EventEmitter } from "node:events";
import { ClaudeNormalizedEvent, ClaudeSessionSnapshot } from "./events";
import { GrokAcpSession, type GrokAcpMcpServer } from "./grokAcp";
import { resolveGrokCli } from "./grokAgentCli";

export interface GrokAdapterOptions {
  sessionId: string;
  cwd: string;
  /** Settings override for the `grok` executable; resolved when absent. */
  executablePath?: string;
  model?: string;
  permissionMode?: string;
  /** Party tool relay and any other MCP servers this member should see. */
  mcpServers?: GrokAcpMcpServer[];
}

const now = (): string => new Date().toISOString();

export class GrokAdapter extends EventEmitter {
  private session: GrokAcpSession | undefined;
  private snapshot: ClaudeSessionSnapshot;
  private starting: Promise<void> | undefined;
  private queued: string[] = [];
  private turnActive = false;
  private disposed = false;

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
    const cli = await resolveGrokCli(this.options.executablePath);
    const session = new GrokAcpSession({
      command: cli.command,
      cwd: this.options.cwd,
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
    this.warnAboutHarnessLimits(cli.version);
    this.reportUsageUnavailable();
    this.drain();
  }

  /**
   * The three capabilities this harness lacks, stated once per session. Silence
   * here would leave a member that looks like the others but approves every
   * tool call on its own.
   */
  private warnAboutHarnessLimits(version: string): void {
    this.emitEvent({
      type: "diagnostic",
      severity: "warning",
      category: "harness",
      title: "Grok Build approves its own tool calls",
      detail:
        `Grok Build ${version} never asks the client for permission, so this member runs every tool it decides to run — ` +
        "the permission control does not apply to it. It also loads your Claude Code hooks and permission rules from ~/.claude, " +
        "which xAI provides no way to disable.",
      recovery: "Use a Claude Code or Codex member when tool calls must be approved.",
      at: now(),
    });
  }

  /**
   * States plainly that no plan meter exists for Grok, so the indicator shows
   * "not applicable" rather than an empty bar a user would read as 0% used.
   * xAI exposes per-turn tokens and nothing else: api.x.ai answers 404 for every
   * usage/billing path and rejects the subscription token on /v1/me, and the ACP
   * stream carries no account window (measured 2026-08-10). Per-turn spend is
   * still recorded — it lands in the Token Usage ledger.
   */
  private reportUsageUnavailable(): void {
    this.emitEvent({ type: "usage_limit", provider: "grok", windows: [], available: false, at: now() });
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
    this.patch({ queuedTurnCount: this.queued.length, status: "running", turnState: "running", lastUserMessageAt: now() });
    this.emitEvent({ type: "status", status: "requesting", at: now() });

    this.session
      .prompt(text, {
        onText: (chunk) => this.emitEvent({ type: "assistant_text_delta", text: chunk, at: now() }),
        onThought: (chunk) => this.emitEvent({ type: "reasoning_delta", text: chunk, at: now() }),
        onToolCall: (call) =>
          this.emitEvent({
            type: "tool_call",
            id: call.toolCallId,
            name: call.title,
            input: call.rawInput,
            status: "started",
            at: now(),
          }),
        onToolCallUpdate: (call) =>
          this.emitEvent({
            type: "tool_call",
            id: call.toolCallId,
            name: call.title,
            input: call.rawInput,
            status: /fail|error/i.test(String(call.status)) ? "failed" : "completed",
            at: now(),
          }),
        onCommands: (commands) =>
          this.patch({ slashCommands: commands.map((command) => ({ name: command.name, description: command.description })) as any }),
        onContextTokens: (tokens) => this.patch({ contextTokens: tokens }),
      })
      .then((result) => {
        this.patch({
          status: "idle",
          turnState: "complete",
          turnCount: (this.snapshot.turnCount || 0) + 1,
          lastAssistantMessageAt: now(),
        });
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
          at: now(),
        });
      })
      .catch((error) => {
        this.patch({ status: "idle", turnState: "complete" });
        this.emitEvent({ type: "error", message: error instanceof Error ? error.message : String(error), at: now() });
      })
      .finally(() => {
        this.turnActive = false;
        this.drain();
      });
  }

  interrupt(): void {
    this.session?.cancel();
  }

  /** Local release only — the harness keeps running, matching the other adapters. */
  forceStop(): void {
    this.turnActive = false;
    this.patch({ status: "idle", turnState: "complete" });
    this.drain();
  }

  restart(): void {
    this.session?.dispose("restarting");
    this.session = undefined;
    this.starting = undefined;
    this.turnActive = false;
    this.patch({ harnessAlive: false, status: "starting" });
    this.start();
  }

  /** `/compact` is a real Grok Build command, delivered the way the TUI does. */
  compact(): void {
    this.sendUserTurn("/compact");
  }

  dispose(): void {
    this.disposed = true;
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

  /**
   * Only plan mode is real here: `session/set_mode` returns OK for any string
   * but only `normal`/`plan` take effect, and no mode restores approval
   * prompts. Anything else is reported instead of appearing to apply.
   */
  private async applyPermissionMode(permissionMode: string): Promise<void> {
    const plan = permissionMode === "plan";
    try {
      await this.session?.setMode(plan ? "plan" : "normal");
      this.patch({ permissionMode });
      if (!plan && permissionMode !== "default" && permissionMode !== "acceptEdits") {
        this.emitEvent({
          type: "diagnostic",
          severity: "warning",
          category: "harness",
          title: `Grok Build has no '${permissionMode}' mode`,
          detail: "It supports only normal and plan; tool calls are never sent to the client for approval.",
          at: now(),
        });
      }
    } catch (error) {
      this.emitEvent({ type: "error", message: error instanceof Error ? error.message : String(error), at: now() });
    }
  }

  /** No approval channel exists, so a decision has nothing to answer. */
  respondApproval(): void {
    this.emitEvent({
      type: "diagnostic",
      severity: "warning",
      category: "harness",
      title: "Grok Build has no pending approvals",
      detail: "This harness executes tool calls without asking, so there is no approval to answer.",
      at: now(),
    });
  }

  private patch(next: Partial<ClaudeSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next, lastEventAt: now() } as ClaudeSessionSnapshot;
    this.emit("snapshot", this.snapshot);
  }

  private emitEvent(event: ClaudeNormalizedEvent): void {
    this.emit("event", event);
  }
}
