/*
 * Real-app WSL E2E for unified Codex authentication.
 *
 * Uses an isolated distro workspace/CODEX_HOME and the deterministic fake Codex
 * app-server. It proves the desktop-selected bridge account is written inside
 * WSL, then a live member resumes the same thread under account B after an
 * A→disconnect→B switch, without closing/reopening its tab.
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-wsl-auth-switch-"));
const userData = path.join(temp, "user-data");
const authDir = path.join(temp, "bridge-auth");
const configPath = path.join(temp, "config.yaml");
const bridgeCredential = path.join(authDir, "codex-selected.json");
const wsRoot = `/tmp/agentparty-auth-switch-${nonce}`;
const wsWorkspace = `${wsRoot}/workspace`;
const wsCodexHome = `${wsRoot}/codex-home`;
const wsLifecycle = `${wsRoot}/lifecycle.jsonl`;
const wsFake = `${wsRoot}/fake-codex-appserver.mjs`;
const workspaceUri = `wsl+${distro}:${wsWorkspace}`;
const defaultCodexAuthDigest = readDefaultNativeDigest();
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(authDir, { recursive: true });
writeBridgeCredential("account-a");
fs.writeFileSync(configPath, `auth-dir: "${authDir.replace(/\\/g, "/")}"\n`);

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

const fakeWin = path.join(root, "scripts", "fake-codex-appserver.mjs");
const fakeWsl = wslpath(fakeWin);
wsl(["bash", "-lc", `mkdir -p "${wsWorkspace}" "${wsCodexHome}"; cp "${fakeWsl}" "${wsFake}"`]);

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
  AGENTPARTY_CODEX_BIN: "node",
  AGENTPARTY_CODEX_ARGS: JSON.stringify([wsFake]),
  AGENTPARTY_FAKE_CODEX_AUTH_OUT: wsLifecycle,
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
  await waitForNativeAccount("account-a");
  assert(readNativeAccount() === "account-a", "desktop bridge account A synchronized into WSL Codex home");
  assert(readDefaultNativeDigest() === defaultCodexAuthDigest, "isolated E2E left the user's default WSL Codex authentication untouched");

  await post("/api/parties", { name: "WSL auth switch E2E" });
  await post("/api/party/members", {
    name: "auth-switch",
    requirement: "Authentication lifecycle E2E",
    runtime: "codex",
    model: "gpt-5.4-mini",
  });
  await post("/api/party/members/auth-switch/start", {
    codexPolicy: { sandbox: "read-only", approval: "on-request", guardian: false },
  });
  await waitForLifecycle((events) => events.some((event) =>
    event.event === "thread/start" && event.accountId === "account-a"));
  assert(true, "live WSL Codex member started under account A");

  const disconnected = await del("/api/auth/subscriptions/codex");
  assert(disconnected.runtimeAuthentication?.some((item) => item.changed), "disconnect propagated to the WSL engine");
  await waitForNativeAccount("");

  writeBridgeCredential("account-b");
  await get("/api/state");
  await waitForNativeAccount("account-b");
  const lifecycle = await waitForLifecycle((events) => events.some((event) =>
    event.event === "thread/resume"
    && event.threadId === "thr-fake"
    && event.accountId === "account-b"));
  assert(lifecycle.some((event) => event.event === "thread/resume" && event.accountId === "account-b"), "live member resumed the same thread under account B without tab close/open");

  const transcript = await waitForAuthNotice();
  assert(JSON.stringify(transcript).includes("Codex 인증이 변경되었습니다"), "session received the one-time authentication-change notice");

  await post("/api/window/close", {});
  await waitForExit(child);
  console.log("WSL CODEX AUTH SWITCH E2E PASSED");
} finally {
  proxy.close();
  if (!child.killed) killProcessTree(child.pid);
  fs.rmSync(temp, { recursive: true, force: true });
  try { wsl(["bash", "-lc", `rm -rf "${wsRoot}"`]); } catch { /* best effort */ }
}

function writeBridgeCredential(accountId) {
  fs.writeFileSync(bridgeCredential, JSON.stringify({
    type: "codex",
    account_id: accountId,
    access_token: `access-${accountId}`,
    refresh_token: `refresh-${accountId}`,
    id_token: `id-${accountId}`,
    last_refresh: new Date().toISOString(),
    disabled: false,
  }));
}

function readNativeAccount() {
  try {
    return JSON.parse(wsl(["bash", "-lc", `cat "${wsCodexHome}/auth.json"`])).tokens?.account_id || "";
  } catch {
    return "";
  }
}

function readDefaultNativeDigest() {
  try {
    return wsl(["bash", "-lc", 'sha256sum "$HOME/.codex/auth.json" 2>/dev/null | cut -d" " -f1']).trim();
  } catch {
    return "";
  }
}

async function waitForNativeAccount(expected) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (readNativeAccount() === expected) return;
    await delay(300);
  }
  throw new Error(`WSL native account did not become '${expected}' (actual '${readNativeAccount()}').`);
}

function readLifecycle() {
  try {
    return wsl(["bash", "-lc", `cat "${wsLifecycle}" 2>/dev/null || true`])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitForLifecycle(predicate) {
  const started = Date.now();
  let events = [];
  while (Date.now() - started < 60_000) {
    events = readLifecycle();
    if (predicate(events)) return events;
    await delay(300);
  }
  throw new Error(`Expected Codex lifecycle event was not observed: ${JSON.stringify(events)}`);
}

async function waitForAuthNotice() {
  const started = Date.now();
  let transcript;
  while (Date.now() - started < 30_000) {
    transcript = await get("/api/party/members/auth-switch/transcript").catch(() => ({}));
    if (JSON.stringify(transcript).includes("Codex 인증이 변경되었습니다")) return transcript;
    await delay(500);
  }
  throw new Error(`Authentication notice was not persisted: ${JSON.stringify(transcript)}`);
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
      } catch {
        // App/WSL engine or discovery advertisement is still starting.
      }
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
  } catch {
    return [];
  }
}

async function request(method, url, body) {
  const response = await fetch(base + url, {
    method,
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  if (!response.ok) throw new Error(`${method} ${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

function get(url) {
  return request("GET", url);
}

function post(url, body) {
  return request("POST", url, body);
}

function del(url) {
  return request("DELETE", url);
}

function wsl(args) {
  return execFileSync("wsl.exe", ["-d", distro, "-e", ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function wslpath(winPath) {
  return wsl(["wslpath", "-a", winPath]).trim();
}

function waitForExit(process) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("App did not exit.")), 15_000);
    process.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* exited */ }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}
