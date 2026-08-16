/*
 * The pending-approval listing a phone asks for after being away.
 *
 * An approval raised while the phone was disconnected falls out of the event
 * ring buffer, and before this listing existed there was no other way to reach
 * it — the user could not discover it from the phone at all. So what matters
 * here is what the list REFUSES to offer: anything already answered, and
 * anything so old that answering it would fail.
 *
 * Run: node scripts/qa-approval-list.mjs
 */
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = qaTempDir();
const out = path.join(outDir, "approval-index.mjs");
const built = await build({ entryPoints: [path.join(projectRoot, "src/main/approvalIndex.ts")], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
writeFileSync(out, built.outputFiles[0].text);
const { ApprovalIndex } = await import(pathToFileURL(out).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const WS_A = "C:/Project/A";
const WS_B = "C:/Project/B";
const request = (requestId, extra = {}) => ({ type: "approval_request", requestId, toolName: "Bash", title: "rm -rf build/", ...extra });
const resolved = (requestId, decision = "allow") => ({ type: "approval_resolved", requestId, decision });
const feed = (index, workspace, sessionId, events) => index.note(workspace, "session:events", { sessionId, events });

console.log("\nwhat is waiting:");
{
  const index = new ApprovalIndex();
  feed(index, WS_A, "sess-1", [request("req-1"), request("req-2")]);
  feed(index, WS_B, "sess-9", [request("req-3")]);
  const pending = index.pending();
  assert(pending.length === 3, "every unanswered approval is listed");
  assert(pending.map((a) => a.requestId).join(",") === "req-1,req-2,req-3", "oldest first");
  assert(pending[0].toolName === "Bash" && pending[0].title === "rm -rf build/",
    "the row says WHAT is being approved — a user cannot consent to an opaque id");
  assert(index.pending(WS_A).map((a) => a.requestId).join(",") === "req-1,req-2", "a workspace filter narrows it");
  assert(index.pending(WS_B).length === 1, "…to that workspace only");
}

console.log("\nwhat it refuses to offer:");
{
  const index = new ApprovalIndex();
  feed(index, WS_A, "sess-1", [request("req-1"), request("req-2")]);
  feed(index, WS_A, "sess-1", [resolved("req-1", "deny")]);
  const pending = index.pending();
  assert(pending.length === 1 && pending[0].requestId === "req-2", "an answered approval leaves the list");
  // Re-offering a resolved approval is not a display bug: the user answers the
  // same destructive command a second time believing it is new.
  assert(index.find("req-1")?.resolvedAt !== undefined, "…but it is still FOUND, so a repeat tap can be told it was already answered");
  assert(index.find("req-1")?.decision === "deny", "…with the decision that was actually taken");
}

console.log("\naged-out entries:");
{
  const index = new ApprovalIndex();
  feed(index, WS_A, "sess-1", [request("req-old")]);
  const entry = index.list().find((a) => a.requestId === "req-old");
  // 24h is the retention bound; push it past that.
  entry.requestedAt = Date.now() - (25 * 60 * 60 * 1000);
  assert(index.pending().length === 0, "an approval too old to answer is not offered");
  assert(index.find("req-old") === undefined, "…and find() agrees, so the two cannot disagree on a phone's screen");
}

console.log("\nan approval seen only as resolved:");
{
  // The app can start mid-turn and never see the request itself.
  const index = new ApprovalIndex();
  feed(index, WS_A, "sess-1", [resolved("req-x")]);
  assert(index.pending().length === 0, "it is not pending — it is already answered");
  assert(index.find("req-x")?.resolvedAt !== undefined, "…and is reported as already answered rather than unknown");
}

console.log("\nanswering the same approval twice at once:");
{
  const sf = path.join(outDir, "single-flight.mjs");
  const sfBuilt = await build({ entryPoints: [path.join(projectRoot, "src/main/singleFlight.ts")], bundle: true, format: "esm", platform: "node", write: false });
  writeFileSync(sf, sfBuilt.outputFiles[0].text);
  const { SingleFlight } = await import(pathToFileURL(sf).href);

  const flight = new SingleFlight();
  let deliveries = 0;
  const deliver = async () => {
    deliveries += 1;
    await new Promise((r) => setTimeout(r, 10));
    return { outcome: "delivered" };
  };
  // Two taps, or one tap from the phone while the desktop card is open. Both
  // pass the `resolvedAt` check before either records anything.
  const [a, b] = await Promise.all([
    flight.run("req-1", deliver),
    flight.run("req-1", deliver),
  ]);
  assert(deliveries === 1, "the harness is reached once, not twice");
  assert(a.outcome === "delivered" && b.outcome === "delivered",
    "both callers are told what actually happened — the second is not told 'too late' for an answer that landed");
  assert(!flight.has("req-1"), "the entry is dropped once settled, so it is not a cache");

  // A different request must not be collapsed into it.
  let others = 0;
  await Promise.all([flight.run("req-2", async () => { others += 1; }), flight.run("req-3", async () => { others += 1; })]);
  assert(others === 2, "different approvals are independent");

  // A failure must not leave the key wedged: the next attempt has to be able to run.
  await flight.run("req-4", async () => { throw new Error("engine down"); }).catch(() => {});
  assert(!flight.has("req-4"), "a failed attempt clears, so a retry is possible");
}

console.log(failures.length ? `\nAPPROVAL LIST FAILED (${failures.length})` : "\nAPPROVAL LIST PASSED");
process.exit(failures.length ? 1 : 0);
