/*
 * Windows-side launcher for the `agent-party` CLI (docs/WSL_REMOTE.md §13).
 *
 * Invoked by the WSL shim over interop (node.exe) with a WorkspaceLocation URI
 * (e.g. wsl+Ubuntu-22.04:/home/dev/proj). Discovers the running app's automation
 * URL from <userData>/automation.json and asks it to open a window on that
 * workspace — running on the Windows side, so it can reach 127.0.0.1 (which a
 * WSL process cannot, under default NAT networking).
 *
 * Usage: node.exe agent-party-launcher.mjs <workspace-uri>
 */
import { readFileSync } from "node:fs";
import path from "node:path";

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
    const file = path.join(userDataDir(), "automation.json");
    const info = JSON.parse(readFileSync(file, "utf8"));
    return typeof info.baseUrl === "string" ? info.baseUrl : "";
  } catch {
    return "";
  }
}

const baseUrl = discoverBaseUrl();
if (!baseUrl) {
  console.error("AgentParty does not appear to be running (no automation.json). Start the app, then retry.");
  process.exit(1);
}

try {
  const res = await fetch(`${baseUrl}/api/windows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspacePath: uri }),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  const win = await res.json();
  console.log(`AgentParty opened ${uri} (window ${win.id}).`);
} catch (error) {
  console.error(`Failed to reach AgentParty at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
