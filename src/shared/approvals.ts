/**
 * Answering an approval request by its own id.
 *
 * A phone woken by a push notification holds only the approval's id: it has no
 * session list, and a cold start has no store at all. iOS gives it roughly 30
 * seconds from the tap to reconnect and answer, so a lookup round trip does not
 * fit — and a session id it remembered from an earlier run is already dead if
 * the member has since respawned.
 *
 * So the desktop resolves the id itself, and reports the OUTCOME rather than a
 * bare success. The common case is a notification tapped ten minutes late, on a
 * request that has since expired or been answered at the desk; a phone that
 * showed "approved" for one of those would be lying to its user.
 */

/** What actually happened to an answer. Distinct so the phone can say which. */
export const APPROVAL_OUTCOMES = [
  /** The harness took the answer and the turn is proceeding. */
  "delivered",
  /** Someone already answered it — at the desk, or from another device. */
  "already_resolved",
  /** The request is gone: its turn ended, or its session was closed/respawned. */
  "expired",
  /** No such approval was ever seen on this desktop. */
  "unknown",
] as const;
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

/**
 * What one engine reports back about a single delivery attempt. Narrower than
 * {@link ApprovalOutcome}: an engine knows whether the harness took the answer,
 * but not whether the request had already been resolved earlier.
 */
export type ApprovalDelivery =
  /** The harness accepted it. */
  | "delivered"
  /** The session is alive but holds no such pending request. */
  | "not_pending"
  /** The session itself is gone. */
  | "no_such_session";

export interface ApprovalResponseResult {
  ok: true;
  outcome: ApprovalOutcome;
  requestId: string;
  /** Where the request was seen. Absent when the outcome is `unknown`. */
  workspacePath?: string;
  sessionId?: string;
  /** Which member owns the session, when the desktop knows it. */
  member?: string;
  requestedAt?: number;
  /** Set when the outcome is `already_resolved`. */
  resolvedAt?: number;
  decision?: "allow" | "deny";
}
