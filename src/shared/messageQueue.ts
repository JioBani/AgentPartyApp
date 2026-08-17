/**
 * Message queue — what a member has been told but has NOT yet been handed.
 *
 * Every harness already buffers turns internally (`queuedUserTurns` in the
 * Claude/Codex/Cursor adapters), but that buffer is write-only from the app's
 * point of view: it leaks a *count* and nothing else, it lives in process
 * memory, and once a turn is in it there is no way to take it back. That makes
 * the three things the user actually wants — see what is waiting, cancel it,
 * edit it — impossible to build on top of.
 *
 * So the queue is owned HERE, one level above the harness: a message aimed at a
 * busy member is held by the app, and `sendUserTurn` is not called at all until
 * the item is dequeued.
 *
 * There is exactly ONE queue, and it is this one. The app never hands a turn to
 * a busy session — not even for "지금 보내기" or `interrupt: true`. Both pull
 * the item to the front and stop the turn instead; the idle drain is the only
 * path into the harness. Nothing distinguishes a second holding pen from where
 * the user sits: they typed one message, into one box, and a buffer they cannot
 * see, edit or cancel is not a feature but a leak. The adapter buffer remains
 * only as the net for the genuine race (a member can go idle between our check
 * and the send).
 *
 * Pure logic — no I/O — so main (ownership + persistence) and renderer (the
 * queue UI) agree by construction and the rules are unit-testable in isolation.
 *
 * Every mutation returns a discriminated result rather than a best-effort new
 * array. A cancel that matched nothing is a REAL failure the user must see: the
 * item it targeted was almost certainly already handed to the harness, and
 * silently returning the unchanged queue would render as "cancelled" while the
 * agent answers it anyway.
 */

import type { ImageAttachment } from "./attachments";

/** One waiting message. `from: null` means the user typed it; otherwise a member sent it. */
export interface QueuedMessage {
  id: string;
  text: string;
  /** Member name that sent it, or null for the user. Drives the sender chip and the merge boundary. */
  from: string | null;
  /** Enqueue time, ISO. */
  at: string;
  attachments?: ImageAttachment[];
  /**
   * True when this row cut in via interrupt / "지금 바로 처리". Cut-in rows sit
   * ahead of ordinary waiting rows; among themselves they keep arrival order
   * so a later interrupt cannot leapfrog an earlier one.
   */
  cutIn?: boolean;
}

/** Per-member queue state as persisted on the member record. */
export interface MemberQueueState {
  items: QueuedMessage[];
  /** Merge-on-send preference. Undefined inherits {@link DEFAULT_QUEUE_MERGE}. */
  merge?: boolean;
  /** Collapsed preference. Undefined lets the panel width decide (narrow starts collapsed). */
  collapsed?: boolean;
}

/**
 * Merging defaults ON: the overwhelmingly common case is a person firing off
 * several lines of one thought while the agent works, and delivering those as
 * separate turns makes the agent answer the first line before it has read the
 * rest.
 */
export const DEFAULT_QUEUE_MERGE = true;

/**
 * Upper bound on a single member's queue. Not a silent drop — {@link enqueue}
 * refuses past this point and the caller surfaces the refusal, because a queue
 * that quietly stops accepting is indistinguishable from a message that was
 * sent and ignored.
 */
export const QUEUE_LIMIT = 20;

/** Separator between merged items. A blank line, so paragraph structure survives. */
export const MERGE_SEPARATOR = "\n\n";

export type QueueFailure =
  | "not_found"
  | "queue_full"
  | "empty_text"
  | "already_first"
  | "out_of_range"
  | "already_there"
  | "different_sender"
  | "empty_queue";

export type QueueResult<T> = { ok: true; value: T } | { ok: false; reason: QueueFailure };

const ok = <T>(value: T): QueueResult<T> => ({ ok: true, value });
const fail = <T>(reason: QueueFailure): QueueResult<T> => ({ ok: false, reason });

/** Human-readable reason, surfaced in the UI notice and the HTTP error body. */
export function describeQueueFailure(reason: QueueFailure): string {
  switch (reason) {
    case "not_found":
      return "그 메시지는 이미 대기열에 없습니다 — 먼저 전송되었을 수 있습니다.";
    case "queue_full":
      return `대기열이 가득 찼습니다 (최대 ${QUEUE_LIMIT}건). 기존 항목을 보내거나 취소한 뒤 다시 시도하세요.`;
    case "empty_text":
      return "빈 메시지는 대기열에 넣을 수 없습니다.";
    case "already_first":
      return "이미 맨 위 항목입니다.";
    case "out_of_range":
      return "대기열에 없는 위치로는 옮길 수 없습니다.";
    case "already_there":
      return "이미 그 자리에 있습니다.";
    case "different_sender":
      return "보낸 사람이 다른 메시지끼리는 합칠 수 없습니다.";
    case "empty_queue":
      return "대기열이 비어 있습니다.";
  }
}

