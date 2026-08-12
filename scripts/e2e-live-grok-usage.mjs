/* Real-app E2E: official Grok Build ACP billing → /api/usage → titlebar UI. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = `${process.pid}-${Date.now()}`;
const workspace = path.join(os.tmpdir(), `agentparty-grok-usage-${runId}-workspace`);
const userData = path.join(os.tmpdir(), `agentparty-grok-usage-${runId}-user-data`);
const screenshot = path.join(os.tmpdir(), `agentparty-grok-usage-${runId}.png`);
let base = "";
let child;

try {
  fs.mkdirSync(workspace, { recursive: true });
  child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  await waitForApi();
  await post("/api/parties", { name: "grok usage e2e" });
  await post("/api/party/members", {
    name: "grok-usage",
    requirement: "Verify Grok subscription usage",
    role: "usage verifier",
    runtime: "grok",
    model: "grok-4.5",
  });
  const started = await post("/api/party/members/grok-usage/start", { model: "grok-4.5", permissionMode: "plan" });
  assert(started.session?.id, "real Grok member session started");

  const usage = await waitForGrokUsage();
  assert(usage.available === true, "Grok account usage is available");
  assert(usage.windows?.[0]?.kind === "weekly", "Grok account period is weekly");
  assert(Number.isFinite(usage.windows?.[0]?.utilization), "Grok credit utilization is numeric");
  assert(Number.isFinite(usage.windows?.[0]?.resetsAt), "Grok reset time is present");

  await post("/api/capture", { path: screenshot });
  assert(fs.existsSync(screenshot), "real app UI screenshot captured");
  console.log(`GROK USAGE E2E PASSED (${usage.windows[0].utilization}% used, screenshot ${screenshot})`);
  await post("/api/window/close", {}).catch(() => {});
  await waitForExit(child).catch(() => killTree(child.pid));
} catch (error) {
  if (child?.pid) killTree(child.pid);
  throw error;
} finally {
  removePath(workspace);
  removePath(userData);
}

async function waitForApi() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    base = firstBaseUrl(workspace);
    if (base) {
      try { if ((await get("/api/health")).ok) return; } catch {}
    }
    await delay(500);
  }
  throw new Error("AgentParty automation API did not start.");
}

async function waitForGrokUsage() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const usage = (await get("/api/usage")).usage?.grok;
    if (usage?.windows?.length) return usage;
    await delay(1000);
  }
  throw new Error("Grok usage did not reach /api/usage within 60 seconds.");
}

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} returned ${response.status}`);
  return response.json();
}

async function post(route, body) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

function waitForExit(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("AgentParty did not exit.")), 10_000);
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function killTree(pid) {
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}

function removePath(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(value, message) { if (!value) throw new Error(`Assertion failed: ${message}`); console.log(`  ok: ${message}`); }
