import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import * as path from "node:path";
import type { ClaudeEffort, ClaudeNormalizedEvent, ClaudeSessionSnapshot, HarnessCommand } from "./events";
import { DefaultTurnCostResolver } from "./costing";
import type { TurnUsage } from "./costing";
import type { PartyIdentity } from "./partyBridge";
import { buildPartyPrimer } from "./partyBridge";
import type { CodexPolicy, SandboxMode } from "../shared/codexPolicy";
import { codexPolicyFromPermissionMode } from "../shared/codexPolicy";
import type { CodexApprovalKind } from "../shared/codexApproval";
import { approvalMeta, approvalResult, codexDecisionOf, normalizeUserInputQuestions } from "../shared/codexApproval";
import { fileEditsFrom, planStepsFrom, toolSourceLabel } from "../shared/codexItems";
import { pluginCommands, skillCommands } from "../shared/codexDiscovery";

export interface CodexAdapterOptions {
  id: string;
  cwd: string;
  model: string;
  effort: ClaudeEffort;
  permissionMode?: string;
  /** Explicit two-axis safety model; falls back to deriving from permissionMode. */
  policy?: CodexPolicy;
  debugEnabled: boolean;
  executablePath?: string;
  executableArgs?: string[];
  resumeSessionId?: string;
  partyIdentity?: PartyIdentity;
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
  private queuedTurns: string[] = [];
  private activeTurn = false;
  private lastEventAt: string | undefined;
  private lastUserMessageAt: string | undefined;
  private lastAssistantMessageAt: string | undefined;
  private lastError: string | undefined;
  private lastUsage: TurnUsage | undefined;
  private requestSeq = 0;
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly startedAt = now();
  private readonly costResolver = new DefaultTurnCostResolver();
  private policy: CodexPolicy;
  /** Live palette inventory: built-in commands + discovered skills/plugins. */
  private inventory: HarnessCommand[] = CODEX_COMMANDS;

