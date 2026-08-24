/*
 * Integration test for the party in-process MCP bridge
 * (the party-communication design). Drives the REAL PartyApplicationService with a
 * fake SessionManager so no Claude session is spawned, then exercises the bridge
 * that the service hands to a member's session — verifying the whole chain:
 *
 *   MCP tool (buildPartyToolDefs + real SDK `tool`)
 *     -> PartyBridge (identity-stamped `from`)
 *       -> PartyApplicationService.sendMessage / createMember / removeMember
 *         -> fake SessionManager (capture)
 *
 * Asserts: identity is closure-bound (from is never agent input), member-create
 * auto-starts and persists reasoning, codex is accepted, sending to an off/absent
 * member errors, list/list-models return rich data, and broadcasts fire.
 */
import { build } from "esbuild";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = qaTempDir();

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function load(entry, name) {
  const out = path.join(qaDir, name);
  await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
    external: ["@anthropic-ai/claude-agent-sdk"] });
  return import(pathToFileURL(out).href);
}

const { PartyApplicationService } = await load("src/main/application/partyApplicationService.ts", "party-svc.mjs");
const { buildPartyDynamicToolSpec, buildPartyToolDefs, buildPartyPrimer, invokePartyTool, PARTY_MCP_SERVER, PARTY_TOOL_NAMES, PARTY_TOOL_PREFIX } = await load("src/core/partyBridge.ts", "party-bridge.mjs");
const sdk = await import("@anthropic-ai/claude-agent-sdk");

// --- Fake SessionManager: captures bindings, never spawns a real session ------
const workspace = mkdtempSync(path.join(os.tmpdir(), "agentparty-qa-"));
const live = new Set();
const captured = [];
const sentTurns = [];
const interrupted = [];
const permissionChanges = [];
const snapshots = new Map();
let notifyCount = 0;
let seq = 0;
// Captures the resume id passed to createSession, so respawn's conversation-
// continuity (resume the harness thread) can be asserted. A session's harness
// thread id is deterministic (`thread-<sessionId>`).
const resumedWith = [];
const sessionManager = {
  // The service subscribes to session events (it records a member's harness
  // thread as soon as a turn commits, #19). This fake emits nothing, so the
  // subscription is inert here — but it has to EXIST, because the real
  // dependency is an EventEmitter and a stand-in missing part of that contract
  // breaks at construction instead of in an assertion.
  on: () => undefined,
  createSession(input, resume, binding) {
    const id = `sess-${++seq}`;
    live.add(id);
    snapshots.set(id, { status: "idle", turnCount: 0, pendingApprovalCount: 0, model: input.model });
    captured.push(binding);
    resumedWith.push(resume);
    return { id, title: "t", workspace: input.workspacePath, snapshot: snapshots.get(id) };
  },
  harnessSessionId(id) { return live.has(id) ? `thread-${id}` : undefined; },
  createMockSession(input) {
    const id = `mock-${++seq}`; live.add(id);
    snapshots.set(id, { status: "idle", turnCount: 0, pendingApprovalCount: 0, model: input.model });
    return { id, title: "t", workspace: input.workspacePath, snapshot: snapshots.get(id) };
  },
  hasSession(id) { return live.has(id); },
  sendUserTurn(id, text) { sentTurns.push({ id, text }); },
  closeSession(id) { live.delete(id); },
  interrupt(id) { interrupted.push(id); },
  setPermissionMode(id, permissionMode) { permissionChanges.push({ id, permissionMode }); },
  setCodexPolicy(id, codexPolicy) { permissionChanges.push({ id, codexPolicy }); },
  // A session is "compacting" while its id is in this set (the real manager sets it
  // in compact() and clears it on the outcome). Interrupt-on-send must respect it.
  compacting: new Set(),
  isCompacting(id) { return this.compacting.has(id); },
  listSessions() { return [...live].map((id) => ({ id, title: "t", workspace, snapshot: snapshots.get(id) || {} })); },
  notifyPartyChanged() { notifyCount += 1; },
  // Live codex catalog: discovered, so list-models must expose it per-harness.
  getCodexModelState() {
    return { status: "ready", models: [{ model: "gpt-5.5", displayName: "GPT-5.5", isDefault: true, hidden: false, defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }], serviceTiers: [] }] };
  },
};

