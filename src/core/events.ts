import type { ModelRoute } from "./modelRegistry";

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
  /** Live inventory of slash commands the harness reports for this session. */
  slashCommands?: HarnessCommand[];
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
  | { type: "tool_call"; id: string; name: string; input?: unknown; status: "started" | "completed" | "failed"; result?: unknown; at: string }
  | { type: "approval_request"; requestId: string; toolName: string; input: unknown; title?: string; description?: string; suggestions?: unknown[]; at: string }
  | { type: "approval_resolved"; requestId: string; decision: "allow" | "deny"; at: string }
  | { type: "control_response"; requestId?: string; response: unknown; at: string }
  | { type: "file_change"; filePath?: string; toolName?: string; input?: unknown; result?: unknown; at: string }
  | { type: "turn_complete"; result: string; costUsd?: number; cost?: TurnCost; stopReason?: string; at: string }
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
