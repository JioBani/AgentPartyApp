/*
 * Windows-side launcher for the `agent-party` CLI (docs/WSL_REMOTE.md §13).
 *
 * Invoked by the WSL shim over interop (node.exe) with a WorkspaceLocation URI
 * (e.g. wsl+Ubuntu-22.04:/home/dev/proj). If AgentParty is running, asks it to
 * open a window on that workspace; if not, launches the app on that workspace
 * (like `code .`). Runs on the Windows side so it can reach 127.0.0.1, which a
 * WSL process cannot under default NAT networking.
 *
 * Usage: node.exe agent-party-launcher.mjs <workspace-uri>
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const uri = process.argv[2];
if (!uri) {
  console.error("usage: agent-party-launcher <workspace-uri>");
  process.exit(2);
}

function userDataDir() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  return path.join(appData, "AgentParty");
}

function discoverBaseUrl() {
  try {
    const info = JSON.parse(readFileSync(path.join(userDataDir(), "automation.json"), "utf8"));
    return typeof info.baseUrl === "string" ? info.baseUrl : "";
  } catch {
    return "";
  }
}

async function reachable(baseUrl) {
  if (!baseUrl) return false;
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function openInRunningApp(baseUrl) {
  const res = await fetch(`${baseUrl}/api/windows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspacePath: uri }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const win = await res.json();
  console.log(`AgentParty opened ${uri} (window ${win.id}).`);
}

function launchApp() {
  // The app exe sits two levels up from resources/bin in a packaged install.
  const exe = path.resolve(here, "..", "..", "AgentParty.exe");
  if (!existsSync(exe)) {
    throw new Error(`AgentParty is not running and its executable was not found at ${exe}. Start the app, then retry.`);
  }
  // Strip ELECTRON_RUN_AS_NODE so the exe boots as the app, not as plain node.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(exe, ["--workspace", uri], { detached: true, stdio: "ignore", env }).unref();
  console.log(`Launching AgentParty for ${uri}…`);
}

try {
  const baseUrl = discoverBaseUrl();
  if (await reachable(baseUrl)) {
    await openInRunningApp(baseUrl);
  } else {
    launchApp();
  }
} catch (error) {
  console.error(`agent-party: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
