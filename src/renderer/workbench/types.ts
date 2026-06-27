import type { PartyMember, SessionView } from "../../shared/types";

/** Per-member transcript block — the rendering contract filled by agent events. */
export type TranscriptBlock =
  | { id: string; kind: "user" | "assistant" | "reasoning" | "status" | "error"; text: string; at?: string }
  | { id: string; kind: "tool"; name: string; status?: string; input?: unknown; result?: unknown; at?: string }
  | {
      id: string;
      kind: "approval";
      requestId: string;
      toolName: string;
      title?: string;
      description?: string;
      input?: unknown;
      resolved?: "allow" | "deny";
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