const svc = new PartyApplicationService({ sessionManager, getWorkspacePath: () => workspace });

console.log("\nParty bridge assertions:");

// Create a party: `main` is auto-created AND its session auto-init'd (no turn).
const created = svc.createParty({ name: "team-qa" });
const partyId = created.member?.partyId || created.currentPartyId;
assert(captured.length === 1, "creating a party auto-starts main's session (exactly one binding)");
// main is born from the single runtime default profile (harness + model).
assert(created.member?.name === "main" && created.member?.runtime === "claude-code" && created.member?.model === "sonnet", "main is created from the runtime default profile");
const mainBinding = captured[0];
assert(mainBinding?.identity?.member === "main" && mainBinding?.identity?.party === partyId, "binding identity is closure-bound to the member (party + name)");
const bridge = mainBinding.bridge;

// --- list-models: rich discovery --------------------------------------------
const models = await bridge.listModels();
assert(models.ok && Array.isArray(models.data?.harnesses), "list-models returns harnesses");
const harnessIds = models.data.harnesses.map((h) => h.id);
assert(harnessIds.includes("claude-code") && harnessIds.includes("codex") && harnessIds.includes("cursor"), "claude-code, codex, and cursor harnesses are exposed");
assert(models.data.harnesses.find((h) => h.id === "codex")?.status === "available", "codex is marked available");
assert(Array.isArray(models.data.models) && models.data.models.length > 5, "list-models returns the model catalog");
assert(models.data.models.some((m) => typeof m.perf === "number" && m.context), "models carry rich meta (perf + context)");
assert(models.data.harnesses.every((h) => h.permission?.kind), "each harness exposes its member-create permission contract + default");
// Any filter requests detail rows; the no-argument index intentionally omits
// per-route fields to keep discovery compact.
const detailedModels = await bridge.listModels({ query: "gpt" });
assert(detailedModels.data.models.some((m) => m.reasoning && (m.reasoning.effort || m.reasoning.thinking)), "at least one detailed model exposes reasoning options");
assert(detailedModels.data.models.every((m) => ["claude-code", "codex", "cursor", "grok"].includes(m.harness)), "every detailed model states its harness (member-create needs it)");
assert(detailedModels.data.models.every((m) => ["claude-code", "codex", "cursor", "grok"].includes(m.executionHarness)), "every detailed model states its concrete execution harness");
const codexListed = detailedModels.data.models.filter((m) => m.harness === "codex");
assert(codexListed.some((m) => m.id === "gpt-5.5"), "the live codex catalog rides into list-models");
assert(codexListed.find((m) => m.id === "gpt-5.5")?.reasoning?.effort?.options?.length === 4, "codex models expose effort options (effort-only reasoning)");

// --- member-create: codex accepted ------------------------------------------
const initialCodexPolicy = { sandbox: "read-only", approval: "on-request", guardian: false };
const codex = await bridge.createMember({ name: "cx", role: "x", harness: "codex", codexPolicy: initialCodexPolicy });
assert(codex.ok && svc.list().members.find((m) => m.name === "cx")?.runtime === "codex", "member-create accepts codex harness");
assert(captured.length === 2, "codex member-create starts a codex session");
assert(JSON.stringify(svc.list().members.find((m) => m.name === "cx")?.codexPolicy) === JSON.stringify(initialCodexPolicy), "member-create persists an explicit initial Codex policy");
const changedCodexPolicy = { sandbox: "workspace-write", approval: "never", guardian: true };
const changedCx = await bridge.setPermission("cx", { codexPolicy: changedCodexPolicy });
assert(changedCx.ok && JSON.stringify(svc.list().members.find((m) => m.name === "cx")?.codexPolicy) === JSON.stringify(changedCodexPolicy), "one member can change another Codex member's policy");
assert(permissionChanges.some((change) => change.codexPolicy?.guardian === true), "live Codex permission change reaches the target adapter");

