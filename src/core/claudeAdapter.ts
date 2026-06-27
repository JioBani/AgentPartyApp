import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { DefaultTurnCostResolver, TurnUsage } from "./costing";
import { ClaudeEffort, ClaudeNormalizedEvent, ClaudeSessionSnapshot } from "./events";
import { buildModelRoutes, displayModelFor, inferModelProvider, ModelProviderId, ModelRoute, ModelRouteConfig, runtimeModelFor } from "./modelRegistry";
import { RawLogger } from "./rawLogger";
import type { RouterTurnUsage } from "./routerShim";

export interface ClaudeAdapterOptions {
  id: string;
  cwd: string;
  executablePath?: string;
  model: string;
  providerId?: ModelProviderId;
  effort: ClaudeEffort;
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

export class ClaudeAdapter extends EventEmitter {
  private logger: RawLogger | undefined;
  private input = new AsyncInputQueue();
  private query: Query | undefined;
  private abortController: AbortController | undefined;
  private started = false;
  private currentStatus = "created";
  private turnState: string | undefined;
  private sessionId = "";
  private permissionMode: PermissionMode = "default";
  private model: string;
  private runtimeModel: string;
  private providerId: ModelProviderId;
  private effort: ClaudeEffort;
  private resumeSessionId: string | undefined;
  private turnCount = 0;
  private lastEventAt: string | undefined;
  private lastUserMessageAt: string | undefined;
  private lastAssistantMessageAt: string | undefined;
  private lastError: string | undefined;
  private supportedSlashCommands: string[] = [];
  private supportedModels: ModelRoute[] = [];
  private currentRoute: ModelRoute | undefined;
  private readonly costResolver = new DefaultTurnCostResolver();
  private debugMode: boolean;
  private readonly queuedUserTurns: string[] = [];
  private lastStatusKey: string | undefined;
  private lastStatusAt = 0;
  private readonly pendingApprovals = new Map<
    string,
    {
      resolve: (result: PermissionResult) => void;
      toolName: string;
      input: Record<string, unknown>;
      toolUseID: string;
    }
  >();
  private readonly activeTools = new Map<string, { id: string; name: string; input?: unknown }>();
  private readonly startedAt = new Date().toISOString();

  constructor(private readonly options: ClaudeAdapterOptions) {
    super();
    this.model = displayModelFor(options.model);
    this.runtimeModel = runtimeModelFor(options.model, options.customModelRoutes);
    this.providerId = options.providerId || inferModelProvider(options.model, options.customModelRoutes);
    this.currentRoute = this.resolveCurrentRoute();
    this.effort = options.effort;
    this.permissionMode = options.permissionMode || "default";
    this.resumeSessionId = options.resumeSessionId;
    this.debugMode = options.debugEnabled;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.currentStatus = "starting";
    this.abortController = new AbortController();
    this.input = new AsyncInputQueue();
    this.ensureLogger();

    void this.run();
  }

  sendUserTurn(text: string): void {
    if (!this.started) {
      this.start();
    }
    if (this.isTurnActive()) {
      this.queuedUserTurns.push(text);
      this.emitEvent({ type: "status", status: "queued", detail: `${this.queuedUserTurns.length} message(s) queued`, at: now() });
      return;
    }
    this.dispatchUserTurn(text);
  }

  interrupt(): void {
    if (!this.query) {
      this.emitEvent({ type: "status", status: "interrupt", detail: "no active query", at: now() });
      return;
    }
    this.currentStatus = "interrupting";
    this.turnState = "interrupting";
    void this.query.interrupt().then(
      () => this.emitEvent({ type: "status", status: "interrupt", detail: "requested", at: now() }),
      (error) => this.emitError(error),
    );
    this.emit("snapshot", this.getSnapshot());
  }

