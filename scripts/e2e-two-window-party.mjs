/*
 * Full-process e2e: TWO windows of ONE process (the `agent-party`-run-twice case)
 * have INDEPENDENT active parties. Reproduces the user's report — running
 * `agent-party` twice on the same cwd opens a second WINDOW in the first process
 * (the launcher delegates via POST /api/windows), and both windows used to share
 * one active party so switching in one switched the other.
 *
 * Proves: one process, two windows; selecting a party in window A does NOT move
 * window B, and each window's GET /api/party (addressed by ?window=<id>) reports
 * its own current party. Offline (no model).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBaseUrls } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "ap-2win-ud-"));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ap-2win-ws-"));
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(workspace) {
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), `--workspace=${workspace}`], {
    cwd: root, stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
    env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_USER_DATA: ud, AGENTPARTY_WINDOW_DISPLAY: "left" },
  });
  child.on("error", (e) => console.error("launch error:", e.message));
  return child;
}
async function reachable(baseUrl) { try { const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } }
async function liveUrls(workspace) { const urls = discoverBaseUrls(workspace); const live = []; for (const u of urls) if (await reachable(u)) live.push(u); return live; }
async function waitCount(workspace, n) { for (let i = 0; i < 80; i++) { if ((await liveUrls(workspace)).length >= n) return true; await delay(500); } return false; }
function kill(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
async function post(baseUrl, u, b) { const r = await fetch(`${baseUrl}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return r.json(); }
async function get(baseUrl, u) { const r = await fetch(`${baseUrl}${u}`); return r.json(); }

const proc = launch(ws);
try {
  assert(await waitCount(ws, 1), "the app process came up on the workspace");
  const [base] = await liveUrls(ws);

  // Second `agent-party` on the same cwd = a second WINDOW in THIS process.
  const initial = (await get(base, "/api/windows")).windows || [];
  const win1 = initial[0]?.id;
  const opened = await post(base, "/api/windows", { workspacePath: ws });
  const win2 = opened?.id;
  const after = (await get(base, "/api/windows")).windows || [];
  assert(Boolean(win1 && win2 && win1 !== win2), `two distinct windows exist (#1=${win1}, #2=${win2})`);
  assert(after.length === 2, `the process now hosts TWO windows (${after.length})`);
  assert((await liveUrls(ws)).length === 1, "still ONE process serves the workspace (not two)");

  // Two parties (shared on disk); createParty response's currentPartyId is the new id.
  const idA = (await post(base, "/api/parties", { name: "WIN-A" }))?.currentPartyId;
  const idB = (await post(base, "/api/parties", { name: "WIN-B" }))?.currentPartyId;
  assert(Boolean(idA && idB && idA !== idB), "created two distinct parties");

  // The user's exact scenario: BOTH windows just VIEW party A (a GET is what a
  // renderer does on load) — window #1 never explicitly selects. Then window #2
  // selects B. Window #1 must NOT follow (regression: an unselected window used to
  // track the shared last-active hint that #2's select moved).
  await post(base, `/api/parties/${idA}/select?window=${win1}`, {}); // both start on A
  const seed1 = (await get(base, `/api/party?window=${win1}`)).currentPartyId;
  const seed2 = (await get(base, `/api/party?window=${win2}`)).currentPartyId; // #2 only VIEWS A (pins it)
  assert(seed1 === idA && seed2 === idA, `both windows start on A (#1=${seed1}, #2=${seed2})`);

  // Window #2 selects B — window #1 (which never re-selected) must stay on A.
  await post(base, `/api/parties/${idB}/select?window=${win2}`, {});
  const cur1 = (await get(base, `/api/party?window=${win1}`)).currentPartyId;
  const cur2 = (await get(base, `/api/party?window=${win2}`)).currentPartyId;
  assert(cur1 === idA, `window #1 STAYED on A after window #2 selected B (got ${cur1})`);
  assert(cur2 === idB, `window #2 moved to its OWN party B (got ${cur2})`);
  // And #1's view still carries A's full members (not another party's) — the
  // asymmetry the user saw ("only main in the other window") was this bug.
  const members1 = (await get(base, `/api/party?window=${win1}`)).members || [];
  assert(members1.every((m) => m.partyId === idA), "window #1's members all belong to party A (no cross-party leak)");

  // Window #1 now selects B too — window #2 must stay on B (no reverse drag).
  await post(base, `/api/parties/${idB}/select?window=${win1}`, {});
  const cur2again = (await get(base, `/api/party?window=${win2}`)).currentPartyId;
  assert(cur2again === idB, `window #2 stayed on B while window #1 moved to B (got ${cur2again})`);
} catch (error) {
  console.error(error);
  failures.push(String(error?.message || error));
} finally {
  kill(proc.pid);
  await delay(500);
  for (const p of [ud, ws]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
}

console.log("");
if (failures.length) { console.log(`TWO-WINDOW PARTY E2E FAILED: ${failures.length}`); process.exit(1); }
console.log("TWO-WINDOW PARTY E2E PASSED (one process, two windows, independent active parties)");
process.exit(0);
