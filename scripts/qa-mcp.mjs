/*
 * MCP status + actions, engine level. Drives the SAME EngineConnection methods
 * the HTTP API (/api/sessions/:id/mcp*) and the workbench MCP panel call, so
 * route-parity is exercised without a live model (a QA mock member backs it).
 * Verifies: the neutral snapshot shape + harness tag + per-server capability
 * flags, and that reconnect / toggle / authenticate mutate live state.
 */
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(qaDir, { recursive: true });
const out = path.join(qaDir, "engine-host-mcp.mjs");
const result = await build({ entryPoints: [path.join(projectRoot, "src/main/engine/engineHost.ts")], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
writeFileSync(out, result.outputFiles[0].text);
const { createEngineHost } = await import(pathToFileURL(out).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const workspace = path.join(os.tmpdir(), "agentparty-qa-mcp");
mkdirSync(workspace, { recursive: true });
rmSync(path.join(workspace, ".agent_party_app"), { recursive: true, force: true });

const host = createEngineHost({ storageDir: workspace, router: { preferredPort: 0, authToken: "engine", openRouterApiKey: "" } });
const engine = host.engineRegistry.forWorkspace(workspace);

await engine.qaSeed({ members: [{ name: "solo", autoReply: false }] });
const member = (await engine.listParty()).members.find((m) => m.name === "solo");
const sessionId = member?.sessionId;

console.log("\nlistSessionMcpServers (shared UI+API status path):");
assert(Boolean(sessionId), "mock member has a live session");
const snap = await engine.listSessionMcpServers(sessionId);
assert(snap?.supported === true, "snapshot.supported is true");
assert(typeof snap?.harness === "string", "snapshot carries a harness tag");
assert(Array.isArray(snap?.servers) && snap.servers.length === 3, "lists the seeded servers");

const byName = Object.fromEntries((snap.servers || []).map((s) => [s.name, s]));
assert(byName.filesystem?.state === "connected", "filesystem is connected");
assert(byName.filesystem?.tools?.length === 2, "filesystem reports its tools");
assert(byName.sentry?.state === "needs-auth" && byName.sentry?.canAuthenticate === true, "sentry is needs-auth + can authenticate");
assert(byName.legacy?.state === "failed" && byName.legacy?.error === "spawn ENOENT", "legacy is failed with an error message");

console.log("\nreconnect / toggle / authenticate mutate live state:");
await engine.reconnectSessionMcpServer(sessionId, "legacy");
let after = await engine.listSessionMcpServers(sessionId);
assert(after.servers.find((s) => s.name === "legacy")?.state === "connected", "reconnect brings 'legacy' to connected");

await engine.setSessionMcpServerEnabled(sessionId, "filesystem", false);
after = await engine.listSessionMcpServers(sessionId);
assert(after.servers.find((s) => s.name === "filesystem")?.state === "disabled", "toggle disables 'filesystem'");

const auth = await engine.authenticateSessionMcpServer(sessionId, "sentry");
assert(typeof auth?.authorizationUrl === "string" && auth.authorizationUrl.includes("sentry"), "authenticate returns an authorization URL");
after = await engine.listSessionMcpServers(sessionId);
assert(after.servers.find((s) => s.name === "sentry")?.state === "connected", "authenticate connects 'sentry'");

host.dispose();
console.log(failures.length ? `\nMCP FAILED (${failures.length})` : "\nMCP PASSED");
process.exit(failures.length ? 1 : 0);
