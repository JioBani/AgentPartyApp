/*
 * Engine-level check for mocking INTER-MEMBER messages during frontend QA.
 * Seeds two mock members and simulates "alice -> bob" purely via the API
 * (sendPartyMessage), asserting that (1) the party message is recorded and
 * delivered, and (2) the receiver's session renders the incoming message the
 * same way a real session does (a `status: "sent"` event whose detail is the
 * channel-wrapped text). Guards the MockHarnessSession.sendUserTurn fix that
 * makes inter-member messaging visible without a real model session.
 */
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(qaDir, { recursive: true });

const out = path.join(qaDir, "engine-host-mock.mjs");
const result = await build({ entryPoints: [path.join(projectRoot, "src/main/engine/engineHost.ts")], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
writeFileSync(out, result.outputFiles[0].text);
const { createEngineHost } = await import(pathToFileURL(out).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const workspace = path.join(os.tmpdir(), "agentparty-qa-party-mock");
mkdirSync(workspace, { recursive: true });
rmSync(path.join(workspace, ".agent_party_app"), { recursive: true, force: true });

const host = createEngineHost({ storageDir: workspace, router: { preferredPort: 0, authToken: "engine", openRouterApiKey: "" } });
const events = [];
host.sessionManager.on("events", (p) => { for (const e of p.events || []) events.push({ ...e, sessionId: p.sessionId }); });

const engine = host.engineRegistry.forWorkspace(workspace);
// Two mock members; bob auto-replies, alice does not (so we can read its inbox cleanly).
await engine.qaSeed({ members: [{ name: "alice", autoReply: false }, { name: "bob", autoReply: true }] });
const listing = await engine.listParty();
const bob = listing.members.find((m) => m.name === "bob");
const alice = listing.members.find((m) => m.name === "alice");

console.log("\nMock inter-member messaging assertions:");
assert(Boolean(bob?.sessionId) && Boolean(alice?.sessionId), "both mock members have sessions");

// Simulate alice -> bob, exactly as the party `send` tool / UI would, over the API.
const send = await engine.sendPartyMessage("bob", "Please review PR 42", "alice");
await new Promise((r) => setTimeout(r, 50));

assert(send?.partyMessage?.from === "alice" && send?.partyMessage?.to === "bob", "party message recorded as alice -> bob");
assert(send?.partyMessage?.delivered === true, "message delivered to bob's (mock) session");
assert((await engine.listParty()).messages.some((m) => m.from === "alice" && m.to === "bob"), "message appears in party state");

const bobInbox = events.filter((e) => e.sessionId === bob.sessionId && e.type === "status" && e.status === "sent");
assert(bobInbox.length === 1, "bob's session rendered exactly one incoming message");
assert(/from="alice"/.test(bobInbox[0]?.detail || "") && /Please review PR 42/.test(bobInbox[0]?.detail || ""), "incoming message is channel-wrapped (from=alice) and carries the content");

// bob auto-replies → its transcript also shows an assistant turn (the 'response').
await new Promise((r) => setTimeout(r, 800));
const bobReply = events.find((e) => e.sessionId === bob.sessionId && e.type === "assistant_text_delta");
assert(Boolean(bobReply), "auto-reply mock produced an assistant response in bob's transcript");

// Reverse direction renders in alice's transcript too.
await engine.sendPartyMessage("alice", "Done — looks good", "bob");
await new Promise((r) => setTimeout(r, 50));
const aliceInbox = events.filter((e) => e.sessionId === alice.sessionId && e.type === "status" && e.status === "sent");
assert(aliceInbox.some((e) => /from="bob"/.test(e.detail || "")), "alice's transcript renders bob's reply (bidirectional)");

host.dispose();
console.log(failures.length ? `\nFAILED (${failures.length})` : "\nMOCK PARTY MESSAGING PASSED");
process.exit(failures.length ? 1 : 0);