export function emptyQueue(): MemberQueueState {
  return { items: [] };
}

/** Normalizes whatever was read off disk into a well-formed queue (tolerates older records with no queue). */
export function readQueue(state: MemberQueueState | undefined): MemberQueueState {
  if (!state || !Array.isArray(state.items)) {
    return emptyQueue();
  }
  return { items: state.items.filter(isQueuedMessage), merge: state.merge, collapsed: state.collapsed };
}

function isQueuedMessage(item: unknown): item is QueuedMessage {
  const candidate = item as QueuedMessage | undefined;
  return Boolean(candidate && typeof candidate.id === "string" && typeof candidate.text === "string");
}

/** Effective merge setting for a member (its own preference, else the global default). */
export function mergeOn(state: MemberQueueState): boolean {
  return state.merge === undefined ? DEFAULT_QUEUE_MERGE : state.merge;
}

/**
 * Consecutive same-sender runs, in queue order.
 *
 * A sender change ends a MERGE UNIT, not the delivery: everything waiting goes
 * out in ONE turn, and each run inside it keeps its own attribution. Merging
 * across senders is the one thing that is never done — a member's words folded
 * into the user's are not merged but misattributed — and that is the whole
 * reason the turn is a list of runs rather than one string.
 *
 * The cut-in flag deliberately does NOT split a run. It orders the queue (a
 * cut-in row is parked at the front) and nothing else; once the whole queue
 * leaves together, treating it as a merge boundary would only split one
 * person's words for no reason the reader could see.
 */
export function senderRuns(items: QueuedMessage[]): QueuedMessage[][] {
  const runs: QueuedMessage[][] = [];
  for (const item of items) {
    const current = runs[runs.length - 1];
    if (current && (current[0].from ?? null) === (item.from ?? null)) {
      current.push(item);
      continue;
    }
    runs.push([item]);
  }
  return runs;
}

/**
 * The first same-sender run. Only a rendering aid now (the queue's first block);
 * delivery takes the whole queue — see {@link takeNext}.
 */
export function leadRun(items: QueuedMessage[]): QueuedMessage[] {
  return senderRuns(items)[0] || [];
}

/** True when the queue holds more than one distinct sender (drives the "같은 것끼리만" hint). */
export function hasMixedSenders(items: QueuedMessage[]): boolean {
  if (items.length < 2) {
    return false;
  }
  const first = items[0].from ?? null;
  return items.some((item) => (item.from ?? null) !== first);
}

/**
 * Merged body for a run. Original order and original wording are preserved
 * verbatim — no summarizing, no numbering. The agent must read exactly what the
 * sender wrote.
 */
export function mergeTexts(items: QueuedMessage[]): string {
  return items.map((item) => item.text).join(MERGE_SEPARATOR);
}

/** Attachments of a run, flattened in order, so merging never drops an image. */
export function mergeAttachments(items: QueuedMessage[]): ImageAttachment[] | undefined {
  const all = items.flatMap((item) => item.attachments || []);
  return all.length ? all : undefined;
}

export function enqueue(state: MemberQueueState, item: QueuedMessage): QueueResult<MemberQueueState> {
  if (!item.text.trim() && !(item.attachments || []).length) {
    return fail("empty_text");
  }
  if (state.items.length >= QUEUE_LIMIT) {
    return fail("queue_full");
  }
  // Always appended. Arrival order IS the order the sender intended.
  return ok({ ...state, items: [...state.items, item] });
}

/**
 * Parks a message ahead of ordinary waiting rows — what interrupt / "지금 바로
 * 처리" means. Inserts AFTER any cut-in rows already at the front so multiple
 * interrupts keep arrival order among themselves; only the non-cut-in tail is
 * jumped. Marks the item `cutIn` so the UI can say why it is ahead.
 */
export function enqueueCutIn(state: MemberQueueState, item: QueuedMessage): QueueResult<MemberQueueState> {
  if (!item.text.trim() && !(item.attachments || []).length) {
    return fail("empty_text");
  }
  if (state.items.length >= QUEUE_LIMIT) {
    return fail("queue_full");
  }
  const cutInItem: QueuedMessage = { ...item, cutIn: true };
  let insertAt = 0;
  while (insertAt < state.items.length && state.items[insertAt].cutIn) {
    insertAt += 1;
  }
  const items = state.items.slice();
  items.splice(insertAt, 0, cutInItem);
  return ok({ ...state, items });
}

/** @deprecated Use {@link enqueueCutIn} — kept as an alias so call sites read clearly. */
export function enqueueFront(state: MemberQueueState, item: QueuedMessage): QueueResult<MemberQueueState> {
  return enqueueCutIn(state, item);
}

