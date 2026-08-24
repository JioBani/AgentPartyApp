/*
 * `turn_complete` names the turn it ends.
 *
 * That payload sums cost and tokens. Of everything a client can receive twice
 * this is the one the user cannot catch by looking: a paragraph appearing twice
 * is obvious, a bill inflated by 30% is not — it is simply believed. So the
 * event has to carry an identity a consumer can dedupe on.
 *
 * Stamped by SessionManager rather than by each adapter, which is what this
 * checks: the id is present and it CHANGES between turns.
 *
 * Run: node scripts/qa-turn-id.mjs
 */
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = qaTempDir();
const out = path.join(qaDir, "engine-host-turn-id.mjs");
const result = await build({ entryPoints: [path.join(projectRoot, "src/main/engine/engineHost.ts")], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
writeFileSync(out, result.outputFiles[0].text);
const { createEngineHost } = await import(pathToFileURL(out).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const workspace = path.join(os.tmpdir(), "agentparty-qa-turn-id");
mkdirSync(workspace, { recursive: true });
rmSync(path.join(workspace, ".agent_party_app"), { recursive: true, force: true });

const host = createEngineHost({ storageDir: workspace, router: { preferredPort: 0, authToken: "engine", openRouterApiKey: "" } });
const events = [];
const batches = [];
host.sessionManager.on("events", (p) => {
  batches.push(p);
  for (const e of p.events || []) events.push({ ...e, sessionId: p.sessionId });
});

const engine = host.engineRegistry.forWorkspace(workspace);
await engine.qaSeed({ members: [{ name: "alice", autoReply: false }, { name: "bob", autoReply: true }] });
const listing = await engine.listParty();
const bob = listing.members.find((m) => m.name === "bob");

const completedTurns = () => events.filter((e) => e.type === "turn_complete" && e.sessionId === bob.sessionId);

await engine.sendPartyMessage("bob", "first turn", "alice");
await new Promise((r) => setTimeout(r, 900));
const afterFirst = completedTurns();

await engine.sendPartyMessage("bob", "second turn", "alice");
await new Promise((r) => setTimeout(r, 900));
const afterSecond = completedTurns();

console.log("\nturn_complete carries an identity:");
assert(afterFirst.length >= 1, "the first turn completed");
assert(typeof afterFirst[0]?.turnId === "string" && afterFirst[0].turnId.length > 0, "…and it names its turn");
assert(afterFirst[0]?.turnId.startsWith(`${bob.sessionId}:`), "the id is scoped to the session, so two members cannot collide");

console.log("\nand the identity changes between turns:");
assert(afterSecond.length > afterFirst.length, "a second turn completed");
const ids = afterSecond.map((e) => e.turnId);
assert(new Set(ids).size === ids.length, `every completed turn has a distinct id (${ids.join(", ")})`);
// The failure this guards: a turn that starts without being counted lets the
// next turn_complete reuse the previous id, and a consumer deduping on it then
// DISCARDS a real turn's cost — an undercount, which hides better than an
// overcount.
assert(afterSecond[afterSecond.length - 1].turnId !== afterFirst[0].turnId, "the newest turn does not reuse the first turn's id");

console.log("\nand event batches carry one contiguous stream cursor:");
const bobBatches = batches.filter((batch) => batch.sessionId === bob.sessionId);
assert(bobBatches.length > 1, "the session emitted several delivery batches");
assert(bobBatches.every((batch) => typeof batch.streamId === "string" && batch.streamId.length > 0), "every batch names its stream epoch");
assert(new Set(bobBatches.map((batch) => batch.streamId)).size === 1, "one live session keeps one stream epoch");
assert(bobBatches.every((batch, index) => batch.seq === index + 1), `batch sequence is contiguous (${bobBatches.map((batch) => batch.seq).join(", ")})`);
const bobTranscript = await engine.getMemberTranscript("bob");
const lastBobBatch = bobBatches[bobBatches.length - 1];
assert(Array.isArray(bobTranscript.blocks) && bobTranscript.blocks.length > 0, "active transcript snapshot carries its materialized blocks");
assert(bobTranscript.cursor?.streamId === lastBobBatch.streamId && bobTranscript.cursor?.seq === lastBobBatch.seq, "active transcript cursor exactly matches the batches represented by its blocks");

host.dispose?.();
console.log(failures.length ? `\nTURN ID FAILED (${failures.length})` : "\nTURN ID PASSED");
process.exit(failures.length ? 1 : 0);
