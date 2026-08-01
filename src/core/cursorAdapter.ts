import { EventEmitter } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import * as readline from "node:readline";
import type { ClaudeEffort, ClaudeNormalizedEvent, ClaudeSessionSnapshot } from "./events";
import type { TurnTokenBreakdown } from "../shared/tokenUsage";
import type { ImageAttachment } from "../shared/attachments";
import { parseContextTokens } from "../shared/modelCatalog";
import { RawLogger } from "./rawLogger";
import { resolveCursorAgentCommand } from "./cursorAgentCli";
import { fetchCursorUsage, readCursorAccessToken } from "./cursorUsage";
import type { McpServerSnapshot } from "../shared/mcp";
import {
  cursorPolicyFromLegacyPermission,
  cursorPolicyOf,
  requireCursorPolicy,
  type CursorPolicy,
} from "../shared/cursorPolicy";

export interface CursorAdapterOptions {
  id: string;
  cwd: string;
  executablePath?: string;
  model: string;
  effort: ClaudeEffort;
  serviceTier?: string;
  permissionMode?: string;
  cursorPolicy?: CursorPolicy;
  debugEnabled: boolean;
  storageDir: string;
  resumeSessionId?: string;
  pluginDir?: string;
  partyPrimer?: string;
  /** Stamped on usage_limit events for the SessionManager's fan-in filter. */
  usageSourceId?: string;
}

interface QueuedTurn {
  text: string;
  attachments?: ImageAttachment[];
}

/**
 * A turn whose text never reached the Cursor chat. See
 * {@link CursorAdapter.uncommittedTurns}.
 */
interface UncommittedTurn {
  text: string;
  /** What the model had said before the turn broke, if anything. */
  assistant: string;
  /** Why it never committed, shown to the model in the replay block. */
  reason: string;
}

/** Replay budget — enough to keep a conversation coherent, bounded per turn. */
const MAX_REPLAYED_TURNS = 8;
const MAX_REPLAYED_USER_CHARS = 4_000;
const MAX_REPLAYED_ASSISTANT_CHARS = 1_500;

/**
 * Cursor Agent's headless protocol is one process per turn. Conversation
 * continuity comes from the CLI's own chat id (`--resume <id>`), not from
 * keeping a terminal process alive. This adapter normalizes each NDJSON record
 * into the same event stream used by Claude Code and Codex.
 */
export class CursorAdapter extends EventEmitter {
  private process?: ChildProcessByStdio<null, Readable, Readable>;
  private lineReader?: readline.Interface;
  private logger?: RawLogger;
  private started = false;
  private disposed = false;
  private status = "created";
  private turnState?: string;
  private sessionId: string;
  private model: string;
  private effort: ClaudeEffort;
  private serviceTier: "standard" | "fast";
  private cursorPolicy: CursorPolicy;
  private debugMode: boolean;
  private turnCount = 0;
  private queuedTurns: QueuedTurn[] = [];
  private startedAt = now();
  private lastEventAt?: string;
  private lastUserMessageAt?: string;
  private lastAssistantMessageAt?: string;
  private lastError?: string;
  private contextTokens?: number;
  /** Per-turn token split from the last `result` block, for the usage ledger. */
  private lastTokens?: TurnTokenBreakdown;
  private stderrTail = "";
  private resultSeen = false;
  private turnFailed = false;
  /** True after the user (or party interrupt) asked Stop — exit must not look like a crash. */
  private interruptRequested = false;
  private partyMcpConnected = false;
  private usageRefreshTimer?: NodeJS.Timeout;
  private lastUsageStatus = "";
  /**
   * Turns whose text never reached the Cursor chat. cursor-agent writes a turn
   * to its chat only when that turn FINISHES, so a Stop (or a turn that died)
   * drops the user's message and the partial answer entirely — `--resume` then
   * hands the model a conversation in which the user never said it. They are
   * replayed as context on the next turn and released only once a turn really
   * commits. Without this, "stop and rephrase" silently lost the question.
   */
  private uncommittedTurns: UncommittedTurn[] = [];
  /** The in-flight turn's text plus what the model said before it broke. */
  private activeTurn?: { text: string; assistant: string };
  /**
   * True once a turn has actually been committed to the chat. The party primer
   * rides on the first COMMITTED turn, not the first attempted one — a stopped
   * first turn used to consume it and leave the member without its identity.
   */
  private primerDelivered = false;

