/*
 * Full-process e2e for per-workspace discovery (Stage 2). Launches TWO real app
 * processes that SHARE one userData (the exact condition that used to clobber the
 * global <userData>/automation.json) but open DIFFERENT cwds, and proves they are
 * independently discoverable with zero interference:
 *   - each workspace's `.agent_party_app/instances/<pid>.json` points at ITS
 *     process's automation API (different ports),
 *   - no machine-global automation.json is written,
 *   - driving one process's API never reflects the other's parties.
 * Offline (no model). Requires Stage 3? No — uses AGENTPARTY_ALLOW_MULTI_INSTANCE
 * to run two processes while the single-instance lock still exists.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = "C:\\Project\\AgentPartyApp";
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "ap-disco-ud-"));
const wsA = fs.mkdtempSync(path.join(os.tmpdir(), "ap-disco-A-"));
const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "ap-disco-B-"));
const portA = 48943, portB = 48944;
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(ws, port) {
  return spawn(process.env.ComSpec || "cmd.exe", ["/c", "node", "scripts/launch-electron.mjs", `--workspace=${ws}`], {
    cwd: root, stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
    env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_ALLOW_MULTI_INSTANCE: "1", AGENTPARTY_AUTOMATION_PORT: String(port), AGENTPARTY_USER_DATA: ud, AGENTPARTY_WINDOW_DISPLAY: "left" },
  });
}
async function health(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
async function waitHealthy(port) { for (let i = 0; i < 60; i++) { if (await health(port)) return true; await delay(500); } return false; }
async function post(port, u, b) { const r = await fetch(`http://127.0.0.1:${port}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return r.json(); }
async function get(port, u) { const r = await fetch(`http://127.0.0.1:${port}${u}`); return r.json(); }
function kill(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }

const a = launch(wsA, portA);
const b = launch(wsB, portB);
try {
  assert(await waitHealthy(portA), "process A (cwd wsA) is up");
  assert(await waitHealthy(portB), "process B (cwd wsB) is up");

  // Each workspace discovers ITS OWN process — no clobber despite shared userData.
  assert(firstBaseUrl(wsA) === `http://127.0.0.1:${portA}`, `wsA discovery → A (${firstBaseUrl(wsA)})`);
  assert(firstBaseUrl(wsB) === `http://127.0.0.1:${portB}`, `wsB discovery → B (${firstBaseUrl(wsB)})`);

  // No machine-global automation.json anywhere in the shared userData.
  assert(!fs.existsSync(path.join(ud, "automation.json")), "no global <userData>/automation.json written");

  // The two processes are independent: a party created in A is not visible in B.
  await post(portA, "/api/qa/reset").catch(() => {});
  await post(portB, "/api/qa/reset").catch(() => {});
  await post(portA, "/api/qa/seed", { party: "only-in-A", members: [{ name: "m", role: "r" }] });
  const bParties = (await get(portB, "/api/party")).parties.map((p) => p.name);
  assert(!bParties.includes("only-in-A"), "party created in A is NOT visible in B (isolated processes)");

  await post(portA, "/api/window/close").catch(() => {});
  await post(portB, "/api/window/close").catch(() => {});
  await delay(1500);
  // Discovery files removed on quit.
  assert(firstBaseUrl(wsA) === "", "A's discovery removed after quit");
  assert(firstBaseUrl(wsB) === "", "B's discovery removed after quit");
} catch (error) {
  console.error(error);
  failures.push(String(error?.message || error));
} finally {
  kill(a.pid); kill(b.pid);
  for (const p of [ud, wsA, wsB]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
}

console.log("");
if (failures.length) { console.log(`DISCOVERY E2E FAILED: ${failures.length}`); process.exit(1); }
console.log("DISCOVERY E2E PASSED (two processes, shared userData, different cwds — independent + no clobber)");
process.exit(0);
