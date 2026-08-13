import type { ModelRoute } from "./modelRegistry";
import type { SubagentActivity, SubagentBlock, SubagentPhase } from "../shared/subagentActivity";
import type { UsageProviderId, UsageWindow } from "../shared/usageLimits";
import type { CursorPolicy } from "../shared/cursorPolicy";
import type { TurnTokenBreakdown } from "../shared/tokenUsage";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * A slash command the live harness reports as available for a session — built-in
 * commands, skills, plugin commands, MCP prompts, and custom commands all arrive
 * through this same shape (the SDK's `SlashCommand`). The command palette uses
 * this to show the *actually available* inventory, not a hardcoded guess.
 */
export interface HarnessCommand {
  /** Command name without the leading slash (e.g. "model", "mcp__server__prompt"). */
  name: string;
  description?: string;
  /** Argument hint, e.g. "<file>". */
  argumentHint?: string;
  aliases?: string[];
  /** Provenance for the palette source badge: "built-in" | "skill" | "plugin" | … */
  source?: string;
  /** When set, the command is unavailable and this explains why (e.g. "disabled"). */
  disabledReason?: string;
}

export interface TurnCost {
  amountUsd?: number;
  source: "claude-code" | "openrouter" | "codex" | "cursor" | "grok" | "estimate" | "unknown";
  basis: "provider-reported" | "harness-reported" | "estimated" | "subscription" | "free" | "unavailable";
  label: string;
  detail?: string;
}

export interface ClaudeSessionSnapshot {
  id: string;
  pid?: number;
  cwd: string;
  sessionId?: string;
  model: string;
  effort: ClaudeEffort;
  /** Live thinking mode (adaptive | enabled | disabled), when the harness has one. */
  thinkingMode?: string;
  /** Live thinking token budget, when set. */
  thinkingBudget?: number;
  permissionMode?: string;
  cursorPolicy?: CursorPolicy;
  status: string;
  /**
   * Whether this session's harness can still serve turns.
   *
   * Deliberately NOT derived from `status`: the three harnesses use different
   * words for the same fact, and one of them uses none at all. Claude reports
   * `closed` when its stream ends. Codex sets `error` when its app-server dies
   * mid-turn but leaves the status UNTOUCHED when it dies while idle. Cursor
   * spawns a process per TURN, so holding no process is its healthy resting
   * state rather than death. Matching one status string therefore left a dead
   * Codex member reading as `idle` forever (#21).
   *
   * Each adapter answers from what it actually knows, so callers get one fact
   * instead of a string match that only ever fit Claude.
   */
  harnessAlive: boolean;
  turnState?: string;
  startedAt: string;
  lastEventAt?: string;
  lastUserMessageAt?: string;
  lastAssistantMessageAt?: string;
  logPath?: string;
  debugMode: boolean;
  lastError?: string;
  turnCount: number;
  queuedTurnCount: number;
  pendingApprovalCount?: number;
  /**
   * Current context-window occupancy in tokens — the size of the last turn's
   * prompt+generation, NOT a cumulative bill. Non-cumulative on purpose: it
   * drops after a compaction, so paired with {@link contextWindow} it drives a
   * "how full is my context" meter. Absent until the first turn reports usage.
   */
  contextTokens?: number;
  /**
   * The model's context-window size in tokens when the harness reports it
   * numerically (Codex). When absent the renderer resolves the window from the
   * model catalog's `context` string; if that too is unknown the meter shows the
   * used count without a ratio (never a fabricated denominator).
   */
  contextWindow?: number;
  /**
   * Harness tasks still in flight that are NOT the current turn — a backgrounded
   * shell, a workflow, an MCP monitor, a subagent that outlived its turn.
   *
   * Read by idle-sleep: a member whose turn ended can still be doing work, and
   * tearing its process down would destroy it silently. Like {@link harnessAlive}
   * each adapter answers from what it actually knows, and a harness with no such
   * signal reports nothing rather than a comforting zero — absent means "cannot
   * tell", which callers must treat as "do not assume it is safe".
   */
  backgroundTaskCount?: number;
  /** Live inventory of slash commands the harness reports for this session. */
  slashCommands?: HarnessCommand[];
  /** Codex two-axis safety model (sandbox × approval + guardian); Codex sessions only. */
  codexPolicy?: import("../shared/codexPolicy").CodexPolicy;
}

export interface ResumableSessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
}

