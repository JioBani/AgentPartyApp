/*
 * Product E2E for subscription disconnect.
 *
 * Launches the real Electron application against an isolated credential
 * directory and a tiny loopback model surface. The HTTP API drives the same
 * AppController method as the Authentication button.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-disconnect-e2e-"));
const workspace = path.join(temp, "workspace");
const userData = path.join(temp, "user-data");
const nativeCodexHome = path.join(temp, "native-codex-home");
const authDir = path.join(temp, "bridge-auth");
const configPath = path.join(temp, "config.yaml");
const codexCredential = path.join(authDir, "codex-account.json");
const claudeCredential = path.join(authDir, "claude-account.json");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(authDir, { recursive: true });
fs.mkdirSync(nativeCodexHome, { recursive: true });
const nativeCredential = JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "native-owner" } });
fs.writeFileSync(path.join(nativeCodexHome, "auth.json"), nativeCredential);
fs.writeFileSync(codexCredential, JSON.stringify({
  type: "codex",
  account_id: "disconnect-e2e",
  access_token: "qa-access",
  refresh_token: "qa-refresh",
  id_token: "qa-id",
  last_refresh: "2026-07-23T00:00:00.000Z",
}));
fs.writeFileSync(claudeCredential, JSON.stringify({ type: "claude", access_token: "qa-secret" }));
fs.writeFileSync(configPath, `auth-dir: "${authDir.replace(/\\/g, "/")}"\n`);

const proxy = http.createServer((req, res) => {
  if (req.url === "/v1/models") {
    const data = [];
    if (fs.existsSync(codexCredential)) data.push({ id: "gpt-5.4-mini" });
    if (fs.existsSync(claudeCredential)) data.push({ id: "claude-sonnet-4-6" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyPort = proxy.address().port;

const env = {
  ...process.env,
  AGENTPARTY_E2E: "1",
  AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
  AGENTPARTY_USER_DATA: userData,
  AGENTPARTY_NATIVE_CODEX_HOME: nativeCodexHome,
  AGENTPARTY_SUBSCRIPTION_PROXY_URL: `http://127.0.0.1:${proxyPort}/v1`,
  AGENTPARTY_SUBSCRIPTION_PROXY_CONFIG: configPath,
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env,
  windowsHide: true,
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  const baseUrl = await waitForApi();
  const initial = await getJson(`${baseUrl}/api/state`);
  const connectedBridge = initial.auth.find((item) => item.id === "codex-bridge");
  assert(connectedBridge?.status === "available", "real app sees the isolated Codex bridge account");
  assert(connectedBridge?.label === "Claude Code용 GPT 연결", "real Authentication screen names the bridge by its purpose");
  assert(
    connectedBridge?.detail === "Claude Code 하네스에서 GPT 모델을 사용할 때만 필요합니다. Codex 하네스의 로그인과는 별도입니다.",
    "real Authentication screen explains when the bridge is needed",
  );
  assert(initial.auth.find((item) => item.id === "codex"), "native Codex remains a separate Authentication card");

  await postJson(`${baseUrl}/api/navigation`, { view: "auth" });
  const capture = await postJson(`${baseUrl}/api/capture`, { path: path.join(temp, "auth-before-disconnect.png") });
  assert(capture.ok && capture.bytes > 0, "real Authentication screen with the connected account was rendered");

  const spec = await getJson(`${baseUrl}/api/spec`);
  assert(spec.endpoints.includes("DELETE /api/auth/subscriptions/:provider"), "disconnect endpoint is registered");

  const response = await fetch(`${baseUrl}/api/auth/subscriptions/codex`, { method: "DELETE" });
  assert(response.ok, `disconnect endpoint returned ${response.status}`);
  const result = await response.json();
  assert(result.ok && result.status === "disconnected", "AppController reports Codex disconnected");
  assert(result.removedCredentials === 1, "exactly one Codex credential was disconnected");
  const disconnectedBridge = result.auth.find((item) => item.id === "codex-bridge");
  assert(disconnectedBridge?.status === "missing", "UI auth state now offers a new Codex bridge connection");
  assert(disconnectedBridge?.detail === connectedBridge.detail, "disconnected bridge keeps the same purpose explanation");
  assert(disconnectedBridge?.action?.provider === "codex", "Codex bridge can immediately connect a different account");
  assert(!fs.existsSync(codexCredential), "Codex credential left the active bridge directory");
  assert(fs.readFileSync(path.join(nativeCodexHome, "auth.json"), "utf8") === nativeCredential, "bridge disconnect leaves the native Codex credential byte-identical");
  assert(fs.existsSync(claudeCredential), "unrelated Claude credential was untouched");
  const backups = findFiles(path.join(userData, "disconnected-subscription-auth", "codex"));
  assert(backups.length === 1, "disconnected credential is retained in recoverable app-data backup");

  await fetch(`${baseUrl}/api/window/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => undefined);
  await waitForExit(child);
  console.log("SUBSCRIPTION DISCONNECT E2E PASSED");
} finally {
  proxy.close();
  if (!child.killed) killProcessTree(child.pid);
  fs.rmSync(temp, { recursive: true, force: true });
}

async function waitForApi() {
  const instancesDir = path.join(workspace, ".agent_party_app", "instances");
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    for (const baseUrl of discoverBaseUrls(instancesDir)) {
      try {
        if ((await getJson(`${baseUrl}/api/health`))?.ok) return baseUrl;
      } catch {
        // App is still starting.
      }
    }
    await delay(300);
  }
  throw new Error("Automation API did not start.");
}

function discoverBaseUrls(instancesDir) {
  try {
    return fs.readdirSync(instancesDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(fs.readFileSync(path.join(instancesDir, file), "utf8")).baseUrl)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile());
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function waitForExit(process) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("App did not exit.")), 10_000);
    process.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // Process already exited.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}
