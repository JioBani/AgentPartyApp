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
const { buildMemberView, statusLabel } = await import(pathToFileURL(file).href);

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


// A stale approval block must never outrank a live busy turn. An approval whose
// resolution was not recorded (app killed with the prompt open) persists to disk
// and returns on restore; trusting it pinned the member in "approval" forever, so
// the stop control never reappeared (observed on SEL-6877 `req`: snapshot
// pendingApprovalCount=0, one unresolved AskUserQuestion block from hours earlier).
console.log("\napproval vs. busy precedence:");
const staleApproval = { id: "ap1", kind: "approval", requestId: "r1", toolName: "AskUserQuestion" };
const busyNoPending = { id: "s1", snapshot: { status: "responding", model: "gpt-5.4", pendingApprovalCount: 0 } };
const busyPending = { id: "s1", snapshot: { status: "responding", model: "gpt-5.4", pendingApprovalCount: 1 } };
const view = (transcript, session) => buildMemberView({ member, sessions: [session], transcriptBySession: { s1: transcript }, seenCount: 0 });

assert(view([staleApproval], busyNoPending).status === "working", "a live session reporting 0 pending approvals wins over a stale approval block");
assert(view([staleApproval], busyNoPending).busy === true, "so the member is busy and the stop control shows");
assert(view([staleApproval], busyPending).status === "approval", "a REAL pending approval still reads as approval");
assert(view([staleApproval], idleSession).status === "idle", "an idle live session with a stale block is idle, not approval");
assert(
  buildMemberView({ member: { ...member, sessionId: undefined }, sessions: [], transcriptBySession: {}, seenCount: 0, restored: [staleApproval] }).status === "not-started",
  "with no live session the transcript is the only record (member reads not-started, not a false busy)",
);

// [#13] A member whose harness died kept a session object and fell through to
// "idle" — it read as ready to chat. The main process now reports it as
// `missing_session` (W1), and the renderer must show that instead of inventing
// readiness. `statusLabel` is asserted too: the wording states only the FACT
// that the session is gone, never a guess at why.
console.log("\ndead member vs. never-started (#13):");
const dead = { ...member, status: "missing_session" };
const deadView = (transcript, session) => buildMemberView({ member: dead, sessions: [session], transcriptBySession: { s1: transcript }, seenCount: 0 });

assert(deadView([], idleSession).status === "disconnected", "a member whose session is gone reads as disconnected, NOT idle (= ready to chat)");
assert(statusLabel("disconnected") === "disconnected", "…and is labelled by the fact (no cause invented, no 'error'/'failed')");
assert(deadView([], idleSession).busy === false, "a disconnected member is never busy, so no progress indicator can appear over it");

// Precedence: everything below `disconnected` in deriveStatus describes a LIVE
// session. A restored-but-unresolved approval must not pin a dead member in
// "approval" (the #4-class shape), and a status left mid-flight must not read
// as busy.
assert(deadView([staleApproval], busyPending).status === "disconnected", "a dead member with a pending approval is still disconnected (approval cannot outrank it)");
assert(deadView([{ id: "a", kind: "assistant", text: "hi" }], busySession).status === "disconnected", "a dead member whose status was left mid-turn does not read as working");

// The distinction W1 handed over, locked so it cannot be quietly collapsed: an
// app RESTART clears the stale binding, so a restarted member has no sessionId
// and correctly reads "not started" — its conversation is intact and messaging
// it resumes. Only a live binding with nothing behind it is `disconnected`.
const restarted = { name: "cx", status: "idle", runtime: "codex", model: "gpt-5.4" };
assert(
  buildMemberView({ member: restarted, sessions: [], transcriptBySession: {}, seenCount: 0, restored }).status === "not-started",
  "a member after an app restart reads not-started (binding cleared), never disconnected",
);
assert(statusLabel("not-started") === "not started", "…so the two states stay distinguishable on screen");

console.log(failures.length ? `\nSTALL STATUS FAILED (${failures.length})` : "\nSTALL STATUS PASSED");
process.exit(failures.length ? 1 : 0);
