import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import { resolveCursorAgentCommand } from "./cursorAgentCli";

/**
 * Minimal ACP (Agent Client Protocol) client for the Cursor Agent CLI.
 *
 * Speaks JSON-RPC over stdio to a `cursor-agent acp` child. This is the
 * transport half of the Cursor cross-harness bridge: one live child holds one
 * ACP session, and the bridge layer above maps Anthropic Messages turns onto
 * `session/prompt` calls (see the Cursor integration documentation).
 *
 * Everything here was measured against the real CLI before being written:
 *   - session/new returns the LIVE model catalog (modelId encodes variants,
 *     e.g. "grok-4.5[effort=high,fast=true]") — never guess model ids.
 *   - `session/request_permission` is how MCP tool calls get approved. The
 *     bridge auto-approves: tool EXECUTION belongs to the calling harness; the
 *     only "tools" visible here are the bridge's own relay.
 *   - `session/cancel` is a notification; the in-flight prompt resolves with
 *     stopReason "cancelled" and the session stays usable.
 *   - fs/terminal client capabilities stay OFF so the agent cannot touch the
 *     workspace behind the calling harness's back.
 */

export interface CursorAcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface CursorAcpSessionOptions {
  /** Explicit cursor-agent executable (settings override); resolved otherwise. */
  executablePath?: string;
  /** Workspace directory the ACP session runs in. */
  cwd: string;
  /** ACP modelId to pin (from the session's own availableModels). */
  modelId?: string;
  /** MCP servers the agent should spawn (the bridge's tool relay). */
  mcpServers?: CursorAcpMcpServer[];
  /** Per-request JSON-RPC timeout (default 120s; prompts get no timeout). */
  requestTimeoutMs?: number;
}

export interface CursorAcpModel {
  modelId: string;
  name: string;
}

export interface CursorAcpPromptHandlers {
  onChunk?: (text: string) => void;
  onThought?: (text: string) => void;
}

