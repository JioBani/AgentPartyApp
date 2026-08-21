/*
 * Product E2E: opening a WSL workspace in the real app.
 *
 * Reproduces the reported failure — `agent-party` from inside a distro (or any
 * `POST /api/windows` with a `wsl+<distro>:` URI) opened a window that showed
 * "작업공간 없음". The cause was load-time: the bundled engine server imported
 * `electron` and read `__dirname`, neither of which exists under a distro's
 * plain node, so the engine died and `getState` never resolved a workspace.
 *
 * Drives the SAME surface the CLI and the UI use: the real AgentParty process,
 * its automation HTTP API, no mocks and no special code path.
 *
 * Usage: node scripts/e2e-wsl-workspace-open.mjs [distro]
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, delay, removePath } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distro = process.argv[2] || "Ubuntu-20.04";
const wslWorkspacePosix = `/tmp/agentparty-e2e-wsl-workspace-${process.pid}`;
const wslUri = `wsl+${distro}:${wslWorkspacePosix}`;
const localWorkspace = path.join(os.tmpdir(), "agentparty-e2e-wsl-open-workspace");
const userData = path.join(os.tmpdir(), "agentparty-e2e-wsl-open-userdata");
const port = 45231;

const app = createElectronE2eApp({
  root,
  workspace: localWorkspace,
  userData,
  port,
});

function check(label, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!condition) {
    failures += 1;
  }
}
let failures = 0;

function sameWorkspace(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const wslA = /^wsl\+([^:]+):(.*)$/i.exec(a);
  const wslB = /^wsl\+([^:]+):(.*)$/i.exec(b);
  if (wslA || wslB) {
    return Boolean(wslA && wslB)
      && wslA[1].toLowerCase() === wslB[1].toLowerCase()
      && path.posix.normalize(wslA[2]) === path.posix.normalize(wslB[2]);
  }
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

const fixtureScript = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const workspace = process.argv[1];
const root = path.join(workspace, ".agent_party_app");
fs.rmSync(workspace, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const parties = [
  { id: "SEL-6809", name: "SEL-6809", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" },
  { id: "SEL-6884", name: "SEL-6884", createdAt: "2026-08-20T00:00:01.000Z", updatedAt: "2026-08-20T00:00:01.000Z" },
];
fs.writeFileSync(path.join(root, "parties.json"), JSON.stringify({ version: 2, parties, lastActivePartyId: parties[0].id }, null, 2));
for (const party of parties) {
  const dir = path.join(root, "parties", party.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "party.json"), JSON.stringify({
    version: 2,
    members: [{ name: "main", partyId: party.id, role: "main", status: "idle", createdAt: party.createdAt, updatedAt: party.updatedAt }],
    messages: [],
  }, null, 2));
}
`;
execFileSync("wsl.exe", ["-d", distro, "-e", "node", "-e", fixtureScript, wslWorkspacePosix], { stdio: "inherit" });

await app.prepare();
await app.launch();
let restarted;
try {
  const nativeWindow = (await app.get("/api/windows")).windows?.[0];
  check("the app initially opens a native Windows workspace", sameWorkspace(nativeWindow?.workspacePath, localWorkspace), nativeWindow?.workspacePath);

  // The exact call `agent-party` makes when the app is already running.
  const win = await app.post("/api/windows", { workspacePath: wslUri });
  check("POST /api/windows returns the WSL workspace", sameWorkspace(win.workspacePath, wslUri), `${win.workspacePath}`);

  // What the header renders from: an empty `workspace` is the "작업공간 없음" bug.
  const state = await app.get(`/api/state?window=${encodeURIComponent(win.id)}`);
  check("state resolves a workspace at all", Boolean(state.workspace), JSON.stringify(state.workspace));
  check("workspace host is the distro", state.workspace?.kind === "wsl" && state.workspace?.distro?.toLowerCase() === distro.toLowerCase(), `${state.workspace?.kind}/${state.workspace?.distro}`);
  check("workspace path is the distro path", state.workspace?.path === wslWorkspacePosix, `${state.workspace?.path}`);

  // Proof the in-distro engine actually answered (not just a parsed URI): this
  // field comes back over the stdio RPC from the engine running inside WSL.
  check("in-distro engine served the session list", Array.isArray(state.sessions), typeof state.sessions);

  // Regression: these parties already existed before the Windows app opened.
  // The old desktop migration tried to read the WSL URI with Windows fs APIs,
  // returned an empty migration, and left a party visible only through the
  // workbench's temporary current-workspace overlay. Moving it then failed with
  // "파티 'SEL-6809' 이 목록에 없습니다."
  const expectedIds = ["SEL-6809", "SEL-6884"];
  const grouped = await app.get("/api/party-groups");
  const registeredIds = grouped.parties?.filter((party) => sameWorkspace(party.workspacePath, wslUri)).map((party) => party.id).sort() || [];
  check("pre-existing WSL parties enter the app-global registry", JSON.stringify(registeredIds) === JSON.stringify(expectedIds), registeredIds.join(","));

  const locations = await app.get(`/api/cwd/members?window=${encodeURIComponent(win.id)}`);
  const legacyLocations = locations.members?.filter((member) => expectedIds.includes(member.partyName)) || [];
  check(
    "legacy WSL members are backfilled on the distro-owned store",
    legacyLocations.length === expectedIds.length && legacyLocations.every((member) => member.location?.env === "wsl" && member.location?.distro?.toLowerCase() === distro.toLowerCase()),
    JSON.stringify(legacyLocations),
  );

  // Force the precise bug seam: the workbench still has the live WSL parties,
  // but the durable global registry no longer does. The first move must locate
  // the owning live engine and reconcile its complete snapshot before filing.
  rmSync(path.join(userData, "party-groups.json"), { force: true });
  const createdGroup = await app.post("/api/party-groups", { name: "WSL QA" });
  const targetGroup = createdGroup.group?.id;
  check("created a target group through the public API", Boolean(targetGroup), targetGroup);
  check("regression seam has a visible party absent from the registry", (createdGroup.parties || []).length === 0, `${createdGroup.parties?.length || 0} registered`);

  // Repeated moves exercise the same user-facing capability and assert every
  // response remains a COMPLETE registry. No party may vanish while another is
  // being filed.
  for (let index = 0; index < 12; index += 1) {
    const partyId = expectedIds[index % expectedIds.length];
    const groupId = index % 2 === 0 ? targetGroup : "default";
    const moved = await app.post(`/api/parties/${encodeURIComponent(partyId)}/group`, { groupId });
    const ids = moved.parties?.filter((party) => sameWorkspace(party.workspacePath, wslUri)).map((party) => party.id).sort() || [];
    check(`move ${index + 1} keeps every WSL party visible`, JSON.stringify(ids) === JSON.stringify(expectedIds), ids.join(","));
  }

  // The native window receives the same app-global registry update; this is a
  // renderer assertion, not merely a JSON-store assertion.
  let nativeRow;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    nativeRow = await app.post(`/api/measure?window=${encodeURIComponent(nativeWindow.id)}`, {
      selector: '.wb-party-row[data-party-id="SEL-6809"]',
    });
    if (nativeRow?.elements?.length === 1) break;
    await delay(100);
  }
  check("native Windows window renders the registered WSL party", nativeRow?.elements?.length === 1, `${nativeRow?.elements?.length || 0} rows`);

  // Relaunch on Windows only. The durable global registry must still show WSL
  // parties without opening a WSL window or starting its engine again.
  app.kill();
  await delay(1_000);
  restarted = createElectronE2eApp({ root, workspace: localWorkspace, userData, port });
  await restarted.launch();
  const afterRestart = await restarted.get("/api/party-groups");
  const persistedIds = afterRestart.parties?.filter((party) => sameWorkspace(party.workspacePath, wslUri)).map((party) => party.id).sort() || [];
  check("native-only restart still lists WSL parties", JSON.stringify(persistedIds) === JSON.stringify(expectedIds), persistedIds.join(","));
  const restartWindows = (await restarted.get("/api/windows")).windows || [];
  check("native-only restart did not open a WSL workspace", restartWindows.length === 1 && sameWorkspace(restartWindows[0].workspacePath, localWorkspace), JSON.stringify(restartWindows));
} finally {
  await restarted?.close().catch(() => undefined);
  restarted?.kill();
  app.kill();
  execFileSync("wsl.exe", ["-d", distro, "-e", "node", "-e", "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })", wslWorkspacePosix], { stdio: "inherit" });
  await removePath(localWorkspace);
  await removePath(userData);
}

console.log(failures === 0 ? "\nWSL workspace open E2E: PASS" : `\nWSL workspace open E2E: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
