/*
 * Message queue rules — unit test of the pure logic in shared/messageQueue.ts.
 *
 * The queue moved OUT of the harness adapters and into the app so waiting
 * messages can be seen, cancelled and edited. Two properties matter most and
 * are easy to regress:
 *   1) merging never crosses a sender boundary (that would forge attribution),
 *   2) a mutation that matched nothing REPORTS failure instead of returning the
 *      queue unchanged — a "cancel" that silently no-ops reads as success while
 *      the agent answers the message anyway.
 * No Electron, no model — pure logic.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const outDir = qaTempDir();

async function load(entry, name) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
  const file = path.join(outDir, name); writeFileSync(file, r.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const Q = await load("src/shared/messageQueue.ts", "message-queue.mjs");

const item = (id, text, from = null) => ({ id, text, from, at: "2026-08-02T00:00:00.000Z" });
const queueOf = (...items) => ({ items });

// ============ 1) leading run — the merge unit ============
console.log("\nleadRun (merge boundary):");
{
  const mine = queueOf(item("a", "1"), item("b", "2"), item("c", "3", "reviewer"));
  assert(Q.leadRun(mine.items).length === 2, "the run stops where the sender changes");
  assert(Q.leadRun([]).length === 0, "an empty queue has an empty run");
  assert(Q.leadRun(queueOf(item("a", "1", "reviewer"), item("b", "2", "reviewer")).items).length === 2, "a member's own consecutive items form one run");

  // A cut-in row orders the queue and nothing else. It used to end the merge
  // unit too, back when only the leading run left; now the whole queue goes in
  // one turn, so splitting one person's words at it would show the reader a
  // boundary that means nothing.
  const cutInThenWaiting = queueOf({ ...item("u", "urgent"), cutIn: true }, item("a", "1"), item("b", "2"));
  assert(Q.leadRun(cutInThenWaiting.items).length === 3, "a cut-in row merges with the same sender's rows behind it — it only sets the ORDER");
  assert(Q.senderRuns(mine.items).map((run) => run.length).join(",") === "2,1", "senderRuns splits the queue into author blocks, in order");
  assert(Q.senderRuns([]).length === 0, "an empty queue has no blocks");

  const alternating = queueOf(item("a", "1"), item("b", "2", "reviewer"), item("c", "3"));
  assert(Q.leadRun(alternating.items).length === 1, "a single leading item is a run of one");
  assert(Q.hasMixedSenders(alternating.items) === true, "mixed senders are detected");
  assert(Q.hasMixedSenders(mine.items) === true, "a trailing different sender counts as mixed");
  assert(Q.hasMixedSenders([item("a", "1"), item("b", "2")]) === false, "one sender is not mixed");
  assert(Q.hasMixedSenders([item("a", "1")]) === false, "a single item is never mixed");
}

// ============ 2) merged body ============
console.log("\nmergeTexts (verbatim, blank-line joined):");
{
  const merged = Q.mergeTexts([item("a", "first"), item("b", "second")]);
  assert(merged === "first\n\nsecond", "items join with exactly one blank line");
  assert(Q.mergeTexts([item("a", "line1\nline2"), item("b", "x")]) === "line1\nline2\n\nx", "internal newlines are preserved untouched");
  assert(Q.mergeTexts([item("a", "solo")]) === "solo", "a single item merges to itself with no separator");
}

// ============ 3) enqueue bounds ============
console.log("\nenqueue:");
{
  const appended = Q.enqueue(queueOf(item("a", "1")), item("b", "2"));
  assert(appended.ok && appended.value.items.map((i) => i.id).join(",") === "a,b", "enqueue always appends to the end");

  const front = Q.enqueueCutIn(queueOf(item("a", "1"), item("b", "2")), item("u", "urgent"));
  assert(front.ok && front.value.items.map((i) => i.id).join(",") === "u,a,b", "enqueueCutIn parks interrupt/send-now ahead of waiting rows");
  assert(front.value.items[0].cutIn === true, "…and marks the row so the UI can say why it is ahead");
  assert(queueOf(item("a", "1")).items.map((i) => i.id).join(",") === "a", "enqueueCutIn leaves the original queue untouched");

  const second = Q.enqueueCutIn(front.value, item("u2", "second urgent"));
  assert(second.ok && second.value.items.map((i) => i.id).join(",") === "u,u2,a,b", "a later interrupt keeps arrival order among cut-in rows (does not leapfrog the earlier one)");

  const blank = Q.enqueue(queueOf(), item("x", "   "));
  assert(!blank.ok && blank.reason === "empty_text", "whitespace-only text is refused, not silently queued");

  const blankFront = Q.enqueueCutIn(queueOf(), item("x", "   "));
  assert(!blankFront.ok && blankFront.reason === "empty_text", "enqueueCutIn refuses empty text the same way");

  const withImage = Q.enqueue(queueOf(), { ...item("x", ""), attachments: [{ id: "i" }] });
  assert(withImage.ok, "an image-only message is legitimate and accepted");

  const full = queueOf(...Array.from({ length: Q.QUEUE_LIMIT }, (_, i) => item(`f${i}`, "x")));
  const overflow = Q.enqueue(full, item("over", "y"));
  assert(!overflow.ok && overflow.reason === "queue_full", "past the limit enqueue REFUSES rather than dropping silently");
  assert(full.items.length === Q.QUEUE_LIMIT, "the refused enqueue left the queue untouched");
  const overflowFront = Q.enqueueCutIn(full, item("over", "y"));
  assert(!overflowFront.ok && overflowFront.reason === "queue_full", "enqueueCutIn refuses at the same limit");
}

// ============ 4) failure is reported, not swallowed ============
console.log("\nmutations report failure:");
{
  const one = queueOf(item("a", "1"), item("b", "2"));

  const gone = Q.removeItem(one, "nope");
  assert(!gone.ok && gone.reason === "not_found", "cancelling an item that already left FAILS (it is in the harness now)");

  const nowhere = Q.moveItemTo(one, "a", 0);
  assert(!nowhere.ok && nowhere.reason === "already_there", "dropping a row where it already is fails explicitly rather than rewriting the queue");
  const offEnd = Q.moveItemTo(one, "a", 2);
  assert(!offEnd.ok && offEnd.reason === "out_of_range", "a drop past the end is refused, not clamped into a move nobody asked for");
  const ghost = Q.moveItemTo(one, "nope", 1);
  assert(!ghost.ok && ghost.reason === "not_found", "moving an item that already left FAILS");

  const okMove = Q.moveItemTo(one, "b", 0);
  assert(okMove.ok && okMove.value.items.map((i) => i.id).join(",") === "b,a", "a legal drop lands the row at the target position");
  assert(one.items.map((i) => i.id).join(",") === "a,b", "the original queue is never mutated in place");

  // The reason the command carries a position and not a direction: a drag
  // crosses several slots at once, and the queue must never be seen in the
  // in-between orders a run of swaps would produce.
  const four = queueOf(item("a", "1"), item("b", "2"), item("c", "3"), item("d", "4"));
  const far = Q.moveItemTo(four, "a", 3);
  assert(far.ok && far.value.items.map((i) => i.id).join(",") === "b,c,d,a", "a row dropped three slots down lands there in one move");
  const back = Q.moveItemTo(four, "d", 1);
  assert(back.ok && back.value.items.map((i) => i.id).join(",") === "a,d,b,c", "and the same holds dragging upward");

  const front = Q.moveItemToFront(four, "c");
  assert(front.ok && front.value.items.map((i) => i.id).join(",") === "c,a,b,d", "지금 보내기 pulls its row to the front, leaving the rest in order");
  const alreadyFront = Q.moveItemToFront(four, "a");
  assert(alreadyFront.ok && alreadyFront.value.items.map((i) => i.id).join(",") === "a,b,c,d", "asking for the front when already there is a no-op, not a failure");

  const okRemove = Q.removeItem(one, "a");
  assert(okRemove.ok && okRemove.value.removed.id === "a" && okRemove.value.state.items.length === 1, "remove returns both the survivor state and the removed item");

  assert(Q.describeQueueFailure("not_found").length > 0, "every failure has a human-readable reason for the UI");
  assert(Q.describeQueueFailure("queue_full").includes(String(Q.QUEUE_LIMIT)), "the full-queue message names the actual limit");
}

// ============ 5) mergeUp stays inside a sender ============
console.log("\nmergeUp:");
{
  const mixed = queueOf(item("a", "mine"), item("b", "theirs", "reviewer"));
  const crossed = Q.mergeUp(mixed, "b");
  assert(!crossed.ok && crossed.reason === "different_sender", "merging across senders is refused — attribution must not be forged");

  const same = queueOf(item("a", "one"), item("b", "two"));
  const folded = Q.mergeUp(same, "b");
  assert(folded.ok && folded.value.items.length === 1, "same-sender mergeUp collapses two rows into one");
  assert(folded.ok && folded.value.items[0].text === "one\n\ntwo", "the folded row carries both bodies in order");
  assert(folded.ok && folded.value.items[0].id === "a", "the surviving row keeps the UPPER item's id");

  const first = Q.mergeUp(same, "a");
  assert(!first.ok && first.reason === "already_first", "the first row has nothing above it to merge into");

  const images = queueOf({ ...item("a", "one"), attachments: [{ id: "i1" }] }, { ...item("b", "two"), attachments: [{ id: "i2" }] });
  const withImages = Q.mergeUp(images, "b");
  assert(withImages.ok && withImages.value.items[0].attachments.length === 2, "merging carries BOTH items' attachments — an image is never dropped");
}

// ============ 6) takeNext honours the merge setting ============
console.log("\ntakeNext (what actually leaves):");
{
  const three = queueOf(item("a", "1"), item("b", "2"), item("c", "3", "reviewer"));

  const mergedTake = Q.takeNext({ ...three, merge: true });
  assert(mergedTake.ok && mergedTake.value.turn.count === 3, "merge ON sends the WHOLE queue as one turn");
  assert(mergedTake.ok && mergedTake.value.state.items.length === 0, "…so nothing is left waiting for a second turn");
  assert(mergedTake.ok && mergedTake.value.turn.blocks.length === 2, "the turn is split into author blocks, not one forged string");
  assert(mergedTake.ok && mergedTake.value.turn.blocks[0].from === null && mergedTake.value.turn.blocks[0].text === "1\n\n2", "the user's consecutive rows merge into one block");
  assert(mergedTake.ok && mergedTake.value.turn.blocks[1].from === "reviewer" && mergedTake.value.turn.blocks[1].text === "3", "the member's row keeps its own author");
  assert(mergedTake.ok && mergedTake.value.turn.blocks[0].count === 2, "each block reports how many items it folded");

  const singleTake = Q.takeNext({ ...three, merge: false });
  assert(singleTake.ok && singleTake.value.turn.blocks[0].text === "1" && singleTake.value.turn.count === 1, "merge OFF sends exactly one item");
  assert(singleTake.ok && singleTake.value.state.items.length === 2, "merge OFF leaves the rest queued");

  assert(Q.mergeOn({ items: [] }) === Q.DEFAULT_QUEUE_MERGE, "an unset preference inherits the global default");
  assert(Q.mergeOn({ items: [], merge: false }) === false, "an explicit false is honoured over the default");

  const empty = Q.takeNext(queueOf());
  assert(!empty.ok && empty.reason === "empty_queue", "draining an empty queue reports it instead of sending an empty turn");

  const one = Q.takeItem(three, "c");
  assert(one.ok && one.value.turn.blocks.length === 1 && one.value.turn.blocks[0].text === "3" && one.value.turn.blocks[0].from === "reviewer", "takeItem pulls one specific row out of the middle");
  assert(one.ok && one.value.state.items.length === 2, "the rest of the queue survives a single-item send");
  const missing = Q.takeItem(three, "zzz");
  assert(!missing.ok && missing.reason === "not_found", "send-now on a vanished row fails loudly");
}

// ============ 7) tolerant read of persisted state ============
console.log("\nreadQueue (restored from disk):");
{
  assert(Q.readQueue(undefined).items.length === 0, "a member persisted before this feature reads as an empty queue");
  assert(Q.readQueue({}).items.length === 0, "a malformed record reads as empty rather than throwing");
  const dirty = Q.readQueue({ items: [item("a", "1"), null, { id: "b" }, "junk"] });
  assert(dirty.items.length === 1, "unreadable entries are dropped, well-formed ones survive");
  assert(Q.readQueue({ items: [], merge: false, collapsed: true }).merge === false, "preferences survive the read");
}

// ============ 8) untrusted command parsing ============
console.log("\nparseQueueCommand (HTTP/IPC edge):");
{
  const bad = (body, why) => {
    let threw = false;
    try { Q.parseQueueCommand(body); } catch { threw = true; }
    assert(threw, why);
  };

  assert(Q.parseQueueCommand({ action: "send" }).action === "send", "a bare action parses");
  assert(Q.parseQueueCommand({ action: "cancel", itemId: "q1" }).itemId === "q1", "an item action keeps its id");
  assert(Q.parseQueueCommand({ action: "move", itemId: "q1", toIndex: 2 }).toIndex === 2, "move keeps its target position");
  assert(Q.parseQueueCommand({ action: "move", itemId: "q1", toIndex: 0 }).toIndex === 0, "position 0 is a real target, not a missing value");

  bad({ action: "nope" }, "an unknown action is REFUSED, not defaulted into some other mutation");
  bad({}, "a missing action is refused");
  bad({ action: "cancel" }, "an item action without an itemId is refused");
  bad({ action: "move", itemId: "q1", toIndex: -1 }, "a negative position is refused");
  bad({ action: "move", itemId: "q1", toIndex: 1.5 }, "a fractional position is refused rather than rounded");
  bad({ action: "move", itemId: "q1" }, "move without a position is refused");
  bad({ action: "preference" }, "a preference command that sets nothing is refused");

  const pref = Q.parseQueueCommand({ action: "preference", merge: false });
  assert(pref.merge === false && pref.collapsed === undefined, "an omitted preference field stays undefined (left alone, not reset)");
}

// ============ 9) the OTHER queue is never hidden ============
// There are two queues: this app's, and the one each harness adapter keeps on
// its own `isTurnActive()`. A turn can still reach the adapter's buffer through
// the genuine race where the session snapshot still reads idle but the
// adapter's turn has begun. Interrupt-on-send no longer feeds that buffer
// (#23) — it parks as a cut-in row on THIS queue instead. Harness-held items
// cannot be cancelled. The view model must therefore SHOW them; hiding them
// would rebuild the invisible queue this whole feature exists to abolish.
console.log("\nharness-held messages are disclosed, not hidden:");
{
  const V = await load("src/renderer/workbench/queueView.ts", "queue-view.mjs");
  const view = (over) => V.buildQueueView({
    queue: { items: [] }, density: "wide", working: true, detached: false,
    memberName: "backend", openRows: new Set(), handedOver: over,
  });

  assert(view(0).empty === true, "with nothing anywhere, the panel stays out of the way");
  assert(view(2).empty === false, "an EMPTY app queue still renders when the harness holds messages");
  assert(view(2).handedOver === 2, "…and reports how many, so the count is never understated");
  assert(view(2).count === 0, "they are NOT folded into the cancellable count — 취소 must not be offered for them");
  assert(view(undefined).handedOver === 0, "a member with no live session reports none rather than NaN");

  const cutInView = V.buildQueueView({
    queue: { items: [{ id: "u", text: "urgent", from: null, at: "2026-08-02T00:00:00.000Z", cutIn: true }, { id: "a", text: "waiting", from: null, at: "2026-08-02T00:00:00.000Z" }] },
    density: "wide", working: true, detached: false, memberName: "backend", openRows: new Set(),
  });
  assert(cutInView.rows[0].cutIn === true && cutInView.rows[1].cutIn === false, "cut-in rows are flagged in the view model");
  assert(/지금 처리/.test(cutInView.note), "the header note explains why cut-in rows are ahead");

  // Merging needs a second message to mean anything. With one waiting, the
  // preference is remembered but nothing merges — and the row must not render
  // as a merge block, which would say "these go together" about a single item.
  const queued = (n) => ({
    items: Array.from({ length: n }, (_, index) => ({ id: `q${index}`, text: `m${index}`, from: null, at: "2026-08-02T00:00:00.000Z" })),
    merge: true,
  });
  const one = V.buildQueueView({ queue: queued(1), density: "wide", working: true, detached: false, memberName: "backend", openRows: new Set() });
  const two = V.buildQueueView({ queue: queued(2), density: "wide", working: true, detached: false, memberName: "backend", openRows: new Set() });
  assert(one.canMerge === false, "one waiting message cannot be merged with anything");
  assert(one.merge === false, "…so the effective merge is off however the preference is set");
  assert(two.canMerge === true && two.merge === true, "a second message makes the preference effective");
  assert(one.mergeNote === "", "with nothing to merge the row says nothing — the single visible item already says it");
  assert(two.mergeNote !== "", "…and describes the merge once there is one");
  assert(!/건/.test(one.sendAllLabel), "the whole-queue button does not name a merged count for a single item");
  assert(/2건/.test(two.sendAllLabel), "…and does name it once a merge is real");
  assert(one.rows[0].highlighted === true, "with nothing to merge, the single row is still the one going next");
  assert(one.rows[0].onRail === false, "…but it is not drawn as part of a merge block");
  // An idle member with a queue: the button beside the header already reads
  // 지금 보내기, so the line that restated it is gone.
  const idleView = V.buildQueueView({ queue: queued(2), density: "wide", working: false, detached: false, memberName: "backend", openRows: new Set() });
  assert(idleView.note === "", "nothing is being waited for, so the header states nothing");
  assert(/지금 보내기/.test(idleView.sendAllLabel), "…and the action itself still says what pressing it does");
}

console.log(`\n${failures.length ? `FAILED (${failures.length})` : "All message queue assertions passed"}`);
process.exit(failures.length ? 1 : 0);