// --- member-create: claude-code auto-starts + persists reasoning -------------
const make = await bridge.createMember({ name: "reviewer", role: "Code reviewer", harness: "claude-code", model: "sonnet", reasoning: "enabled", permissionMode: "plan" });
assert(make.ok, "member-create (claude-code) succeeds");
assert(captured.length === 3, "member-create auto-starts the new member's session");
const reviewer = svc.list().members.find((m) => m.name === "reviewer");
assert(reviewer?.reasoning === "enabled", "reasoning is persisted on the created member");
assert(reviewer?.status === "running", "created member is live");
assert(reviewer?.permissionMode === "plan", "member-create persists an explicit initial Claude permission");
const beforeDuplicateStart = captured.length;
const reusedReviewer = svc.startMember("reviewer", { auto: true }, {}, partyId);
assert(reusedReviewer.session?.id === reviewer?.sessionId && captured.length === beforeDuplicateStart, "concurrent/prewarm start reuses the live session instead of orphaning a duplicate");
const changedReviewer = await bridge.setPermission("reviewer", { permissionMode: "auto" });
assert(changedReviewer.ok && svc.list().members.find((m) => m.name === "reviewer")?.permissionMode === "auto", "one member can change another Claude member's permission");

// --- send: delivered, with from stamped to the caller (not agent input) ------
const before = sentTurns.length;
const sent = await bridge.send("main", "reviewer", "please review PR 42");
assert(sent.ok, "send to a running member succeeds");
assert(sentTurns.length === before + 1, "send delivered one turn into the target session");
assert(/from="main"/.test(sentTurns[before].text) && /please review PR 42/.test(sentTurns[before].text), "delivered payload is channel-wrapped with from=main");

// --- send: errors for absent / off members ----------------------------------
const ghost = await bridge.send("main", "ghost", "hi");
assert(!ghost.ok && /does not exist/i.test(ghost.error || ""), "send to a nonexistent member errors");

// --- list: rich member view --------------------------------------------------
const listed = await bridge.list();
const names = (listed.data?.members || []).map((m) => m.name);
assert(listed.ok && names.includes("main") && names.includes("reviewer"), "list returns the party members");
assert(listed.data.members.find((m) => m.name === "reviewer")?.harness === "claude-code", "list carries harness per member");

// --- member-remove: main protected, others removable -------------------------
const rmMain = await bridge.removeMember("main");
assert(!rmMain.ok, "member-remove refuses to remove 'main'");

// A different process/window can move the advisory last-active hint while this
// bridge remains bound to its own party. Removing a member must return that
// acted-on party's view, close only that member's session, and leave the other
// party byte-for-byte equivalent at the service boundary.
const scopeProbeCreated = await bridge.createMember({ name: "scope-probe", role: "remove scope QA", harness: "claude-code" });
assert(scopeProbeCreated.ok, "created a scoped member-removal probe");
const scopeProbeSession = svc.list(partyId).members.find((m) => m.name === "scope-probe")?.sessionId;
const otherCreated = svc.createParty({ name: "other-party" });
const otherPartyId = otherCreated.member?.partyId || otherCreated.currentPartyId;
const otherMembersBefore = svc.list(otherPartyId).members.map((m) => `${m.partyId}/${m.name}/${m.sessionId || ""}`).sort();
const scopedRemoval = svc.removeMember("scope-probe", partyId);
assert(scopedRemoval.currentPartyId === partyId, "member removal result stays scoped to the acted-on party when the global hint points elsewhere");
assert(!scopedRemoval.members.some((m) => m.name === "scope-probe"), "scoped removal result excludes the deleted member");
assert(scopeProbeSession && !live.has(scopeProbeSession), "scoped removal still closes the deleted member's session");
const otherMembersAfter = svc.list(otherPartyId).members.map((m) => `${m.partyId}/${m.name}/${m.sessionId || ""}`).sort();
assert(JSON.stringify(otherMembersAfter) === JSON.stringify(otherMembersBefore), "scoped removal leaves the other party unchanged");
svc.selectParty(partyId);

const rmRev = await bridge.removeMember("reviewer");
assert(rmRev.ok, "member-remove removes a normal member");
assert(!svc.list().members.some((m) => m.name === "reviewer"), "removed member is gone from party state");

