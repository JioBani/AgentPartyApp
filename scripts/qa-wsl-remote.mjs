/*
 * WSL remote engine E2E (Stage 5b, the WSL remote-engine design §7/§8).
 *
 * The headline flow: a Windows process spawns the engine inside a WSL distro via
 * wsl.exe (the production spawnWslEngine) and drives it over stdio through the
 * production RemoteEngineClient — exactly what the desktop does for a
 * `wsl+<distro>:/path` workspace. Verifies results and that the engine persisted
 * to the distro's own ext4 fs.
 *
 * Skips (not fails) where wsl.exe is absent.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const qaDir = qaTempDir();

async function bundle(entry, outName) {
  const out = path.join(qaDir, outName);
  const result = await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true, format: "esm", platform: "node", write: false, external: ["electron"],
  });
  writeFileSync(out, result.outputFiles[0].text);
  return out;
}

let hasWsl = true;
try { execFileSync("wsl.exe", ["-e", "true"], { stdio: "ignore" }); } catch { hasWsl = false; }
if (!hasWsl) {
  console.log("WSL not available — skipping WSL remote E2E.");
  process.exit(0);
}

const serverBundle = await bundle("src/main/engine/transport/engineServerEntry.ts", "engine-server.mjs");
const clientBundle = await bundle("src/main/engine/transport/remoteEngineClient.ts", "engine-client.mjs");
const wslBundle = await bundle("src/main/engine/transport/wslEngine.ts", "wsl-engine.mjs");
const { RemoteEngineClient } = await import(pathToFileURL(clientBundle).href);
const { spawnWslEngine } = await import(pathToFileURL(wslBundle).href);

const distro = process.env.QA_WSL_DISTRO || "Ubuntu-22.04";
const wslWs = process.env.QA_WSL_WS || "/home/dev/agentparty-wsl-e2e";

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

console.log(`WSL remote engine E2E (${distro} @ ${wslWs}):`);

// Clean the workspace store inside the distro.
execFileSync("wsl.exe", ["-d", distro, "-e", "bash", "-lc", `rm -rf "${wslWs}/.agent_party_app" && mkdir -p "${wslWs}"`], { encoding: "utf8" });

const handle = spawnWslEngine({ distro, workspacePosix: wslWs, serverBundleWinPath: serverBundle });
const client = new RemoteEngineClient(handle.transport, wslWs, handle.dispose);

try {
  const seed = await client.qaSeed({ party: "WSL Remote", members: [
    { name: "wr-1", role: "backend" },
    { name: "wr-2", role: "reviewer" },
  ] });
  assert(seed.created.includes("wr-1") && seed.created.includes("wr-2"), "Windows client seeded the WSL engine (both members)");

  const listing = await client.listParty();
  const names = listing.members.map((m) => m.name);
  assert(names.includes("wr-1") && names.includes("wr-2"), `listParty over wsl.exe stdio (${names.join(",")})`);
  assert(listing.parties.some((p) => p.name === "WSL Remote"), "party 'WSL Remote' present");

  await client.qaEmit("wr-1", { events: [{ type: "assistant_text_delta", text: "driven from Windows" }], status: "working" });
  assert(true, "qaEmit over wsl.exe stdio accepted");

  /*
   * Approval injection across the transport (B-18). Worth its own coverage for
   * two reasons: the recorded scenarios are a NEW module reaching the engine
   * bundle, which is run by the distro's plain node and dies at load on any
   * Electron dependency; and a refusal has to survive the RPC boundary as a
   * REJECTION. If the transport turned a throw into a resolved promise, the
   * "cannot fake an approval" guard would silently no-op in WSL only.
   */
  const injected = await client.qaInteraction("wr-1", { type: "approval", scenario: "codex-command-once" });
  assert(Boolean(injected?.requestId), `recorded approval injected over wsl.exe stdio (${injected?.requestId})`);

  // The session snapshot, not the transcript: an injected approval is a LIVE
  // event that the renderer folds, so nothing is persisted server-side. What the
  // engine does record is that the member is now waiting on someone.
  const sessions = await client.listWorkspaceSessions();
  const waiting = sessions.find((s) => (s.snapshot?.pendingApprovalCount || 0) > 0);
  assert(Boolean(waiting), `the WSL engine registered a pending approval (not merely accepted the call)`);

  let remoteRefusal = "";
  try {
    await client.qaInteraction("wr-1", { type: "approval", scenario: "does-not-exist" });
  } catch (error) {
    remoteRefusal = String(error?.message || error);
  }
  assert(Boolean(remoteRefusal), "an unknown scenario REJECTS across the transport (no silent success in WSL)");
  assert(/does-not-exist/.test(remoteRefusal), `…and the reason survives the boundary (${remoteRefusal.slice(0, 70)}…)`);

  // Verify the engine persisted to the distro's own ext4 fs.
  // The layout is the SPLIT one (a shared `parties.json` index plus a per-party
  // `parties/<id>/party.json`); this used to look for the pre-split
  // `state.json`, which the app stopped writing when the store was split, so the
  // check had been failing on a file that is no longer supposed to exist.
  const fsCheck = execFileSync("wsl.exe", ["-d", distro, "-e", "bash", "-lc",
    `test -f "${wslWs}/.agent_party_app/parties.json" && echo INDEX_OK; ls "${wslWs}/.agent_party_app/parties"/*/party.json >/dev/null 2>&1 && echo PARTY_OK; df -T "${wslWs}/.agent_party_app" | tail -1`],
    { encoding: "utf8" });
  console.log(fsCheck.trim().split("\n").map((l) => `    ${l}`).join("\n"));
  assert(/INDEX_OK/.test(fsCheck), "WSL engine persisted the parties index to the distro");
  assert(/PARTY_OK/.test(fsCheck), "…and a per-party file beside it (split layout)");
  assert(/\bext4\b/.test(fsCheck), "store is on the distro's native ext4 fs");

  const stateText = execFileSync("wsl.exe", ["-d", distro, "-e", "bash", "-lc", `cat "${wslWs}/.agent_party_app/parties"/*/party.json`], { encoding: "utf8" });
  assert(/"wr-1"/.test(stateText), "persisted party contains wr-1");
} finally {
  client.dispose();
}

console.log("");
if (failures.length) {
  console.log(`WSL REMOTE FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("WSL REMOTE PASSED (Windows drove a WSL-native engine over wsl.exe; store on ext4)");
process.exit(0);
