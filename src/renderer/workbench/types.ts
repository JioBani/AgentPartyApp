import type { PartyMember, SessionView } from "../../shared/types";
import type { AutoCompactSetting } from "../../shared/autoCompact";
import type { ImageAttachment } from "../../shared/attachments";
import type { SubagentActivity, SubagentBlock, SubagentPhase } from "../../shared/subagentActivity";
import type { RouteVision } from "./routes";
import type { CursorPolicy } from "../../shared/cursorPolicy";

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
  // `sent` marks a status line that is the harness echoing back a user turn the
  // app just submitted. It is the user's own message, not agent output, so it
  // does not end a reply that is still streaming (see appendText, [#14]).
  | { id: string; kind: "user" | "assistant" | "reasoning" | "status" | "error"; text: string; attachments?: ImageAttachment[]; sent?: boolean; at?: string }
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
  | { id: string; kind: "channel"; direction: "in" | "out"; from: string; to: string; text: string; state?: "ok" | "failed"; at?: string; /** Envelope origin: another member ("agentparty") or the Discord bridge. */ source?: "agentparty" | "discord" }
  // A party write-action this member drove (member-create / member-remove).
  | { id: string; kind: "partyAction"; action: "create" | "remove"; member: string; role?: string; model?: string; harness?: string; state?: "ok" | "failed"; error?: string; at?: string }
  // A Message Gate outcome for an OUTGOING send by this member (inline badge).
  // rejected = blocked (not delivered) · forced = bypassed the gate · failed =
  // reviewer errored so it was delivered unreviewed (fail-open). UI-only.
  | { id: string; kind: "gate"; gate: "rejected" | "forced" | "failed"; to: string; from?: string; reason?: string; rule?: string; errcode?: string; at?: string }
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

/**
 * `disconnected` is the member's own `missing_session`: it is bound to a session
 * that nothing is behind any more. It is deliberately NOT folded into
 * `not-started`, which means "never started, message it and it begins" — telling
 * a user that about a member they cannot reach is worse than saying nothing.
 */
export type MemberStatus = "working" | "idle" | "approval" | "not-started" | "stalled" | "disconnected";

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
  cursorPolicy?: CursorPolicy;
  /** Effective model's multimodal support, for composer gating + indicators. */
  vision?: RouteVision;
  /** The effective model's selectable effort options (empty when the model has none). */
  effortOptions: { id: string; label: string }[];
  /**
   * Context-window occupancy for the capacity meter. `used` is the current
   * footprint in tokens; `total` is the model's window (undefined when unknown —
   * the meter then shows the raw count without a ratio). `stale` is true when the
   * value is the persisted "last known" occupancy from a prior turn (no live
   * session running yet) — so a reopened member/app shows the meter immediately
   * and marks it as not-yet-refreshed rather than showing nothing.
   */
  context?: { used: number; total?: number; stale?: boolean };
  /**
   * Effective auto-compaction setting (the member's own, else the global
   * default). Drives the toolbar pill, the sidebar badge, and the crossing
   * trigger. Always resolved — never undefined.
   */
  autoCompact: AutoCompactSetting;
  /** True while a manual/automatic compaction is in flight (transient spinner). */
  compacting: boolean;
}

/** One watch-slot. Tabs time-share the slot; `active` is the visible member. */
export interface PanelState {
  id: string;
  tabs: string[]; // member names, left -> right
  active: string; // member name
  weight: number; // flex weight relative to sibling panels
}
