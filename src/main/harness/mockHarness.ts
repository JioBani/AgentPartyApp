import { EventEmitter } from "node:events";
import type { ClaudeNormalizedEvent, ClaudeSessionSnapshot } from "../../core/events";
import type { HarnessSession } from "./types";
import type { HarnessId } from "../../shared/types";
import type { McpAuthResult, McpServerInfo, McpServerSnapshot } from "../../shared/mcp";

/** Distributes `Omit` across the event union so each member keeps its own keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A normalized event with an optional `at` (the mock stamps it if missing). */
type EventInput = DistributiveOmit<ClaudeNormalizedEvent, "at"> & { at?: string };

export interface MockHarnessOptions {
  id: string;
  cwd: string;
  model: string;
  effort: string;
  permissionMode: string;
  /** When true, a user turn auto-produces a canned reply (nice for manual QA). */
  autoReply?: boolean;
  /** Seeded slash-command inventory so the palette can be exercised in QA. */
  commands?: ClaudeSessionSnapshot["slashCommands"];
  /** Which harness this mock stands in for (drives the MCP snapshot tag). */
  harness?: HarnessId;
}

/**
 * A fake harness session that satisfies the same `HarnessSession` contract as
 * the real `ClaudeAdapter`, but is driven by QA API calls instead of a model
 * process. Because it emits the same normalized events through the same
 * SessionManager path, the renderer cannot tell it apart from a live session —
 * which is exactly what makes it useful for end-to-end frontend QA.
 *
 * It performs no network/model calls and is only ever created in QA mode.
 */
export class MockHarnessSession extends EventEmitter implements HarnessSession {
  private snapshot: ClaudeSessionSnapshot;
  private disposed = false;
  private timers = new Set<NodeJS.Timeout>();
  private autoReply: boolean;
  private readonly harness: HarnessId;
  /** Deterministic MCP server set for QA — covers each state + capability mix. */
  private readonly mcpServers: McpServerInfo[];

  constructor(options: MockHarnessOptions) {
    super();
    this.autoReply = options.autoReply ?? true;
    this.harness = options.harness ?? "claude-code";
    this.mcpServers = seedMockMcpServers();
    this.snapshot = {
      id: options.id,
      cwd: options.cwd,
      sessionId: `mock-${options.id}`,
      model: options.model,
      effort: options.effort as ClaudeSessionSnapshot["effort"],
      permissionMode: options.permissionMode,
      status: "idle",
      startedAt: new Date().toISOString(),
      debugMode: false,
      turnCount: 0,
      queuedTurnCount: 0,
      pendingApprovalCount: 0,
      slashCommands: options.commands,
    };
  }

  start(): void {
    this.emitEvent({ type: "session", sessionId: this.snapshot.sessionId || this.snapshot.id, model: this.snapshot.model, permissionMode: this.snapshot.permissionMode, slashCommands: this.snapshot.slashCommands, at: now() });
    this.pushSnapshot();
  }

  /** Streams a normalized event to the renderer and updates derived snapshot state. */
  inject(partial: EventInput): void {
    if (this.disposed) {
      return;
    }
    const event = { ...partial, at: partial.at || now() } as ClaudeNormalizedEvent;
    // Mirror the real adapters: any event may carry live context occupancy. This
    // is what lets QA drive the context donut / capacity readouts offline (no
    // model, no billing) — inject a status event with contextTokens/contextWindow.
    const withCtx = partial as { contextTokens?: number; contextWindow?: number };
    if (typeof withCtx.contextTokens === "number") {
      this.snapshot.contextTokens = withCtx.contextTokens;
    }
    if (typeof withCtx.contextWindow === "number") {
      this.snapshot.contextWindow = withCtx.contextWindow;
    }
    switch (event.type) {
      case "session":
        if (event.slashCommands) {
          this.snapshot.slashCommands = event.slashCommands;
        }
        break;
      case "assistant_text_delta":
      case "reasoning_delta":
      case "tool_call":
        this.snapshot.status = "responding";
        break;
      case "approval_request":
        this.snapshot.pendingApprovalCount = (this.snapshot.pendingApprovalCount || 0) + 1;
        break;
      case "approval_resolved":
        this.snapshot.pendingApprovalCount = Math.max(0, (this.snapshot.pendingApprovalCount || 0) - 1);
        break;
      case "turn_complete":
        this.snapshot.status = "idle";
        this.snapshot.turnCount += 1;
        break;
      default:
        break;
    }
    this.snapshot.lastEventAt = event.at;
    this.emitEvent(event);
    this.pushSnapshot();
  }