  private dispatchUserTurn(text: string): void {
    this.resetRouterTurnUsage();
    this.input.push({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
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
    this.emitEvent({ type: "status", status: "sent", detail: text, at: now() });
  }

  compact(): void {
    this.sendUserTurn("/compact");
  }

  setModel(model: string, providerId?: string, runtimeModel?: string): void {
    const previousUsesRouter = this.usesRouterBackend();
    this.model = displayModelFor(model);
    this.runtimeModel = runtimeModel || runtimeModelFor(model, this.options.customModelRoutes);
    this.providerId = asModelProviderId(providerId) || inferModelProvider(model, this.options.customModelRoutes);
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

  setThinking(enabled: boolean, mode?: string): void {
    this.emitEvent({
      type: "status",
      status: "thinking",
      detail: `not supported by Claude Code route yet (${enabled ? mode || "enabled" : "disabled"})`,
      at: now(),
    });
  }

  setPermissionMode(permissionMode: string): void {
    this.permissionMode = permissionMode as PermissionMode;
    if (!this.query) {
      return;
    }
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

  respondApproval(requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      this.emitEvent({ type: "error", message: `No pending permission request for ${requestId}.`, at: now() });
      return;
    }

    const result: PermissionResult =
      behavior === "allow"
        ? {
            behavior: "allow",
            updatedInput: asRecord(updatedInput) ?? pending.input,
            toolUseID: pending.toolUseID,
            decisionClassification: "user_temporary",
          }
        : {
            behavior: "deny",
            message: message || "Denied by user",
            toolUseID: pending.toolUseID,
            decisionClassification: "user_reject",
          };

    this.emitEvent({ type: "approval_resolved", requestId, decision: behavior, at: now() });
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
  }

  restart(resumeCurrentSession = false): void {
    if (resumeCurrentSession && this.sessionId) {
      this.resumeSessionId = this.sessionId;
    } else if (!resumeCurrentSession) {
      this.resumeSessionId = this.options.resumeSessionId;
    }
    this.dispose();
    this.sessionId = "";
    this.started = false;
    this.pendingApprovals.clear();
    this.activeTools.clear();
    this.queuedUserTurns.length = 0;
    this.start();
  }

  getSnapshot(): ClaudeSessionSnapshot {
    return {
      id: this.options.id,
      cwd: this.options.cwd,
      sessionId: this.sessionId || undefined,
      model: this.model,
      effort: this.effort,
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
    };
  }

  dispose(): void {
    this.input.close();
    this.abortController?.abort();
    this.query?.close();
    this.query = undefined;
    this.started = false;
    this.currentStatus = "closed";
    this.logger?.close();
  }

  private async run(): Promise<void> {
    try {
      const sdk = await loadSdk();
      const executable = resolveClaudeExecutable(this.options.executablePath);
      if (this.usesRouterBackend() && !isRoutableRouterModel(this.runtimeModel)) {
        throw new Error(`No explicit AgentParty router mapping for '${this.model}' (${this.runtimeModel}). Refusing to fall back to another model.`);
      }
      if (this.usesRouterBackend()) {
        this.emitEvent({ type: "status", status: "router-check", detail: this.options.routerBaseUrl, at: now() });
        await assertRouterReachable(this.options.routerBaseUrl);
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
        permissionMode: this.permissionMode,
        allowDangerouslySkipPermissions: this.permissionMode === "bypassPermissions",
        resume: this.resumeSessionId,
        canUseTool: this.canUseTool,
        includePartialMessages: true,
        includeHookEvents: true,
        enableFileCheckpointing: true,
        tools: { type: "preset", preset: "claude_code" },
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
      this.currentStatus = "spawned";
      this.emitEvent({ type: "status", status: "spawned", detail: executable, at: now() });

      void this.initializeQueryMetadata();
      for await (const message of this.query) {
        this.log("sdk_message", message);
        await this.normalize(message);
      }
      this.currentStatus = "closed";
      this.emitEvent({ type: "status", status: "closed", at: now() });
    } catch (error) {
      this.emitError(error);
    } finally {
      this.started = false;
      this.logger?.close();
    }
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const requestId = options.toolUseID || `permission-${Date.now()}`;

    return await new Promise<PermissionResult>((resolve) => {
      this.pendingApprovals.set(requestId, { resolve, toolName, input, toolUseID: options.toolUseID });
      this.log("permission_request", { requestId, toolName, input, options: scrubPermissionOptions(options) });
      this.emitEvent({
        type: "approval_request",
        requestId,
        toolName,
        input: withFilePath(input),
        title: options.title || options.displayName,
        description: options.description || options.decisionReason,
        suggestions: options.suggestions,
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
      this.supportedSlashCommands = (init.commands || []).map((command: any) => command.name || command.command || String(command));
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
    } catch (error) {
      this.emitError(error);
    }
  }

  private async normalize(message: SDKMessage): Promise<void> {
    if ((message as any).session_id) {
      this.sessionId = (message as any).session_id || this.sessionId;
    }

    if (message.type === "system") {
      this.normalizeSystem(message as any);
      return;
    }

    if (message.type === "stream_event") {
      this.normalizeStreamEvent((message as any).event);
      return;
    }

    if (message.type === "assistant") {
      this.lastAssistantMessageAt = now();
      this.normalizeAssistantSnapshot((message as any).message);
      return;
    }

    if (message.type === "user") {
      this.normalizeUserSnapshot((message as any).message);
      return;
    }

    if (message.type === "result") {
      this.currentStatus = "idle";
      this.turnState = "complete";
      if ((message as any).is_error) {
        const errorMessage = Array.isArray((message as any).errors) && (message as any).errors.length > 0
          ? (message as any).errors.join("; ")
          : (message as any).result || (message as any).subtype || "Claude returned an error result.";
        this.lastError = errorMessage;
        this.emitEvent({ type: "error", message: errorMessage, at: now() });
        this.drainQueuedTurn();
        return;
      }
      const harnessCostUsd = typeof (message as any).total_cost_usd === "number" ? (message as any).total_cost_usd : undefined;
      const usage = mergeUsage(extractUsage(message), this.consumeRouterTurnUsage());
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
        at: now(),
      });
      this.drainQueuedTurn();
      return;
    }

    if (message.type === "rate_limit_event") {
      this.emitStatus("rate_limit", JSON.stringify((message as any).rate_limit_info));
    }
  }

  private normalizeSystem(message: any): void {
    if (message.subtype === "init") {
      this.sessionId = message.session_id || this.sessionId;
      this.runtimeModel = message.model || this.runtimeModel;
      this.model = displayModelFor(this.runtimeModel);
      this.providerId = inferModelProvider(this.runtimeModel, this.options.customModelRoutes);
      this.currentRoute = this.resolveCurrentRoute();
      this.permissionMode = message.permissionMode || this.permissionMode;
      this.currentStatus = "initialized";
      this.emitEvent({
        type: "session",
        sessionId: this.sessionId,
        model: this.model,
        permissionMode: this.permissionMode,
        tools: message.tools,
        slashCommands: message.slash_commands,
        models: this.supportedModels,
        at: now(),
      });
      return;
    }

    if (message.subtype === "status" || message.subtype === "session_state_changed") {
      this.currentStatus = message.status || message.state || "idle";
      this.turnState = message.state || this.turnState;
      this.emitStatus(this.currentStatus, message.permissionMode || message.compact_result || message.compact_error);
      return;
    }

    if (message.subtype === "thinking_tokens") {
      this.emitEvent({ type: "thinking_tokens", estimatedTokens: message.estimated_tokens || 0, delta: message.estimated_tokens_delta, at: now() });
      return;
    }

    if (message.subtype === "commands_changed") {
      this.supportedSlashCommands = (message.commands || []).map((command: any) => command.name || command.command || String(command));
      this.emitStatus("commands_changed", `${this.supportedSlashCommands.length} slash commands`);
      return;
    }

    if (message.subtype === "permission_denied") {
      this.emitEvent({ type: "tool_call", id: message.tool_use_id, name: message.tool_name, input: withFilePath(message.tool_input), status: "failed", result: message.message, at: now() });
      return;
    }

    if (message.subtype === "task_started" || message.subtype === "task_updated" || message.subtype === "task_progress" || message.subtype === "tool_use_summary") {
      this.emitStatus(message.subtype, message.summary || message.description || message.status);
      return;
    }

    if (message.subtype === "compact_boundary") {
      this.emitStatus("compact", JSON.stringify(message.compact_metadata));
    }
  }

  private normalizeStreamEvent(event: any): void {
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
      };
      this.activeTools.set(String(event.index), tool);
      this.emitEvent({ type: "tool_call", ...tool, status: "started", at: now() });
      return;
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        this.lastAssistantMessageAt = now();
        this.emitEvent({ type: "assistant_text_delta", text: delta.text, blockIndex: event.index, at: now() });
      } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
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
        this.emitEvent({ type: "tool_call", ...tool, status: "completed", at: now() });
        this.activeTools.delete(String(event.index));
      }
    }
  }

  private normalizeAssistantSnapshot(message: any): void {
    for (const item of message?.content || []) {
      if (item?.type === "tool_use") {
        this.emitEvent({ type: "tool_call", id: item.id || item.name || `tool-${Date.now()}`, name: item.name || "tool", input: withFilePath(item.input), status: "started", at: now() });
      } else if (item?.type === "tool_result") {
        this.emitEvent({ type: "tool_call", id: item.tool_use_id || `tool-result-${Date.now()}`, name: "tool_result", status: item.is_error ? "failed" : "completed", result: item.content, at: now() });
      }
    }
  }

  private normalizeUserSnapshot(message: any): void {
    for (const item of message?.content || []) {
      if (item?.type === "tool_result") {
        this.emitEvent({ type: "tool_call", id: item.tool_use_id || `tool-result-${Date.now()}`, name: "tool_result", status: item.is_error ? "failed" : "completed", result: item.content, at: now() });
      }
    }
  }

  private emitError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    this.currentStatus = "error";
    this.emitEvent({ type: "error", message, at: now() });
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
    return this.providerId !== "anthropic" || !isNativeClaudeModel(this.runtimeModel);
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
    this.dispatchUserTurn(next);
  }

