/*
 * The member list's status, as served to a client that has no transcript.
 *
 * The eight display values used to exist only in the renderer, derived from the
 * member, its session and its transcript. A paired phone holds no transcript,
 * so it could compute six of them and would have to guess at `approval` and
 * `stalled` — and guessing `idle` there shows a stalled member as merely
 * waiting, which states something false rather than omitting something.
 *
 * So the derivation now ships on the party listing. This checks the two claims
 * that matter: the value is THERE, and it is not the stored one.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = qaTempDir();

const out = path.join(qaDir, "engine-host-display-status.mjs");
const result = await build({ entryPoints: [path.join(projectRoot, "src/main/engine/engineHost.ts")], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
writeFileSync(out, result.outputFiles[0].text);
const { createEngineHost } = await import(pathToFileURL(out).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const workspace = path.join(os.tmpdir(), "agentparty-qa-display-status");
mkdirSync(workspace, { recursive: true });
rmSync(path.join(workspace, ".agent_party_app"), { recursive: true, force: true });

const host = createEngineHost({ storageDir: workspace, router: { preferredPort: 0, authToken: "engine", openRouterApiKey: "" } });
const engine = host.engineRegistry.forWorkspace(workspace);
await engine.qaSeed({ members: [{ name: "alice", autoReply: false }] });

const listing = await engine.listParty();
const alice = listing.members.find((m) => m.name === "alice");

const DISPLAY_VALUES = new Set(["working", "idle", "approval", "not-started", "stalled", "disconnected", "sleeping", "closed"]);
const STORED_VALUES = new Set(["idle", "opened", "running", "closed", "missing_session", "sleeping"]);

console.log("\nderived status on the party listing:");
assert(Boolean(alice), "the seeded member is listed");
assert(alice?.displayStatus !== undefined, "the member carries displayStatus");
assert(DISPLAY_VALUES.has(alice?.displayStatus), `displayStatus is one of the eight (got ${alice?.displayStatus})`);
// The whole point: a live member stores `running`, which is NOT a display
// value. A client echoing the stored field would render a status that does not
// exist in the design.
assert(alice?.status === "running", "the stored status is still the raw six-value one");
assert(!DISPLAY_VALUES.has("running"), "…and `running` is not among the display values");
assert(alice?.displayStatus === "idle", "a bound, quiet member reads idle rather than its stored `running`");

console.log("\nit is derived, never persisted:");
const partyFile = path.join(workspace, ".agent_party_app", "parties", listing.currentPartyId, "party.json");
const raw = readFileSync(partyFile, "utf8");
assert(!raw.includes("displayStatus"), "displayStatus is absent from party.json on disk");
const stored = JSON.parse(raw).members.find((m) => m.name === "alice");
assert(stored && stored.displayStatus === undefined, "…and absent from the member record itself");
assert(STORED_VALUES.has(stored?.status), `the persisted status stays in the six-value domain (got ${stored?.status})`);

console.log("\nsleeping and closed pass through unchanged:");
// These two are read straight off the stored value, so they are the cases where
// display and storage agree — worth pinning, because a future shortcut that
// "just maps the stored value" would pass here and fail everywhere else.
const { deriveMemberStatus } = await (async () => {
  const shared = path.join(qaDir, "member-display-status.mjs");
  const built = await build({ entryPoints: [path.join(projectRoot, "src/shared/memberDisplayStatus.ts")], bundle: true, format: "esm", platform: "node", write: false });
  writeFileSync(shared, built.outputFiles[0].text);
  return import(pathToFileURL(shared).href);
})();

const facts = { stored: "idle", hasLiveSession: true, busy: false, pendingApproval: false, stalled: false };
assert(deriveMemberStatus({ ...facts, stored: "sleeping", hasLiveSession: false }) === "sleeping", "a sleeping member is sleeping, not not-started");
assert(deriveMemberStatus({ ...facts, stored: "closed", hasLiveSession: false }) === "closed", "a closed member is closed, not not-started");
assert(deriveMemberStatus({ ...facts, hasLiveSession: false }) === "not-started", "no live session reads not-started");
assert(deriveMemberStatus({ ...facts, stored: "missing_session" }) === "disconnected", "a dead binding reads disconnected");
assert(deriveMemberStatus({ ...facts, stored: "missing_session", pendingApproval: true }) === "disconnected", "…and an approval cannot outrank it");
assert(deriveMemberStatus({ ...facts, pendingApproval: true }) === "approval", "a pending approval outranks busy");
assert(deriveMemberStatus({ ...facts, busy: true, stalled: true }) === "stalled", "a silent turn reads stalled, not working");
assert(deriveMemberStatus({ ...facts, busy: true }) === "working", "a live turn reads working");

host.dispose?.();
console.log(failures.length ? `\nDISPLAY STATUS FAILED (${failures.length})` : "\nDISPLAY STATUS PASSED");
process.exit(failures.length ? 1 : 0);