  constructor(private readonly options: CursorAdapterOptions) {
    super();
    if (!isSupportedCursorModel(options.model)) {
      throw new Error(`Cursor harness currently supports only 'Auto' and 'Grok 4.5' (received '${options.model}').`);
    }
    cursorModelSlug(options.model, options.effort, options.serviceTier);
    this.sessionId = options.resumeSessionId || "";
    this.model = options.model;
    this.effort = options.effort;
    this.serviceTier = normalizeServiceTier(options.serviceTier);
    this.cursorPolicy = cursorPolicyOf(options.cursorPolicy, options.permissionMode);
    this.debugMode = options.debugEnabled;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.status = "idle";
    this.emitEvent({ type: "status", status: "ready", detail: "Cursor Agent CLI", at: now() });
    // Account plan usage is an HTTP read of the CLI's own credential — no CLI
    // process needed, so the meter works even for the turn-less background
    // poller (SessionManager.startUsageAdapter).
    void this.refreshUsageLimits();
    this.startUsagePolling();
  }

  /**
   * Reads the Cursor account's current billing-cycle plan usage and feeds the
   * shared usage indicator. Failures emit an EMPTY usage_limit (so the UI shows
   * "데이터 없음" instead of loading forever) plus a deduped diagnostic.
   */
  async refreshUsageLimits(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const token = readCursorAccessToken();
    if (!token) {
      this.emitEvent({ type: "usage_limit", provider: "cursor", windows: [], at: now(), sourceId: this.options.usageSourceId });
      this.emitUsageStatus("Cursor CLI is not logged in on this host. Run `cursor-agent login`.");
      return;
    }
    const result = await fetchCursorUsage(token);
    if (this.disposed) {
      return;
    }
    if (result.windows.length) {
      this.emitEvent({ type: "usage_limit", provider: "cursor", windows: result.windows, available: true, at: now(), sourceId: this.options.usageSourceId });
      this.lastUsageStatus = "";
      return;
    }
    this.emitEvent({ type: "usage_limit", provider: "cursor", windows: [], at: now(), sourceId: this.options.usageSourceId });
    this.emitUsageStatus(result.error || "Cursor usage read returned no usable plan meter.");
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
    this.usageRefreshTimer.unref?.();
  }

  sendUserTurn(text: string, attachments?: ImageAttachment[]): void {
    if (attachments?.length) {
      this.emitEvent({
        type: "diagnostic",
        severity: "error",
        category: "vision",
        title: "Cursor CLI image input is not wired yet",
        detail: `The turn included ${attachments.length} image(s); none were sent.`,
        recovery: "Send the turn without images, or use Claude Code/Codex for image input.",
        at: now(),
      });
      return;
    }
    if (!this.started) this.start();
    if (this.process) {
      this.queuedTurns.push({ text, attachments });
      // Cursor can emit its final result shortly before the CLI process exits.
      // A user turn submitted in that handoff window is queued behind the still
      // live process. Keep the session visibly busy instead of leaving it at
      // `idle`, which made the Send button replace Stop and looked like the new
      // message had been dropped.
      if (this.status === "idle") {
        this.status = "requesting";
        this.turnState = "submitted";
      }
      this.emitEvent({ type: "status", status: "queued", detail: `${this.queuedTurns.length} message(s) queued`, at: now() });
      return;
    }
    this.runTurn(text);
  }

  interrupt(): void {
    if (!this.process) {
      this.emitEvent({ type: "status", status: "interrupt", detail: "no active Cursor turn", at: now() });
      return;
    }
    this.interruptRequested = true;
    this.status = "interrupting";
    this.turnState = "interrupting";
    this.process.kill();
    this.emitEvent({ type: "status", status: "interrupt", detail: "requested", at: now() });
  }

