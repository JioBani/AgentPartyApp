import type { PartyMember, SessionView } from "../../shared/types";
import { memberColor } from "../theme/memberColors";
import type { MemberStatus, MemberView, TranscriptBlock } from "./types";

const BUSY_STATUSES = new Set(["requesting", "responding", "interrupting"]);

export function isSessionBusy(session?: SessionView): boolean {
  return session ? BUSY_STATUSES.has(String(session.snapshot.status)) : false;
}

function hasPendingApproval(transcript: TranscriptBlock[], session?: SessionView): boolean {
  if (session && Number(session.snapshot.pendingApprovalCount || 0) > 0) {
    return true;
  }
  return transcript.some((block) => block.kind === "approval" && !block.resolved);
}

function deriveStatus(member: PartyMember, session: SessionView | undefined, transcript: TranscriptBlock[]): MemberStatus {
  if (!member.sessionId || !session) {
    return "not-started";
  }
  if (hasPendingApproval(transcript, session)) {
    return "approval";
  }
  if (isSessionBusy(session)) {
    return "working";
  }
  return "idle";
}

export interface BuildMemberViewInput {
  member: PartyMember;
  sessions: SessionView[];
  transcriptBySession: Record<string, TranscriptBlock[]>;
  seenCount: number;
}

/** Assembles the per-member view consumed by panels, tabs, and the sidebar. */
export function buildMemberView({ member, sessions, transcriptBySession, seenCount }: BuildMemberViewInput): MemberView {
  const session = member.sessionId ? sessions.find((item) => item.id === member.sessionId) : undefined;
  const transcript = session ? transcriptBySession[session.id] || [] : [];
  const status = deriveStatus(member, session, transcript);
  return {
    name: member.name,
    color: memberColor(member.name),
    member,
    session,
    status,
    transcript,
    unread: Math.max(0, transcript.length - seenCount),
    pendingApproval: status === "approval",
    busy: status === "working",
    model: String(session?.snapshot.model || member.model || ""),
    effort: String(session?.snapshot.effort || member.effort || ""),
    permissionMode: String(session?.snapshot.permissionMode || member.permissionMode || ""),
  };
}

/**
 * The most severe diagnostic among the last few transcript blocks, for the panel
 * header badge — so a reroute / rate-limit / warning is visible without scrolling.
 * Scans the tail only (recent), and error outranks warning outranks info.
 */
export function latestDiagnostic(transcript: TranscriptBlock[]): Extract<TranscriptBlock, { kind: "diagnostic" }> | undefined {
  const rank = (s: string) => (s === "error" ? 3 : s === "warning" ? 2 : 1);
  let best: Extract<TranscriptBlock, { kind: "diagnostic" }> | undefined;
  for (const block of transcript.slice(-12)) {
    if (block.kind === "diagnostic" && (!best || rank(block.severity) >= rank(best.severity))) {
      best = block;
    }
  }
  return best;
}

export function statusLabel(status: MemberStatus): string {
  switch (status) {
    case "working":
      return "working";
    case "approval":
      return "approval";
    case "not-started":
      return "not started";
    default:
      return "idle";
  }
}