  /** Sets the busy/idle state without adding a transcript line. */
  setStatus(status: string): void {
    this.snapshot.status = status;
    this.snapshot.lastEventAt = now();
    this.pushSnapshot();
  }

  sendUserTurn(text: string): void {
    this.snapshot.lastUserMessageAt = now();
    // Render the incoming turn exactly like ClaudeAdapter.sendUserTurn (a
    // `status: "sent"` event whose detail is the message text). Without this the
    // receiver's transcript stays blank, so an inter-member message simulated via
    // POST /api/party/messages would not be visible during frontend QA.
    this.inject({ type: "status", status: "sent", detail: text });
    if (!this.autoReply) {
      return;
    }
    this.setStatus("responding");
    this.schedule(() => {
      this.inject({ type: "assistant_text_delta", text: `(mock) "${truncate(text)}" 잘 받았습니다. QA 응답입니다.` });
    }, 350);
    this.schedule(() => {
      this.inject({ type: "turn_complete", result: "ok", stopReason: "end_turn" });
    }, 700);
  }

  interrupt(): void {
    this.setStatus("idle");
    this.inject({ type: "status", status: "interrupted", at: now() });
  }

  restart(): void {
    this.snapshot.turnCount = 0;
    this.snapshot.pendingApprovalCount = 0;
    this.setStatus("idle");
    this.inject({ type: "status", status: "restarted", at: now() });
  }

  compact(): void {
    this.inject({ type: "status", status: "compacted", at: now() });
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.removeAllListeners();
  }

  getSnapshot(): ClaudeSessionSnapshot {
    return this.snapshot;
  }

  setDebugMode(enabled: boolean): void {
    this.snapshot.debugMode = enabled;
    this.pushSnapshot();
  }

  setModel(model: string): void {
    this.snapshot.model = model;
    this.pushSnapshot();
  }

  setEffort(effort: string): void {
    this.snapshot.effort = effort as ClaudeSessionSnapshot["effort"];
    this.pushSnapshot();
  }

  setThinking(_mode: string, _budget?: number): void {
    // Mock sessions have no model backend; thinking is a no-op for QA.
    this.pushSnapshot();
  }

  setPermissionMode(permissionMode: string): void {
    this.snapshot.permissionMode = permissionMode;
    this.pushSnapshot();
  }

  respondApproval(requestId: string, behavior: "allow" | "deny"): void {
    this.inject({ type: "approval_resolved", requestId, decision: behavior, at: now() });
  }

  // MCP: deterministic in-memory servers so the status + action path (and the
  // /api/sessions/:id/mcp endpoint) can be exercised end-to-end without a model.
  async listMcpServers(): Promise<McpServerSnapshot> {
    return { supported: true, harness: this.harness, servers: this.mcpServers.map((server) => ({ ...server, tools: [...server.tools] })) };
  }

  async reconnectMcpServer(name: string): Promise<void> {
    const server = this.requireMcp(name);
    server.state = "connected";
    server.error = undefined;
  }

  async setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
    const server = this.requireMcp(name);
    server.state = enabled ? "connected" : "disabled";
  }

  async authenticateMcpServer(name: string): Promise<McpAuthResult> {
    const server = this.requireMcp(name);
    server.state = "connected";
    return { authorizationUrl: `https://auth.example/mock/${encodeURIComponent(name)}` };
  }

  private requireMcp(name: string): McpServerInfo {
    const server = this.mcpServers.find((entry) => entry.name === name);
    if (!server) {
      throw new Error(`Mock MCP server '${name}' not found.`);
    }
    return server;
  }

  private schedule(fn: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, delay);
    this.timers.add(timer);
  }

  private emitEvent(event: ClaudeNormalizedEvent): void {
    this.emit("event", event);
  }

  private pushSnapshot(): void {
    this.emit("snapshot", { ...this.snapshot });
  }
}

function now(): string {
  return new Date().toISOString();
}

/** A fresh seed each session so mutations (reconnect/toggle) don't leak across QA runs. */
function seedMockMcpServers(): McpServerInfo[] {
  return [
    { name: "filesystem", state: "connected", transport: "stdio", scope: "user", tools: [{ name: "read_file", description: "Read a file" }, { name: "write_file" }], canReconnect: true, canToggle: true, canAuthenticate: false },
    { name: "sentry", state: "needs-auth", transport: "http", scope: "project", url: "https://mcp.sentry.dev/mcp", error: "Needs authentication", tools: [], canReconnect: true, canToggle: true, canAuthenticate: true },
    { name: "legacy", state: "failed", transport: "stdio", scope: "local", error: "spawn ENOENT", tools: [], canReconnect: true, canToggle: true, canAuthenticate: false },
  ];
}

function truncate(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