export function removeItem(state: MemberQueueState, id: string): QueueResult<{ state: MemberQueueState; removed: QueuedMessage }> {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) {
    return fail("not_found");
  }
  const items = state.items.slice();
  const [removed] = items.splice(index, 1);
  return ok({ state: { ...state, items }, removed });
}

/**
 * Moves an item to an absolute position.
 *
 * An absolute target rather than a step, because the gesture that drives this is
 * a drag: the user picks a row up and puts it down somewhere, and expressing
 * that as a run of ±1 swaps would make the queue pass through orders nobody
 * asked for — each one persisted, broadcast, and briefly rendered.
 */
export function moveItemTo(state: MemberQueueState, id: string, toIndex: number): QueueResult<MemberQueueState> {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) {
    return fail("not_found");
  }
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= state.items.length) {
    return fail("out_of_range");
  }
  if (toIndex === index) {
    return fail("already_there");
  }
  const items = state.items.slice();
  const [moved] = items.splice(index, 1);
  items.splice(toIndex, 0, moved);
  return ok({ ...state, items });
}

/**
 * Pulls an item to the front without reordering anything else — what "지금
 * 보내기" means on a busy member, whose message cannot jump the harness but can
 * jump the rest of the queue.
 */
export function moveItemToFront(state: MemberQueueState, id: string): QueueResult<MemberQueueState> {
  const moved = moveItemTo(state, id, 0);
  return moved.ok || moved.reason !== "already_there" ? moved : ok(state);
}

/**
 * Folds an item into the one above it. Only within a sender — see {@link leadRun}
 * for why crossing that boundary is not a merge but a forgery.
 */
export function mergeUp(state: MemberQueueState, id: string): QueueResult<MemberQueueState> {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) {
    return fail("not_found");
  }
  if (index === 0) {
    return fail("already_first");
  }
  return mergeInto(state, id, state.items[index - 1].id);
}

/**
 * Folds `sourceId` into `targetId` wherever the two sit — what dropping one
 * queued message onto another means.
 *
 * The source lands AFTER the target's text: the target is the message being
 * added to, the dragged one is the addition. The target keeps its place in the
 * queue, because merging changes what a message says, not when it is sent.
 *
 * One operation rather than a move followed by a merge. As two steps, a failure
 * in between would leave the queue reordered but unmerged — the user asked to
 * combine two messages and would silently have got their order changed instead.
 *
 * Still refused across senders, for the reason {@link leadRun} gives: folding
 * one member's words into another's does not merge them, it misattributes them.
 */
export function mergeInto(state: MemberQueueState, sourceId: string, targetId: string): QueueResult<MemberQueueState> {
  if (sourceId === targetId) {
    return fail("already_there");
  }
  const sourceIndex = state.items.findIndex((item) => item.id === sourceId);
  const targetIndex = state.items.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) {
    return fail("not_found");
  }
  const source = state.items[sourceIndex];
  const target = state.items[targetIndex];
  if ((source.from ?? null) !== (target.from ?? null)) {
    return fail("different_sender");
  }
  const items = state.items.slice();
  items[targetIndex] = {
    ...target,
    text: mergeTexts([target, source]),
    attachments: mergeAttachments([target, source]),
  };
  items.splice(sourceIndex, 1);
  return ok({ ...state, items });
}

/** One same-sender block of a dequeued turn — the merge unit, with its author. */
export interface DequeuedBlock {
  /** Member name that wrote these, or null for the user. */
  from: string | null;
  /** The run's messages, merged verbatim in order. */
  text: string;
  /** Items folded into this block. */
  count: number;
  attachments?: ImageAttachment[];
}

/** What a dequeue hands to the harness: ONE turn, as its ordered author blocks. */
export interface DequeuedTurn {
  /**
   * Every item that left, in order, folded into same-sender blocks. A list
   * rather than a string because the caller renders each block with its own
   * attribution (a member's block travels in its channel envelope), which is
   * what lets one turn carry several authors without forging any of them.
   */
  blocks: DequeuedBlock[];
  /** Every attachment that left, flattened in order. */
  attachments?: ImageAttachment[];
  /** Item count folded into this turn (>1 renders the "N건 합쳐서 보냄" badge). */
  count: number;
}

function blockOf(run: QueuedMessage[]): DequeuedBlock {
  return { from: run[0].from ?? null, text: mergeTexts(run), count: run.length, attachments: mergeAttachments(run) };
}