  constructor(private readonly options: CodexAdapterOptions) {
    super();
    this.sessionId = options.resumeSessionId || "";
    this.policy = options.policy ?? codexPolicyFromPermissionMode(options.permissionMode);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.status = "starting";
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

  sendUserTurn(text: string): void {
    if (this.disposed) {
      return;
    }
    if (!this.started) {
      this.start();
    }
    if (this.activeTurn) {
      this.queuedTurns.push(text);
      this.emitEvent({ type: "status", status: "queued", detail: `${this.queuedTurns.length} message(s) queued`, at: now() });
      return;
    }
    void this.runTurn(text);
  }

  interrupt(): void {
    if (!this.sessionId || !this.activeTurnId) {
      this.emitEvent({ type: "status", status: "interrupt", detail: "no active codex turn", at: now() });
      return;
    }
    this.status = "interrupting";
    this.turnState = "interrupting";
    void this.request("turn/interrupt", { threadId: this.sessionId, turnId: this.activeTurnId }).catch((error) => this.finishWithError(error));
    this.emitEvent({ type: "status", status: "interrupt", detail: "requested", at: now() });
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
    this.start();
  }

  compact(): void {
    if (!this.sessionId) {
      this.sendUserTurn("/compact");
      return;
    }
    void this.request("thread/compact/start", { threadId: this.sessionId }).catch((error) => this.finishWithError(error));
  }

  dispose(): void {
    this.disposed = true;
    this.shutdownProcess();
    this.removeAllListeners();
  }

  getSnapshot(): ClaudeSessionSnapshot {
    return {
      id: this.options.id,
      pid: this.process?.pid,
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
      debugMode: this.options.debugEnabled,
      lastError: this.lastError,
      turnCount: this.turnCount,
      queuedTurnCount: this.queuedTurns.length,
      pendingApprovalCount: this.pendingApprovals.size,
      slashCommands: this.inventory,
      codexPolicy: this.policy,
    };
  }

  setDebugMode(_enabled: boolean): void {
    this.emit("snapshot", this.getSnapshot());
  }

  setModel(model: string): void {
    (this.options as { model: string }).model = model;
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

  /**
   * Answers a server approval/input request. The user-facing choice (once /
   * session / always / decline) rides in `updatedInput.codexDecision`; the coarse
   * `behavior` is the allow/deny fallback. Each request method maps to its own
   * protocol response shape (command/file/permissions/user-input/elicitation).
   */
  respondApproval(requestId: string, behavior?: "allow" | "deny", updatedInput?: unknown, _message?: string): void {
    const approval = this.pendingApprovals.get(requestId);
    if (!approval) {
      this.emitEvent({ type: "error", message: `Unknown Codex approval request '${requestId}'.`, at: now() });
      return;
    }
    const decision = codexDecisionOf(behavior, updatedInput);
    const params = (approval.input || {}) as Record<string, any>;
    const result = approvalResult(approval.method, decision, params, updatedInput);
    this.respond(requestId, result);
    this.pendingApprovals.delete(requestId);
    this.emitEvent({ type: "approval_resolved", requestId, decision: decision === "decline" ? "deny" : "allow", at: now() });
  }

  private async ensureThread(): Promise<void> {
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
    const requested = this.options.executablePath || process.env.AGENTPARTY_CODEX_BIN || "codex";
    const resolved = resolveCodexExecutable(requested);
    const spawnArgs = [...this.codexExecutableArgs(), "app-server"];
    this.process = spawn(resolved.command, spawnArgs, {
      cwd: this.options.cwd,
      env: process.env,
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
    this.emitEvent({ type: "status", status: "spawned", detail: [resolved.command, ...spawnArgs].join(" "), at: now() });
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
      cwd: this.options.cwd,
      approvalPolicy: this.policy.approval,
      approvalsReviewer: this.policy.guardian ? "auto_review" : "user",
      sandbox: this.policy.sandbox,
    });
    this.applyThreadResult(result);
  }

  private async resumeThread(): Promise<void> {
    const result = await this.request("thread/resume", {
      threadId: this.sessionId,
      model: this.options.model,
      cwd: this.options.cwd,
      approvalPolicy: this.policy.approval,
      approvalsReviewer: this.policy.guardian ? "auto_review" : "user",
      sandbox: this.policy.sandbox,
    });
    this.applyThreadResult(result);
  }

  private applyThreadResult(result: any): void {
    this.sessionId = String(result?.thread?.id || result?.thread?.sessionId || this.sessionId || this.options.id);
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
    this.emitEvent({ type: "status", status: "discovery", detail: `${kind}: ${error instanceof Error ? error.message : String(error)}`, at: now() });
    return undefined;
  }

  private async runTurn(text: string): Promise<void> {
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
      const prompt = this.options.partyIdentity ? `${buildPartyPrimer(this.options.partyIdentity)}\n\n${text}` : text;
      const result = await this.request("turn/start", {
        threadId: this.sessionId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        cwd: this.options.cwd,
        approvalPolicy: this.policy.approval,
        approvalsReviewer: this.policy.guardian ? "auto_review" : "user",
        sandboxPolicy: sandboxPolicyObject(this.policy.sandbox),
        model: this.options.model,
        effort: effortFor(this.options.effort),
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
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  }

  private notify(method: string, params: unknown): void {
    if (!this.process?.stdin.writable) {
      return;
    }
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private respond(id: string, result: unknown): void {
    if (!this.process?.stdin.writable) {
      return;
    }
    this.process.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private readMessage(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.emitEvent({ type: "status", status: "stdout", detail: line, at: now() });
      return;
    }
    if (message.id && this.pendingRequests.has(String(message.id))) {
      this.completeRequest(String(message.id), message);
      return;
    }
    if (message.id && message.method) {
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
    this.pendingApprovals.set(requestId, { method, input: params });
    const meta = approvalMeta(method, params);
    // A tool asking for a value reuses the interactive question card; its answers
    // are shaped like AskUserQuestion so the renderer can drive it.
    const input = meta.kind === "userInput" ? { questions: normalizeUserInputQuestions(params.questions) } : params;
    this.emitEvent({
      type: "approval_request",
      requestId,
      toolName: method,
      input,
      title: approvalTitle(meta.kind),
      description: meta.reason,
      codex: meta,
      at: now(),
    });
  }

  private normalizeNotification(message: any): void {
    const method = String(message.method);
    const params = message.params || {};
    if (method === "thread/started") {
      this.sessionId = String(params.thread?.id || params.thread?.sessionId || this.sessionId);
      this.emitEvent({ type: "session", sessionId: this.sessionId, model: this.options.model, permissionMode: this.options.permissionMode, slashCommands: this.inventory, at: now() });
      return;
    }
    if (method === "thread/status/changed") {
      const status = String(params.status?.type || "unknown");
      this.status = status === "active" ? "responding" : status;
      this.emitEvent({ type: "status", status: this.status, at: now() });
      return;
    }
    if (method === "turn/started") {
      this.activeTurnId = String(params.turn?.id || this.activeTurnId || "");
      this.status = "responding";
      this.turnState = "responding";
      this.emitEvent({ type: "status", status: "responding", at: now() });
      return;
    }
    if (method === "turn/completed") {
      this.activeTurnId = undefined;
      void this.emitTurnComplete(params.turn);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      this.lastUsage = normalizeCodexUsage(params.tokenUsage?.last || params.tokenUsage?.total);
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      this.normalizeItem(params.item, method === "item/started" ? "started" : "completed");
      return;
    }
    if (method === "item/agentMessage/delta") {
      const text = String(params.delta || params.text || "");
      if (text) {
        this.lastAssistantMessageAt = now();
        this.emitEvent({ type: "assistant_text_delta", text, at: now() });
      }
      return;
    }
    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
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
      const delta = String(params.delta || "");
      if (delta) {
        this.emitEvent({ type: "tool_call", id: String(params.itemId || ""), name: "shell", status: "started", source: "shell", outputDelta: delta, at: now() });
      }
      return;
    }
    if (method === "error") {
      this.finishWithError(new Error(String(params.error?.message || params.error || "Codex app-server error.")));
      return;
    }
    if (method === "skills/changed" || method === "app/list/updated") {
      // The skill/plugin inventory changed — re-discover so the palette updates.
      void this.refreshInventory();
      return;
    }
    if (method === "warning" || method === "configWarning" || method === "deprecationNotice" || method === "mcpServer/startupStatus/updated") {
      this.emitEvent({ type: "status", status: method, detail: compactJson(params), at: now() });
    }
  }

  private normalizeItem(item: any, status: "started" | "completed"): void {
    if (!item || typeof item !== "object") {
      return;
    }
    const id = String(item.id || `${item.type || "item"}-${Date.now()}`);
    if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
      this.lastAssistantMessageAt = now();
      this.emitEvent({ type: "assistant_text_delta", text: item.text, at: now() });
      return;
    }
    if (item.type === "reasoning") {
      const text = [...stringArray(item.summary), ...stringArray(item.content)].join("\n");
      if (text) {
        this.emitEvent({ type: "reasoning_delta", text, at: now() });
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
      this.emitEvent({ type: "tool_call", id, name: "web_search", input: { query: item.query }, status, source: "web", at: now() });
      return;
    }
    if (item.type === "imageGeneration") {
      this.emitEvent({ type: "tool_call", id, name: "image_generation", input: { revisedPrompt: item.revisedPrompt }, status, result: item.savedPath || item.result, source: "image", at: now() });
      return;
    }
    if (item.type === "imageView") {
      this.emitEvent({ type: "tool_call", id, name: "image_view", input: { path: item.path }, status, source: "image", at: now() });
      return;
    }
    if (item.type === "subAgentActivity") {
      this.emitEvent({ type: "status", status: "subagent", detail: `${item.kind || "activity"} · ${item.agentPath || item.agentThreadId || ""}`.trim(), at: now() });
      return;
    }
    if (item.type === "collabAgentToolCall") {
      this.emitEvent({ type: "status", status: "subagent", detail: `${item.tool || "collab"} → ${(item.receiverThreadIds || []).join(", ")}`.trim(), at: now() });
    }
  }

  private readStderr(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) {
        this.emitEvent({ type: "status", status: "stderr", detail: line.trim(), at: now() });
      }
    }
  }

  private async emitTurnComplete(turn: any): Promise<void> {
    this.status = turn?.status === "failed" ? "error" : "idle";
    this.turnState = turn?.status === "failed" ? "error" : "complete";
    if (turn?.error) {
      this.lastError = String(turn.error.message || JSON.stringify(turn.error));
    }
    if (this.status !== "error") {
      this.turnCount += 1;
    }
    this.activeTurn = false;
    const cost = await this.costResolver.resolve({
      providerId: "openai",
      model: this.options.model,
      runtimeModel: this.options.model,
      pricing: { billing: "subscription", directPrice: "Codex subscription" },
      usage: this.lastUsage,
    });
    this.emitEvent({ type: "turn_complete", result: this.status === "error" ? "error" : "ok", cost, at: now() });
    this.drainQueuedTurn();
  }

  private finishWithError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    this.status = "error";
    this.turnState = "error";
    this.activeTurn = false;
    this.emitEvent({ type: "error", message, at: now() });
    this.drainQueuedTurn();
  }

  private drainQueuedTurn(): void {
    this.activeTurn = false;
    const next = this.queuedTurns.shift();
    if (next) {
      void this.runTurn(next);
      return;
    }
    this.emit("snapshot", this.getSnapshot());
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.process = undefined;
    this.lineReader?.close();
    this.lineReader = undefined;
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error(`Codex app-server exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`));
    }
    this.pendingRequests.clear();
    if (!this.disposed && this.status !== "idle" && this.status !== "initialized") {
      this.finishWithError(new Error(`Codex app-server exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`));
    }
  }

