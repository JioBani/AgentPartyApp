/*
 * Event bridge + chunking unit test — the parts of the mobile pipe that carry
 * no crypto and therefore can be proven exactly.
 *
 * These two encode the protocol rules most likely to be got wrong on one side
 * only, which would show up as "the phone silently misses events" or "a large
 * transcript never arrives":
 *   - 01 §5.2 workspace subscription is a REPLACEMENT set, and it filters the
 *     rewind replay too, not just live delivery.
 *   - 01 §5.3 rewind: same bootId + inside the buffer -> replay, otherwise
 *     snapshot; an empty buffer only replays when the phone is already at head.
 *   - 01 §5.6 chunking: raw bytes are sliced first, then EACH piece is
 *     base64url-encoded. Encoding first and slicing the base64 produces
 *     different wire bytes and would not interoperate with the Dart side.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");
const outDir = qaTempDir();

async function load(entry, name) {
  const result = await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    // libsodium is a WASM module: bundling it detaches its crypto binding
    // ("No secure random number generator found"). Resolve it at runtime.
    external: ["@agentparty/protocol"],
    write: false,
  });
  const bundlePath = path.join(outDir, name);
  writeFileSync(bundlePath, result.outputFiles[0].text);
  return import(pathToFileURL(bundlePath).href);
}

const { EventBridge } = await load("src/main/mobile/eventBridge.ts", "eventBridge.mjs");
const C = await load("src/main/mobile/chunking.ts", "chunking.mjs");

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };
const throws = (fn, match, msg) => {
  let message = "";
  try { fn(); } catch (error) { message = String(error?.message ?? error); }
  assert(message.includes(match), `${msg} (got: ${message || "no throw"})`);
};

/** Collects what one session was handed. */
function recorder(sessionId) {
  const received = [];
  return { sessionId, deliver: (event) => received.push(event), received };
}

console.log("EventBridge assertions:");

// --- no sessions: the hot path allocates nothing ---------------------------
{
  const bridge = new EventBridge({ bootId: "boot-1" });
  assert(bridge.publish("session:events", { a: 1 }, "C:/a") === undefined, "publish with no session is a no-op");
  assert(bridge.window().seq === 0, "a no-op publish does not consume a seq");
}

// --- subscription is a replacement set, and filters delivery ---------------
{
  const bridge = new EventBridge({ bootId: "boot-1" });
  const alice = recorder("s-alice");
  const bob = recorder("s-bob");
  bridge.attach(alice);
  bridge.attach(bob);

  assert(bridge.subscriptionOf("s-alice").length === 0, "a new session subscribes to nothing (01 §5.2 default)");
  bridge.publish("session:events", { n: 1 }, "C:/a");
  assert(alice.received.length === 0, "with no subscription a workspace event is not delivered");

  bridge.setSubscription("s-alice", ["C:/a", "C:/b"]);
  bridge.setSubscription("s-bob", ["C:/b"]);
  bridge.publish("session:events", { n: 2 }, "C:/a");
  bridge.publish("session:events", { n: 3 }, "C:/b");
  bridge.publish("usage:update", { n: 4 });

  assert(alice.received.map((e) => e.d.n).join(",") === "2,3,4", "alice gets both her workspaces plus the global event");
  assert(bob.received.map((e) => e.d.n).join(",") === "3,4", "bob gets only his workspace plus the global event");
  assert(alice.received[0].seq === 2, "seq is global and keeps counting across scopes");

  bridge.setSubscription("s-alice", ["C:/b"]);
  assert(bridge.subscriptionOf("s-alice").join(",") === "C:/b", "subscribe REPLACES the set rather than merging");
  bridge.publish("session:events", { n: 5 }, "C:/a");
  assert(alice.received.length === 3, "the dropped workspace stops being delivered");

  throws(() => bridge.setSubscription("s-ghost", []), "unknown session", "an unknown session is an explicit error");
}

// --- rewind ----------------------------------------------------------------
{
  const bridge = new EventBridge({ bootId: "boot-1" });
  const phone = recorder("s-1");
  bridge.attach(phone);
  bridge.setSubscription("s-1", ["C:/a"]);

  const empty = bridge.resume("s-1", "boot-1", 0);
  assert(empty.kind === "replay" && empty.events.length === 0, "empty buffer at head replays zero events");
  const ahead = bridge.resume("s-1", "boot-1", 7);
  assert(ahead.kind === "snapshot" && ahead.reason === "out_of_window", "a lastSeq beyond head cannot be replayed");
  const other = bridge.resume("s-1", "boot-OTHER", 0);
  assert(other.kind === "snapshot" && other.reason === "boot_changed", "a different bootId always forces a snapshot");

  bridge.publish("session:events", { n: 1 }, "C:/a");
  bridge.publish("session:events", { n: 2 }, "C:/b");
  bridge.publish("usage:update", { n: 3 });

  const replay = bridge.resume("s-1", "boot-1", 0);
  assert(replay.kind === "replay", "same boot and inside the buffer replays");
  assert(replay.events.map((e) => e.d.n).join(",") === "1,3", "replay is filtered by the CURRENT subscription set");
  assert(replay.throughSeq === 3, "replay reports the head it caught the session up to");

  const partial = bridge.resume("s-1", "boot-1", 2);
  assert(partial.events.map((e) => e.d.n).join(",") === "3", "replay starts strictly after lastSeq");
}

