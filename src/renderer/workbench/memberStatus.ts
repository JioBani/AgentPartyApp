import type { PartyMember, SessionView } from "../../shared/types";
import { memberColor } from "../theme/memberColors";
import type { MemberStatus, MemberView, TranscriptBlock } from "./types";
import type { RouteLike, RouteVision } from "./routes";

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
    // The stall watchdog appends a "stall" diagnostic as the newest block when a
    // turn goes silent; while it stays newest (no later activity) the member is
    // stalled, not merely working — so the UI can offer stop/restart instead of
    // an indefinite spinner. Real activity appends after it and clears this.
    return isStalled(transcript) ? "stalled" : "working";
  }
  return "idle";
}

function isStalled(transcript: TranscriptBlock[]): boolean {
  const last = transcript[transcript.length - 1];
  return Boolean(last && last.kind === "diagnostic" && last.category === "stall");
}

export interface BuildMemberViewInput {
  member: PartyMember;
  sessions: SessionView[];
  transcriptBySession: Record<string, TranscriptBlock[]>;
  seenCount: number;
  /** Persisted transcript restored from disk — shown when no live session is bound. */
  restored?: TranscriptBlock[];
  /** Model routes, to resolve the effective model's vision (image) support. */
  routes?: RouteLike[];
}

/** The effective model's multimodal support, resolved from the routes. */
function visionFor(model: string, routes?: RouteLike[]): RouteVision | undefined {
  if (!routes || !model) {
    return undefined;
  }
  const route = routes.find((item) => item.model === model || item.runtimeModel === model);
  return route?.capabilities?.vision;
}

/** Assembles the per-member view consumed by panels, tabs, and the sidebar. */
export function buildMemberView({ member, sessions, transcriptBySession, seenCount, restored, routes }: BuildMemberViewInput): MemberView {
  const session = member.sessionId ? sessions.find((item) => item.id === member.sessionId) : undefined;
  // A live session's transcript wins (it is seeded from the restored history on
  // resume, so it already contains it); otherwise show the restored history so a
  // closed member — or a reopened app — still displays its past conversation.
  const live = session ? transcriptBySession[session.id] || [] : [];
  const transcript = live.length ? live : (restored || []);
  const status = deriveStatus(member, session, transcript);
  const model = String(session?.snapshot.model || member.model || "");
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
    model,
    effort: String(session?.snapshot.effort || member.effort || ""),
    permissionMode: String(session?.snapshot.permissionMode || member.permissionMode || ""),
    vision: visionFor(model, routes),
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
    case "stalled":
      return "stalled";
    case "approval":
      return "approval";
    case "not-started":
      return "not started";
    default:
      return "idle";
  }
}
