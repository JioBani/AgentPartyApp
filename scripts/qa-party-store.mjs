/*
 * Party storage split — unit test of the on-disk layout (Stage 1).
 * Exercises PartyRepository directly against a temp workspace to lock in:
 *   1) legacy `state.json` → per-party split migration (composed state identical),
 *   2) per-party write isolation (editing party A never rewrites party B's file),
 *   3) authoritative partyId (a member's party is its FILE, not a stored field).
 * No Electron, no model — pure fs behavior.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });

const r = await build({ entryPoints: [path.join(projectRoot, "src/main/partyRepository.ts")], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
const bundlePath = path.join(outDir, "party-repo.mjs"); writeFileSync(bundlePath, r.outputFiles[0].text);
const { PartyRepository } = await import(pathToFileURL(bundlePath).href);

const ws = path.join(os.tmpdir(), `ap-party-store-${process.pid}`);
rmSync(ws, { recursive: true, force: true });
mkdirSync(path.join(ws, ".agent_party_app"), { recursive: true });
const repo = new PartyRepository();
const partyFile = (id) => path.join(ws, ".agent_party_app", "parties", id, "party.json");
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));

// ============ 1) legacy migration ============
console.log("\nlegacy state.json → per-party split:");
const legacy = {
  version: 1,
  parties: [
    { id: "p-alpha", name: "Alpha", createdAt: "t", updatedAt: "t" },
    { id: "p-beta", name: "Beta", createdAt: "t", updatedAt: "t" },
  ],
  currentPartyId: "p-beta",
  members: [
    { name: "main", partyId: "p-alpha", status: "idle" },
    { name: "main", partyId: "p-beta", status: "idle" },
    { name: "worker", partyId: "p-beta", status: "idle" },
  ],
  messages: [{ id: "m1", partyId: "p-alpha", from: "user", to: "main", content: "hi", createdAt: "t" }],
};
writeFileSync(path.join(ws, ".agent_party_app", "state.json"), JSON.stringify(legacy));

const composed = repo.read(ws);
assert(composed.parties.length === 2, `composed has both parties (${composed.parties.length})`);
assert(composed.members.length === 3, `composed has all members (${composed.members.length})`);
assert(composed.currentPartyId === "p-beta", `last-active hint restored from currentPartyId (${composed.currentPartyId})`);
assert(existsSync(path.join(ws, ".agent_party_app", "parties.json")), "wrote shared parties.json index");
assert(existsSync(partyFile("p-alpha")) && existsSync(partyFile("p-beta")), "wrote per-party party.json files");
assert(readJson(partyFile("p-alpha")).members.length === 1, "alpha's file has only alpha's member");
assert(readJson(partyFile("p-beta")).members.length === 2, "beta's file has only beta's members");
assert(readJson(partyFile("p-alpha")).messages.length === 1, "alpha's message landed in alpha's file");
assert(existsSync(path.join(ws, ".agent_party_app", "state.json")), "legacy state.json kept as backup");
assert(readJson(path.join(ws, ".agent_party_app", "parties.json")).lastActivePartyId === "p-beta", "index carries lastActivePartyId hint");

// second read must NOT re-migrate — it reads the new layout and matches
const again = repo.read(ws);
assert(JSON.stringify(again.members.map((m) => `${m.partyId}/${m.name}`).sort()) === JSON.stringify(composed.members.map((m) => `${m.partyId}/${m.name}`).sort()), "second read (new layout) yields identical membership");

// ============ 2) per-party write isolation ============
console.log("\nper-party write isolation:");
const betaBefore = readFileSync(partyFile("p-beta"), "utf8");
const betaMtimeBefore = statSync(partyFile("p-beta")).mtimeMs;
await new Promise((res) => setTimeout(res, 20));
// Edit ALPHA only (add a member) via the granular writer.
repo.writeParty(ws, "p-alpha", [
  { name: "main", partyId: "p-alpha", status: "idle" },
  { name: "helper", partyId: "p-alpha", status: "idle" },
], []);
assert(readJson(partyFile("p-alpha")).members.length === 2, "alpha gained its new member");
assert(readFileSync(partyFile("p-beta"), "utf8") === betaBefore, "beta's file content is BYTE-IDENTICAL (no clobber)");
assert(statSync(partyFile("p-beta")).mtimeMs === betaMtimeBefore, "beta's file was not even rewritten (mtime unchanged)");

// ============ 3) authoritative partyId (file location wins) ============
console.log("\nauthoritative partyId (a member's party is its file):");
// Store a member under alpha's file WITHOUT a partyId, and one with a WRONG id.
repo.writeParty(ws, "p-alpha", [
  { name: "noid", status: "idle" },              // missing partyId
  { name: "wrongid", partyId: "p-ZZZ", status: "idle" }, // stale/wrong partyId
], []);
const composed3 = repo.read(ws);
const noid = composed3.members.find((m) => m.name === "noid");
const wrongid = composed3.members.find((m) => m.name === "wrongid");
assert(noid && noid.partyId === "p-alpha", "member with no stored partyId gets its file's party authoritatively");
assert(wrongid && wrongid.partyId === "p-alpha", "member with a WRONG stored partyId is corrected to its file's party (no silent mis-route)");

rmSync(ws, { recursive: true, force: true });
console.log(failures.length ? `\nPARTY STORE FAILED (${failures.length})` : "\nPARTY STORE PASSED");
process.exit(failures.length ? 1 : 0);
