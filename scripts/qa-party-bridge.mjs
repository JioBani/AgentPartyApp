/*
 * Integration test for the party in-process MCP bridge
 * (docs/PARTY_COMMUNICATION.md). Drives the REAL PartyApplicationService with a
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

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(qaDir, { recursive: true });

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function load(entry, name) {
  const out = path.join(qaDir, name);
  await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
    external: ["@anthropic-ai/claude-agent-sdk"] });
  return import(pathToFileURL(out).href);
}

const { PartyApplicationService } = await load("src/main/application/partyApplicationService.ts", "party-svc.mjs");
const { buildPartyDynamicToolSpec, buildPartyToolDefs, buildPartyPrimer, invokePartyTool, PARTY_MCP_SERVER, PARTY_TOOL_PREFIX } = await load("src/core/partyBridge.ts", "party-bridge.mjs");
const sdk = await import("@anthropic-ai/claude-agent-sdk");

// --- Fake SessionManager: captures bindings, never spawns a real session ------
const workspace = mkdtempSync(path.join(os.tmpdir(), "agentparty-qa-"));
const live = new Set();
const captured = [];
const sentTurns = [];
let notifyCount = 0;
let seq = 0;
const sessionManager = {
  createSession(input, _resume, binding) {
    const id = `sess-${++seq}`;
    live.add(id);
    captured.push(binding);
    return { id, title: "t", workspace: input.workspacePath, snapshot: {} };
  },
  createMockSession(input) {
    const id = `mock-${++seq}`; live.add(id);
    return { id, title: "t", workspace: input.workspacePath, snapshot: {} };
  },
  hasSession(id) { return live.has(id); },
  sendUserTurn(id, text) { sentTurns.push({ id, text }); },
  closeSession(id) { live.delete(id); },
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
assert(harnessIds.includes("claude-code") && harnessIds.includes("codex"), "both claude-code and codex harnesses are exposed");
assert(models.data.harnesses.find((h) => h.id === "codex")?.status === "available", "codex is marked available");
assert(Array.isArray(models.data.models) && models.data.models.length > 5, "list-models returns the model catalog");
assert(models.data.models.some((m) => m.reasoning && (m.reasoning.effort || m.reasoning.thinking)), "at least one model exposes reasoning options");
assert(models.data.models.some((m) => typeof m.perf === "number" && m.context), "models carry rich meta (perf + context)");
assert(models.data.models.every((m) => m.harness === "claude-code" || m.harness === "codex"), "every model states its harness (member-create needs it)");
const codexListed = models.data.models.filter((m) => m.harness === "codex");
assert(codexListed.some((m) => m.id === "gpt-5.5"), "the live codex catalog rides into list-models");
assert(codexListed.find((m) => m.id === "gpt-5.5")?.reasoning?.effort?.options?.length === 4, "codex models expose effort options (effort-only reasoning)");

// --- member-create: codex accepted ------------------------------------------
const codex = await bridge.createMember({ name: "cx", role: "x", harness: "codex" });
assert(codex.ok && svc.list().members.find((m) => m.name === "cx")?.runtime === "codex", "member-create accepts codex harness");
assert(captured.length === 2, "codex member-create starts a codex session");

// --- member-create: claude-code auto-starts + persists reasoning -------------
const make = await bridge.createMember({ name: "reviewer", role: "Code reviewer", harness: "claude-code", model: "sonnet", reasoning: "enabled" });
assert(make.ok, "member-create (claude-code) succeeds");
assert(captured.length === 3, "member-create auto-starts the new member's session");
const reviewer = svc.list().members.find((m) => m.name === "reviewer");
assert(reviewer?.reasoning === "enabled", "reasoning is persisted on the created member");
assert(reviewer?.status === "running", "created member is live");

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
const rmRev = await bridge.removeMember("reviewer");
assert(rmRev.ok, "member-remove removes a normal member");
assert(!svc.list().members.some((m) => m.name === "reviewer"), "removed member is gone from party state");

assert(notifyCount >= 3, `party broadcasts fired on bridge mutations (got ${notifyCount})`);

// --- MCP glue: buildPartyToolDefs wires real SDK tools to the bridge ----------
console.log("\nMCP tool surface assertions:");
assert(PARTY_MCP_SERVER === "agentparty-app", "MCP server name is agentparty-app");
assert(PARTY_TOOL_PREFIX === "mcp__agentparty-app__", "namespaced tool prefix matches");
const defs = buildPartyToolDefs(sdk.tool, bridge, mainBinding.identity);
const toolNames = defs.map((d) => d.name);
assert(JSON.stringify(toolNames) === JSON.stringify(["send", "member-create", "member-remove", "list", "list-models"]), "exposes the five party tools in order");
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
assert(JSON.stringify(dynamic.tools.map((tool) => tool.name)) === JSON.stringify(toolNames), "Codex dynamic tools expose the same five party tools");
const beforeDynamic = sentTurns.length;
const dynamicOut = await invokePartyTool(bridge, mainBinding.identity, `${PARTY_TOOL_PREFIX}send`, { to: "buddy", content: "hello from codex" });
assert(dynamicOut.ok, "Codex dispatcher accepts namespaced party tool names");
assert(sentTurns.length === beforeDynamic + 1 && /from="main"/.test(sentTurns[beforeDynamic].text), "Codex dispatcher stamps from=main through the same bridge identity");
const unknownDynamic = await invokePartyTool(bridge, mainBinding.identity, "mcp__agentparty__send", {});
assert(!unknownDynamic.ok && /Unknown AgentParty tool/.test(unknownDynamic.error || ""), "Codex dispatcher rejects legacy agentparty tool names");

// --- session primer: deterministic surface knowledge (no model memory) -------
console.log("\nParty primer assertions:");
const primer = buildPartyPrimer({ party: "team-qa", member: "reviewer", role: "Code reviewer" });
assert(/AgentParty/.test(primer), "primer introduces the AgentParty app");
assert(primer.includes("reviewer") && primer.includes("team-qa") && primer.includes("Code reviewer"), "primer states the member's identity (party + name + role)");
assert(primer.includes("mcp__agentparty-app__send") && primer.includes("mcp__agentparty-app__member-create"), "primer names the agentparty-app tool surface");
assert(/LEGACY/.test(primer) && /mcp__agentparty__\*/.test(primer) && /mcp__plugin_\*_agentparty__\*/.test(primer), "primer warns off the legacy agentparty surfaces by name");
assert(/<channel source="agentparty"/.test(primer), "primer documents the channel communication protocol");
const noRole = buildPartyPrimer({ party: "p", member: "m" });
assert(/none specified/.test(noRole), "primer handles a missing role gracefully");

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nPARTY BRIDGE PASSED");
process.exit(failures.length ? 1 : 0);
