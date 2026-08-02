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

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });

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

  const blank = Q.enqueue(queueOf(), item("x", "   "));
  assert(!blank.ok && blank.reason === "empty_text", "whitespace-only text is refused, not silently queued");

  const withImage = Q.enqueue(queueOf(), { ...item("x", ""), attachments: [{ id: "i" }] });
  assert(withImage.ok, "an image-only message is legitimate and accepted");

  const full = queueOf(...Array.from({ length: Q.QUEUE_LIMIT }, (_, i) => item(`f${i}`, "x")));
  const overflow = Q.enqueue(full, item("over", "y"));
  assert(!overflow.ok && overflow.reason === "queue_full", "past the limit enqueue REFUSES rather than dropping silently");
  assert(full.items.length === Q.QUEUE_LIMIT, "the refused enqueue left the queue untouched");
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
  assert(mergedTake.ok && mergedTake.value.turn.text === "1\n\n2", "merge ON sends the whole leading run as one turn");
  assert(mergedTake.ok && mergedTake.value.turn.count === 2, "the turn reports how many items it folded");
  assert(mergedTake.ok && mergedTake.value.state.items.length === 1, "the other sender's item stays queued");
  assert(mergedTake.ok && mergedTake.value.turn.from === null, "the turn carries the sender of its run");

  const singleTake = Q.takeNext({ ...three, merge: false });
  assert(singleTake.ok && singleTake.value.turn.text === "1" && singleTake.value.turn.count === 1, "merge OFF sends exactly one item");
  assert(singleTake.ok && singleTake.value.state.items.length === 2, "merge OFF leaves the rest queued");

  assert(Q.mergeOn({ items: [] }) === Q.DEFAULT_QUEUE_MERGE, "an unset preference inherits the global default");
  assert(Q.mergeOn({ items: [], merge: false }) === false, "an explicit false is honoured over the default");

  const empty = Q.takeNext(queueOf());
  assert(!empty.ok && empty.reason === "empty_queue", "draining an empty queue reports it instead of sending an empty turn");

  const one = Q.takeItem(three, "c");
  assert(one.ok && one.value.turn.text === "3" && one.value.turn.from === "reviewer", "takeItem pulls one specific row out of the middle");
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
// its own `isTurnActive()`. A turn reaches the adapter's while invisible here in
// two ways — `interrupt: true` sends mid-turn on purpose (the Discord bridge
// always does), and the window where the session snapshot still reads idle but
// the adapter's turn has begun. Those items cannot be cancelled. The view model
// must therefore SHOW them; hiding them would rebuild the invisible queue this
// whole feature exists to abolish, one layer down.
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
}

console.log(`\n${failures.length ? `FAILED (${failures.length})` : "All message queue assertions passed"}`);
process.exit(failures.length ? 1 : 0);