  forceStop(): void {
    if (!this.process) return;
    // Force-stop is still a deliberate user action — release the turn cleanly
    // instead of surfacing a fake "Cursor Agent turn failed" diagnostic.
    this.interruptRequested = true;
    this.status = "interrupting";
    this.turnState = "interrupting";
    this.process.kill("SIGKILL");
    this.emitEvent({ type: "status", status: "interrupt", detail: "force-stop requested", at: now() });
  }

  restart(): void {
    const activeProcess = this.process;
    this.process = undefined;
    activeProcess?.kill("SIGKILL");
    this.lineReader?.close();
    this.lineReader = undefined;
    this.sessionId = "";
    this.turnCount = 0;
    this.queuedTurns = [];
    this.lastError = undefined;
    this.interruptRequested = false;
    this.contextTokens = undefined;
    this.partyMcpConnected = false;
    // A new chat: nothing is owed to the old one, and the primer must ride again.
    this.uncommittedTurns = [];
    this.activeTurn = undefined;
    this.primerDelivered = false;
    this.status = "idle";
    this.turnState = undefined;
    this.startedAt = now();
    this.emitEvent({ type: "status", status: "restarted", detail: "Cursor chat context cleared; the next turn starts a new chat", at: now() });
  }

  compact(): void {
    this.sendUserTurn("/compress");
  }

  dispose(): void {
    this.disposed = true;
    if (this.usageRefreshTimer) {
      clearInterval(this.usageRefreshTimer);
      this.usageRefreshTimer = undefined;
    }
    this.process?.kill("SIGKILL");
    this.process = undefined;
    this.lineReader?.close();
    this.lineReader = undefined;
    this.logger?.close();
    this.logger = undefined;
    this.queuedTurns = [];
  }

  getSnapshot(): ClaudeSessionSnapshot {
    return {
      id: this.options.id,
      pid: this.process?.pid,
      // Cursor spawns the CLI per TURN, so between turns it legitimately holds
      // no process — that is idle, not dead. A turn's process dying is a failed
      // TURN (surfaced as an error); the next turn spawns a new one. So the only
      // thing that ends this session's ability to serve turns is disposal, and
      // claiming otherwise would mark every healthy idle Cursor member dead.
      harnessAlive: !this.disposed,
      cwd: this.options.cwd,
      sessionId: this.sessionId || undefined,
      model: this.model,
      effort: this.effort,
      cursorPolicy: { ...this.cursorPolicy },
      status: this.status,
      turnState: this.turnState,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      lastUserMessageAt: this.lastUserMessageAt,
      lastAssistantMessageAt: this.lastAssistantMessageAt,
      logPath: this.logger?.filePath,
      debugMode: this.debugMode,
      lastError: this.lastError,
      turnCount: this.turnCount,
      queuedTurnCount: this.queuedTurns.length,
      contextTokens: this.contextTokens,
      contextWindow: isCursorAuto(this.model) ? undefined : parseContextTokens("500K"),
    };
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
    if (enabled) this.ensureLogger();
    else {
      this.logger?.close();
      this.logger = undefined;
    }
    this.emitEvent({ type: "status", status: "debug", detail: enabled ? "enabled" : "disabled", at: now() });
  }

  setModel(model: string): void {
    if (!isSupportedCursorModel(model)) {
      this.emitEvent({ type: "error", message: `Cursor harness currently supports only 'Auto' and 'Grok 4.5' (received '${model}').`, at: now() });
      return;
    }
    this.model = model;
    this.emitEvent({ type: "status", status: "model", detail: `${model}; applies to the next Cursor turn`, at: now() });
  }

  setEffort(effort: string): void {
    if (isCursorAuto(this.model)) {
      this.emitEvent({ type: "error", message: "Cursor Auto chooses its own model and does not accept a Grok effort level.", at: now() });
      return;
    }
    try {
      cursorModelSlug(this.model, effort, this.serviceTier);
    } catch (error) {
      this.emitEvent({ type: "error", message: error instanceof Error ? error.message : String(error), at: now() });
      return;
    }
    this.effort = effort as ClaudeEffort;
    this.emitEvent({ type: "status", status: "effort", detail: `${effort}; applies to the next Cursor turn`, at: now() });
  }

