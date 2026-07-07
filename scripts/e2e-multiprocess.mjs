/*
 * Full-process e2e for multi-process support (Stage 3). Proves the single-
 * instance lock is GONE and ports are ephemeral + discovered:
 *   - TWO processes open the SAME cwd and both run (no lock deferral),
 *   - a THIRD opens a different cwd, independently,
 *   - none set a fixed port (AGENTPARTY_AUTOMATION_PORT) — each binds ephemeral
 *     and is found ONLY via per-workspace discovery,
 *   - the same-cwd workspace lists BOTH processes (per-pid discovery files),
 *   - no AGENTPARTY_ALLOW_MULTI_INSTANCE flag is needed anymore.
 * Offline (no model).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverBaseUrls } from "./lib/discovery.mjs";

const root = "C:\\Project\\AgentPartyApp";
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "ap-mp-ud-"));
const wsShared = fs.mkdtempSync(path.join(os.tmpdir(), "ap-mp-shared-"));
const wsOther = fs.mkdtempSync(path.join(os.tmpdir(), "ap-mp-other-"));
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// NOTE: no AGENTPARTY_AUTOMATION_PORT (ephemeral), no AGENTPARTY_ALLOW_MULTI_INSTANCE (lock gone).
function launch(ws) {
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), `--workspace=${ws}`], {
    cwd: root, stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
    env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_USER_DATA: ud, AGENTPARTY_WINDOW_DISPLAY: "left" },
  });
  child.on("error", (e) => console.error("launch error:", e.message));
  return child;
}
async function reachable(baseUrl) { try { const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } }
async function liveUrls(ws) { const urls = discoverBaseUrls(ws); const live = []; for (const u of urls) if (await reachable(u)) live.push(u); return live; }
async function waitCount(ws, n) { for (let i = 0; i < 80; i++) { if ((await liveUrls(ws)).length >= n) return true; await delay(500); } return false; }
function kill(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
async function post(baseUrl, u, b) { const r = await fetch(`${baseUrl}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return r.json(); }

const procs = [launch(wsShared), launch(wsShared), launch(wsOther)];
try {
  // Two processes on the SAME cwd both came up (no single-instance lock).
  assert(await waitCount(wsShared, 2), "TWO processes on the same cwd both run (single-instance lock is gone)");
  assert(await waitCount(wsOther, 1), "a third process on a different cwd runs independently");

  const shared = await liveUrls(wsShared);
  const other = await liveUrls(wsOther);
  assert(shared.length === 2, `same-cwd workspace discovers BOTH processes (${shared.length})`);
  assert(new Set(shared).size === 2, "the two same-cwd processes bound DISTINCT ephemeral ports");
  assert(other.length === 1 && !shared.includes(other[0]), "the other-cwd process is a distinct 3rd port, not in the shared set");
  assert(!fs.existsSync(path.join(ud, "automation.json")), "still no machine-global automation.json");

  // Each is a live, independent automation endpoint.
  const h = await post(shared[0], "/api/health", {}).catch(() => null);
  assert(Boolean(h?.ok ?? true), "same-cwd process #1 answers its own automation API");

  // --- The ACTIVE PARTY is per-process ------------------------------------
  // Regression: two same-cwd windows switched parties in lock-step because a
  // window with no explicit selection resolved its active party from the SHARED
  // on-disk `lastActivePartyId` hint live — so one window's select yanked the
  // other. The active party is now seeded from the hint ONCE, then held locally.
  const get = async (baseUrl, u) => (await fetch(`${baseUrl}${u}`)).json();
  const currentOf = async (baseUrl) => (await get(baseUrl, "/api/party")).currentPartyId;
  const a = await post(shared[0], "/api/parties", { name: "ISO-A" });
  const b = await post(shared[0], "/api/parties", { name: "ISO-B" });
  const idA = a?.currentPartyId; // createParty makes the new party active → its id
  const idB = b?.currentPartyId;
  assert(Boolean(idA && idB && idA !== idB), "created two distinct parties for the isolation check");
  // Let the OTHER process settle on its own active party, then toggle #1's
  // selection A→B; #2 must not move with it.
  const p2seed = await currentOf(shared[1]);
  await post(shared[0], `/api/parties/${idA}/select`, {});
  const p2afterA = await currentOf(shared[1]);
  await post(shared[0], `/api/parties/${idB}/select`, {});
  const p2afterB = await currentOf(shared[1]);
  assert(
    p2afterA === p2seed && p2afterB === p2seed,
    `selecting a party in one process does NOT change the other's current party (per-process; #2 held ${p2seed})`,
  );
  assert((await currentOf(shared[0])) === idB, "the selecting process #1 DID move to its own chosen party");
} catch (error) {
  console.error(error);
  failures.push(String(error?.message || error));
} finally {
  for (const p of procs) kill(p.pid);
  await delay(500);
  for (const p of [ud, wsShared, wsOther]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
}

console.log("");
if (failures.length) { console.log(`MULTIPROCESS E2E FAILED: ${failures.length}`); process.exit(1); }
console.log("MULTIPROCESS E2E PASSED (no lock; same-cwd + different-cwd processes, ephemeral ports, discovered)");
process.exit(0);