// --- pruning ---------------------------------------------------------------
{
  let clock = 1_000_000;
  const bridge = new EventBridge({ bootId: "boot-1", maxCount: 3, maxAgeMs: 1_000, now: () => clock });
  bridge.attach(recorder("s-1"));
  for (let n = 0; n < 5; n += 1) {
    bridge.publish("e", { n });
  }
  assert(bridge.window().count === 3, "the buffer drops the oldest beyond maxCount");
  assert(bridge.window().minSeq === 3 && bridge.window().maxSeq === 5, "the window reports the surviving range");

  const dropped = bridge.resume("s-1", "boot-1", 1);
  assert(dropped.kind === "snapshot", "a lastSeq older than the buffer falls back to a snapshot");

  clock += 5_000;
  bridge.publish("e", { n: 99 });
  assert(bridge.window().count === 1, "events older than maxAgeMs are pruned on the next publish");
}

console.log("\nChunking assertions (01 §5.6):");

// --- wire shape ------------------------------------------------------------
{
  assert(C.needsChunking("x".repeat(C.CHUNK_RAW_BYTES + 1)), "an envelope over the raw-byte limit is chunked");
  assert(!C.needsChunking("x".repeat(C.CHUNK_RAW_BYTES)), "an envelope at the limit is sent whole");

  // Korean text: multi-byte characters must not decide where the cut lands.
  const envelope = JSON.stringify({ k: "res", id: "r-1", ok: true, r: { text: "한글".repeat(30_000) } });
  const chunks = C.splitEnvelope(envelope, "group-1");
  assert(chunks.length > 1, "a large envelope splits into several chunks");
  assert(chunks.every((c) => c.k === "ctl" && c.c === "chunk" && c.id === "group-1"), "every chunk carries the group id");
  assert(chunks.every((c, i) => c.i === i && c.n === chunks.length), "chunks are indexed 0..n-1 with a consistent total");

  const raw = Buffer.from(envelope, "utf8");
  assert(
    Buffer.from(chunks[0].data, "base64url").byteLength === C.CHUNK_RAW_BYTES,
    "each chunk carries exactly one raw-byte slice, not a slice of the base64",
  );
  assert(
    Buffer.from(chunks[0].data, "base64url").equals(raw.subarray(0, C.CHUNK_RAW_BYTES)),
    "chunk 0 decodes to the envelope's first raw bytes (the Dart side must agree byte-for-byte)",
  );
  assert(
    !Buffer.from(envelope, "utf8").toString("base64url").startsWith(chunks[0].data + chunks[1].data.slice(0, 1)) ||
      chunks.length === 1,
    "the encoding is per-slice, not one base64 stream sliced afterwards",
  );

  const assembler = new C.ChunkAssembler();
  let assembled;
  for (const chunk of chunks) {
    assembled = assembler.accept(chunk);
  }
  assert(assembled === envelope, "reassembly reproduces the original envelope exactly, Korean text intact");
  assert(!assembler.inProgress, "the assembler is clean after a completed group");
}

// --- every failure ends the session, none is swallowed ---------------------
{
  const chunks = C.splitEnvelope(JSON.stringify({ k: "evt", d: "x".repeat(80_000) }), "g");
  const fresh = () => new C.ChunkAssembler();

  throws(() => fresh().accept({ ...chunks[1] }), "started at index 1", "a group must start at chunk 0");
  throws(() => fresh().accept({ ...chunks[0], i: 9, n: 3 }), "out of range", "an index outside 0..n-1 is rejected");
  throws(() => fresh().accept({ ...chunks[0], n: 0 }), "out of range", "a zero total is rejected");

  const gap = fresh();
  gap.accept(chunks[0]);
  throws(() => gap.accept(chunks[2]), "expected chunk 1", "a gap in the sequence is rejected");

  const dup = fresh();
  dup.accept(chunks[0]);
  throws(() => dup.accept(chunks[0]), "expected chunk 1", "a repeated chunk is rejected");

  const mixed = fresh();
  mixed.accept(chunks[0]);
  throws(() => mixed.accept({ ...chunks[1], id: "other" }), "interleaved", "a second group cannot interleave");

  const shifted = fresh();
  shifted.accept(chunks[0]);
  throws(() => shifted.accept({ ...chunks[1], n: 99 }), "changed its total", "the total cannot change mid-group");

  assert(fresh().inProgress === false, "a fresh assembler holds no group");
  const partial = fresh();
  partial.accept(chunks[0]);
  assert(partial.inProgress === true, "a partially received group is visible, not silent");
  partial.reset();
  assert(partial.inProgress === false, "reset() clears the partial group");
}

// --- assembly ceiling ------------------------------------------------------
{
  const oversize = Buffer.alloc(C.CHUNK_ASSEMBLY_MAX_BYTES + 1, 0x61).toString("utf8");
  throws(() => C.splitEnvelope(oversize, "g"), "exceeds the", "splitting refuses an envelope past the 16 MiB ceiling");
}

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