  setThinking(_mode: string, _budget?: number): void {
    this.emitEvent({ type: "status", status: "thinking", detail: "Cursor Grok reasoning is controlled by effort.", at: now() });
  }

  setPermissionMode(permissionMode: string): void {
    this.setCursorPolicy(cursorPolicyFromLegacyPermission(permissionMode));
  }

  setCursorPolicy(policy: CursorPolicy): void {
    this.cursorPolicy = requireCursorPolicy(policy);
    this.emitEvent({
      type: "status",
      status: "permission",
      detail: `${this.cursorPolicy.mode} / ${this.cursorPolicy.approval}; applies to the next Cursor turn`,
      at: now(),
    });
  }

  async listMcpServers(): Promise<McpServerSnapshot> {
    return {
      supported: true,
      harness: "cursor",
      servers: this.options.pluginDir
        ? [{
            name: "agentparty-app",
            state: this.partyMcpConnected ? "connected" : "unknown",
            transport: "stdio",
            tools: CURSOR_PARTY_MCP_TOOLS.map((name) => ({ name })),
            canReconnect: false,
            canToggle: false,
            canAuthenticate: false,
          }]
        : [],
      note: this.options.pluginDir
        ? this.partyMcpConnected
          ? "AgentParty observed a successful interaction with this session-scoped Cursor MCP plugin."
          : "AgentParty injects this session-scoped MCP plugin into every Cursor turn. Tools are the configured AgentParty inventory; Cursor print mode does not expose a separate live connection event."
        : "No session-scoped Cursor MCP plugin is configured.",
    };
  }

  respondApproval(requestId: string): void {
    this.emitEvent({
      type: "error",
      message: `Cursor print mode does not expose an interactive approval request '${requestId}'.`,
      at: now(),
    });
  }

  private runTurn(text: string): void {
    let resolved;
    try {
      resolved = resolveCursorAgentCommand(this.options.executablePath);
    } catch (error) {
      this.finishWithError(error);
      return;
    }
    const prompt = this.buildPrompt(text);
    const args = [
      ...resolved.argsPrefix,
      "-p",
      "--output-format",
      "stream-json",
      "--trust",
      "--model",
      cursorModelSlug(this.model, this.effort, this.serviceTier),
      ...cursorPolicyArgs(this.cursorPolicy),
      ...(this.options.pluginDir ? ["--plugin-dir", this.options.pluginDir, "--approve-mcps"] : []),
      ...(this.sessionId ? ["--resume", this.sessionId] : []),
      prompt,
    ];
    this.ensureLogger();
    this.resultSeen = false;
    this.turnFailed = false;
    this.interruptRequested = false;
    this.lastError = undefined;
    this.stderrTail = "";
    this.activeTurn = { text, assistant: "" };
    this.turnCount += 1;
    this.lastUserMessageAt = now();
    this.status = "requesting";
    this.turnState = "submitted";
    this.emitEvent({ type: "status", status: "sent", detail: text, at: now() });
    this.logger?.write("spawn", { command: resolved.command, args: args.slice(0, -1), promptLength: prompt.length, source: resolved.source });

    const child = spawn(resolved.command, args, {
      cwd: this.options.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    this.lineReader = readline.createInterface({ input: child.stdout });
    this.lineReader.on("line", (line) => this.readLine(line));
    child.stderr.on("data", (chunk) => {
      const value = String(chunk);
      this.stderrTail = (this.stderrTail + value).slice(-16_000);
      this.logger?.write("stderr", value);
    });
    // Parent-side EPIPE when Cursor closes a stdio end mid-drain must not become
    // an uncaught exception in Electron main.
    child.stdout.on("error", (error) => {
      if (isPipeClosedError(error)) return;
      this.logger?.write("stdout-error", String(error));
    });
    child.stderr.on("error", (error) => {
      if (isPipeClosedError(error)) return;
      this.logger?.write("stderr-error", String(error));
    });
    child.on("error", (error) => {
      if (this.interruptRequested) {
        this.finishInterrupted();
        return;
      }
      this.finishWithError(error);
    });
    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      this.process = undefined;
      this.lineReader?.close();
      this.lineReader = undefined;
      if (this.interruptRequested && !this.resultSeen) {
        this.finishInterrupted(signal ? `stopped (${signal})` : "stopped");
      } else if (!this.resultSeen && !this.turnFailed) {
        const detail = this.stderrTail.trim() || `Cursor Agent exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`;
        // Cursor's context logger writes info/debug via console.log → stdout. When
        // that pipe is already closed (MCP teardown, Stop race), the CLI dumps a
        // "broken pipe" stack at logger.js:91 and exits without a result frame.
        if (isCursorStdioPipeNoise(detail)) {
          this.finishWithPipeNoise(detail);
        } else {
          this.finishWithError(new Error(detail));
        }
      } else if (this.turnFailed) {
        this.emit("snapshot", this.getSnapshot());
        this.drainQueue();
      } else if (this.queuedTurns.length) {
        // Hand the process slot directly to the queued turn. Publishing an idle
        // snapshot first creates a visible Send/Stop flicker and reports
        // turnActive=false even though accepted work is waiting.
        this.drainQueue();
      } else {
        this.status = "idle";
        this.turnState = undefined;
        this.emit("snapshot", this.getSnapshot());
      }
    });
    this.emit("snapshot", this.getSnapshot());
  }