  private ensureLogger(): void {
    if (!this.debugMode || this.logger) {
      return;
    }
    this.logger = new RawLogger({
      baseDir: path.join(this.options.storageDir, "logs"),
      sessionId: this.options.id,
      maxFiles: 10,
      maxBytes: 2 * 1024 * 1024,
    });
  }
}

async function loadSdk(): Promise<SdkModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<SdkModule>;
  return await dynamicImport("@anthropic-ai/claude-agent-sdk");
}

function resolveClaudeExecutable(configured: string | undefined): string | undefined {
  if (configured && configured.trim()) {
    return configured.trim();
  }

  const packagedExecutable = resolvePackagedClaudeExecutable();
  if (packagedExecutable) {
    return packagedExecutable;
  }

  // Let @anthropic-ai/claude-agent-sdk resolve its matching bundled native binary.
  // This mirrors the official extension's "SDK + matching Claude binary" boundary.
  return undefined;
}

function resolvePackagedClaudeExecutable(): string | undefined {
  const resourcesPath = process.resourcesPath;
  if (!resourcesPath || !fs.existsSync(resourcesPath)) {
    return undefined;
  }
  const packageName = claudeNativePackageName();
  if (!packageName) {
    return undefined;
  }
  const executableName = process.platform === "win32" ? "claude.exe" : "claude";
  const executablePath = path.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "node_modules",
    packageName,
    executableName,
  );
  return fs.existsSync(executablePath) ? executablePath : undefined;
}

