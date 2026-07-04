/*
 * Stall watchdog — renderer contract. The harness-general watchdog
 * (SessionManager.scanForStalls) appends a `stall` diagnostic as the newest
 * transcript block when an active turn goes silent. This test locks the
 * user-visible result: while that diagnostic stays newest the member reads as
 * "stalled" (not an indefinite "working" spinner), and real activity after it
 * clears back to "working", and turn completion returns to "idle".
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const outDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(outDir, { recursive: true });
const bundled = await build({ entryPoints: [path.join(projectRoot, "src/renderer/workbench/memberStatus.ts")], bundle: true, format: "esm", platform: "neutral", write: false });
const file = path.join(outDir, "member-status.mjs");
writeFileSync(file, bundled.outputFiles[0].text);
const { buildMemberView } = await import(pathToFileURL(file).href);

const member = { name: "cx", status: "running", runtime: "codex", sessionId: "s1", model: "gpt-5.4" };
const busySession = { id: "s1", snapshot: { status: "responding", model: "gpt-5.4" } };
const idleSession = { id: "s1", snapshot: { status: "idle", model: "gpt-5.4" } };
const stall = { id: "d1", kind: "diagnostic", severity: "warning", category: "stall", title: "응답이 멈춘 것 같습니다" };

function status(transcript, session = busySession) {
  return buildMemberView({ member, sessions: [session], transcriptBySession: { s1: transcript }, seenCount: 0 }).status;
}

console.log("\nstall status transitions:");
assert(status([{ id: "a", kind: "assistant", text: "hi" }]) === "working", "a busy turn with no stall reads as working");
assert(status([{ id: "a", kind: "assistant", text: "hi" }, stall]) === "stalled", "a stall diagnostic as the newest block → stalled");
assert(status([stall, { id: "a2", kind: "assistant", text: "resumed" }]) === "working", "activity after the stall clears back to working");
assert(status([stall], idleSession) === "idle", "once the turn ends (not busy) it is idle, not stalled");
assert(buildMemberView({ member, sessions: [busySession], transcriptBySession: { s1: [stall] }, seenCount: 0 }).busy === false, "a stalled member is not 'busy' (so the panel offers restart, not an endless stop-spinner)");

console.log("\nrestored transcript fallback (session history):");
const restored = [{ id: "r1", kind: "user", text: "old" }, { id: "r2", kind: "assistant", text: "reply" }];
// No live session (closed member / just-reopened app) → the restored history shows.
const closedMember = { name: "cx", status: "closed", runtime: "codex", model: "gpt-5.4" };
const closedView = buildMemberView({ member: closedMember, sessions: [], transcriptBySession: {}, seenCount: 0, restored });
assert(closedView.transcript.length === 2 && closedView.transcript[1].text === "reply", "a member with no live session shows its restored transcript");
// A live session's transcript wins over the restored copy (it was seeded from it).
const liveView = buildMemberView({ member, sessions: [busySession], transcriptBySession: { s1: [{ id: "a", kind: "assistant", text: "live" }] }, seenCount: 0, restored });
assert(liveView.transcript.length === 1 && liveView.transcript[0].text === "live", "a live session's transcript takes precedence over the restored copy");

console.log(failures.length ? `\nSTALL STATUS FAILED (${failures.length})` : "\nSTALL STATUS PASSED");
process.exit(failures.length ? 1 : 0);