  /**
   * The prompt actually handed to `cursor-agent`: the party primer while it is
   * still undelivered, then any turns the chat never recorded, then the new
   * message.
   */
  private buildPrompt(text: string): string {
    const parts: string[] = [];
    if (!this.primerDelivered && this.options.partyPrimer) {
      parts.push(this.options.partyPrimer);
    }
    const replay = this.replayBlock();
    if (replay) {
      parts.push(replay);
    }
    parts.push(text);
    return parts.join("\n\n");
  }

  /**
   * Renders {@link uncommittedTurns} for the model. It is labelled as history
   * the user already sent — not as a new instruction — so a "stop and rephrase"
   * reads exactly as it happened instead of the model silently answering an old
   * request.
   */
  private replayBlock(): string {
    if (!this.uncommittedTurns.length) {
      return "";
    }
    const lines = this.uncommittedTurns.map((turn) => {
      const parts = [`[user] ${clamp(turn.text, MAX_REPLAYED_USER_CHARS)}`];
      if (turn.assistant.trim()) {
        parts.push(`[your partial answer] ${clamp(turn.assistant.trim(), MAX_REPLAYED_ASSISTANT_CHARS)}`);
      }
      parts.push(`[${turn.reason}]`);
      return parts.join("\n");
    });
    return [
      "<unsaved_history>",
      "The user already sent the turns below in THIS conversation, but Cursor never",
      "saved them to the chat because each turn ended before it finished, so they are",
      "missing from the history you were resumed with. Treat them as things the user",
      "really said. Do not answer them again unless the new message asks you to.",
      "",
      lines.join("\n\n"),
      "</unsaved_history>",
    ].join("\n");
  }

  /**
   * The turn reached a result, so Cursor has now written it — and everything
   * replayed alongside it — into the chat. Releases the replay backlog and
   * settles the party primer.
   */
  private commitTurn(): void {
    this.activeTurn = undefined;
    this.uncommittedTurns = [];
    this.primerDelivered = true;
  }

  /**
   * Records a turn the Cursor chat will never contain, so the next turn can
   * replay it. Called from every path that ends a turn WITHOUT a committed
   * result (stop, force-stop, CLI failure, stdio teardown).
   */
  private rememberUncommittedTurn(reason: string): void {
    const turn = this.activeTurn;
    this.activeTurn = undefined;
    if (!turn) {
      return;
    }
    this.uncommittedTurns.push({ text: turn.text, assistant: turn.assistant, reason });
    if (this.uncommittedTurns.length > MAX_REPLAYED_TURNS) {
      // Never drop silently: the oldest entries fall out of the replay budget,
      // so say so where the user (and the model) can see it.
      const dropped = this.uncommittedTurns.splice(0, this.uncommittedTurns.length - MAX_REPLAYED_TURNS);
      this.emitEvent({
        type: "diagnostic",
        severity: "warning",
        category: "cursor-cli",
        title: "중단된 이전 메시지가 대화에서 밀려났습니다",
        detail: `Cursor는 완료된 턴만 채팅에 저장합니다. 중단된 턴이 ${MAX_REPLAYED_TURNS}개를 넘어 가장 오래된 ${dropped.length}개는 더 이상 모델에게 전달되지 않습니다.`,
        recovery: "필요한 내용은 새 메시지에 다시 적어 주세요.",
        at: now(),
      });
    }
  }