function claudeNativePackageName(): string | undefined {
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "";
  if (!arch) {
    return undefined;
  }
  if (process.platform === "win32") {
    return `@anthropic-ai/claude-agent-sdk-win32-${arch}`;
  }
  if (process.platform === "darwin") {
    return `@anthropic-ai/claude-agent-sdk-darwin-${arch}`;
  }
  if (process.platform === "linux") {
    return `@anthropic-ai/claude-agent-sdk-linux-${arch}`;
  }
  return undefined;
}

function now(): string {
  return new Date().toISOString();
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

function withFilePath(value: unknown): unknown {
  const record = asRecord(value);
  if (!record || record.filePath) {
    return value;
  }
  const filePath = extractToolFilePath(record);
  if (typeof filePath !== "string" || !filePath) {
    return value;
  }
  return { ...record, filePath };
}

function extractToolFilePath(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of ["filePath", "file_path", "path", "notebook_path", "filename"]) {
    const field = record[key];
    if (typeof field === "string" && field) {
      return field;
    }
  }
  return undefined;
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

function isNativeClaudeModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower === "default" ||
    lower === "opus" ||
    lower === "opus[1m]" ||
    lower === "sonnet" ||
    lower === "haiku" ||
    lower.startsWith("claude-sonnet") ||
    lower.startsWith("claude-opus") ||
    lower.startsWith("claude-haiku")
  );
}

function isRoutableRouterModel(model: string): boolean {
  return new Set([
    "claude-gpt-5.5",
    "claude-gpt-5.4",
    "claude-gpt-5.4-mini",
    "claude-glm",
    "claude-minimax",
    "claude-qwen",
    "claude-coder",
    "claude-deepseek-flash",
    "claude-deepseek-pro",
  ]).has(model);
}

async function assertRouterReachable(baseUrl: string): Promise<void> {
  const target = parseRouterTarget(baseUrl);
  const ok = await canConnect(target.host, target.port, 1200);
  if (!ok) {
    throw new Error(
      `AgentParty router is not reachable at ${target.host}:${target.port} (${baseUrl}). ` +
        "Start the local router before using router-backed models such as MiniMax M3; refusing to let Claude Code retry against an unavailable backend.",
    );
  }
  const health = await readRouterHealth(baseUrl);
  if (health && health.openRouterConfigured === false) {
    throw new Error(
      "AgentParty Native embedded router is running, but OpenRouter is not configured. " +
        "Set agentpartyNative.router.openRouterApiKey or OPENROUTER_API_KEY before using router-backed models such as MiniMax M3.",
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

async function readRouterHealth(baseUrl: string): Promise<{ openRouterConfigured?: boolean } | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(new URL("/health", baseUrl), { signal: controller.signal });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as { openRouterConfigured?: boolean };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
