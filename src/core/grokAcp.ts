/**
 * ACP (JSON-RPC over stdio) client for the official Grok Build CLI.
 *
 * Kept separate from {@link ./cursorAcp} deliberately. Both speak ACP, but what
 * they speak around it does not overlap: Grok Build carries a vendor
 * `_x.ai/*` notification stream (models, settings, session list, hooks, prompt
 * completion), sets model and mode through methods Cursor does not implement,
 * and — unlike the Cursor bridge, which auto-approves because the CALLING
 * harness owns approval — is itself the harness a member runs on. Sharing one
 * class would couple two contracts that are only superficially alike.
 *
 * Everything below was measured against `grok 1.0.0 (3cd0d0cbce)` on
 * 2026-08-10; the method-support notes are what the binary actually answered,
 * not what the docs claim.
 */
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as readline from "node:readline";
import { grokAgentStdioArgs, type GrokReasoningEffort } from "./grokAgentCli";
import type { GrokBillingResult } from "./grokUsage";

export interface GrokAcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface GrokAcpOptions {
  /** Resolved `grok` executable (see resolveGrokCli). */
  command: string;
  cwd: string;
  /** Existing Grok thread to load instead of creating a context-empty session. */
  resumeSessionId?: string;
  /** Applied by the CLI when the ACP agent starts; ACP cannot mutate it live. */
  reasoningEffort?: GrokReasoningEffort;
  mcpServers?: GrokAcpMcpServer[];
  /** Extra environment for the child (isolation knobs, GROK_HOME, …). */
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export interface GrokAcpModel {
  modelId: string;
  name: string;
  description?: string;
  contextTokens?: number;
  supportsReasoningEffort?: boolean;
}

export interface GrokAcpToolCall {
  toolCallId: string;
  title: string;
  /** Stable vendor tool id from xAI metadata (the title may be rewritten into a full human-readable command). */
  name?: string;
  kind?: string;
  status?: string;
  readOnly?: boolean;
  locations?: Array<{ path: string }>;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
}

export interface GrokAcpPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface GrokAcpPermissionRequest {
  requestId: string;
  sessionId: string;
  toolCall: GrokAcpToolCall;
  options: GrokAcpPermissionOption[];
}

export type GrokAcpPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface GrokAcpHandlers {
  onText?: (text: string) => void;
  onThought?: (text: string) => void;
  onToolCall?: (call: GrokAcpToolCall) => void;
  onToolCallUpdate?: (call: GrokAcpToolCall) => void;
  onPlan?: (plan: unknown) => void;
  onCommands?: (commands: Array<{ name: string; description?: string }>) => void;
  /** Running context occupancy, carried on every update's `_meta.totalTokens`. */
  onContextTokens?: (tokens: number) => void;
  onPermissionRequest?: (request: GrokAcpPermissionRequest) => Promise<GrokAcpPermissionOutcome> | GrokAcpPermissionOutcome;
}

export interface GrokAcpTurnResult {
  stopReason: string;
  text: string;
  thought: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  costUsd?: number;
}

type GrokTurnUsage = NonNullable<GrokAcpTurnResult["usage"]>;

/**
 * Normalizes the vendor `turn_completed` usage shape.
 *
 * Grok's ACP extension reports `inputTokens` as prompt tokens INCLUDING both
 * cache buckets (`totalTokens === inputTokens + outputTokens`). AgentParty's
 * ledger keeps those buckets disjoint, so subtract them here. The alternate
 * branch also accepts the headless snake_case shape, whose input bucket is
 * already uncached.
 */
export function grokAcpTurnUsage(raw: any): GrokTurnUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const finite = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return undefined;
  };
  const inputReported = finite(raw.inputTokens, raw.input_tokens);
  const output = finite(raw.outputTokens, raw.output_tokens) ?? 0;
  const cacheRead = finite(raw.cachedReadTokens, raw.cacheReadInputTokens, raw.cache_read_input_tokens) ?? 0;
  const cacheWrite = finite(raw.cacheCreationTokens, raw.cacheWriteInputTokens, raw.cache_creation_input_tokens) ?? 0;
  const reasoning = finite(raw.reasoningTokens, raw.reasoning_tokens) ?? 0;
  const total = finite(raw.totalTokens, raw.total_tokens);
  if (inputReported == null && total == null) return undefined;

  const inputIncludesCache = inputReported != null
    && total != null
    && Math.abs(total - (inputReported + output)) < 0.5;
  const input = inputReported == null
    ? Math.max(0, (total ?? 0) - output - cacheRead - cacheWrite)
    : Math.max(0, inputReported - (inputIncludesCache ? cacheRead + cacheWrite : 0));
  return { input, output, cacheRead, cacheWrite, reasoning };
}

