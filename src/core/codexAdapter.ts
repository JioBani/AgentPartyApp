import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { ClaudeEffort, ClaudeNormalizedEvent, ClaudeSessionSnapshot, HarnessCommand } from "./events";
import { DefaultTurnCostResolver } from "./costing";
import type { TurnUsage } from "./costing";
import type { PartyIdentity } from "./partyBridge";
import { buildPartyPrimer } from "./partyBridge";

export interface CodexAdapterOptions {
  id: string;
  cwd: string;
  model: string;
  effort: ClaudeEffort;
  permissionMode?: string;
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
  { name: "model", description: "Switch model" },
  { name: "approvals", description: "Change approval mode" },
  { name: "new", description: "Start a new conversation" },
  { name: "init", description: "Create an AGENTS.md for this repo" },
  { name: "compact", description: "Summarize to free context" },
  { name: "diff", description: "Show working-tree diff" },
  { name: "mention", description: "Mention a file", argumentHint: "<path>" },
  { name: "status", description: "Show session status" },
  { name: "mcp", description: "List MCP servers" },
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

  constructor(private readonly options: CodexAdapterOptions) {
    super();
    this.sessionId = options.resumeSessionId || "";
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
      slashCommands: CODEX_COMMANDS,
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
      slashCommands: CODEX_COMMANDS,
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
    this.emitEvent({ type: "status", status: "permission", detail: permissionMode, at: now() });
  }

  respondApproval(requestId: string, behavior?: "allow" | "deny", _updatedInput?: unknown, _message?: string): void {
    const approval = this.pendingApprovals.get(requestId);
    if (!approval) {
      this.emitEvent({ type: "error", message: `Unknown Codex approval request '${requestId}'.`, at: now() });
      return;
    }
    const decision = approvalDecision(approval.method, behavior === "allow");
    this.respond(requestId, decision);
    this.pendingApprovals.delete(requestId);
    this.emitEvent({ type: "approval_resolved", requestId, decision: behavior === "allow" ? "allow" : "deny", at: now() });
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
    const executable = this.options.executablePath || process.env.AGENTPARTY_CODEX_BIN || "codex";
    const spawnArgs = [...this.codexExecutableArgs(), "app-server"];
    this.process = spawn(executable, spawnArgs, {
      cwd: this.options.cwd,
      env: process.env,
      windowsHide: true,
    });
    this.lineReader = readline.createInterface({ input: this.process.stdout });
    this.lineReader.on("line", (line) => this.readMessage(line));
    this.process.stderr.on("data", (chunk) => this.readStderr(String(chunk)));
    this.process.on("error", (error) => this.finishWithError(error));
    this.process.on("exit", (code, signal) => this.handleExit(code, signal));
    this.emitEvent({ type: "status", status: "spawned", detail: [executable, ...spawnArgs].join(" "), at: now() });
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
      approvalPolicy: approvalPolicyFor(this.options.permissionMode),
      approvalsReviewer: "user",
      sandbox: sandboxModeFor(this.options.permissionMode),
    });
    this.applyThreadResult(result);
  }

  private async resumeThread(): Promise<void> {
    const result = await this.request("thread/resume", {
      threadId: this.sessionId,
      model: this.options.model,
      cwd: this.options.cwd,
      approvalPolicy: approvalPolicyFor(this.options.permissionMode),
      approvalsReviewer: "user",
      sandbox: sandboxModeFor(this.options.permissionMode),
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
      slashCommands: CODEX_COMMANDS,
      at: now(),
    });
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
        approvalPolicy: approvalPolicyFor(this.options.permissionMode),
        approvalsReviewer: "user",
        sandboxPolicy: sandboxPolicyFor(this.options.permissionMode),
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
    this.pendingApprovals.set(requestId, { method, input: message.params });
    this.emitEvent({
      type: "approval_request",
      requestId,
      toolName: method,
      input: message.params,
      title: "Codex approval request",
      description: approvalDescription(method, message.params),
      at: now(),
    });
  }

  private normalizeNotification(message: any): void {
    const method = String(message.method);
    const params = message.params || {};
    if (method === "thread/started") {
      this.sessionId = String(params.thread?.id || params.thread?.sessionId || this.sessionId);
      this.emitEvent({ type: "session", sessionId: this.sessionId, model: this.options.model, permissionMode: this.options.permissionMode, slashCommands: CODEX_COMMANDS, at: now() });
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
    if (method === "error") {
      this.finishWithError(new Error(String(params.error?.message || params.error || "Codex app-server error.")));
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
    if (item.type === "commandExecution") {
      this.emitEvent({ type: "tool_call", id, name: "command_execution", input: item.command, status, result: item.aggregatedOutput || item.exitCode, at: now() });
      return;
    }
    if (item.type === "fileChange") {
      this.emitEvent({ type: "file_change", filePath: undefined, input: item.changes, result: item.status, at: now() });
      return;
    }
    if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
      this.emitEvent({ type: "tool_call", id, name: item.tool || item.server || "tool", input: item.arguments, status, result: item.result || item.contentItems || item.error, at: now() });
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

function approvalPolicyFor(permissionMode: string | undefined): unknown {
  if (permissionMode === "bypassPermissions" || permissionMode === "dontAsk") {
    return "never";
  }
  return "on-request";
}

function sandboxModeFor(permissionMode: string | undefined): string {
  if (permissionMode === "bypassPermissions" || permissionMode === "dontAsk") {
    return "danger-full-access";
  }
  if (permissionMode === "acceptEdits" || permissionMode === "auto") {
    return "workspace-write";
  }
  return "read-only";
}

function sandboxPolicyFor(permissionMode: string | undefined): unknown {
  const mode = sandboxModeFor(permissionMode);
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

function approvalDecision(method: string, allowed: boolean): unknown {
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: allowed ? "approved" : "denied" };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: allowed ? "accept" : "decline" };
  }
  if (method === "item/commandExecution/requestApproval") {
    return { decision: allowed ? "accept" : "decline" };
  }
  return { decision: allowed ? "accept" : "decline" };
}

function approvalDescription(method: string, input: any): string {
  if (method === "item/commandExecution/requestApproval") {
    return String(input?.command || input?.reason || "Codex wants to run a command.");
  }
  if (method === "item/fileChange/requestApproval") {
    return String(input?.reason || input?.grantRoot || "Codex wants to change files.");
  }
  return method;
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
