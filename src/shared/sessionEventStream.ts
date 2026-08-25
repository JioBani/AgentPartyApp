/**
 * Position in one live session's ordered event stream.
 *
 * `streamId` changes when a session process is recreated, so a sequence reset
 * can never be mistaken for an already-consumed batch from the previous
 * process. `seq` is contiguous and starts at one inside that stream.
 */
export interface SessionEventCursor {
  streamId: string;
  seq: number;
}

/** One renderer/main-process delivery unit from SessionManager. */
export interface SessionEventBatch<TEvent = unknown> {
  sessionId: string;
  workspace?: string;
  events: TEvent[];
  /** Absent only for legacy fixtures that bypass SessionManager. */
  streamId?: string;
  /** Absent only for legacy fixtures that bypass SessionManager. */
  seq?: number;
}

/**
 * Materialized transcript plus the exact live-event position it contains.
 * The two values are captured together by the main-process recorder.
 */
export interface TranscriptSnapshot<TBlock = unknown> {
  blocks: TBlock[];
  cursor?: SessionEventCursor;
}

export interface SessionEventGap {
  streamId: string;
  expectedSeq: number;
  receivedSeq: number;
}

export interface SessionEventReconciliation<TEvent = unknown> {
  /** Pending batches not already materialized in the snapshot. */
  batches: SessionEventBatch<TEvent>[];
  /** Highest position represented by snapshot + accepted pending batches. */
  cursor?: SessionEventCursor;
  /** First proven gap after the snapshot boundary, if any. */
  gap?: SessionEventGap;
}

/** Returns a usable cursor only for a fully stamped live batch. */
export function sessionEventCursor(batch: Pick<SessionEventBatch, "streamId" | "seq"> | null | undefined): SessionEventCursor | undefined {
  return typeof batch?.streamId === "string"
    && batch.streamId.length > 0
    && Number.isSafeInteger(batch.seq)
    && Number(batch.seq) >= 0
    ? { streamId: batch.streamId, seq: Number(batch.seq) }
    : undefined;
}

/** Whether a materialized snapshot/current cursor already contains this batch. */
export function cursorCoversBatch(cursor: SessionEventCursor | undefined, batch: SessionEventBatch): boolean {
  const incoming = sessionEventCursor(batch);
  return Boolean(cursor && incoming && cursor.streamId === incoming.streamId && cursor.seq >= incoming.seq);
}

/** Keeps legacy/other-epoch batches for zero-loss, dropping only proven overlap. */
export function batchesAfterSessionEventCursor<TEvent>(
  batches: SessionEventBatch<TEvent>[],
  cursor: SessionEventCursor | undefined,
): SessionEventBatch<TEvent>[] {
  return batches.filter((batch) => !cursorCoversBatch(cursor, batch));
}

/** Advances monotonically inside a stream; a new stream starts its own epoch. */
export function advanceSessionEventCursor(
  current: SessionEventCursor | undefined,
  incoming: SessionEventCursor | undefined,
): SessionEventCursor | undefined {
  if (!incoming) return current;
  if (!current || current.streamId !== incoming.streamId || incoming.seq > current.seq) {
    return incoming;
  }
  return current;
}

/** Detects a skipped batch, including a new stream first observed after seq 1. */
export function hasSessionEventGap(previous: SessionEventCursor | undefined, incoming: SessionEventCursor | undefined): boolean {
  if (!incoming) return false;
  if (!previous || previous.streamId !== incoming.streamId) {
    return incoming.seq > 1;
  }
  return incoming.seq > previous.seq + 1;
}

/**
 * Reconciles live batches buffered while a transcript snapshot was loading.
 *
 * A newly opened window may first observe live batch 9, then receive a snapshot
 * that already contains batches 1–8. Calling `hasSessionEventGap(undefined, 9)`
 * before that snapshot arrives is therefore a false positive. Gap detection is
 * valid only after the atomic snapshot cursor establishes the base position.
 */
export function reconcileSessionEventBatches<TEvent>(
  batches: SessionEventBatch<TEvent>[],
  snapshotCursor: SessionEventCursor | undefined,
): SessionEventReconciliation<TEvent> {
  const uncovered = batchesAfterSessionEventCursor(batches, snapshotCursor);
  let cursor = snapshotCursor;
  let gap: SessionEventGap | undefined;
  for (const batch of uncovered) {
    const incoming = sessionEventCursor(batch);
    if (!gap && hasSessionEventGap(cursor, incoming) && incoming) {
      gap = {
        streamId: incoming.streamId,
        expectedSeq: cursor?.streamId === incoming.streamId ? cursor.seq + 1 : 1,
        receivedSeq: incoming.seq,
      };
    }
    cursor = advanceSessionEventCursor(cursor, incoming);
  }
  return { batches: uncovered, cursor, gap };
}