  private shutdownProcess(): void {
    this.lineReader?.close();
    this.lineReader = undefined;
    this.process?.kill();
    this.process = undefined;
    this.pendingRequests.clear();
    this.pendingApprovals.clear();
  }

  private codexExecutableArgs(): string[] {
    if (this.options.executableArgs) {
      return this.options.executableArgs;
    }
    const raw = process.env.AGENTPARTY_CODEX_ARGS;
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  private emitEvent(event: ClaudeNormalizedEvent): void {
    this.lastEventAt = event.at;
    this.emit("event", event);
    this.emit("snapshot", this.getSnapshot());
  }
}

/** Maps a sandbox mode to the app-server `sandboxPolicy` object. */
function sandboxPolicyObject(mode: SandboxMode): unknown {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "workspace-write") {
    return { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
  return { type: "readOnly", networkAccess: false };
}

function effortFor(effort: ClaudeEffort): string | null {
  return effort === "xhigh" || effort === "max" ? "high" : effort;
}

function approvalTitle(kind: CodexApprovalKind): string {
  switch (kind) {
    case "command":
      return "명령 실행 승인";
    case "fileChange":
      return "파일 변경 승인";
    case "permissions":
      return "권한 상승 승인";
    case "userInput":
      return "Codex가 입력을 요청함";
    case "elicitation":
      return "MCP 서버 요청";
    default:
      return "Codex 승인 요청";
  }
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Resolves how to spawn the codex executable. A bare command name on Windows
 * (e.g. `codex` installed by npm) is a `.cmd` shim: `spawn` can't find the bare
 * name (ENOENT) and Node refuses to run a `.cmd` directly (EINVAL) — so let the
 * shell resolve it via PATHEXT. An explicit path or already-extensioned name
 * (e.g. `AGENTPARTY_CODEX_BIN`) is spawned directly.
 */
function resolveCodexExecutable(executable: string): { command: string; shell: boolean } {
  if (executable.includes("/") || executable.includes("\\") || path.extname(executable)) {
    return { command: executable, shell: false };
  }
  return { command: executable, shell: process.platform === "win32" };
}