/**
 * Takes what should go out next.
 *
 * With merge ON that is the WHOLE queue, as one turn: a member waiting behind
 * the user (or the other way round) was never a reason to make the recipient
 * answer twice, and holding the rest back meant the second half arrived after a
 * reply written without it. Merging still stops at a sender change — the turn
 * carries the runs separately (see {@link senderRuns}) — so nothing is ever
 * attributed to the wrong author. With merge OFF exactly one item leaves.
 *
 * Either way the returned state is what remains: the caller sends `turn` and
 * persists `state` together, so a crash between the two can only ever re-send,
 * never silently swallow.
 */
export function takeNext(state: MemberQueueState): QueueResult<{ state: MemberQueueState; turn: DequeuedTurn }> {
  if (!state.items.length) {
    return fail("empty_queue");
  }
  const taken = mergeOn(state) ? state.items : state.items.slice(0, 1);
  return ok({
    state: { ...state, items: state.items.slice(taken.length) },
    turn: { blocks: senderRuns(taken).map(blockOf), attachments: mergeAttachments(taken), count: taken.length },
  });
}

/** Takes one specific item out for immediate delivery ("지금 보내기" on a row). */
export function takeItem(state: MemberQueueState, id: string): QueueResult<{ state: MemberQueueState; turn: DequeuedTurn }> {
  const removal = removeItem(state, id);
  if (!removal.ok) {
    return fail(removal.reason);
  }
  const { state: next, removed } = removal.value;
  return ok({ state: next, turn: { blocks: [blockOf([removed])], attachments: removed.attachments, count: 1 } });
}

export function clearQueue(state: MemberQueueState): MemberQueueState {
  return { ...state, items: [] };
}

/**
 * Every mutation the UI and the HTTP API can ask for, as one discriminated
 * command. A single command travels the whole stack (renderer → AppController →
 * engine RPC → service) instead of nine near-identical methods repeated at each
 * layer, so adding a queue operation is one case, not four signatures.
 */
export type QueueCommand =
  /** Deliver the leading run now ("합쳐서 지금 보내기"). */
  | { action: "send" }
  /** Drop everything waiting ("모두 취소"). */
  | { action: "clear" }
  /** Persist a per-member preference; omitted fields are left alone. */
  | { action: "preference"; merge?: boolean; collapsed?: boolean }
  /** Deliver exactly one row now ("지금 보내기"). */
  | { action: "sendItem"; itemId: string }
  /** Remove one row ("삭제"). */
  | { action: "cancel"; itemId: string }
  /** Remove one row and hand its text back for the composer ("편집"). */
  | { action: "edit"; itemId: string }
  /** Put one row at an absolute position — the drop half of a drag. */
  | { action: "move"; itemId: string; toIndex: number }
  /** Fold one row into the row above it ("위와 합치기"). */
  | { action: "mergeUp"; itemId: string }
  /** Fold one row into another — dropping a queued message onto a message. */
  | { action: "mergeInto"; itemId: string; targetId: string };

/**
 * Validates an untrusted command (HTTP body). Rejects rather than guessing: a
 * misspelled action that silently fell through to a default would be a mutation
 * the caller never asked for.
 */
export function parseQueueCommand(body: unknown): QueueCommand {
  const input = (body || {}) as Record<string, unknown>;
  const action = String(input.action || "");
  const itemId = typeof input.itemId === "string" ? input.itemId : "";
  const needsItem = (): string => {
    if (!itemId) {
      throw new Error(`Queue action '${action}' requires an 'itemId'.`);
    }
    return itemId;
  };
  switch (action) {
    case "send":
      return { action: "send" };
    case "clear":
      return { action: "clear" };
    case "preference": {
      if (input.merge === undefined && input.collapsed === undefined) {
        throw new Error("Queue action 'preference' requires 'merge' and/or 'collapsed'.");
      }
      return {
        action: "preference",
        merge: input.merge === undefined ? undefined : input.merge === true,
        collapsed: input.collapsed === undefined ? undefined : input.collapsed === true,
      };
    }
    case "sendItem":
      return { action: "sendItem", itemId: needsItem() };
    case "cancel":
      return { action: "cancel", itemId: needsItem() };
    case "edit":
      return { action: "edit", itemId: needsItem() };
    case "mergeUp":
      return { action: "mergeUp", itemId: needsItem() };
    case "mergeInto": {
      const targetId = typeof input.targetId === "string" ? input.targetId : "";
      if (!targetId) {
        throw new Error("Queue action 'mergeInto' requires a 'targetId' — the row being merged into.");
      }
      return { action: "mergeInto", itemId: needsItem(), targetId };
    }
    case "move": {
      const toIndex = Number(input.toIndex);
      if (!Number.isInteger(toIndex) || toIndex < 0) {
        throw new Error("Queue action 'move' requires 'toIndex', a 0-based position in the queue.");
      }
      return { action: "move", itemId: needsItem(), toIndex };
    }
    default:
      throw new Error(`Unknown queue action '${action}'.`);
  }
}
