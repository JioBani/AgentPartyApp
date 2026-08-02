/*
 * R-63 — party messages to an open tab without a live session auto-start and
 * deliver (same as user turns). Closed tabs still refuse.
 *
 * Drives PartyApplicationService with a fake SessionManager. Takes a FRESH
 * directory per run, because a workspace lives beside the bundle and a previous
 * run's leftovers would read as this run's state.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaRunDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = qaRunDir("open-tab-deliver");

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function load(entry, name) {
  const out = path.join(outDir, name);
  await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
    external: ["@anthropic-ai/claude-agent-sdk", "electron"],
  });
  return import(`${pathToFileURL(out).href}?v=${Date.now()}`);
}

const { PartyApplicationService } = await load("src/main/application/partyApplicationService.ts", "party-svc-r63.mjs");

const workspace = path.join(outDir, "ws");
mkdirSync(workspace, { recursive: true });
const live = new Set();
const sentTurns = [];
let seq = 0;
const snapshots = new Map();
const sessionManager = {
  on: () => undefined,
  createSession(input) {
    const id = `sess-${++seq}`;
    live.add(id);
    snapshots.set(id, { status: "idle", turnCount: 0, pendingApprovalCount: 0, model: input.model });
    return { id, title: "t", workspace: input.workspacePath, snapshot: snapshots.get(id) };
  },
  createMockSession(input) {
    const id = `mock-${++seq}`;
    live.add(id);
    snapshots.set(id, { status: "idle", turnCount: 0, pendingApprovalCount: 0, model: input.model });
    return { id, title: "t", workspace: input.workspacePath, snapshot: snapshots.get(id) };
  },
  harnessSessionId(id) { return live.has(id) ? `thread-${id}` : undefined; },
  hasSession(id) { return live.has(id); },
  sendUserTurn(id, text, _attachments, trigger) { sentTurns.push({ id, text, trigger }); },
  closeSession(id) { live.delete(id); },
  interrupt() {},
  isCompacting() { return false; },
  listSessions() { return [...live].map((id) => ({ id, title: "t", workspace, snapshot: snapshots.get(id) || {} })); },
  notifyPartyChanged() {},
  getCodexModelState() { return { status: "ready", models: [] }; },
};

const svc = new PartyApplicationService({ sessionManager, getWorkspacePath: () => workspace });
const created = svc.createParty({ name: "r63" });
const partyId = created.member?.partyId || created.currentPartyId;

console.log("\nR-63 open-tab delivery:");
svc.createMember({ partyId, name: "idle-open", requirement: "open tab, no session yet", runtime: "claude-code" });
const opened = svc.openMember("idle-open", partyId);
assert(opened.member?.status === "opened" && !opened.member?.sessionId, "open tab has no session yet");

const before = sentTurns.length;
const beforeSessions = live.size;
const delivered = svc.sendMessage("idle-open", "wake up and review", "main", undefined, partyId);
assert(delivered.partyMessage?.delivered === true, "party message is delivered");
assert(!delivered.partyMessage?.error, `no delivery error (got ${delivered.partyMessage?.error})`);
assert(live.size === beforeSessions + 1, "a session was started for the open tab");
assert(sentTurns.length === before + 1, "one user turn was injected into the new session");
assert(sentTurns.at(-1)?.trigger === "party-message", "turn is tagged as a party-message");
assert(/from="main"/.test(sentTurns.at(-1)?.text || "") && /wake up and review/.test(sentTurns.at(-1)?.text || ""), "payload is channel-wrapped with sender + content");
assert(delivered.member?.status === "running" && Boolean(delivered.member?.sessionId), "member is running with a session after delivery");

console.log("\nClosed tab still refuses:");
svc.createMember({ partyId, name: "closed-tab", requirement: "closed", runtime: "claude-code" });
svc.closeMember("closed-tab", partyId);
const beforeClosed = sentTurns.length;
const refused = svc.sendMessage("closed-tab", "should not wake", "main", undefined, partyId);
assert(refused.partyMessage?.delivered !== true, "closed tab does not get a delivered message");
assert(refused.partyMessage?.error === "target_member_is_closed", `closed error is explicit (got ${refused.partyMessage?.error})`);
assert(sentTurns.length === beforeClosed, "no turn was injected for a closed tab");

console.log("");
if (failures.length) {
  console.log(`OPEN TAB DELIVER QA FAILED: ${failures.length}`);
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
console.log("OPEN TAB DELIVER QA PASSED");