assert(notifyCount >= 3, `party broadcasts fired on bridge mutations (got ${notifyCount})`);

// --- member-status / interrupt / broadcast (agent coordination tools) ---------
console.log("\nCoordination tool assertions:");
await bridge.createMember({ name: "worker1", role: "r", harness: "claude-code" });
await bridge.createMember({ name: "worker2", role: "r", harness: "claude-code" });
const memberSession = (name) => svc.list().members.find((m) => m.name === name)?.sessionId;

// member-status: idle members read as not turnActive; a busy one flips.
const allStatus = await bridge.status();
assert(allStatus.ok && allStatus.data.members.length >= 3, "member-status without a name returns every member");
assert(allStatus.data.members.every((m) => m.turnActive === false && m.running === true), "idle members report turnActive=false, running=true");
snapshots.get(memberSession("worker1")).status = "responding";
const oneStatus = await bridge.status("worker1");
assert(oneStatus.ok && oneStatus.data.members.length === 1 && oneStatus.data.members[0].turnActive === true && oneStatus.data.members[0].status === "responding", "a mid-turn member reports turnActive=true");
const ghostStatus = await bridge.status("ghost");
assert(!ghostStatus.ok && /does not exist/i.test(ghostStatus.error || ""), "member-status for a nonexistent member errors");

// interrupt: self is refused; a busy member is stopped; an idle one is a no-op report.
const selfInterrupt = await bridge.interrupt("main");
assert(!selfInterrupt.ok && /yourself/i.test(selfInterrupt.error || ""), "interrupt refuses the caller itself");
const stopBusy = await bridge.interrupt("worker1");
assert(stopBusy.ok && stopBusy.data.interrupted.includes("worker1") && interrupted.includes(memberSession("worker1")), "interrupting a busy member stops its session");
const stopIdle = await bridge.interrupt("worker2");
assert(stopIdle.ok && stopIdle.data.interrupted.length === 0 && stopIdle.data.idle.includes("worker2"), "interrupting an idle member reports idle (not an error, no adapter call)");

// interrupt all: stops every busy member EXCEPT the caller.
snapshots.get(memberSession("worker1")).status = "responding";
snapshots.get(memberSession("worker2")).status = "requesting";
snapshots.get(memberSession("main")).status = "responding";
const beforeAll = interrupted.length;
const stopAll = await bridge.interrupt("all");
assert(stopAll.ok && stopAll.data.interrupted.sort().join() === "worker1,worker2", "interrupt 'all' stops every busy member except the caller");
assert(interrupted.length === beforeAll + 2 && !interrupted.slice(beforeAll).includes(memberSession("main")), "the caller's own session is never interrupted by 'all'");
snapshots.get(memberSession("main")).status = "idle";

// send with interrupt: a busy recipient's turn is stopped; the message parks at
// the FRONT of the app queue and is NOT handed to the harness yet (#23).
snapshots.get(memberSession("worker2")).status = "responding";
const beforeInj = { interrupts: interrupted.length, turns: sentTurns.length };
const inject = await bridge.send("main", "worker2", "urgent: stop and read this", true);
const urgentQueue = svc.getMemberQueue("worker2", partyId);
assert(inject.ok && interrupted.length === beforeInj.interrupts + 1 && sentTurns.length === beforeInj.turns, "send(interrupt=true) stops the busy recipient without handing the harness a turn");
assert(urgentQueue.items[0]?.text === "urgent: stop and read this", "…and parks the urgent message at the front of the app queue");
assert(inject.data?.queued === true, "…reported as queued (not failed) so the sender will not duplicate-resend");
const beforeQueue = interrupted.length;
snapshots.get(memberSession("worker2")).status = "idle";
await bridge.send("main", "worker2", "normal follow-up", true);
assert(interrupted.length === beforeQueue, "send(interrupt=true) to an idle recipient skips the interrupt");

