import type { PartyMember, SessionView } from "../../shared/types";
import type { ImageAttachment } from "../../shared/attachments";
import type { SubagentActivity, SubagentBlock, SubagentPhase } from "../../shared/subagentActivity";
import type { RouteVision } from "./routes";

/**
 * One in-session subagent, folded from `subagent` normalized events. Its output
 * is kept out of the member transcript entirely — the dock lists these and the
 * detail view drills into `blocks` (the subagent's own transcript).
 */
export interface Subagent {
  id: string;
  /** Display name / label (Claude description·subagent_type, Codex role·nickname). */
  name: string;
  /** Scope or identity badge (e.g. "auth/**", "#a3f2"). */
  hint?: string;
  role?: string;
  phase: SubagentPhase;
  /** The task delegated to this subagent (shown at the top of the detail view). */
  task?: string;
  /** Meta left/right in the dock row (e.g. "318 tests" · "2m 04s"). */
  tools?: string;
  dur?: string;
  /** Latest one-line activity; the swap point for a future model analyzer. */
  activity?: SubagentActivity;
  /** The subagent's own transcript. */
  blocks: SubagentBlock[];
  updatedAt?: string;
}

/** Per-member transcript block — the rendering contract filled by agent events. */
export type TranscriptBlock =
  | { id: string; kind: "user" | "assistant" | "reasoning" | "status" | "error"; text: string; attachments?: ImageAttachment[]; at?: string }
  | { id: string; kind: "tool"; name: string; status?: string; input?: unknown; result?: unknown; source?: string; cwd?: string; exitCode?: number; durationMs?: number; output?: string; at?: string }
  // A Codex plan/TODO card (from a plan item + turn/plan/updated); latest wins.
  | { id: string; kind: "plan"; steps: import("../../shared/codexItems").CodexPlanStep[]; explanation?: string; at?: string }
  // A Codex fileChange item: per-file diff with +/- stats.
  | { id: string; kind: "fileChange"; changes: import("../../shared/codexItems").CodexFileEdit[]; status?: string; at?: string }
  // A surfaced Codex diagnostic (reroute / rate-limit / warning); never silently dropped.
  // `repeat` counts consecutive identical occurrences folded into one block
  // (≥2 renders a ×N badge) — a re-firing diagnostic ticks a counter, never stacks.
  | { id: string; kind: "diagnostic"; severity: "info" | "warning" | "error"; category: string; title: string; detail?: string; recovery?: string; repeat?: number; at?: string }
  // Inter-member (agentparty channel) message. `direction` is relative to the
  // member whose transcript this is: "in" = received, "out" = this member sent.
  | { id: string; kind: "channel"; direction: "in" | "out"; from: string; to: string; text: string; state?: "ok" | "failed"; at?: string }
  // A party write-action this member drove (member-create / member-remove).
  | { id: string; kind: "partyAction"; action: "create" | "remove"; member: string; role?: string; model?: string; harness?: string; state?: "ok" | "failed"; error?: string; at?: string }
  | {
      id: string;
      kind: "approval";
      requestId: string;
      toolName: string;
      title?: string;
      description?: string;
      input?: unknown;
      resolved?: "allow" | "deny";
      /** Codex approval metadata (command/diff/decision options); Codex requests only. */
      codex?: import("../../shared/codexApproval").CodexApprovalMeta;
      /** For AskUserQuestion: the user's chosen answers (question text -> label). */
      answers?: Record<string, string>;
      at?: string;
    };

export type MemberStatus = "working" | "idle" | "approval" | "not-started" | "stalled";

export type PanelDensity = "wide" | "mid" | "narrow";

/**
 * Everything a panel/tab needs about one member, assembled from the party
 * member record, its live session, and its transcript. Components consume this
 * view instead of reaching into raw IPC state.
 */
export interface MemberView {
  name: string;
  color: string;
  member: PartyMember;
  session?: SessionView;
  status: MemberStatus;
  transcript: TranscriptBlock[];
  /** In-session subagents (dock + detail); empty when the member has none. */
  subagents: Subagent[];
  unread: number;
  pendingApproval: boolean;
  busy: boolean;
  model: string;
  effort: string;
  /** Current thinking mode (live snapshot first, else the member's persisted reasoning). */
  thinkingMode?: string;
  /** Current thinking token budget, when set. */
  thinkingBudget?: number;
  permissionMode: string;
  /** Effective model's multimodal support, for composer gating + indicators. */
  vision?: RouteVision;
  /**
   * Live context-window occupancy for the capacity meter. `used` is the current
   * footprint in tokens; `total` is the model's window (undefined when unknown —
   * the meter then shows the raw count without a ratio). Absent until the
   * session reports usage.
   */
  context?: { used: number; total?: number };
}

/** One watch-slot. Tabs time-share the slot; `active` is the visible member. */
export interface PanelState {
  id: string;
  tabs: string[]; // member names, left -> right
  active: string; // member name
  weight: number; // flex weight relative to sibling panels
}
