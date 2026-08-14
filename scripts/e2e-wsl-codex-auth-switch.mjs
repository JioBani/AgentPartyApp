/*
 * Real-app WSL E2E for Codex authentication ownership.
 *
 * A bridge OAuth credential and a native WSL Codex credential coexist. Loading
 * state and disconnecting the bridge must leave WSL auth.json byte-identical.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distro = process.env.AGENTPARTY_WSL_DISTRO || "Ubuntu-20.04";
const nonce = `${process.pid}-${Date.now()}`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-wsl-auth-owner-"));
const userData = path.join(temp, "user-data");
const authDir = path.join(temp, "bridge-auth");
const configPath = path.join(temp, "config.yaml");
const bridgeCredential = path.join(authDir, "codex-selected.json");
const wsRoot = `/tmp/agentparty-auth-owner-${nonce}`;
const wsWorkspace = `${wsRoot}/workspace`;
const wsCodexHome = `${wsRoot}/codex-home`;
const wsAuth = `${wsCodexHome}/auth.json`;
const workspaceUri = `wsl+${distro}:${wsWorkspace}`;
const nativeCredential = JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "wsl-native-owner", refresh_token: "native-only" } });

fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(authDir, { recursive: true });
fs.writeFileSync(bridgeCredential, JSON.stringify({
  type: "codex",
  account_id: "bridge-owner",
  access_token: "bridge-access",
  refresh_token: "bridge-refresh",
  id_token: "bridge-id",
  last_refresh: new Date().toISOString(),
}));
fs.writeFileSync(configPath, `auth-dir: "${authDir.replace(/\\/g, "/")}"\n`);
wsl(["bash", "-lc", `mkdir -p "${wsWorkspace}" "${wsCodexHome}"; printf %s '${nativeCredential}' > "${wsAuth}"`]);

const proxy = http.createServer((req, res) => {
  if (req.url === "/v1/models") {
    const data = fs.existsSync(bridgeCredential) ? [{ id: "gpt-5.4-mini" }] : [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyPort = proxy.address().port;

const port = 49000 + Math.floor(Math.random() * 1000);
let base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  AGENTPARTY_E2E: "1",
  AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
  AGENTPARTY_AUTOMATION_PORT: String(port),
  AGENTPARTY_USER_DATA: userData,
  AGENTPARTY_SUBSCRIPTION_PROXY_URL: `http://127.0.0.1:${proxyPort}/v1`,
  AGENTPARTY_SUBSCRIPTION_PROXY_CONFIG: configPath,
  AGENTPARTY_NATIVE_CODEX_HOME: wsCodexHome,
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspaceUri], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env,
  windowsHide: true,
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  await waitForApi();
  const initial = await get("/api/state");
  assert(initial.workspace?.kind === "wsl", "real app opened the isolated WSL workspace");
  assert(initial.auth.find((item) => item.id === "codex-bridge")?.status === "available", "bridge account is visible separately");
  assert(readNativeCredential() === nativeCredential, "state load did not copy the bridge token into WSL Codex");

  const disconnected = await del("/api/auth/subscriptions/codex");
  assert(disconnected.status === "disconnected", "bridge account disconnected through AppController HTTP API");
  assert(disconnected.auth.find((item) => item.id === "codex-bridge")?.status === "missing", "bridge card reflects disconnect");
  assert(readNativeCredential() === nativeCredential, "bridge disconnect left WSL auth.json byte-identical");

  await post("/api/window/close", {});
  await waitForExit(child);
  console.log("WSL CODEX AUTH OWNERSHIP E2E PASSED");
} finally {
  proxy.close();
  if (!child.killed) killProcessTree(child.pid);
  fs.rmSync(temp, { recursive: true, force: true });
  try { wsl(["bash", "-lc", `rm -rf "${wsRoot}"`]); } catch { /* best effort */ }
}

function readNativeCredential() {
  return wsl(["bash", "-lc", `cat "${wsAuth}"`]);
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    for (const candidate of [base, ...discoverBaseUrls()]) {
      try {
        const response = await fetch(candidate + "/api/health");
        if (response.ok && (await response.json()).ok) {
          base = candidate;
          return;
        }
      } catch { /* app/WSL engine is still starting */ }
    }
    await delay(500);
  }
  throw new Error("Automation API did not start.");
}

function discoverBaseUrls() {
  const discoveryDir = `\\\\wsl$\\${distro}\\${wsWorkspace.replace(/^\/+/, "").replace(/\//g, "\\")}\\.agent_party_app\\instances`;
  try {
    return fs.readdirSync(discoveryDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(discoveryDir, name), "utf8")).baseUrl)
      .filter((value) => typeof value === "string");
  } catch { return []; }
}

async function request(method, url, body) {
  const response = await fetch(base + url, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}
function get(url) { return request("GET", url); }
function post(url, body) { return request("POST", url, body); }
function del(url) { return request("DELETE", url); }
function wsl(args) { return execFileSync("wsl.exe", ["-d", distro, "-e", ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }); }
function waitForExit(process) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("App did not exit.")), 15_000);
    process.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}
function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* exited */ }
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}