// send with interrupt to a COMPACTING recipient: even though it is busy, the
// compaction is NOT torn down — the interrupt is suppressed; the message still
// parks as a cut-in on the app queue (not the harness buffer).
svc.clearMemberQueue("worker2", partyId);
snapshots.get(memberSession("worker2")).status = "responding";
sessionManager.compacting.add(memberSession("worker2"));
const beforeCompact = { interrupts: interrupted.length, turns: sentTurns.length };
const compactSend = await bridge.send("main", "worker2", "don't cut the compaction", true);
const compactQueue = svc.getMemberQueue("worker2", partyId);
assert(compactSend.ok && interrupted.length === beforeCompact.interrupts && sentTurns.length === beforeCompact.turns, "send(interrupt=true) to a COMPACTING recipient skips the interrupt and does not hand the harness a turn");
assert(compactQueue.items[0]?.text === "don't cut the compaction" && compactQueue.items[0]?.cutIn === true, "…and parks as a cut-in on the app queue while the compaction finishes");
sessionManager.compacting.delete(memberSession("worker2"));
snapshots.get(memberSession("worker2")).status = "idle";
svc.clearMemberQueue("worker2", partyId);

// Omitted interrupt inherits: explicit call > sender override > Runtime default.
console.log("\nMember message interrupt defaults:");
snapshots.get(memberSession("worker2")).status = "responding";
svc.setMemberMessaging({ interruptOnSend: true });
svc.setMemberOutboundInterrupt("main", null, partyId);
const beforeDefaultInterrupt = interrupted.length;
await bridge.send("main", "worker2", "runtime-default-cut-in");
let inheritedQueue = svc.getMemberQueue("worker2", partyId);
assert(interrupted.length === beforeDefaultInterrupt + 1 && inheritedQueue.items[0]?.cutIn === true, "omitted interrupt inherits the Runtime true default");

svc.setMemberOutboundInterrupt("main", false, partyId);
const beforeMemberQueue = interrupted.length;
await bridge.send("main", "worker2", "member-override-queue");
inheritedQueue = svc.getMemberQueue("worker2", partyId);
assert(interrupted.length === beforeMemberQueue && inheritedQueue.items.at(-1)?.text === "member-override-queue", "sender false override queues behind and beats Runtime true");

const beforeExplicit = interrupted.length;
await bridge.send("main", "worker2", "explicit-cut-in", true);
inheritedQueue = svc.getMemberQueue("worker2", partyId);
assert(interrupted.length === beforeExplicit + 1 && inheritedQueue.items.find((item) => item.text === "explicit-cut-in")?.cutIn === true, "explicit true beats the sender false override");
svc.setMemberOutboundInterrupt("main", null, partyId);
svc.setMemberMessaging({ interruptOnSend: false });
snapshots.get(memberSession("worker2")).status = "idle";
svc.clearMemberQueue("worker2", partyId);

// broadcast: every other member gets the channel-wrapped message; self excluded.
// A BUSY recipient's copy goes to its QUEUE instead of being injected — worker1
// is still mid-turn from the interrupt leg above. That is a third outcome,
// deliberately not folded into `failed`: telling the sender that a message which
// is merely waiting has failed invites a duplicate resend.
const beforeBc = sentTurns.length;
const bc = await bridge.broadcast("전체 공지");
const reached = [...bc.data.delivered, ...(bc.data.queuedMembers || [])];
assert(bc.ok && reached.length >= 3 && !reached.includes("main"), "broadcast reaches every member except the caller");
assert(bc.data.queuedMembers?.includes("worker1"), "a BUSY recipient is reported as queued, not as failed");
assert(!bc.data.failed.some((f) => f.name === "worker1"), "…and does not also appear in failed");
assert(sentTurns.length === beforeBc + bc.data.delivered.length, "broadcast injected one turn per DELIVERED recipient (the queued one waits)");
assert(sentTurns.slice(beforeBc).every((t) => /from="main"/.test(t.text) && /전체 공지/.test(t.text)), "broadcast payloads are channel-wrapped with from=main");
// A member without a live session lands in failed, never silently dropped.
svc.closeMember("worker1", partyId);
// Auto-start (renderer prewarm) must NOT resurrect a closed member — the
// prewarm-vs-close race silently reopened a just-closed member with a fresh
// session (and a queued message then got delivered to it).
const autoStart = svc.startMember("worker1", { auto: true }, {}, partyId);
assert(autoStart.ok && autoStart.member?.status === "closed" && !autoStart.session, "auto-start on a closed member is skipped (stays closed, no session)");
const bc2 = await bridge.broadcast("두번째 공지", true);
assert(bc2.ok && bc2.data.failed.some((f) => f.name === "worker1"), "broadcast reports undeliverable members in failed");
assert(!bc2.data.delivered.includes("worker1"), "closed member is not counted as delivered");
const deliberate = svc.startMember("worker1", {}, {}, partyId);
assert(Boolean(deliberate.session?.id) && deliberate.member?.status === "running", "a deliberate start still reopens a closed member");
svc.closeMember("worker1", partyId);

