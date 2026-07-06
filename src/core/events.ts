import type { ModelRoute } from "./modelRegistry";
import type { SubagentActivity, SubagentBlock, SubagentPhase } from "../shared/subagentActivity";

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
  source: "claude-code" | "openrouter" | "codex" | "estimate" | "unknown";
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
  permissionMode?: string;
  status: string;
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
  | { type: "session"; sessionId: string; model?: string; permissionMode?: string; tools?: string[]; slashCommands?: HarnessCommand[]; models?: ModelRoute[]; at: string }
  | { type: "assistant_text_delta"; text: string; blockIndex?: number; at: string }
  | { type: "reasoning_delta"; text: string; blockIndex?: number; at: string }
  | { type: "thinking_tokens"; estimatedTokens: number; delta?: number; at: string }
  | { type: "tool_call"; id: string; name: string; input?: unknown; status: "started" | "completed" | "failed"; result?: unknown; source?: string; cwd?: string; exitCode?: number; durationMs?: number; outputDelta?: string; at: string }
  | { type: "plan"; steps: import("../shared/codexItems").CodexPlanStep[]; explanation?: string; at: string }
  | { type: "diagnostic"; severity: "info" | "warning" | "error"; category: string; title: string; detail?: string; recovery?: string; at: string }
  | { type: "approval_request"; requestId: string; toolName: string; input: unknown; title?: string; description?: string; suggestions?: unknown[]; codex?: import("../shared/codexApproval").CodexApprovalMeta; at: string }
  | { type: "approval_resolved"; requestId: string; decision: "allow" | "deny"; at: string }
  | { type: "control_response"; requestId?: string; response: unknown; at: string }
  | { type: "file_change"; filePath?: string; toolName?: string; input?: unknown; result?: unknown; changes?: import("../shared/codexItems").CodexFileEdit[]; status?: string; at: string }
  | { type: "turn_complete"; result: string; costUsd?: number; cost?: TurnCost; stopReason?: string; at: string }
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
  | { type: "error"; message: string; at: string };

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