export type ClaudeNormalizedEvent =
  | { type: "status"; status: string | null; detail?: string; at: string }
  | { type: "session"; sessionId: string; model?: string; permissionMode?: string; cursorPolicy?: CursorPolicy; tools?: string[]; slashCommands?: HarnessCommand[]; models?: ModelRoute[]; at: string }
  | { type: "assistant_text_delta"; text: string; blockIndex?: number; at: string }
  | { type: "reasoning_delta"; text: string; blockIndex?: number; at: string }
  | { type: "thinking_tokens"; estimatedTokens: number; delta?: number; at: string }
  | { type: "tool_call"; id: string; name: string; input?: unknown; status: "started" | "completed" | "failed"; result?: unknown; source?: string; cwd?: string; exitCode?: number; durationMs?: number; outputDelta?: string; at: string }
  | { type: "plan"; steps: import("../shared/codexItems").CodexPlanStep[]; explanation?: string; at: string }
  | { type: "diagnostic"; severity: "info" | "warning" | "error"; category: string; title: string; detail?: string; recovery?: string; at: string }
  // Account/provider-scoped rate-limit usage (NOT per-session context). Emitted
  // when a harness reports its rolling-window utilization; the main process
  // aggregates the latest per provider and pushes it to every window. See
  // src/shared/usageLimits.ts.
  //
  // `sourceId` identifies which adapter reported the read — `sessionManager`
  // uses it to fan-in dedupe so only the single active source per provider
  // (foreground session > background poller > remote engine) drives the merge,
  // instead of every live session racing to overwrite each other's values.
  // QA injection stamps a reserved `qa` id that always passes the filter.
  //
  // `loggedOut` marks a read that failed because the provider's CLI has no
  // credential on this host — the UI renders "로그아웃 상태" instead of the
  // ambiguous "데이터 없음". See ProviderUsage.loggedOut.
  | { type: "usage_limit"; provider: UsageProviderId; windows: UsageWindow[]; available?: boolean; loggedOut?: boolean; at: string; sourceId?: string }
  // `blockedPath`/`agentID` are Claude Code's — the path that triggered the
  // prompt and the subagent that asked. Both arrive populated from the SDK and
  // used to be dropped here, so the card could not show either.
  | { type: "approval_request"; requestId: string; toolName: string; input: unknown; title?: string; description?: string; suggestions?: unknown[]; blockedPath?: string; agentID?: string; codex?: import("../shared/codexApproval").CodexApprovalMeta; at: string }
  // `answers` rides along so the resolution is self-contained. It used to be
  // applied only by the window whose button was clicked, so the same answered
  // question read "—" in every other window sharing the workspace and after a
  // session restore — the record lived nowhere but that one renderer.
  | { type: "approval_resolved"; requestId: string; decision: "allow" | "deny"; answers?: Record<string, string>; at: string }
  /**
   * Compaction progress, structured. The metadata used to be stringified into a
   * status line, so the transcript showed the harness's raw JSON and the UI had
   * nothing to render from. Every number is optional because the SDK declares
   * it optional (`post_tokens`, `duration_ms`) and Codex sends none of them.
   */
  | { type: "compact_state"; state: "running" | "done" | "failed"; trigger?: "manual" | "auto"; preTokens?: number; postTokens?: number; durationMs?: number; keptCount?: number; reason?: string; at: string }
  | { type: "control_response"; requestId?: string; response: unknown; at: string }
  // A message that waited in the app-level queue has just been handed to the
  // harness. Authored by the app, not by any harness — it is the only record
  // that a queued message became a real turn, so the renderer can place the user
  // bubble in the transcript at the moment of DELIVERY rather than the moment of
  // typing. `count` > 1 means several queued items merged into this one turn.
  // See src/shared/messageQueue.ts.
  | { type: "queue_dequeued"; text: string; from: string | null; count: number; at: string }
  | { type: "file_change"; filePath?: string; toolName?: string; input?: unknown; result?: unknown; changes?: import("../shared/codexItems").CodexFileEdit[]; status?: string; at: string }
  // `usage` carries the per-turn token split (fresh/cacheRead/cacheWrite/output +
  // context occupancy) as far as the harness reports it — the raw accounting the
  // Token Usage ledger persists. Absent when the harness reports no usage.
  | { type: "turn_complete"; result: string; costUsd?: number; cost?: TurnCost; stopReason?: string; usage?: TurnTokenBreakdown; at: string }
  // An in-session subagent's lifecycle / live activity / own-transcript block.
  // Kept OUT of the parent transcript: the renderer folds these into a separate
  // per-session subagent slice (dock + drill-in detail). One event can carry any
  // combination of the three optional facets. Both harnesses normalize to this —
  // see docs/codex-ux-research/08-subagent-activity.md.
  | { type: "subagent"; agentId: string;
      /** Sent on spawn and on identity/status transitions (merged, latest wins). */
      lifecycle?: { phase?: SubagentPhase; label?: string; role?: string; hint?: string; assignedTask?: string; model?: string; tools?: string; dur?: string };
      /** Live one-line activity; a model analyzer may later enrich `summary`. */
      activity?: SubagentActivity;
      /** A block appended to the subagent's OWN transcript. */
      block?: SubagentBlock;
      at: string }
  // Message Gate outcome for an OUTGOING member-to-member send, rendered as an
  // inline badge in the SENDER's transcript (reject/forced/failed). UI-only — it
  // is never injected into any model's context. See the Message Gate design §8.
  | { type: "gate"; gate: "rejected" | "forced" | "failed"; to: string; from?: string; reason?: string; rule?: string; errcode?: string; at: string }
  /**
   * `environment` marks a failure the USER can fix (a harness CLI that is not
   * installed or not signed in), carrying the id of the environment check that
   * explains it. It is what turns a red wall of English CLI text into a card
   * with buttons — see EnvironmentBlockedError.
   */
  | { type: "error"; message: string; at: string; environment?: { checkId: string; raw?: string } };

export type NormalizedCommand =
  | { type: "sendUserTurn"; text: string }
  | { type: "setModel"; harnessId?: string; providerId?: string; model: string; runtimeModel?: string }
  | { type: "setEffort"; effort: string }
  | { type: "setThinking"; enabled: boolean; mode?: string }
  | { type: "setPermissionMode"; permissionMode: string }
  | { type: "setDebugMode"; enabled: boolean }
  | { type: "listSessions" }
  | { type: "resumeSession"; sessionId: string }
  | { type: "compact" }
  | { type: "approve"; requestId: string; behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }
  | { type: "interrupt" }
  | { type: "stop" }
  | { type: "restart" };
