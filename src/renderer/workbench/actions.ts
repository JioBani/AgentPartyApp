import type { RouteLike } from "./routes";
import type { CodexPolicy } from "../../shared/codexPolicy";
import type { AutoCompactSetting } from "../../shared/autoCompact";
import type { ImageAttachment } from "../../shared/attachments";
import type { McpAuthResult, McpServerSnapshot } from "../../shared/mcp";

/**
 * Command surface a panel needs, addressed by member name. The App shell maps
 * each member to its live session and the right IPC call, so workbench
 * components never touch `window.agentParty` directly.
 */
export interface WorkbenchActions {
  /** Sends a turn to the member (starting its session first if needed), with
   *  optional image attachments (provider-neutral). */
  sendMessage(memberName: string, text: string, attachments?: ImageAttachment[]): void | Promise<void>;
  /**
   * Starts the member's session ahead of the first turn (no message sent), so
   * the harness reports its live command/skill inventory for the palette. Idempotent
   * and at-most-once per member; a no-op when a session is already active.
   */
  prewarm(memberName: string): void;
  /**
   * Resolves an approval request. `updatedInput` carries request-specific extras —
   * for Codex, `{ codexDecision: "once" | "session" | "always" | "decline" }` so the
   * card's richer choice reaches the harness (once/session/prefix-rule/decline).
   */
  approve(memberName: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown): void;
  /**
   * Answers an AskUserQuestion interaction: allows the tool with the chosen
   * answers folded into its input (`answers` = question text -> selected label),
   * which is the shape the SDK expects to feed the model.
   */
  answerQuestion(memberName: string, requestId: string, input: unknown, answers: Record<string, string>): void;
  interrupt(memberName: string): void;
  /**
   * Hard restart: tears down the running harness and restarts it in place with
   * an EMPTY conversation (model context reset). Exposed via the member's
   * right-click menu.
   */
  restart(memberName: string): void;
  /**
   * Respawn (reload): restarts the member's session but RESUMES the same
   * conversation (model context intact). The new session is rebuilt from the
   * member's current config and re-reads MCP, so this applies changes that need
   * a session restart — e.g. a just-added MCP server — without losing the chat.
   * The tab toolbar's primary reset button.
   */
  respawn(memberName: string): void;
  /** Runs a manual compaction now (toolbar pill icon / runtime). Shows a transient spinner. */
  compact(memberName: string): void;
  /**
   * Sets the member's per-member auto-compaction threshold; `undefined` clears
   * the override so the member inherits the global default. Persisted through the
   * party-action path (works with or without a live session).
   */
  setAutoCompact(memberName: string, setting: AutoCompactSetting | undefined): void;
  /**
   * Closes the member's live session (tears down the harness, frees its context
   * + provider usage) and marks the member `closed`. Reopening the tab and
   * sending a message starts a fresh session. Bound to the tab's close (×).
   */
  closeSession(memberName: string): void;
  applyRuntime(memberName: string, runtime: { route?: RouteLike; effort?: string; thinkingMode?: string; thinkingBudget?: number; debug: boolean }): void | Promise<void>;
  setEffort(memberName: string, effort: string): void;
  setThinking(memberName: string, mode: string, budget?: number): void;
  setPermissionMode(memberName: string, mode: string): void;
  /** Codex two-axis safety model (sandbox × approval + guardian); applied live. */
  setCodexPolicy(memberName: string, policy: CodexPolicy): void;
  /** Lists the member's external MCP servers (status + tools). Needs a live session. */
  listMcp(memberName: string): Promise<McpServerSnapshot>;
  /** Reconnects one MCP server (Codex: reloads MCP config). */
  reconnectMcp(memberName: string, server: string): Promise<void>;
  /** Enables/disables one MCP server (Claude Code only). */
  toggleMcp(memberName: string, server: string, enabled: boolean): Promise<void>;
  /** Starts OAuth for a remote MCP server (Codex); returns an authorization URL. */
  authenticateMcp(memberName: string, server: string): Promise<McpAuthResult>;
}
