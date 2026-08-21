/* Proves a real packaged app can serve its party MCP without external Node.js. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const exe = path.join(root, "release", "win-unpacked", "AgentParty.exe");
const relay = path.join(root, "release", "win-unpacked", "resources", "bin", "agentparty-codex-mcp-server.mjs");
if (!fs.existsSync(exe) || !fs.existsSync(relay)) {
  throw new Error("Run npm run package:win before this packaged-runtime check.");
}

const qaRoot = path.join(os.tmpdir(), "agentparty-packaged-mcp-runtime-qa");
const workspace = path.join(qaRoot, "workspace");
const userData = path.join(qaRoot, "user-data");
const port = Number(process.env.AGENTPARTY_PACKAGED_MCP_QA_PORT || 48987);
const baseUrl = `http://127.0.0.1:${port}`;
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const app = spawn(exe, ["--workspace", workspace], {
  cwd: root,
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    AGENTPARTY_QA: "1",
    AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
    AGENTPARTY_AUTOMATION_PORT: String(port),
    AGENTPARTY_USER_DATA: userData,
  },
});

try {
  await waitForApi();
  const child = spawn(exe, [relay], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "",
      AGENTPARTY_AUTOMATION_BASE_URL: baseUrl,
      AGENTPARTY_MEMBER: "packaged-runtime-qa",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "packaged-runtime-qa", version: "1" } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);

  const deadline = Date.now() + 5_000;
  while (!stdout.split(/\r?\n/).some((line) => line.includes('"id":2')) && Date.now() < deadline) {
    await delay(50);
  }
  child.kill();
  const messages = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const initialized = messages.find((message) => message.id === 1);
  const listed = messages.find((message) => message.id === 2);
  if (!initialized?.result?.serverInfo || listed?.result?.tools?.length !== 17) {
    throw new Error(`Packaged MCP did not expose the canonical 17 tools via the live app. stderr=${stderr || "<empty>"}`);
  }
  console.log(`PACKAGED MCP RUNTIME PASSED (${listed.result.tools.length} live tools, external PATH empty)`);
} finally {
  await fetch(`${baseUrl}/api/window/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).catch(() => killApp());
}

async function waitForApi() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok && (await response.json()).ok) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Packaged app automation API did not start.");
}

function killApp() {
  if (!app.pid) return;
  try { execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
