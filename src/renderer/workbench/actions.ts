import type { RouteLike } from "./routes";
import type { CodexPolicy } from "../../shared/codexPolicy";
import type { CursorPolicy } from "../../shared/cursorPolicy";
import type { AutoCompactSetting } from "../../shared/autoCompact";
import type { ImageAttachment } from "../../shared/attachments";
import type { McpAuthResult, McpServerSnapshot } from "../../shared/mcp";
import type { MemberGateOverride, PartyGate } from "../../shared/messageGate";
import type { MemberQueueState, QueueCommand } from "../../shared/messageQueue";

/** A member-gate PATCH: any axis omitted is unchanged; `null` clears to inherit. */
export type MemberGatePatch = MemberGateOverride;

/**
 * Command surface a panel needs, addressed by member name. The App shell maps
 * each member to its live session and the right IPC call, so workbench
 * components never touch `window.agentParty` directly.
 */
export interface WorkbenchActions {
  /**
   * Sends a turn to the member (starting its session first if needed), with
   * optional image attachments (provider-neutral). Resolves
   * with `queued: true`, the new queue, and `queuedItemId` — the row this call
   * parked — when the member was busy, so the caller can act on the item it just
   * parked without having to find it by position (an interrupt parks at the
   * FRONT, so "the last row" is somebody else's message).
   *
   * `interrupt` overrides the composer's setting for this one send: Ctrl/Cmd+
   * Enter passes `true`, which parks at the front AND stops the turn in a single
   * backend call. Omit it to follow the setting.
   */
  sendMessage(
    memberName: string,
    text: string,
    attachments?: ImageAttachment[],
    options?: { interrupt?: boolean },
  ): Promise<{ queued?: boolean; queuedItemId?: string; queue?: MemberQueueState } | undefined>;
  /**
   * Runs one message-queue mutation (send / sendItem / cancel / edit / move /
   * mergeUp / clear / preference) — the same controller path the HTTP API takes.
   * REJECTS on failure instead of resolving with an unchanged queue, so the
   * caller can show it: a cancel that quietly did nothing would read as success
   * while the agent answers the message anyway. `edit` resolves with the removed
   * `text` for the composer to take back.
   */
  runQueueCommand(memberName: string, command: QueueCommand): Promise<{ text?: string } | undefined>;
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
   * Force-releases a turn the harness never closed. Surfaced by the composer
   * only after a normal {@link interrupt} has gone unanswered, because it does
   * NOT stop the harness — it frees the app-side turn so input stops queueing
   * behind a turn that will never complete.
   */
  forceStop(memberName: string): void;
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
   * Sets a member's Message Gate override (a PATCH: mode / rule / reviewer; a
   * `null` axis clears it back to inherit). Persisted through the party-action
   * path (works with or without a live session); cross-editable across members.
   */
  setMemberGate(memberName: string, patch: MemberGatePatch): void;
  /** Sets the sender default; undefined clears it back to the Runtime default. */
  setMemberOutboundInterrupt(memberName: string, value: boolean | undefined): void;
  /** Sets the party-wide Message Gate default (enablement + rule). */
  setPartyGate(partyId: string, gate: PartyGate): void;
  /**
   * Closes the member's live session (tears down the harness, frees its context
   * + provider usage) and marks the member `closed`. Reopening the tab and
   * sending a message starts a fresh session. Bound to the tab's close (×).
   */
  closeSession(memberName: string): void;
  /**
   * Opens 설정 → 환경. Used by the in-transcript blocker card, whose
   * whole purpose is that a user never has to go LOOKING for the screen that
   * explains why their member will not start.
   */
  openEnvironmentSettings(): void;
  applyRuntime(memberName: string, runtime: { route?: RouteLike; effort?: string; serviceTier?: string; thinkingMode?: string; thinkingBudget?: number; debug: boolean }): void | Promise<void>;
  setEffort(memberName: string, effort: string): void;
  setThinking(memberName: string, mode: string, budget?: number): void;
  setPermissionMode(memberName: string, mode: string): void;
  /** Codex two-axis safety model (sandbox × approval + guardian); applied live. */
  setCodexPolicy(memberName: string, policy: CodexPolicy): void;
  /** Cursor agent mode + approval mode; applied to the next turn. */
  setCursorPolicy(memberName: string, policy: CursorPolicy): void;
  /** Lists the member's external MCP servers (status + tools). Needs a live session. */
  listMcp(memberName: string): Promise<McpServerSnapshot>;
  /** Reconnects one MCP server (Codex: reloads MCP config). */
  reconnectMcp(memberName: string, server: string): Promise<void>;
  /** Enables/disables one MCP server (Claude Code only). */
  toggleMcp(memberName: string, server: string, enabled: boolean): Promise<void>;
  /** Starts OAuth for a remote MCP server (Codex); returns an authorization URL. */
  authenticateMcp(memberName: string, server: string): Promise<McpAuthResult>;
}
