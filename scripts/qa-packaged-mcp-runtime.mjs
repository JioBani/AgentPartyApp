/* Proves a packaged install can start its party MCP without external Node.js. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const exe = path.join(root, "release", "win-unpacked", "AgentParty.exe");
const relay = path.join(root, "release", "win-unpacked", "resources", "bin", "agentparty-codex-mcp-server.mjs");
if (!fs.existsSync(exe) || !fs.existsSync(relay)) {
  throw new Error("Run npm run package:win before this packaged-runtime check.");
}

const child = spawn(exe, [relay], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PATH: "" },
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
  await new Promise((resolve) => setTimeout(resolve, 50));
}
child.kill();
const messages = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const initialized = messages.find((message) => message.id === 1);
const listed = messages.find((message) => message.id === 2);
if (!initialized?.result?.serverInfo || !Array.isArray(listed?.result?.tools) || listed.result.tools.length === 0) {
  throw new Error(`Packaged MCP did not initialize via AgentParty.exe. stderr=${stderr || "<empty>"}`);
}
console.log(`PACKAGED MCP RUNTIME PASSED (${listed.result.tools.length} tools, external PATH empty)`);
