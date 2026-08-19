/* Real packaged-executable smoke test. Pass the portable exe as argv[2]. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const executable = path.resolve(process.argv[2] || path.join(root, "release", `AgentParty ${expectedVersion}.exe`));
if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);

const qaRoot = path.join(os.tmpdir(), "agentparty-packaged-release-qa");
const workspace = path.join(qaRoot, "workspace");
const userData = path.join(qaRoot, "user-data");
const capturePath = path.join(qaRoot, "environment.png");
const port = Number(process.env.AGENTPARTY_PACKAGED_QA_PORT || 48988);
const base = `http://127.0.0.1:${port}`;
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const child = spawn(executable, ["--workspace", workspace], {
  cwd: root,
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    AGENTPARTY_QA: "1",
    AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
    AGENTPARTY_AUTOMATION_PORT: String(port),
    AGENTPARTY_USER_DATA: userData,
    AGENTPARTY_WINDOW_DISPLAY: "left",
  },
});

try {
  await waitForApi();
  const state = await get("/api/state");
  const update = await get("/api/update");
  const native = await get("/api/auth/native/claude?refresh=1");
  const environment = await get("/api/environment?refresh=1");
  assert(update.update?.currentVersion === expectedVersion, `packaged app reports version ${update.update?.currentVersion}`);
  assert(state.settings.workspacePath === workspace, "packaged app serves the isolated QA workspace");
  assert(native.host?.label === "Windows", "native Claude auth identifies the Windows execution host");
  assert(environment.checks?.every((check) => check.host?.kind === "windows"), "packaged diagnostics identify every local check as Windows");
  assert(environment.checks?.every((check) => check.host?.workspace === workspace), "packaged diagnostics preserve the exact workspace cwd");
  await post("/api/navigation", { view: "runtime", tab: "environment" });
  await delay(2_000);
  const capture = await post("/api/capture", { path: capturePath });
  assert(capture.ok && fs.existsSync(capturePath), "packaged Environment screen captured");
  console.log(`PACKAGED RELEASE E2E PASSED -> ${capturePath}`);
} finally {
  await post("/api/window/close", {}).catch(() => kill());
}

async function waitForApi() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await get("/api/health")).ok) return; } catch {}
    await delay(500);
  }
  throw new Error("Packaged app automation API did not start.");
}

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} returned ${response.status}`);
  return response.json();
}

async function post(route, body) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

function kill() {
  if (!child.pid) return;
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
