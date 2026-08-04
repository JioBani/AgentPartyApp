/*
 * Product E2E: two real Codex app-servers start concurrently in a WSL-backed
 * AgentParty workspace while other Codex IDE app-servers may already be alive.
 * No model turn is sent; this verifies the failing SQLite initialization path.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, delay } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distro = process.argv[2] || "Ubuntu-20.04";
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const workspacePosix = `/tmp/agentparty-e2e-codex-sqlite-${suffix}`;
const workspaceUri = `wsl+${distro}:${workspacePosix}`;
const memberNames = [`sqlite-a-${suffix}`, `sqlite-b-${suffix}`];
let sqlitePaths = [];
const app = createElectronE2eApp({
  root,
  workspace: path.join(os.tmpdir(), `agentparty-e2e-codex-sqlite-workspace-${suffix}`),
  userData: path.join(os.tmpdir(), `agentparty-e2e-codex-sqlite-userdata-${suffix}`),
  port: 45232,
});

function wsl(args, options = {}) {
  return execFileSync("wsl.exe", ["-d", distro, "-e", ...args], { encoding: "utf8", ...options });
}

wsl(["mkdir", "-p", workspacePosix]);
await app.prepare();
await app.launch();

try {
  const windows = (await app.get("/api/windows")).windows || [];
  const windowId = windows[0]?.id;
  assert(windowId, "real app window is available");
  await app.post(`/api/windows/${encodeURIComponent(windowId)}/workspace`, { workspacePath: workspaceUri });
  await app.post("/api/navigation", { view: "workbench" });

  const created = await app.post("/api/parties", { name: `Codex SQLite isolation ${suffix}` });
  const initialState = await app.get("/api/state");
  const partyId = created.currentPartyId || initialState.party?.currentPartyId;
  assert(partyId, "QA party was created through the automation API");

  for (const name of memberNames) {
    await app.post("/api/party/members", {
      name,
      requirement: "Initialize a WSL Codex app-server without sending a model turn.",
      runtime: "codex",
      model: "gpt-5.4-mini",
    });
  }

  await Promise.all(memberNames.map((name) => app.post(`/api/party/members/${encodeURIComponent(name)}/start`, {
    model: "gpt-5.4-mini",
    codexPolicy: { sandbox: "read-only", approval: "on-request", guardian: false },
  })));

  const ready = await waitForMembers();
  for (const name of memberNames) {
    const member = ready.party?.members?.find((candidate) => candidate.name === name);
    const session = ready.sessions?.find((candidate) => candidate.id === member?.sessionId);
    assert(session?.snapshot?.status === "initialized", `${name} initialized a real WSL Codex app-server`);
    assert(session?.snapshot?.harnessAlive === true, `${name} app-server remains alive after initialization`);
    assert(!session?.snapshot?.lastError, `${name} has no SQLite startup error`);
  }

  const wslHome = wsl(["sh", "-c", "printf %s \"$HOME\""]).trim();
  sqlitePaths = memberNames.map((name) => sqliteHome(
    `${wslHome}/.agent_party_app`,
    `workspace:${workspacePosix}:party:${partyId}:member:${name}`,
  ));
  assert(new Set(sqlitePaths).size === 2, "the two members resolve to different SQLite homes");
  for (const sqlitePath of sqlitePaths) {
    wsl(["test", "-f", `${sqlitePath}/state_5.sqlite`]);
    wsl(["test", "-f", `${sqlitePath}/logs_2.sqlite`]);
  }
  sqlitePaths.push(sqliteHome(
    `${wslHome}/.agent_party_app`,
    `workspace:${workspacePosix}:model-discovery`,
  ));
  console.log("  ok: both isolated SQLite runtimes were created on WSL ext4");

  console.log("\nWSL CODEX SQLITE ISOLATION E2E PASSED");
} finally {
  await app.close().catch(() => undefined);
  app.kill();
  try { wsl(["rm", "-rf", workspacePosix]); } catch { /* best-effort exact QA path cleanup */ }
  for (const sqlitePath of sqlitePaths) {
    if (sqlitePath.startsWith("/") && sqlitePath.includes("/.agent_party_app/codex-sqlite/")) {
      try { wsl(["rm", "-rf", sqlitePath]); } catch { /* best-effort exact QA path cleanup */ }
    }
  }
}

async function waitForMembers(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await app.get("/api/state");
    const snapshots = memberNames.map((name) => {
      const member = last.party?.members?.find((candidate) => candidate.name === name);
      return last.sessions?.find((candidate) => candidate.id === member?.sessionId)?.snapshot;
    });
    const error = snapshots.find((snapshot) => snapshot?.status === "error");
    if (error) throw new Error(error.lastError || "Codex member entered error state");
    if (snapshots.every((snapshot) => snapshot?.status === "initialized")) return last;
    await delay(1000);
  }
  throw new Error(`Timed out waiting for both Codex members: ${JSON.stringify(last?.sessions || [])}`);
}

function sqliteHome(userDataDir, scope) {
  const digest = crypto.createHash("sha256").update(scope).digest("hex").slice(0, 16);
  const label = scope.normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "runtime";
  return `${userDataDir}/codex-sqlite/${label}-${digest}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}
