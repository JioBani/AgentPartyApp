/**
 * The member status the UI shows — one decision table, two callers.
 *
 * The renderer gathers its facts from the member, its live session and its
 * transcript; the main process gathers the same facts from the approval index
 * and the stall watchdog so a phone can be told the answer instead of guessing
 * at it. Only the FACTS differ between them. The ordering below does not, and
 * that is the point: two copies of this decision would drift, and a member list
 * that disagrees with itself across two screens is worse than one that is
 * merely incomplete.
 *
 * `PartyMember.status` — the stored value — is a different, six-value domain
 * (`idle | opened | running | closed | missing_session | sleeping`). It is an
 * input here, never the answer.
 */
export type MemberStatus =
  | "working"
  | "idle"
  | "approval"
  | "not-started"
  | "stalled"
  | "disconnected"
  | "sleeping"
  | "external-cli"
  | "closed";

/** What the caller must find out before the table below can decide. */
export interface MemberStatusFacts {
  /** The stored `PartyMember.status`. */
  stored: string;
  /** The member is bound to a session that this process actually holds. */
  hasLiveSession: boolean;
  /** That session is mid-turn (requesting / responding / interrupting). */
  busy: boolean;
  /** An approval prompt is open and unanswered. */
  pendingApproval: boolean;
  /** The stall watchdog has fired and nothing has happened since. */
  stalled: boolean;
}

/**
 * The ordering IS the definition — each step exists to stop a later one from
 * claiming something untrue.
 */
export function deriveMemberStatus(facts: MemberStatusFacts): MemberStatus {
  if (facts.stored === "external_cli") {
    return "external-cli";
  }
  // Before the no-session case, which it would otherwise fall into: a sleeping
  // member has no session BY DESIGN. "not started" would deny the conversation
  // sitting right there in the transcript, and hide why the next message takes
  // a moment to land.
  if (facts.stored === "sleeping") {
    return "sleeping";
  }
  // Here for the OPPOSITE reason to `sleeping`: a closed member refuses to
  // start on its own, so "not started" would assert the one thing that is
  // untrue — that a message would start it.
  if (facts.stored === "closed") {
    return "closed";
  }
  if (!facts.hasLiveSession) {
    return "not-started";
  }
  // FIRST among the live-session cases on purpose. An unresolved approval
  // restored from disk would otherwise pin a dead member in "approval" forever,
  // and a status left mid-flight would read as busy.
  if (facts.stored === "missing_session") {
    return "disconnected";
  }
  if (facts.pendingApproval) {
    return "approval";
  }
  if (facts.busy) {
    // Stalled rather than merely working, so the UI can offer stop/restart
    // instead of an indefinite spinner.
    return facts.stalled ? "stalled" : "working";
  }
  return "idle";
}
