/*
 * Route-parity check for the shared user-send path. `sendUserMessage` is the ONE
 * method behind both the UI Send button and `POST /api/party/members/:name/message`,
 * so an agent drives the identical route a user does. Verifies (engine level):
 *  - it delivers a RAW user turn (not channel-wrapped like inter-member `send`);
 *  - it REUSES the member's existing live session (no duplicate start);
 *  - it accepts image attachments without error.
 * Contrasted against `sendPartyMessage`, which channel-wraps.
 */
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(qaDir, { recursive: true });
const out = path.join(qaDir, "engine-host-usermsg.mjs");
const result = await build({ entryPoints: [path.join(projectRoot, "src/main/engine/engineHost.ts")], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
writeFileSync(out, result.outputFiles[0].text);
const { createEngineHost } = await import(pathToFileURL(out).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const workspace = path.join(os.tmpdir(), "agentparty-qa-user-message");
mkdirSync(workspace, { recursive: true });
rmSync(path.join(workspace, ".agent_party_app"), { recursive: true, force: true });

const host = createEngineHost({ storageDir: workspace, router: { preferredPort: 0, authToken: "engine", openRouterApiKey: "" } });
const events = [];
host.sessionManager.on("events", (p) => { for (const e of p.events || []) events.push({ ...e, sessionId: p.sessionId }); });
const engine = host.engineRegistry.forWorkspace(workspace);

await engine.qaSeed({ members: [{ name: "solo", autoReply: false }] });
const before = (await engine.listParty()).members.find((m) => m.name === "solo");

console.log("\nsendUserMessage (shared UI+API send path):");
assert(Boolean(before?.sessionId), "member has a live session before sending");

const sentBase = events.filter((e) => e.sessionId === before.sessionId && e.type === "status" && e.status === "sent").length;
const res = await engine.sendUserMessage("solo", "describe this image", [{ kind: "image", mediaType: "image/png", dataBase64: "AAAA", name: "x.png" }]);
await new Promise((r) => setTimeout(r, 60));
const after = (await engine.listParty()).members.find((m) => m.name === "solo");

assert(after?.sessionId === before.sessionId, "reuses the existing session — no duplicate start");
assert(res?.member?.sessionId === before.sessionId, "result carries the member's (same) session id");
const sent = events.filter((e) => e.sessionId === before.sessionId && e.type === "status" && e.status === "sent");
assert(sent.length === sentBase + 1, "exactly one user turn was dispatched");
const detail = sent[sent.length - 1]?.detail || "";
assert(detail === "describe this image", "delivered as a RAW user turn (verbatim text)");
assert(!/from=|<channel/.test(detail), "NOT channel-wrapped (unlike inter-member send)");

// Contrast: sendPartyMessage channel-wraps the same member.
await engine.sendPartyMessage("solo", "hi from bob", "bob");
await new Promise((r) => setTimeout(r, 60));
const wrapped = events.filter((e) => e.sessionId === before.sessionId && e.type === "status" && e.status === "sent").pop();
assert(/from="bob"/.test(wrapped?.detail || ""), "sendPartyMessage IS channel-wrapped (confirms /message vs /send differ)");

host.dispose();
console.log(failures.length ? `\nUSER MESSAGE FAILED (${failures.length})` : "\nUSER MESSAGE PASSED");
process.exit(failures.length ? 1 : 0);