// --- MCP glue: buildPartyToolDefs wires real SDK tools to the bridge ----------
console.log("\nMCP tool surface assertions:");
assert(PARTY_MCP_SERVER === "agentparty-app", "MCP server name is agentparty-app");
assert(PARTY_TOOL_PREFIX === "mcp__agentparty-app__", "namespaced tool prefix matches");
const defs = buildPartyToolDefs(sdk.tool, bridge, mainBinding.identity);
const toolNames = defs.map((d) => d.name);
assert(JSON.stringify(toolNames) === JSON.stringify(PARTY_TOOL_NAMES), "in-process MCP exposes every canonical party tool in order");
// Re-create a target so the send tool delivers, then invoke the real handler.
await bridge.createMember({ name: "buddy", role: "r", harness: "claude-code" });
const sendTool = defs.find((d) => d.name === "send");
const n2 = sentTurns.length;
const out = await sendTool.handler({ to: "buddy", content: "ping" });
assert(Array.isArray(out.content) && out.content[0].type === "text", "send tool returns an MCP text envelope");
assert(out.isError === false, "successful send is not flagged as error");
assert(sentTurns.length === n2 + 1 && /from="main"/.test(sentTurns[n2].text), "tool handler stamps from=main (identity, not args)");

// --- Codex dynamic tool glue: same bridge, Codex protocol shape --------------
console.log("\nCodex dynamic tool assertions:");
const dynamic = buildPartyDynamicToolSpec();
assert(dynamic.type === "namespace" && dynamic.name === PARTY_MCP_SERVER, "Codex dynamic tools use the agentparty-app namespace");
assert(JSON.stringify(dynamic.tools.map((tool) => tool.name)) === JSON.stringify(toolNames), "Codex dynamic tools expose the same canonical party tools");
const dynamicSendSpec = dynamic.tools.find((tool) => tool.name === "send")?.inputSchema;
assert(dynamicSendSpec?.properties?.interrupt?.type === "boolean" && dynamicSendSpec?.properties?.queue?.type === "boolean", "member send exposes separate interrupt and queue delivery flags");
const beforeDynamic = sentTurns.length;
const dynamicOut = await invokePartyTool(bridge, mainBinding.identity, `${PARTY_TOOL_PREFIX}send`, { to: "buddy", content: "hello from codex" });
assert(dynamicOut.ok, "Codex dispatcher accepts namespaced party tool names");
assert(sentTurns.length === beforeDynamic + 1 && /from="main"/.test(sentTurns[beforeDynamic].text), "Codex dispatcher stamps from=main through the same bridge identity");

// Real harness transcripts showed Codex materializing the old optional boolean
// as `interrupt:false` on every call. That generated value must inherit rather
// than silently disabling both Runtime and per-member interrupt preferences.
snapshots.get(memberSession("buddy")).status = "responding";
svc.clearMemberQueue("buddy", partyId);
svc.setMemberOutboundInterrupt("main", null, partyId);
svc.setMemberMessaging({ interruptOnSend: true });
let beforeToolInterrupt = interrupted.length;
let inheritedToolSend = await invokePartyTool(bridge, mainBinding.identity, `${PARTY_TOOL_PREFIX}send`, {
  to: "buddy", content: "legacy-false-inherits-runtime", interrupt: false,
});
let buddyQueue = svc.getMemberQueue("buddy", partyId);
assert(inheritedToolSend.ok && inheritedToolSend.data?.cutIn === true && interrupted.length === beforeToolInterrupt + 1 && buddyQueue.items[0]?.cutIn === true, "legacy tool interrupt:false inherits the Runtime true default");

