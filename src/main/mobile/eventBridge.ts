import { EVENT_BUFFER_MAX_AGE_MS, EVENT_BUFFER_MAX_COUNT, type RpcEvent } from "@agentparty/protocol";

/**
 * Desktop→phone event fan-out with the rewind ring buffer (01 §5.2–5.3, 04).
 *
 * One instance per desktop process. `seq` is global and monotonic for the
 * process lifetime — deliberately not per session, so a phone that reconnects
 * on a new session can still ask for "everything after N". `bootId` changes on
 * every process start, which is how the phone learns that `seq` restarted and
 * a replay is impossible.
 *
 * Delivery is filtered by each session's workspace subscription, and so is the
 * replay: a session that unsubscribed from a workspace must not receive its
 * backlog just because it rewound.
 */
export interface EventSession {
  sessionId: string;
  /** Called for each event this session should receive, in `seq` order. */
  deliver(event: RpcEvent): void;
}

/** What a `resume` request resolved to. The caller performs the transfer. */
export type ResumeOutcome =
  | { kind: "replay"; events: RpcEvent[]; throughSeq: number }
  | { kind: "snapshot"; reason: "boot_changed" | "out_of_window"; fromSeq: number };

export interface EventBridgeOptions {
  bootId: string;
  maxCount?: number;
  maxAgeMs?: number;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

interface Subscriber {
  session: EventSession;
  /** Workspace paths this session asked for. Empty = no workspace events. */
  workspaces: Set<string>;
  lastDeliveredSeq: number;
}

/**
 * A buffered event plus the scope it was published under. The scope has to be
 * retained: replay re-applies the session's CURRENT subscription set, which is
 * impossible without knowing which workspace each buffered event belonged to.
 */
interface BufferedEvent {
  event: RpcEvent;
  workspacePath: string | undefined;
}

export class EventBridge {
  private readonly buffer: BufferedEvent[] = [];
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly maxCount: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  readonly bootId: string;
  private seq = 0;

  constructor(options: EventBridgeOptions) {
    this.bootId = options.bootId;
    this.maxCount = options.maxCount ?? EVENT_BUFFER_MAX_COUNT;
    this.maxAgeMs = options.maxAgeMs ?? EVENT_BUFFER_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  attach(session: EventSession): void {
    this.subscribers.set(session.sessionId, {
      session,
      workspaces: new Set(),
      // A fresh session starts at the current head: `resume` is what asks for
      // history, and without it the phone would be flooded with the backlog.
      lastDeliveredSeq: this.seq,
    });
  }

  detach(sessionId: string): void {
    this.subscribers.delete(sessionId);
  }

  /** 01 §5.2 — replaces the session's subscription set; never merges. */
  setSubscription(sessionId: string, workspaces: readonly string[]): string[] {
    const subscriber = this.require(sessionId);
    subscriber.workspaces = new Set(workspaces);
    return [...subscriber.workspaces];
  }

  subscriptionOf(sessionId: string): string[] {
    return [...this.require(sessionId).workspaces];
  }

  lastDeliveredSeqOf(sessionId: string): number {
    return this.require(sessionId).lastDeliveredSeq;
  }

  /**
   * Assigns `seq`, buffers, and delivers to every session subscribed to
   * `workspacePath` (all sessions when the scope is omitted).
   *
   * Returns before allocating anything when no session is attached — this sits
   * on `broadcastToWorkspace`, which fires on every session event (04 §성능).
   */
  publish(type: string, payload: unknown, workspacePath?: string): RpcEvent | undefined {
    if (this.subscribers.size === 0) {
      return undefined;
    }
    const event: RpcEvent = { k: "evt", seq: ++this.seq, type, d: payload, ts: this.now() };
    this.buffer.push({ event, workspacePath });
    this.prune();

    for (const subscriber of this.subscribers.values()) {
      if (!this.matches(subscriber, workspacePath)) {
        continue;
      }
      subscriber.lastDeliveredSeq = event.seq;
      subscriber.session.deliver(event);
    }
    return event;
  }

  /**
   * 01 §5.3 — resolves a phone's `resume`. Replay is possible only when the
   * boot matches and `lastSeq` is still inside the buffer; otherwise the caller
   * must send a snapshot. `lastSeq === this.seq` is a valid no-op replay.
   */
  resume(sessionId: string, bootId: string, lastSeq: number): ResumeOutcome {
    const subscriber = this.require(sessionId);
    if (bootId !== this.bootId) {
      return { kind: "snapshot", reason: "boot_changed", fromSeq: this.seq };
    }
    const oldestBuffered = this.buffer[0]?.event.seq;
    const beyondHead = lastSeq > this.seq;
    // Nothing buffered yet is only replayable when the phone is already at the
    // head; otherwise its gap covers events that have already been pruned.
    const outOfWindow = beyondHead || (oldestBuffered === undefined ? lastSeq !== this.seq : lastSeq + 1 < oldestBuffered);
    if (outOfWindow) {
      return { kind: "snapshot", reason: "out_of_window", fromSeq: this.seq };
    }
    const events = this.buffer
      .filter((entry) => entry.event.seq > lastSeq && this.matches(subscriber, entry.workspacePath))
      .map((entry) => entry.event);
    subscriber.lastDeliveredSeq = this.seq;
    return { kind: "replay", events, throughSeq: this.seq };
  }

  /** Marks a session as caught up to the live head, after a snapshot. */
  markSnapshotDelivered(sessionId: string): number {
    const subscriber = this.require(sessionId);
    subscriber.lastDeliveredSeq = this.seq;
    return this.seq;
  }

  /** Ring-buffer window reported by `sys.info` and the status route. */
  window(): { seq: number; minSeq: number; maxSeq: number; count: number } {
    return {
      seq: this.seq,
      minSeq: this.buffer[0]?.event.seq ?? 0,
      maxSeq: this.buffer[this.buffer.length - 1]?.event.seq ?? 0,
      count: this.buffer.length,
    };
  }

  // -- internals ------------------------------------------------------------

  private require(sessionId: string): Subscriber {
    const subscriber = this.subscribers.get(sessionId);
    if (!subscriber) {
      throw new Error(`event bridge: unknown session ${sessionId}`);
    }
    return subscriber;
  }

  private matches(subscriber: Subscriber, workspacePath: string | undefined): boolean {
    return workspacePath === undefined || subscriber.workspaces.has(workspacePath);
  }

  /** 04 — drop by count first, then by age; whichever bound is hit. */
  private prune(): void {
    const cutoff = this.now() - this.maxAgeMs;
    while (this.buffer.length > this.maxCount || (this.buffer.length > 0 && this.buffer[0].event.ts < cutoff)) {
      this.buffer.shift();
    }
  }
}