  private readLine(line: string): void {
    this.logger?.write("stdout", line);
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      // Cursor prints some fatal errors as plain stderr/stdout. Preserve them
      // for the exit diagnostic instead of pretending they were model output.
      this.stderrTail = (this.stderrTail + "\n" + line).slice(-16_000);
      return;
    }
    const at = timestampOf(message);
    if (typeof message.session_id === "string" && message.session_id) {
      this.sessionId = message.session_id;
    }
    if (message.type === "system" && message.subtype === "init") {
      // `running` is not part of the shared busy-state contract used by the UI
      // and automation API. Cursor emits init while the submitted turn is still
      // generating, so expose the same `responding` state as Claude and Codex.
      this.status = "responding";
      this.turnState = "in_progress";
      this.emitEvent({
        type: "session",
        sessionId: this.sessionId,
        model: this.model,
        cursorPolicy: { ...this.cursorPolicy },
        at,
      });
      return;
    }
    if (message.type === "thinking" && message.subtype === "delta" && typeof message.text === "string") {
      this.emitEvent({ type: "reasoning_delta", text: message.text, at });
      return;
    }
    if (message.type === "assistant") {
      for (const block of message.message?.content || []) {
        if (block?.type === "text" && typeof block.text === "string") {
          this.lastAssistantMessageAt = at;
          if (this.activeTurn) {
            this.activeTurn.assistant += block.text;
          }
          this.emitEvent({ type: "assistant_text_delta", text: block.text, at });
        }
      }
      return;
    }
    if (message.type === "tool_call") {
      const call = normalizeToolCall(message);
      if (message.subtype !== "started" && !call.failed && isAgentPartyMcpCall(message, call)) {
        this.partyMcpConnected = true;
      }
      this.emitEvent({
        type: "tool_call",
        id: String(message.call_id || call.id || `cursor-tool-${Date.now()}`),
        name: call.name,
        input: call.input,
        status: message.subtype === "started" ? "started" : call.failed ? "failed" : "completed",
        result: call.result,
        at,
      });
      return;
    }
    if (message.type === "result") {
      this.resultSeen = true;
      const usage = message.usage || {};
      const input = finiteNumber(usage.inputTokens);
      const output = finiteNumber(usage.outputTokens);
      const cache = finiteNumber(usage.cacheReadTokens);
      this.contextTokens = input == null && output == null && cache == null ? undefined : (input || 0) + (output || 0) + (cache || 0);
      this.lastTokens = input == null && output == null && cache == null
        ? undefined
        : { input: input ?? undefined, output: output ?? undefined, cacheRead: cache ?? undefined, context: this.contextTokens };
      // Stop/force-stop may still race a CLI error result — treat that as a clean
      // interrupt, not a turn failure.
      if (this.interruptRequested) {
        // The CLI beat the Stop. A successful result means Cursor DID write this
        // turn to its chat, so it must not be replayed as unsaved history.
        if (!message.is_error && message.subtype === "success") {
          this.commitTurn();
        }
        this.finishInterrupted();
        return;
      }
      if (message.is_error || message.subtype !== "success") {
        const detail = String(message.result || "Cursor Agent turn failed.");
        if (isCursorStdioPipeNoise(detail)) {
          this.finishWithPipeNoise(detail);
        } else {
          this.finishWithError(new Error(detail));
        }
      } else {
        this.finishTurn(String(message.result || ""), true);
      }
    }
  }

  private finishTurn(result: string, success: boolean): void {
    this.resultSeen = true;
    this.interruptRequested = false;
    if (success) {
      this.lastError = undefined;
      this.commitTurn();
    } else {
      this.rememberUncommittedTurn("this turn failed");
    }
    const handingOff = success && this.queuedTurns.length > 0;
    this.status = success ? (handingOff ? "responding" : "idle") : "error";
    this.turnState = handingOff ? "in_progress" : undefined;
    this.emitEvent(success
      ? { type: "turn_complete", result, cost: { source: "unknown", basis: "subscription", label: "Cursor subscription" }, usage: this.lastTokens, at: now() }
      : { type: "error", message: result, at: now() });
  }

  /** Completes a Stop/force-stop without treating it as a harness failure. */
  private finishInterrupted(detail = "stopped"): void {
    this.resultSeen = true;
    this.interruptRequested = false;
    this.turnFailed = false;
    this.lastError = undefined;
    this.status = "idle";
    this.turnState = undefined;
    const carried = Boolean(this.activeTurn);
    this.rememberUncommittedTurn("the user stopped this turn before it finished");
    this.emitEvent({
      type: "status",
      status: "interrupted",
      // Say where the stopped message went: Cursor drops it, so the next turn
      // carries it. Otherwise the user reasonably assumes the model heard it.
      detail: carried ? `${detail}; Cursor did not save it, so it is replayed with your next message` : detail,
      at: now(),
    });
    if (!this.process) {
      this.lineReader?.close();
      this.lineReader = undefined;
      this.drainQueue();
    }
  }

  /**
   * Cursor CLI logger.js EPIPE / broken-pipe teardown: keep the session usable
   * and surface a stdio diagnostic instead of a fake model/plan failure.
   */
  private finishWithPipeNoise(detail: string): void {
    this.resultSeen = true;
    this.interruptRequested = false;
    this.turnFailed = false;
    this.lastError = undefined;
    this.status = "idle";
    this.turnState = undefined;
    this.rememberUncommittedTurn("this turn died before it finished (Cursor stdio teardown)");
    this.emitEvent({
      type: "diagnostic",
      severity: "warning",
      category: "cursor-stdio",
      title: "Cursor Agent stdio pipe closed",
      detail: summarizeCursorPipeNoise(detail),
      recovery: "Usually MCP/stdio teardown (logger.js broken pipe). Retry the turn. If every new Cursor member hits this, check the session MCP plugin can reach the automation API.",
      at: now(),
    });
    if (!this.process) {
      this.lineReader?.close();
      this.lineReader = undefined;
      this.drainQueue();
    }
  }

  private finishWithError(error: unknown): void {
    if (this.interruptRequested) {
      this.finishInterrupted();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    this.turnFailed = true;
    this.status = "error";
    this.turnState = undefined;
    this.rememberUncommittedTurn("this turn failed before it finished");
    this.emitEvent({
      type: "diagnostic",
      severity: "error",
      category: "cursor-cli",
      title: "Cursor Agent turn failed",
      detail: message,
      recovery: message.includes("Named models unavailable")
        ? "Upgrade the signed-in Cursor plan or sign in with an account that can use named models. AgentParty will not fall back to Auto."
        : "Run `agent status` and `agent --list-models`, then retry.",
      at: now(),
    });
    this.emitEvent({ type: "error", message, at: now() });
    if (!this.process) {
      this.lineReader?.close();
      this.lineReader = undefined;
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    if (this.process || this.disposed) return;
    const next = this.queuedTurns.shift();
    if (next) this.runTurn(next.text);
  }

  private emitEvent(event: ClaudeNormalizedEvent): void {
    this.lastEventAt = event.at;
    this.logger?.write("event", event);
    this.emit("event", event);
    this.emit("snapshot", this.getSnapshot());
  }

  private ensureLogger(): void {
    if (!this.debugMode || this.logger) return;
    this.logger = new RawLogger({ baseDir: this.options.storageDir, sessionId: `${this.options.id}-cursor`, maxFiles: 30, maxBytes: 5_000_000 });
  }
}

const CURSOR_PARTY_MCP_TOOLS = [
  "send",
  "member-create",
  "member-remove",
  "member-permission",
  "gate-set",
  "party-gate-set",
  "list",
  "list-models",
  "member-status",
  "interrupt",
  "broadcast",
] as const;

export function cursorModelSlug(model: string, effort: string, serviceTier: string = "standard"): string {
  if (isCursorAuto(model)) return "auto";
  if (!isCursorGrok45(model)) {
    throw new Error(`Cursor harness currently supports only 'Auto' and 'Grok 4.5' (received '${model}').`);
  }
  const suffix = normalizeServiceTier(serviceTier) === "fast" ? "-fast" : "";
  switch (effort) {
    case "low":
      return `cursor-grok-4.5-low${suffix}`;
    case "medium":
      return `cursor-grok-4.5-medium${suffix}`;
    case "high":
      return `cursor-grok-4.5-high${suffix}`;
    default:
      throw new Error(`Cursor Grok 4.5 effort must be 'low', 'medium', or 'high' (received '${effort}').`);
  }
}

function normalizeServiceTier(value: string | undefined): "standard" | "fast" {
  if (!value || value === "standard") return "standard";
  if (value === "fast") return "fast";
  throw new Error(`Cursor Grok service tier must be 'standard' or 'fast' (received '${value}').`);
}

function isCursorGrok45(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === "grok 4.5" || normalized.startsWith("cursor-grok-4.5-");
}

function isCursorAuto(model: string): boolean {
  return model.trim().toLowerCase() === "auto";
}

function isSupportedCursorModel(model: string): boolean {
  return isCursorAuto(model) || isCursorGrok45(model);
}

/** Parent/child stdio closed while the other side still wrote. */
function isPipeClosedError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_PREMATURE_CLOSE";
}