svc.clearMemberQueue("buddy", partyId);
svc.setMemberMessaging({ interruptOnSend: false });
svc.setMemberOutboundInterrupt("main", true, partyId);
beforeToolInterrupt = interrupted.length;
inheritedToolSend = await invokePartyTool(bridge, mainBinding.identity, `${PARTY_TOOL_PREFIX}send`, {
  to: "buddy", content: "legacy-false-inherits-member", interrupt: false,
});
buddyQueue = svc.getMemberQueue("buddy", partyId);
assert(inheritedToolSend.ok && inheritedToolSend.data?.cutIn === true && interrupted.length === beforeToolInterrupt + 1 && buddyQueue.items[0]?.cutIn === true, "legacy tool interrupt:false inherits a per-member true override");

svc.clearMemberQueue("buddy", partyId);
beforeToolInterrupt = interrupted.length;
const forcedQueue = await invokePartyTool(bridge, mainBinding.identity, `${PARTY_TOOL_PREFIX}send`, {
  to: "buddy", content: "explicit-tool-queue", queue: true,
});
buddyQueue = svc.getMemberQueue("buddy", partyId);
assert(forcedQueue.ok && forcedQueue.data?.cutIn === false && interrupted.length === beforeToolInterrupt && buddyQueue.items[0]?.cutIn !== true, "queue:true explicitly queues even when the member override is true");

svc.clearMemberQueue("buddy", partyId);
svc.setMemberOutboundInterrupt("main", false, partyId);
beforeToolInterrupt = interrupted.length;
const forcedInterrupt = await invokePartyTool(bridge, mainBinding.identity, `${PARTY_TOOL_PREFIX}send`, {
  to: "buddy", content: "explicit-tool-interrupt", interrupt: true,
});
buddyQueue = svc.getMemberQueue("buddy", partyId);
assert(forcedInterrupt.ok && forcedInterrupt.data?.cutIn === true && interrupted.length === beforeToolInterrupt + 1 && buddyQueue.items[0]?.cutIn === true, "interrupt:true explicitly cuts in even when the member override is false");
const conflictingDelivery = await invokePartyTool(bridge, mainBinding.identity, `${PARTY_TOOL_PREFIX}send`, {
  to: "buddy", content: "ambiguous", interrupt: true, queue: true,
});
assert(!conflictingDelivery.ok && /only one delivery override/i.test(conflictingDelivery.error || ""), "conflicting interrupt/queue flags are rejected visibly");
svc.clearMemberQueue("buddy", partyId);
svc.setMemberOutboundInterrupt("main", null, partyId);
svc.setMemberMessaging({ interruptOnSend: false });
snapshots.get(memberSession("buddy")).status = "idle";
const unknownDynamic = await invokePartyTool(bridge, mainBinding.identity, "mcp__agentparty__send", {});
assert(!unknownDynamic.ok && /Unknown AgentParty tool/.test(unknownDynamic.error || ""), "Codex dispatcher rejects legacy agentparty tool names");
const dynamicPermission = await invokePartyTool(bridge, mainBinding.identity, `${PARTY_TOOL_PREFIX}member-permission`, { name: "buddy", permissionMode: "plan" });
assert(dynamicPermission.ok && svc.list().members.find((m) => m.name === "buddy")?.permissionMode === "plan", "Codex dispatcher routes member-permission through the shared bridge");
// gate-set: any member may edit another member's Message Gate (cross-editable).
const dynamicGate = await invokePartyTool(bridge, mainBinding.identity, `${PARTY_TOOL_PREFIX}gate-set`, { name: "buddy", mode: "on", rule: "Be concise." });
const buddyGate = svc.list().members.find((m) => m.name === "buddy")?.gate;
assert(dynamicGate.ok && buddyGate?.mode === "on" && buddyGate?.rule === "Be concise.", "gate-set routes through the bridge and persists the member override");

