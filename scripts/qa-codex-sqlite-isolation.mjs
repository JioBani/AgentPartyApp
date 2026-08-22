/*
 * Regression QA for Codex app-server SQLite contention.
 *
 * AgentParty intentionally runs multiple app-servers. They must share the
 * user's CODEX_HOME (auth/config/rollouts), but never the same SQLite runtime.
 * The deterministic fake server records the actual child-process environment
 * so this test covers the spawn boundary, not just path generation.
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = qaTempDir();
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-codex-sqlite-qa-"));
const envOut = path.join(runtimeDir, "spawn-env.jsonl");
const sqliteFailOnce = path.join(runtimeDir, "sqlite-failed-once");
const fakeServer = path.join(root, "scripts", "fake-codex-appserver.mjs");
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "OK" : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};

async function bundle(entry, name) {
  const outfile = path.join(outDir, name);
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}

process.env.AGENTPARTY_CODEX_BIN = process.execPath;
process.env.AGENTPARTY_CODEX_ARGS = JSON.stringify([fakeServer]);
process.env.AGENTPARTY_FAKE_CODEX_ENV_OUT = envOut;
// Proves AgentParty does not accidentally inherit one shared user override.
process.env.CODEX_SQLITE_HOME = path.join(runtimeDir, "shared-poison");

const { CodexAdapter } = await bundle("src/core/codexAdapter.ts", "codex-adapter.mjs");
const { discoverCodexModels } = await bundle("src/core/codexModelDiscovery.ts", "codex-discovery.mjs");
const { agentPartyCodexSqliteHome } = await bundle("src/core/codexSqliteHome.ts", "codex-sqlite-home.mjs");

const memberAHome = agentPartyCodexSqliteHome(runtimeDir, "party:qa:member:a");
const memberBHome = agentPartyCodexSqliteHome(runtimeDir, "party:qa:member:b");
const discoveryHome = agentPartyCodexSqliteHome(runtimeDir, "model-discovery");

function adapter(id, member, sqliteHome) {
  return new CodexAdapter({
    id,
    cwd: runtimeDir,
    model: "gpt-5.4-mini",
    effort: "low",
    debugEnabled: false,
    storageDir: runtimeDir,
    sqliteHome,
    partyIdentity: { party: "qa", member },
  });
}

const a1 = adapter("a-1", "a", memberAHome);
const b = adapter("b-1", "b", memberBHome);
try {
  console.log("\nCodex SQLite isolation assertions:");
  a1.start();
  b.start();
  await Promise.all([waitForReady(a1), waitForReady(b)]);
} finally {
  a1.dispose();
  b.dispose();
}

// A respawn of the same logical member must reuse its DB instead of creating
// an unbounded sequence of backfill-heavy directories.
const a2 = adapter("a-2", "a", memberAHome);
try {
  a2.start();
  await waitForReady(a2);
} finally {
  a2.dispose();
}

await discoverCodexModels({ cwd: runtimeDir, sqliteHome: discoveryHome });

// A profile change (including Standard -> Fast) immediately respawns the same
// logical member. Model the old process releasing SQLite a moment late: the
// first app-server exits with Codex's real error, and the adapter must recover
// without deleting or rotating the stable runtime directory.
process.env.AGENTPARTY_FAKE_CODEX_SQLITE_FAIL_ONCE = sqliteFailOnce;
const a3 = adapter("a-3", "a", memberAHome);
try {
  a3.start();
  await waitForReady(a3, 8_000);
} finally {
  a3.dispose();
  delete process.env.AGENTPARTY_FAKE_CODEX_SQLITE_FAIL_ONCE;
}

const records = fs.readFileSync(envOut, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const homes = records.map((record) => path.resolve(record.sqliteHome));
assert(records.length === 6, `normal starts plus one failed/retried app-server spawn were recorded (${records.length}/6)`);
assert(homes[0] === path.resolve(memberAHome) && homes[2] === path.resolve(memberAHome), "the same member reuses one stable SQLite home after respawn");
assert(homes[1] === path.resolve(memberBHome), "a second member receives a different SQLite home");
assert(homes[3] === path.resolve(discoveryHome), "model discovery receives its own SQLite home");
assert(new Set(homes).size === 3, "member A, member B, and discovery do not contend on one SQLite runtime");
assert(homes.every((home) => home !== path.resolve(process.env.CODEX_SQLITE_HOME)), "child processes override an inherited shared CODEX_SQLITE_HOME");
assert(homes.every((home) => fs.existsSync(home)), "each runtime directory exists before Codex starts");
assert(homes[4] === path.resolve(memberAHome) && homes[5] === path.resolve(memberAHome), "SQLite startup retry preserves the member's stable runtime directory");
assert(a3.getSnapshot().lastError === undefined, "a transient SQLite startup handoff is recovered without a visible session error");

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nCODEX SQLITE ISOLATION PASSED");
fs.rmSync(runtimeDir, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);

async function waitForReady(instance, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = instance.getSnapshot();
    if (snapshot.status === "idle" || snapshot.status === "initialized") return;
    if (snapshot.status === "error") throw new Error(snapshot.lastError || "Codex adapter failed");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for fake Codex app-server initialization");
}
