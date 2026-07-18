/*
 * Reachability test for the in-engine automation API that Codex party tools use.
 *
 * A WSL Codex member's party MCP server (agentparty-codex-mcp-server.mjs) runs
 * INSIDE the distro and fetches AGENTPARTY_AUTOMATION_BASE_URL for every tool.
 * Before the fix, the headless engine server ran no automation API and baked
 * `127.0.0.1:0`, so every send/list failed with "-32603: fetch failed".
 *
 * This spawns the SAME engine-server binary that runs in the distro (as a local
 * node process — the distro adds only the `wsl.exe` wrapper) and replays exactly
 * what the MCP server does: read the automation base URL from the ready
 * handshake, then fetch the `send` and `list` party endpoints. It proves the
 * endpoint now exists, binds a real port, and answers — the reachability that
 * was broken. It does NOT exercise the real Codex CLI (needs a live distro +
 * account); that transport is identical to local Codex, which already works.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverBundle = path.join(projectRoot, "dist/engine-server.mjs");

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

if (!existsSync(serverBundle)) {
  console.error("dist/engine-server.mjs missing — run `npm run build` (or `node scripts/build-engine-server.mjs`) first.");
  process.exit(1);
}

const workspace = path.join(os.tmpdir(), "agentparty-wsl-codex-bridge-ws");
const storage = path.join(os.tmpdir(), "agentparty-wsl-codex-bridge-st");
mkdirSync(workspace, { recursive: true });
rmSync(path.join(workspace, ".agent_party_app"), { recursive: true, force: true });

console.log("\nWSL Codex party-tool bridge (in-engine automation API reachability):");

// stdout is the RPC channel we don't use here; ignore it so teardown has fewer
// live handles to tear down (a piped stdout races libuv's close on Windows kill).
const child = spawn(process.execPath, [serverBundle, "--workspace", workspace, "--storage", storage], { stdio: ["ignore", "ignore", "pipe"] });

/** Resolve the automation base URL from the readiness handshake on stderr. */
function waitForBaseUrl() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("engine did not signal ready within 20s")), 20000);
    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = /ENGINE_SERVER_READY\s+(\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`engine exited before ready (code ${code})`)); });
  });
}

async function main() {
  const baseUrl = await waitForBaseUrl();
  assert(Boolean(baseUrl) && !baseUrl.endsWith(":0"), `engine baked a real automation URL, not :0 (${baseUrl})`);

  // `list` tool → GET /api/harness/party. This was one of the failing calls.
  const listRes = await fetch(baseUrl + "/api/harness/party", { headers: { "x-agentparty-member": "tester" } });
  assert(listRes.ok, `GET /api/harness/party reachable (status ${listRes.status})`);
  const listData = await listRes.json().catch(() => undefined);
  assert(listData !== undefined, "list returns JSON (party surface answered, not a dead socket)");

  // `list-models` tool → GET /api/models.
  const modelsRes = await fetch(baseUrl + "/api/models");
  const models = await modelsRes.json().catch(() => undefined);
  assert(modelsRes.ok && models !== undefined, "GET /api/models reachable and returns JSON");

  // `send` tool → POST /api/harness/party/messages. THE call that surfaced
  // "-32603: fetch failed". The original bug was a NETWORK-level failure (the URL
  // was unreachable), so the fix is proven by the fetch RESOLVING with any HTTP
  // response — reaching the party surface — rather than throwing. (The 200
  // delivered-path, which needs a seeded party, is covered by the desktop
  // e2e-smoke; seeding a party here would init-start a real harness.)
  let sendReached = false;
  let sendStatus = 0;
  try {
    const sendRes = await fetch(baseUrl + "/api/harness/party/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-agentparty-member": "tester" },
      body: JSON.stringify({ to: "nobody", from: "tester", content: "ping" }),
    });
    sendReached = true;
    sendStatus = sendRes.status;
    await sendRes.text();
  } catch {
    sendReached = false;
  }
  assert(sendReached, `'send' endpoint reachable — no network-level "fetch failed" (HTTP ${sendStatus || "—"}; 200 delivery covered by e2e-smoke)`);
}

main()
  .catch((error) => { assert(false, `bridge check threw: ${error instanceof Error ? error.message : String(error)}`); })
  .finally(() => {
    try { child.stderr?.destroy(); child.kill(); } catch { /* already gone */ }
    console.log(failures.length ? `\nFAILED (${failures.length})` : "\nWSL CODEX BRIDGE PASSED");
    // Give the killed child's handles a tick to close before exit so libuv does
    // not assert on Windows (UV_HANDLE_CLOSING).
    setTimeout(() => process.exit(failures.length ? 1 : 0), 200);
  });
