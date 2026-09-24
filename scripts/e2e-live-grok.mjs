/* Real-app E2E: AgentParty catalog -> official Grok Build ACP -> selected model turn. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelArg = process.argv.indexOf("--model");
const model = modelArg >= 0 ? process.argv[modelArg + 1] : "grok-4.7";
if (!model || !["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"].includes(model)) {
  throw new Error(`Unsupported Grok live-test model '${model || ""}'.`);
}
const displayName = model === "grok-4.7-build-fast" ? "Grok 4.7 Fast" : `Grok ${model.slice("grok-".length)}`;
const effortLevels = model === "grok-4.5" ? "low,medium,high" : "low,medium,high,xhigh";
const effort = model === "grok-4.5" ? "high" : "xhigh";
const runId = `${process.pid}-${Date.now()}`;
const workspace = path.join(os.tmpdir(), `agentparty-grok-live-${runId}-workspace`);
const userData = path.join(os.tmpdir(), `agentparty-grok-live-${runId}-user-data`);
const expectedReply = `GROK-LIVE-${runId}`;
const memberName = "grok-model-live";
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
    },
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  await waitForApi();
  const models = await get("/api/models");
  const route = models.modelRoutes?.find((item) => item.harnessId === "grok" && item.model === model);
  assert(route?.runtimeModel === model, `${displayName} is exposed through the Grok Build harness`);
  assert(route?.pricing?.context === "500K", `${displayName} carries the ACP-reported 500K context`);
  assert(route?.capabilities?.effort?.options?.map((item) => item.id).join() === effortLevels, `${displayName} exposes its supported effort levels`);
  assert(route?.capabilities?.effort?.defaultValue === "high" && route?.capabilities?.effort?.mutableDuringSession === false, `${displayName} defaults to high and marks effort as start-time-only`);
  assert(route?.capabilities?.thinking?.supported === false, `${displayName} does not expose a separate reasoning toggle`);
  const state = await get("/api/state");
  assert(state.settings?.harnessDefaults?.grok?.model === "grok-4.7", "fresh installs default new Grok members to 4.7 while 4.6 remains selectable");

  await post("/api/parties", { name: `Live ${displayName}` });
  const created = await post("/api/party/members", {
    name: memberName,
    runtime: "grok",
    model,
    effort,
    permissionMode: "plan",
    requirement: `Verify a real ${displayName} response through AgentParty.`,
  });
  assert(created.member?.model === model, `${displayName} member is persisted without fallback`);
  assert(created.member?.effort === effort, `${displayName} member persists ${effort} effort`);
  const started = await post(`/api/party/members/${memberName}/start`, {});
  assert(started.session?.snapshot?.model === model, `official Grok ACP session starts on ${displayName}`);
  assert(started.session?.snapshot?.effort === effort, `official Grok ACP session starts with ${effort} effort`);

  await post(`/api/party/members/${memberName}/message`, {
    text: `Reply with exactly ${expectedReply}. Do not use tools.`,
  });
  await waitForReply();
  console.log(`LIVE ${displayName.toUpperCase()} APP E2E PASSED`);
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

async function waitForReply() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const transcript = await get(`/api/party/members/${memberName}/transcript`);
    if ((transcript.blocks || []).some((block) => block.kind === "assistant" && String(block.text || "").trim() === expectedReply)) {
      assert(true, `real ${displayName} response reached the AgentParty transcript`);
      return;
    }
    const state = await get("/api/state");
    const session = state.sessions?.find((item) => item.snapshot?.model === model);
    if (session?.snapshot?.status === "error") {
      throw new Error(`Real ${displayName} call failed: ${session.snapshot.lastError || "unknown error"}`);
    }
    await delay(500);
  }
  throw new Error(`Real ${displayName} response did not arrive within 120 seconds.`);
}

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
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
  if (proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => proc.once("exit", resolve));
}
function killTree(pid) {
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}
function removePath(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}