export function grokAcpTurnCostUsd(raw: any): number | undefined {
  const direct = Number(raw?.costUsd ?? raw?.cost_usd);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const ticks = Number(raw?.costUsdTicks ?? raw?.cost_usd_ticks);
  return Number.isFinite(ticks) && ticks >= 0 ? ticks / 10_000_000_000 : undefined;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export function grokAcpOpenRequest(options: Pick<GrokAcpOptions, "cwd" | "mcpServers" | "resumeSessionId">): {
  method: "session/new" | "session/load";
  params: { cwd: string; mcpServers: GrokAcpMcpServer[]; sessionId?: string };
} {
  const resumeSessionId = options.resumeSessionId;
  return {
    method: resumeSessionId ? "session/load" : "session/new",
    params: {
      ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
      cwd: options.cwd,
      mcpServers: options.mcpServers ?? [],
    },
  };
}

export class GrokAcpSession {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private sessionId = "";
  private models: GrokAcpModel[] = [];
  private currentModelId = "";
  private stderrTail = "";
  private brokenReason: string | undefined;
  private active: { handlers: GrokAcpHandlers; text: string[]; thought: string[]; usage?: GrokTurnUsage; costUsd?: number } | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: GrokAcpOptions) {}

  get broken(): string | undefined {
    return this.brokenReason;
  }

  get availableModels(): GrokAcpModel[] {
    return this.models;
  }

  get model(): string {
    return this.currentModelId;
  }

  get acpSessionId(): string {
    return this.sessionId;
  }

  /** Account credit usage, fetched by the official CLI with its own login. */
  async billingUsage(): Promise<GrokBillingResult> {
    this.assertUsable();
    return await this.request("_x.ai/billing", {}) as GrokBillingResult;
  }

  /** initialize → authenticate → session/load (resume) or session/new. */
  async start(): Promise<void> {
    const child = spawn(this.options.command, grokAgentStdioArgs(this.options.reasoningEffort), {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.options.env },
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.on("error", (error) => this.markBroken(`grok agent stdio failed to spawn: ${error.message}`));
    child.on("close", (code) => this.markBroken(`grok agent stdio exited (code ${code}). ${this.stderrTail.slice(-300)}`.trim()));

    readline.createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));

    const init: any = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "agentparty", version: "1.0.0" },
    });
    this.readModelState(init?._meta?.modelState);

    // `cached_token` is the credential `grok login` already wrote; the API-key
    // method is only offered when XAI_API_KEY is set. Picking from the offered
    // list (rather than hardcoding) is what keeps this working when the user is
    // signed in one way and not the other.
    const methods: string[] = (init?.authMethods ?? []).map((method: any) => method?.id).filter(Boolean);
    const methodId = methods.includes("cached_token") ? "cached_token" : methods[0];
    if (!methodId) {
      throw new Error("Grok Build offered no authentication method. Run `grok login`. No fallback was attempted.");
    }
    await this.request("authenticate", { methodId, _meta: { headless: true } });

    const resumeSessionId = this.options.resumeSessionId;
    if (resumeSessionId && init?.agentCapabilities?.loadSession !== true) {
      throw new Error(
        `Grok Build does not advertise ACP session loading, so thread '${resumeSessionId}' cannot be resumed. ` +
        "The existing conversation was left intact; no empty replacement session was created.",
      );
    }
    const { method, params } = grokAcpOpenRequest(this.options);
    const session: any = await this.request(method, params);
    const sessionId = session?.sessionId || resumeSessionId;
    if (!sessionId) {
      throw new Error(`Grok Build ACP ${method} returned no sessionId.`);
    }
    this.sessionId = sessionId;
    this.readModelState(session?.models);
  }

  /** One user turn. ACP allows one in-flight prompt per session, so these queue. */
  prompt(text: string, handlers: GrokAcpHandlers = {}): Promise<GrokAcpTurnResult> {
    const run = this.queue.then(async () => {
      this.assertUsable();
      const active: NonNullable<typeof this.active> = { handlers, text: [], thought: [] };
      this.active = active;
      try {
        const result: any = await this.request(
          "session/prompt",
          { sessionId: this.sessionId, prompt: [{ type: "text", text }] },
          0,
        );
        const rawUsage = result?._meta?.usage;
        return {
          stopReason: result?.stopReason || "end_turn",
          text: active.text.join(""),
          thought: active.thought.join(""),
          usage: active.usage ?? grokAcpTurnUsage(rawUsage),
          costUsd: active.costUsd ?? grokAcpTurnCostUsd(rawUsage),
        };
      } finally {
        this.active = undefined;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  cancel(): void {
    if (this.child && this.sessionId) {
      this.notify("session/cancel", { sessionId: this.sessionId });
    }
  }

  /**
   * Switches the model. Verified working; note that `session/set_config_option`
   * — the route Cursor uses — answers -32601 for every configId on this build,
   * so it is not an alternative here.
   */
  async setModel(modelId: string): Promise<void> {
    this.assertUsable();
    const known = this.models.some((model) => model.modelId === modelId);
    if (!known) {
      throw new Error(
        `Grok Build does not offer model '${modelId}' (has: ${this.models.map((m) => m.modelId).join(", ") || "none"}). Refusing to fall back.`,
      );
    }
    await this.request("session/set_model", { sessionId: this.sessionId, modelId });
    this.currentModelId = modelId;
  }

  /**
   * Switches plan mode. Only `normal` and `plan` take effect — the agent
   * returns OK for ANY string but emits `current_mode_update` for just these
   * two, so anything else is rejected here instead of silently doing nothing.
   */
  async setMode(mode: "normal" | "plan"): Promise<void> {
    this.assertUsable();
    await this.request("session/set_mode", { sessionId: this.sessionId, modeId: mode });
  }

  dispose(reason = "disposed"): void {
    this.markBroken(reason);
  }

  private readModelState(state: any): void {
    const available = state?.availableModels;
    if (Array.isArray(available)) {
      this.models = available.map((model: any) => ({
        modelId: model.modelId,
        name: model.name || model.modelId,
        description: model.description,
        contextTokens: Number(model?._meta?.totalContextTokens) || undefined,
        supportsReasoningEffort: Boolean(model?._meta?.supportsReasoningEffort),
      }));
    }
    if (state?.currentModelId) {
      this.currentModelId = state.currentModelId;
    }
  }

  private assertUsable(): void {
    if (this.brokenReason) {
      throw new Error(`Grok Build session is unavailable: ${this.brokenReason}`);
    }
    if (!this.child || !this.sessionId) {
      throw new Error("Grok Build session was used before start() completed.");
    }
  }

  private markBroken(reason: string): void {
    if (this.brokenReason) {
      return;
    }
    this.brokenReason = reason;
    const error = new Error(reason);
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.reject(error);
    }
    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      this.child = undefined;
    }
  }

  private onLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line.replace(/\r$/, ""));
    } catch {
      return;
    }
    if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(message.id);
      if (!entry) {
        return;
      }
      this.pending.delete(message.id);
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      if (message.error) {
        entry.reject(new Error(message.error.message || `Grok Build ACP error on request ${message.id}.`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    this.onServerMessage(message);
  }

  private onServerMessage(message: any): void {
    if (message.method === "session/update" || message.method === "_x.ai/session/update") {
      this.onSessionUpdate(message.params);
      return;
    }
    if (message.method === "_x.ai/models/update") {
      this.readModelState(message.params);
      return;
    }
    if (message.method === "session/request_permission" && message.id != null) {
      const handler = this.active?.handlers.onPermissionRequest;
      if (!handler) {
        // An empty object is not a valid ACP permission response; Grok treats
        // it as a client failure and aborts the entire turn.
        this.respond(message.id, { outcome: { outcome: "cancelled" } });
        return;
      }
      const params = message.params || {};
      const tool = params.toolCall || {};
      const request: GrokAcpPermissionRequest = {
        requestId: String(message.id),
        sessionId: String(params.sessionId || this.sessionId),
        toolCall: {
          toolCallId: String(tool.toolCallId || `permission-${message.id}`),
          title: String(tool.title || tool.kind || "tool"),
          name: tool?._meta?.["x.ai/tool"]?.name,
          kind: tool.kind || tool?._meta?.["x.ai/tool"]?.kind,
          status: tool.status,
          rawInput: tool.rawInput,
        },
        options: Array.isArray(params.options) ? params.options : [],
      };
      Promise.resolve().then(() => handler(request)).then(
        (outcome) => this.respond(message.id, { outcome }),
        () => this.respond(message.id, { outcome: { outcome: "cancelled" } }),
      );
      return;
    }
    // Every other server->client request gets an empty result so a turn can
    // never hang waiting on a response this client does not model.
    if (message.id != null && message.method) {
      this.respond(message.id, {});
    }
  }

  private onSessionUpdate(params: any): void {
    const update = params?.update;
    const totalTokens = Number(params?._meta?.totalTokens);
    if (Number.isFinite(totalTokens) && totalTokens > 0) {
      this.active?.handlers.onContextTokens?.(totalTokens);
    }
    if (!update) {
      return;
    }
    const text = update?.content?.text;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (typeof text === "string" && text) {
          this.active?.text.push(text);
          this.active?.handlers.onText?.(text);
        }
        return;
      case "agent_thought_chunk":
        if (typeof text === "string" && text) {
          this.active?.thought.push(text);
          this.active?.handlers.onThought?.(text);
        }
        return;
      case "tool_call":
      case "tool_call_update": {
        const call: GrokAcpToolCall = {
          toolCallId: update.toolCallId,
          title: update.title || update.kind || "tool",
          name: update?._meta?.["x.ai/tool"]?.name,
          kind: update.kind || update?._meta?.["x.ai/tool"]?.kind,
          status: update.status || params?._meta?.updateParams?.status,
          readOnly: update?._meta?.["x.ai/tool"]?.read_only,
          locations: Array.isArray(update.locations) ? update.locations : undefined,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          content: update.content,
        };
        if (update.sessionUpdate === "tool_call") {
          this.active?.handlers.onToolCall?.(call);
        } else {
          this.active?.handlers.onToolCallUpdate?.(call);
        }
        return;
      }
      case "plan":
        this.active?.handlers.onPlan?.(update);
        return;
      case "available_commands_update":
        this.active?.handlers.onCommands?.(update.availableCommands || []);
        return;
      case "turn_completed":
        if (this.active) {
          this.active.usage = grokAcpTurnUsage(update.usage);
          this.active.costUsd = grokAcpTurnCostUsd(update.usage);
        }
        return;
      default:
    }
  }

  private request(method: string, params: object, timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.child) {
      return Promise.reject(new Error(this.brokenReason || "grok agent stdio is not running."));
    }
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Grok Build ACP ${method} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
    });
  }

  private notify(method: string, params: object): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private respond(id: number, result: object): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }
}