/**
 * Cursor's context `logger.js` writes info/debug through `console.log` (stdout).
 * When that pipe is already closed, Node throws and the CLI dumps a stack that
 * mentions `logger.js:91` / `broken pipe` / `EPIPE` instead of a model result.
 */
function isCursorStdioPipeNoise(detail: string): boolean {
  const text = detail.trim();
  if (!text) return false;
  const pipe = /broken pipe|\bEPIPE\b|ERR_STREAM_DESTROYED|ERR_STREAM_PREMATURE_CLOSE/i.test(text);
  const loggerFrame = /logger\.js:\d+/i.test(text);
  // Pure pipe teardown, or Cursor's logger frame paired with a write failure.
  return pipe || (loggerFrame && /write|pipe|EPIPE|broken/i.test(text));
}

function summarizeCursorPipeNoise(detail: string): string {
  const first = detail.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || detail.trim();
  if (/logger\.js:\d+/i.test(detail) || /broken pipe/i.test(detail)) {
    return `Cursor CLI closed its stdio pipe while logging (${first.slice(0, 240)}).`;
  }
  return first.slice(0, 400);
}

function cursorPolicyArgs(policy: CursorPolicy): string[] {
  const mode = policy.mode === "agent" ? [] : ["--mode", policy.mode];
  const approval = policy.approval === "auto-review"
    ? ["--auto-review"]
    : policy.approval === "unrestricted"
      ? ["--force"]
      : [];
  return [...mode, ...approval];
}

function normalizeToolCall(message: any): { id?: string; name: string; input?: unknown; result?: unknown; failed: boolean } {
  const raw = message.tool_call || {};
  const key = Object.keys(raw).find((name) => name.endsWith("ToolCall"));
  const value = key ? raw[key] : undefined;
  const result = value?.result;
  return {
    id: raw.toolCallId,
    name: key ? key.slice(0, -"ToolCall".length) : "cursor_tool",
    input: value?.args,
    result,
    failed: Boolean(result?.error || result?.failure),
  };
}

function isAgentPartyMcpCall(
  message: unknown,
  call: { name: string; input?: unknown; result?: unknown },
): boolean {
  if (call.name.toLowerCase().includes("mcp")) {
    const payload = JSON.stringify({ input: call.input, result: call.result });
    if (payload.includes("agentparty-app")) return true;
  }
  return JSON.stringify(message).includes("agentparty-app");
}

/** Truncates visibly — a cut is marked, never silent. */
function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… (${value.length - max} chars omitted)`;
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function timestampOf(message: any): string {
  const ms = finiteNumber(message?.timestamp_ms);
  return ms ? new Date(ms).toISOString() : now();
}

function now(): string {
  return new Date().toISOString();
}
