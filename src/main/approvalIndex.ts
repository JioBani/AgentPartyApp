/**
 * Where each approval request came from, so one can be answered by its id alone
 * (`approval.respond`, see `src/shared/approvals.ts` for why that is needed).
 *
 * Fed from the workspace event stream, which carries BOTH local and WSL engine
 * sessions — the desktop forwards a distro engine's events down the same path —
 * so a phone can answer an approval raised inside WSL without knowing that is
 * where it lives.
 */

/** Retention. Long enough for a notification tapped much later to still be explained. */
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 1_000;

export interface ApprovalLocation {
  requestId: string;
  workspacePath: string;
  sessionId: string;
  requestedAt: number;
  /**
   * What is being approved, kept so a phone listing pending approvals can say
   * WHAT it is answering. Without these the list is a row of opaque ids, and a
   * user cannot consent to something the screen will not name.
   *
   * Absent when the app started mid-turn and only saw the `approval_resolved`.
   */
  toolName?: string;
  title?: string;
  /** Set once an `approval_resolved` for this id has been observed. */
  resolvedAt?: number;
  decision?: "allow" | "deny";
}

export class ApprovalIndex {
  /** Insertion-ordered, which is what makes the eviction below oldest-first. */
  private readonly byRequestId = new Map<string, ApprovalLocation>();

  /**
   * Records approvals seen on one workspace's renderer event channel. Knows
   * which channel carries them so callers can hand over the whole stream
   * without testing the channel name themselves.
   */
  note(workspacePath: string, channel: string, payload: unknown): void {
    if (channel !== "session:events") {
      return;
    }
    const message = payload as { sessionId?: unknown; events?: unknown };
    const sessionId = typeof message?.sessionId === "string" ? message.sessionId : "";
    if (!sessionId || !Array.isArray(message?.events)) {
      return;
    }
    for (const event of message.events as Array<Record<string, unknown>>) {
      const requestId = typeof event?.requestId === "string" ? event.requestId : "";
      if (!requestId) continue;
      if (event.type === "approval_request") {
        this.byRequestId.set(requestId, {
          requestId,
          workspacePath,
          sessionId,
          requestedAt: Date.now(),
          toolName: typeof event.toolName === "string" ? event.toolName : undefined,
          title: typeof event.title === "string" ? event.title : undefined,
        });
        this.evict();
      } else if (event.type === "approval_resolved") {
        const known = this.byRequestId.get(requestId);
        const decision = event.decision === "deny" ? "deny" : "allow";
        // Recorded even for an id we never saw requested (the app may have
        // started mid-turn): "already answered" is a better answer than
        // "unknown", and it is the truthful one.
        this.byRequestId.set(requestId, {
          requestId,
          workspacePath: known?.workspacePath || workspacePath,
          sessionId: known?.sessionId || sessionId,
          requestedAt: known?.requestedAt || Date.now(),
          toolName: known?.toolName,
          title: known?.title,
          resolvedAt: Date.now(),
          decision,
        });
        this.evict();
      }
    }
  }

  find(requestId: string): ApprovalLocation | undefined {
    const found = this.byRequestId.get(requestId);
    if (found && Date.now() - found.requestedAt > MAX_AGE_MS) {
      this.byRequestId.delete(requestId);
      return undefined;
    }
    return found;
  }

  /** Marks a request answered through this desktop, so a repeat tap says so. */
  markResolved(requestId: string, decision: "allow" | "deny"): void {
    const known = this.byRequestId.get(requestId);
    if (known) {
      known.resolvedAt = Date.now();
      known.decision = decision;
    }
  }

  /** Live entries, newest last. Exposed for diagnostics and tests. */
  list(): ApprovalLocation[] {
    return [...this.byRequestId.values()];
  }

  /**
   * Approvals still waiting on an answer, oldest first.
   *
   * This is what a phone asks for after being away: an approval raised while it
   * was disconnected is outside the event ring buffer, so without this listing
   * the phone can answer only approvals it happened to be online for — and the
   * user has no way to discover the rest from the phone at all.
   *
   * Aged-out entries are dropped here too, so a stale row cannot be offered as
   * answerable when {@link find} would no longer resolve it.
   */
  pending(workspacePath?: string): ApprovalLocation[] {
    const cutoff = Date.now() - MAX_AGE_MS;
    return [...this.byRequestId.values()]
      .filter((entry) => !entry.resolvedAt
        && entry.requestedAt >= cutoff
        && (!workspacePath || entry.workspacePath === workspacePath))
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }

  private evict(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const [requestId, entry] of this.byRequestId) {
      if (this.byRequestId.size <= MAX_ENTRIES && entry.requestedAt >= cutoff) {
        break; // Insertion order: everything after this is newer and within the cap.
      }
      this.byRequestId.delete(requestId);
    }
  }
}
