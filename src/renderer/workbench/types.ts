import type { PartyMember, SessionView } from "../../shared/types";

/** Per-member transcript block — the rendering contract filled by agent events. */
export type TranscriptBlock =
  | { id: string; kind: "user" | "assistant" | "reasoning" | "status" | "error"; text: string; at?: string }
  | { id: string; kind: "tool"; name: string; status?: string; input?: unknown; result?: unknown; source?: string; cwd?: string; exitCode?: number; durationMs?: number; output?: string; at?: string }
  // A Codex plan/TODO card (from a plan item + turn/plan/updated); latest wins.
  | { id: string; kind: "plan"; steps: import("../../shared/codexItems").CodexPlanStep[]; explanation?: string; at?: string }
  // A Codex fileChange item: per-file diff with +/- stats.
  | { id: string; kind: "fileChange"; changes: import("../../shared/codexItems").CodexFileEdit[]; status?: string; at?: string }
  // A surfaced Codex diagnostic (reroute / rate-limit / warning); never silently dropped.
  | { id: string; kind: "diagnostic"; severity: "info" | "warning" | "error"; category: string; title: string; detail?: string; recovery?: string; at?: string }
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

export type MemberStatus = "working" | "idle" | "approval" | "not-started";

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
  unread: number;
  pendingApproval: boolean;
  busy: boolean;
  model: string;
  effort: string;
  permissionMode: string;
}

/** One watch-slot. Tabs time-share the slot; `active` is the visible member. */
export interface PanelState {
  id: string;
  tabs: string[]; // member names, left -> right
  active: string; // member name
  weight: number; // flex weight relative to sibling panels
}
