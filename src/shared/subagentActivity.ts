/**
 * Subagent observation model — harness-agnostic (Item 08).
 *
 * Both harnesses spawn in-session subagents but expose them differently:
 *   - Claude Code: an `Agent`/`Task` tool_use (carrying description / subagent_type
 *     / prompt) plus nested child events tagged with `parent_tool_use_id`.
 *   - Codex: `collabAgentToolCall` / `subAgentActivity` items on independent
 *     threads (`agentThreadId`, `receiverThreadIds`, `agentPath`).
 * Adapters normalize both into the single `subagent` event in core/events.ts, so
 * one UI renders either. Reference: docs/codex-ux-research/08-subagent-activity.md.
 *
 * This module is the SINGLE SOURCE for the "what is it doing right now?" one-liner
 * (`deriveSubagentAction`). Today it is a static tool→label map. It is isolated
 * here on purpose: a future lightweight-model analyzer can replace/augment it to
 * produce a richer real-time `summary` without touching adapters, events, or the
 * renderer — they all consume the `SubagentActivity` shape, not the derivation.
 */

export type SubagentPhase = "queued" | "working" | "done" | "failed";

/** Coarse activity class, used to pick an icon + a default label. */
export type SubagentActionKind =
  | "reading"
  | "searching"
  | "running"
  | "testing"
  | "web"
  | "editing"
  | "spawning"
  | "thinking"
  | "idle"
  | "unknown";

/**
 * The live one-line activity of a subagent. `label` is the human string shown in
 * the UI; `kind` drives the icon; `sourceTool` records what produced it (for
 * debugging / a future analyzer); `summary` is an optional richer line a model
 * analyzer may fill in later (preferred over `label` when present).
 */
export interface SubagentActivity {
  kind: SubagentActionKind;
  label: string;
  sourceTool?: string;
  summary?: string;
}

/** A block in a subagent's OWN transcript (never mixed into the parent chat). */
export type SubagentBlock =
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; arg?: string; durationMs?: number; result?: string; status?: "started" | "completed" | "failed" }
  | { kind: "status"; text: string }
  | { kind: "typing" };

/** Korean labels per the design handoff's currentAction mapping (Item 08 §D). */
const ACTION_LABEL: Record<SubagentActionKind, string> = {
  reading: "문서 읽는중",
  searching: "코드 탐색중",
  running: "명령 실행중",
  testing: "테스트 실행중",
  web: "웹 검색중",
  editing: "파일 수정중",
  spawning: "서브에이전트 생성중",
  thinking: "생각하는중",
  idle: "대기중",
  unknown: "작업중",
};

/**
 * Maps a raw tool/item name to an action kind. Covers Claude Code tool names,
 * Codex item types, and the common mock/agent-SDK aliases so one map serves both
 * harnesses and the mock fixtures. Extend the arrays to teach a new tool.
 */
// Order matters: earlier entries win. `web` precedes `searching` because
// "websearch" contains the "search" substring; `testing` precedes `running`
// because "run_tests" contains "run".
const TOOL_KIND: Array<{ kind: SubagentActionKind; match: string[] }> = [
  { kind: "web", match: ["websearch", "web_search", "webfetch", "fetch", "browse"] },
  { kind: "spawning", match: ["agent", "task", "spawnagent", "collabagenttoolcall", "resumeagent"] },
  { kind: "testing", match: ["run_tests", "test", "pytest", "jest", "vitest"] },
  { kind: "searching", match: ["grep", "glob", "search", "find", "codebase_search", "ripgrep"] },
  { kind: "reading", match: ["read", "read_file", "cat", "open", "view"] },
  { kind: "editing", match: ["edit", "write", "multiedit", "apply_patch", "filechange", "str_replace"] },
  { kind: "running", match: ["bash", "shell", "commandexecution", "exec", "run", "command", "terminal"] },
];

/**
 * Derives the current one-line activity from the most recent tool a subagent
 * used. `arg` (a path/command/query) is folded into `summary` so the UI can show
 * e.g. "코드 탐색중 · verifyRefresh". Unknown tools fall back to a generic label
 * rather than hiding the activity (no silent drop).
 */
export function deriveSubagentAction(tool: string | undefined, arg?: string): SubagentActivity {
  const normalized = (tool || "").trim().toLowerCase().replace(/[^a-z_]/g, "");
  let kind: SubagentActionKind = "unknown";
  for (const entry of TOOL_KIND) {
    if (entry.match.some((needle) => normalized === needle || normalized.includes(needle))) {
      kind = entry.kind;
      break;
    }
  }
  const summary = arg && arg.trim() ? `${ACTION_LABEL[kind]} · ${arg.trim()}` : undefined;
  return { kind, label: ACTION_LABEL[kind], sourceTool: tool || undefined, summary };
}

/** The label to render for a subagent's live activity (summary wins when set). */
export function subagentActionLabel(activity: SubagentActivity | undefined): string {
  if (!activity) {
    return "";
  }
  return activity.summary || activity.label;
}
