/* Product-service regression for the single combined send+recv review. */
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(qaTempDir(), "gate-duplex-service.mjs");
await build({ entryPoints: [path.join(root, "src/main/application/partyApplicationService.ts")], bundle: true, format: "esm", platform: "node", outfile: out, external: ["electron"] });
const { PartyApplicationService } = await import(pathToFileURL(out).href);
const failures = [];
const assert = (condition, message) => { console.log(`  ${condition ? "✓" : "✗"} ${message}`); if (!condition) failures.push(message); };

const workspace = mkdtempSync(path.join(os.tmpdir(), "agentparty-gate-duplex-"));
process.env.AGENTPARTY_USER_DATA = workspace;
let seq = 0;
const live = new Set();
const snapshots = new Map();
const badges = [];
const delivered = [];
const sessionManager = {
  on() {},
  createSession(input) {
    const id = `s-${++seq}`;
    live.add(id);
    snapshots.set(id, { status: "idle", turnCount: 0, pendingApprovalCount: 0, model: input.model });
    return { id, title: "t", workspace: input.workspacePath, snapshot: snapshots.get(id) };
  },
  hasSession: (id) => live.has(id),
  listSessions: () => [...live].map((id) => ({ id, workspace, snapshot: snapshots.get(id) })),
  sendUserTurn: (id, text) => delivered.push({ id, text }),
  emitGateBadge: (_id, gate) => badges.push(gate),
  recordGateReview() {},
  closeSession: (id) => live.delete(id),
  harnessSessionId: () => undefined,
  getCodexModelState: () => ({ status: "idle", models: [] }),
};

const calls = [];
let behavior = (message) => ({ verdict: "allow", reason: "", violation: message.recipientRules ? "recv" : "send" });
const svc = new PartyApplicationService({
  sessionManager,
  getWorkspacePath: () => workspace,
  reviewGate: async (message, reviewer) => {
    calls.push({ message, reviewer });
    return behavior(message, reviewer);
  },
});

const created = svc.createParty({ name: "duplex" });
const partyId = created.currentPartyId;
await svc.createMember({ partyId, name: "sender", requirement: "send" });
await svc.createMember({ partyId, name: "other", requirement: "other" });
svc.startMember("sender", {}, {}, partyId);
const sendReviewer = { model: "send-model", effort: "medium" };
const recvReviewer = { model: "recv-model", effort: "high" };
svc.setMemberGate("sender", { axis: "send", mode: "on", rule: "sender rule", reviewer: sendReviewer }, partyId);
svc.setMemberGate("main", { axis: "recv", mode: "on", rule: "recipient rule", reviewer: recvReviewer }, partyId);

console.log("\none combined call:");
calls.length = 0;
await svc.sendGatedMessage("main", "candidate", "sender", undefined, partyId);
assert(calls.length === 1, "two active axes invoke the reviewer exactly once");
assert(calls[0].message.senderRules === "sender rule" && calls[0].message.recipientRules === "recipient rule", "the one request keeps sender and recipient rules separate");
assert(calls[0].reviewer.model === "recv-model", "explicit recipient reviewer wins");

console.log("\nreviewer fallback and inactive axes:");
svc.setMemberGate("main", { axis: "recv", reviewer: null }, partyId);
calls.length = 0;
await svc.sendGatedMessage("main", "candidate", "sender", undefined, partyId);
assert(calls[0].reviewer.model === "send-model", "unset recipient reviewer leaves explicit sender reviewer in control");
svc.setMemberGate("sender", { axis: "send", mode: "off" }, partyId);
calls.length = 0;
await svc.sendGatedMessage("main", "candidate", "sender", undefined, partyId);
assert(calls.length === 1 && !calls[0].message.senderRules && calls[0].message.recipientRules === "recipient rule", "recipient-only gate sends only recipient rules");
svc.setMemberGate("main", { axis: "recv", mode: "off" }, partyId);
calls.length = 0;
await svc.sendGatedMessage("main", "candidate", "sender", undefined, partyId);
assert(calls.length === 0, "two inactive axes skip the reviewer");

console.log("\nbroadcast isolation and event metadata:");
svc.setMemberGate("main", { axis: "recv", mode: "on", rule: "reject this target", reviewer: recvReviewer }, partyId);
svc.setMemberGate("other", { axis: "recv", mode: "on", rule: "allow this target" }, partyId);
behavior = (message) => message.to === "main"
  ? { verdict: "reject", reason: "recipient policy", violation: "recv" }
  : { verdict: "allow", reason: "" };
calls.length = 0;
badges.length = 0;
const result = await svc.broadcastMessage("broadcast", "sender", partyId);
assert(calls.length === 2, "broadcast performs one independent review per recipient");
assert(result.failed.some((item) => item.name === "main") && result.delivered.includes("other"), "one rejection does not stop delivery to another recipient");
const rejected = badges.find((badge) => badge.gate === "rejected");
assert(rejected?.scope === "recv" && rejected?.violation === "recv", "rejection badge identifies the evaluated and violated axis");
assert(rejected?.reviewer?.model === "recv-model", "badge records the reviewer actually used");

rmSync(workspace, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exitCode = failures.length ? 1 : 0;
