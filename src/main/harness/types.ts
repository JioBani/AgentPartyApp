import { EventEmitter } from "node:events";
import { ClaudeNormalizedEvent, ClaudeSessionSnapshot } from "../../core/events";
import type { CodexPolicy } from "../../shared/codexPolicy";
import type { CursorPolicy } from "../../shared/cursorPolicy";
import type { ImageAttachment } from "../../shared/attachments";
import type { McpAuthResult, McpServerSnapshot } from "../../shared/mcp";

export type HarnessId = "claude-code" | "codex" | "cursor" | "grok";

export interface HarnessSession extends EventEmitter {
  start(): void;
  /** Sends a user turn. `attachments` (images) are optional and provider-neutral. */
  sendUserTurn(text: string, attachments?: ImageAttachment[]): void;
  interrupt(): void;
  /**
   * Releases a turn this harness will never close, so input stops queueing
   * behind it. Local to the adapter — it does not stop the harness. Every
   * harness must implement it: a wedged turn blocks input identically on all of
   * them, and the UI offers the same manual escape hatch regardless.
   */
  forceStop(): void;
  restart(): void;
  compact(): void;
  dispose(): void;
  getSnapshot(): ClaudeSessionSnapshot;
  setDebugMode(enabled: boolean): void;
  setModel(model: string, providerId?: string, runtimeModel?: string): void;
  setEffort(effort: string): void;
  setThinking(mode: string, budget?: number): void;
  setPermissionMode(permissionMode: string): void;
  /**
   * Account credentials changed outside this harness process. Codex adapters
   * reconnect automatically; other harnesses omit this capability.
   */
  authenticationChanged?(generation: string): "ignored" | "restarted" | "deferred";
  /** Refresh provider/account-scoped usage limits now, if the harness exposes them. */
  refreshUsageLimits?(): Promise<void>;
  /** Codex-only: update the two-axis safety model live. Absent on Claude. */
  setCodexPolicy?(policy: CodexPolicy): void;
  /** Cursor-only: update agent mode and approval mode for the next turn. */
  setCursorPolicy?(policy: CursorPolicy): void;
  /**
   * MCP (external servers this member connects to as a **client**). Optional
   * because support + per-action capabilities differ per harness; the snapshot's
   * `canReconnect/canToggle/canAuthenticate` flags tell the UI what each server
   * supports. An absent method means the harness doesn't support that action at
   * all (callers surface a clear error rather than silently no-op).
   */
  listMcpServers?(): Promise<McpServerSnapshot>;
  reconnectMcpServer?(name: string): Promise<void>;
  setMcpServerEnabled?(name: string, enabled: boolean): Promise<void>;
  authenticateMcpServer?(name: string): Promise<McpAuthResult>;
  respondApproval(requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): void;
  on(event: "event", listener: (event: ClaudeNormalizedEvent) => void): this;
  on(event: "snapshot", listener: (snapshot: ClaudeSessionSnapshot) => void): this;
}

export interface HarnessDescriptor {
  id: HarnessId;
  label: string;
  status: "available" | "planned";
  description: string;
}

export const harnesses: HarnessDescriptor[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    status: "available",
    description: "Primary local harness backed by the Claude Code SDK.",
  },
  {
    id: "codex",
    label: "Codex",
    status: "available",
    description: "Local Codex CLI harness backed by persistent app-server JSON-RPC.",
  },
  {
    id: "cursor",
    label: "Cursor CLI",
    status: "available",
    description: "Cursor Agent CLI harness with Auto and Cursor Grok 4.5.",
  },
  {
    id: "grok",
    label: "Grok Build",
    status: "available",
    description: "xAI's Grok Build CLI over ACP, on your Grok subscription. Approves its own tool calls.",
  },
];