// --- session primer: deterministic surface knowledge (no model memory) -------
console.log("\nParty primer assertions:");
const primer = buildPartyPrimer({ party: "team-qa", member: "reviewer", role: "Code reviewer" });
assert(/AgentParty/.test(primer), "primer introduces the AgentParty app");
assert(primer.includes("reviewer") && primer.includes("team-qa") && primer.includes("Code reviewer"), "primer states the member's identity (party + name + role)");
assert(primer.includes("mcp__agentparty-app__send") && primer.includes("mcp__agentparty-app__member-create"), "primer names the agentparty-app tool surface");
assert(primer.includes("mcp__agentparty-app__broadcast") && primer.includes("mcp__agentparty-app__member-status") && primer.includes("mcp__agentparty-app__interrupt"), "primer teaches the coordination tools (broadcast/status/interrupt)");
assert(primer.includes("Do not poll member status") && primer.includes("do not repeat unchanged status checks"), "primer forbids wasteful repeated member-status polling");
assert(primer.includes("mcp__agentparty-app__member-permission"), "primer teaches agents how to change another member's permission");
assert(/Message Gate/.test(primer) && /reject/i.test(primer) && /force: true/.test(primer), "primer explains the Message Gate (review of outgoing messages, reject→rewrite, force escape hatch)");
assert(primer.includes("mcp__agentparty-app__gate-set"), "primer names the gate-set tool");
assert(/interrupt: true/.test(primer), "primer explains the interrupt-and-inject send option");
assert(/queue: true/.test(primer) && /Never pass `interrupt: false`/.test(primer), "primer keeps generated false values from overriding the saved interrupt preference");
// A sent message QUEUES behind the recipient's current turn (Codex: next tool
// call) — the primer must teach this so agents stop expecting instant delivery.
assert(/QUEUED/.test(primer) && /next tool call/.test(primer), "primer teaches queued delivery + Codex next-tool-call timing");
assert(/ONE turn at a time/.test(primer) && /tangled/.test(primer), "primer explains the one-turn-at-a-time model that causes perceived turn tangling");
assert(/LEGACY/.test(primer) && /mcp__agentparty__\*/.test(primer) && /mcp__plugin_\*_agentparty__\*/.test(primer), "primer warns off the legacy agentparty surfaces by name");
assert(/<channel source="agentparty"/.test(primer), "primer documents the channel communication protocol");
const noRole = buildPartyPrimer({ party: "p", member: "m" });
assert(/none specified/.test(noRole), "primer handles a missing role gracefully");

// --- respawn: reload the session, CONTINUING the conversation ----------------
// The tab toolbar's primary reset. Unlike a hard restart (fresh conversation),
// respawn tears the old session down and starts a new one that RESUMES the same
// harness thread — so the conversation continues (model context intact) while
// new config (e.g. a just-added MCP server) is applied. The app session id
// changes, but the fresh session is created WITH the old session's harness
// thread id as its resume target.
console.log("\nRespawn (reload, keep conversation) assertions:");
await bridge.createMember({ name: "respawner", role: "r", harness: "claude-code", model: "sonnet" });
const beforeSession = svc.list().members.find((m) => m.name === "respawner")?.sessionId;
const beforeThread = sessionManager.harnessSessionId(beforeSession);
assert(Boolean(beforeSession) && live.has(beforeSession), "respawner starts with a live session");
resumedWith.length = 0;
const respawned = svc.respawnMember("respawner", {}, partyId);
const afterSession = respawned.member?.sessionId;
assert(respawned.member?.status === "running", "respawned member is running again");
assert(Boolean(afterSession) && afterSession !== beforeSession, "respawn mints a NEW app session id (the old one is torn down)");
assert(!live.has(beforeSession), "respawn closed the previous session (old app session no longer live)");
assert(live.has(afterSession), "the reloaded session is live");
assert(resumedWith.includes(beforeThread), "respawn RESUMES the old harness thread (conversation continues, not a fresh chat)");
assert(svc.list().members.find((m) => m.name === "respawner")?.harnessSessionId === beforeThread, "the live harness thread id was captured onto the member before teardown");
assert(svc.list().members.find((m) => m.name === "respawner")?.model === "sonnet", "respawn preserves the member's persisted config (model)");

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nPARTY BRIDGE PASSED");
process.exit(failures.length ? 1 : 0);