/** ACP prompt content blocks (verified live: text and base64 image). */
export type CursorAcpPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface CursorAcpPromptResult {
  stopReason: string;
  text: string;
  thought: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

interface PendingEntry {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

/** One `cursor-agent acp` child owning one ACP session. Prompts are serialized. */
export class CursorAcpSession {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private sessionId = "";
  private models: CursorAcpModel[] = [];
  private stderrTail = "";
  private brokenReason: string | undefined;
  private activePrompt: { handlers: CursorAcpPromptHandlers; chunks: string[]; thoughts: string[] } | undefined;
  private promptQueue: Promise<unknown> = Promise.resolve();
  /** Stamped by the pool on every use; the idle sweep compares against it. */
  lastUsedAt = Date.now();

  constructor(private readonly options: CursorAcpSessionOptions) {}

  get broken(): string | undefined {
    return this.brokenReason;
  }

  get availableModels(): CursorAcpModel[] {
    return this.models;
  }

  /** Spawns the child and completes initialize → authenticate → session/new (→ model pin). */
  async start(): Promise<void> {
    const resolved = resolveCursorAgentCommand(this.options.executablePath);
    const child = spawn(resolved.command, [...resolved.argsPrefix, "acp"], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.on("error", (error) => this.markBroken(`cursor-agent acp spawn failed: ${error.message}`));
    child.on("close", (code) => this.markBroken(`cursor-agent acp exited (code ${code}). ${this.stderrTail.slice(-300)}`.trim()));

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this.onLine(line));

    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "agentparty-cursor-bridge", version: "1.0.0" },
    });
    await this.request("authenticate", { methodId: "cursor_login" });
    const session = (await this.request("session/new", {
      cwd: this.options.cwd,
      mcpServers: this.options.mcpServers ?? [],
    })) as { sessionId?: string; models?: { availableModels?: CursorAcpModel[] } };
    if (!session?.sessionId) {
      throw new Error("Cursor ACP session/new returned no sessionId.");
    }
    this.sessionId = session.sessionId;
    this.models = session.models?.availableModels ?? [];
    if (this.options.modelId) {
      const known = this.models.some((model) => model.modelId === this.options.modelId);
      if (!known) {
        throw new Error(
          `Cursor ACP model '${this.options.modelId}' is not in the live catalog ` +
          `(${this.models.map((model) => model.modelId).join(", ") || "empty"}). Refusing to fall back.`,
        );
      }
      await this.request("session/set_config_option", {
        sessionId: this.sessionId,
        configId: "model",
        value: this.options.modelId,
      });
    }
  }

  /**
   * Sends one user turn and resolves when the agent finishes it. Serialized:
   * ACP allows one in-flight prompt per session, so overlapping callers queue.
   * No JSON-RPC timeout — a turn legitimately runs for minutes (tool relays);
   * the bridge above owns end-to-end deadlines and can `cancel()`.
   */
  prompt(content: string | CursorAcpPromptBlock[], handlers: CursorAcpPromptHandlers = {}): Promise<CursorAcpPromptResult> {
    const blocks: CursorAcpPromptBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const run = this.promptQueue.then(async () => {
      this.assertUsable();
      const active = { handlers, chunks: [] as string[], thoughts: [] as string[] };
      this.activePrompt = active;
      try {
        const result = (await this.request(
          "session/prompt",
          { sessionId: this.sessionId, prompt: blocks },
          0,
        )) as { stopReason?: string };
        return {
          stopReason: result?.stopReason || "end_turn",
          text: active.chunks.join(""),
          thought: active.thoughts.join(""),
        };
      } finally {
        this.activePrompt = undefined;
      }
    });
    // Keep the queue alive after a failed prompt; the failure still reaches the caller.
    this.promptQueue = run.catch(() => undefined);
    return run;
  }

  /** Cancels the in-flight prompt (notification; the prompt resolves with stopReason "cancelled"). */
  cancel(): void {
    if (this.child && this.sessionId) {
      this.notify("session/cancel", { sessionId: this.sessionId });
    }
  }

  dispose(reason = "disposed"): void {
    this.markBroken(reason);
  }

  private assertUsable(): void {
    if (this.brokenReason) {
      throw new Error(`Cursor ACP session is unavailable: ${this.brokenReason}`);
    }
    if (!this.child || !this.sessionId) {
      throw new Error("Cursor ACP session was used before start() completed.");
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
        // The child is already gone; nothing to clean.
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
      if (entry) {
        this.pending.delete(message.id);
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
        if (message.error) {
          entry.reject(new Error(message.error.message || `Cursor ACP error on request ${message.id}.`));
        } else {
          entry.resolve(message.result);
        }
      }
      return;
    }
    this.onServerMessage(message);
  }

  private onServerMessage(message: any): void {
    if (message.method === "session/update") {
      const update = message.params?.update ?? message.params;
      const text = update?.content?.text;
      if (update?.sessionUpdate === "agent_message_chunk" && typeof text === "string" && text) {
        this.activePrompt?.chunks.push(text);
        this.activePrompt?.handlers.onChunk?.(text);
      } else if (update?.sessionUpdate === "agent_thought_chunk" && typeof text === "string" && text) {
        this.activePrompt?.thoughts.push(text);
        this.activePrompt?.handlers.onThought?.(text);
      }
      return;
    }
    if (message.method === "session/request_permission" && message.id != null) {
      // Auto-approve. Tool execution/approval belongs to the CALLING harness;
      // the only tools this session can see are the bridge's own relay, and
      // fs/terminal capabilities are disabled at initialize.
      const options: Array<{ optionId?: string; kind?: string }> = message.params?.options ?? [];
      const allow = options.find((option) => option.kind === "allow_always")
        || options.find((option) => /allow/i.test(String(option.optionId)))
        || options[0];
      this.respond(message.id, { outcome: { outcome: "selected", optionId: allow?.optionId || "allow-once" } });
      return;
    }
    if (message.id != null && message.method) {
      // cursor/* side-requests (ask_question, create_plan, …). The bridge has
      // no human to ask; answer deterministically so the turn cannot hang.
      if (message.method === "cursor/ask_question" && Array.isArray(message.params?.options)) {
        this.respond(message.id, { selectedId: message.params.options[0]?.id ?? "" });
      } else if (message.method === "cursor/create_plan") {
        this.respond(message.id, { approved: true });
      } else {
        this.respond(message.id, {});
      }
    }
  }

  private request(method: string, params: object, timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.child) {
      return Promise.reject(new Error(this.brokenReason || "Cursor ACP child is not running."));
    }
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const entry: PendingEntry = { resolve, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Cursor ACP ${method} timed out after ${timeoutMs}ms.`));
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

/**
 * Sessions keyed by conversation. The key is the harness's per-session router
 * token (`agentparty-native-session:<id>`), so one Claude Code session maps to
 * exactly one warm ACP child — session/new costs ~5-7s, so reuse is what makes
 * turn latency acceptable.
 */
export class CursorAcpPool {
  private readonly sessions = new Map<string, { session: CursorAcpSession; fingerprint: string }>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly idleTtlMs = 5 * 60_000) {}

  /** Returns a live session for the key, recreating on option changes or breakage. */
  async acquire(key: string, options: CursorAcpSessionOptions): Promise<CursorAcpSession> {
    const fingerprint = JSON.stringify([options.cwd, options.modelId, options.mcpServers, options.executablePath]);
    const existing = this.sessions.get(key);
    if (existing && !existing.session.broken && existing.fingerprint === fingerprint) {
      existing.session.lastUsedAt = Date.now();
      return existing.session;
    }
    existing?.session.dispose("replaced by a new session for the same conversation");
    const session = new CursorAcpSession(options);
    await session.start();
    session.lastUsedAt = Date.now();
    this.sessions.set(key, { session, fingerprint });
    this.ensureSweep();
    return session;
  }

  release(key: string): void {
    const entry = this.sessions.get(key);
    if (entry) {
      this.sessions.delete(key);
      entry.session.dispose("released");
    }
  }

  disposeAll(): void {
    for (const [key] of this.sessions) {
      this.release(key);
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private ensureSweep(): void {
    if (this.sweepTimer) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      const cutoff = Date.now() - this.idleTtlMs;
      for (const [key, entry] of this.sessions) {
        if (entry.session.broken || entry.session.lastUsedAt < cutoff) {
          this.sessions.delete(key);
          entry.session.dispose("idle");
        }
      }
      if (this.sessions.size === 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = undefined;
      }
    }, 60_000);
    this.sweepTimer.unref?.();
  }
}
