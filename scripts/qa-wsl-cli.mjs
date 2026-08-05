/*
 * agent-party CLI E2E (Stage 5d, the WSL remote-engine design §13). Requires the desktop
 * app to be running. Runs the WSL shim from a directory inside the distro — as a
 * user would type `agent-party` — and verifies the app opened a window on that
 * cwd. Skips (not fails) where wsl.exe is absent.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distro = process.env.QA_WSL_DISTRO || "Ubuntu-22.04";
const wslWs = process.env.QA_WSL_WS || "/home/dev/agentparty-wsl-e2e";
// Discover the app serving this WSL workspace (per-workspace discovery).
const BASE = process.env.QA_BASE || firstBaseUrl(`wsl+${distro}:${wslWs}`);

let hasWsl = true;
try { execFileSync("wsl.exe", ["-e", "true"], { stdio: "ignore" }); } catch { hasWsl = false; }
if (!hasWsl) { console.log("WSL not available — skipping agent-party CLI E2E."); process.exit(0); }

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

console.log("agent-party CLI E2E:");

const health = await api("GET", "/api/health").catch(() => null);
assert(Boolean(health?.ok), "desktop app is running");

// Ensure the target dir exists in the distro.
execFileSync("wsl.exe", ["-d", distro, "-e", "bash", "-lc", `mkdir -p "${wslWs}"`], { encoding: "utf8" });

// The shim lives in the repo (on C:); resolve its path inside the distro.
const shimWin = path.join(projectRoot, "scripts", "agent-party");
const shimWsl = execFileSync("wsl.exe", ["-d", distro, "-e", "wslpath", "-a", shimWin], { encoding: "utf8" }).trim();

// Type `agent-party` from the target dir.
const out = execFileSync("wsl.exe", ["-d", distro, "-e", "bash", "-lc", `cd "${wslWs}" && sh "${shimWsl}"`], { encoding: "utf8" });
console.log(`    shim → ${out.trim()}`);
assert(/AgentParty opened/.test(out), "shim built the wsl URI and the Windows launcher opened it");

// The app now has a window on the WSL workspace.
const expected = `wsl+${distro}:${wslWs}`;
const wins = (await api("GET", "/api/windows")).windows;
assert(wins.some((w) => w.workspacePath === expected), `a window is open on ${expected}`);

console.log("");
if (failures.length) {
  console.log(`AGENT-PARTY CLI FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("AGENT-PARTY CLI PASSED (typed in WSL → app opened that cwd as the workspace)");
