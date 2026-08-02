/*
 * Session-history persistence (main side). Two guarantees:
 *   1. A member's transcript round-trips to disk (capped), so a reopened app /
 *      reopened member restores its past conversation.
 *   2. Reopening a member RESUMES the harness's own thread: saving a transcript
 *      captures the live harness thread id, and the next startMember passes it as
 *      the resume id (fresh on first start, resume on the second) — so the model
 *      context continues, not just the visible record.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };



const outDir = qaTempDir();
async function bundleNode(entry, name) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", packages: "external", write: false });
  const p = path.join(outDir, name);
  writeFileSync(p, r.outputFiles[0].text);
  return import(pathToFileURL(p).href);
}

const workspace = path.join(tmpdir(), `agentparty-history-qa-${process.pid}`);
mkdirSync(workspace, { recursive: true });

// ---- 1. Repository round-trip + cap -----------------------------------------
const R = await bundleNode("src/main/partyRepository.ts", "party-repo.mjs");
const repo = new R.PartyRepository();
console.log("\ntranscript persistence (repository):");
assert(repo.readTranscript(workspace, "p1", "m1").length === 0, "an unknown member reads an empty transcript");
const blocks = [{ kind: "user", text: "hi" }, { kind: "assistant", text: "hello" }];
repo.writeTranscript(workspace, "p1", "m1", { blocks });
const read = repo.readTranscript(workspace, "p1", "m1");
assert(read.length === 2 && read[1].text === "hello", "transcript round-trips (write → read)");
const many = Array.from({ length: 1000 }, (_, i) => ({ kind: "user", text: `b${i}` }));
repo.writeTranscript(workspace, "p1", "m1", { blocks: many });
const capped = repo.readTranscript(workspace, "p1", "m1");
assert(capped.length === 800 && capped[capped.length - 1].text === "b999", "transcript is capped to the most recent 800 blocks");

// ---- 2. Harness-thread resume on reopen -------------------------------------
const S = await bundleNode("src/main/application/partyApplicationService.ts", "party-svc.mjs");
const createCalls = [];
let seq = 0;
const sessionManager = {
  // Present because the real dependency is an EventEmitter the service
  // subscribes to (it records the harness thread as soon as a turn commits,
  // #19). This fake never emits, so the reopen behaviour asserted below is
  // driven purely by the explicit calls, exactly as before.
  on: () => undefined,
  createSession(input, resumeSessionId, binding) { createCalls.push({ resumeSessionId, member: binding?.identity?.member }); return { id: `session-${++seq}`, title: "", workspace: input.workspacePath, snapshot: {} }; },
  createMockSession() { throw new Error("mock not used"); },
  harnessSessionId() { return "harness-thread-9"; },
  hasSession() { return true; },
  listSessions() { return []; },
  closeSession() { return true; },
  notifyPartyChanged() {},
  getCodexModelState() { return { status: "ready", models: [] }; },
};
const svc = new S.PartyApplicationService({ sessionManager, getWorkspacePath: () => workspace });
const party = svc.createParty({ name: "hist" });
const partyId = party.member?.partyId || party.parties?.[0]?.id || party.currentPartyId;
svc.createMember({ partyId, name: "cx", requirement: "researcher", runtime: "codex" });

console.log("\nharness-thread resume:");
const cxStarts = () => createCalls.filter((c) => c.member === "cx");
svc.startMember("cx");
assert(cxStarts().length === 1 && cxStarts()[0].resumeSessionId === undefined, "first start creates a FRESH thread (no resume id)");
// The renderer persists the transcript; that call also captures the live thread id.
svc.saveMemberTranscript("cx", { blocks });
assert(svc.getMemberTranscript("cx").length === 2, "saved transcript is retrievable for restore");
svc.closeMember("cx");
svc.startMember("cx");
assert(cxStarts().length === 2 && cxStarts()[1].resumeSessionId === "harness-thread-9", "reopening the member RESUMES its harness thread (context continues)");

rmSync(workspace, { recursive: true, force: true });
console.log(failures.length ? `\nSESSION HISTORY FAILED (${failures.length})` : "\nSESSION HISTORY PASSED");
process.exit(failures.length ? 1 : 0);
