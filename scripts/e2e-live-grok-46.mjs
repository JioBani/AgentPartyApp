/* Real-app E2E: AgentParty catalog -> official Grok Build ACP -> Grok 4.6 turn. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = `${process.pid}-${Date.now()}`;
const workspace = path.join(os.tmpdir(), `agentparty-grok-46-${runId}-workspace`);
const userData = path.join(os.tmpdir(), `agentparty-grok-46-${runId}-user-data`);
const expectedReply = `GROK46-${runId}`;
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
  const route = models.modelRoutes?.find((item) => item.harnessId === "grok" && item.model === "grok-4.6");
  assert(route?.runtimeModel === "grok-4.6", "Grok 4.6 is exposed through the Grok Build harness");
  assert(route?.pricing?.context === "500K", "Grok 4.6 carries the ACP-reported 500K context");
  assert(route?.capabilities?.effort?.options?.map((item) => item.id).join() === "low,medium,high,xhigh", "Grok 4.6 exposes low through xhigh effort");
  assert(route?.capabilities?.effort?.defaultValue === "high" && route?.capabilities?.effort?.mutableDuringSession === false, "Grok 4.6 defaults to high and marks effort as start-time-only");
  assert(route?.capabilities?.thinking?.supported === false, "Grok 4.6 does not expose a separate reasoning toggle");
  const state = await get("/api/state");
  assert(state.settings?.harnessDefaults?.grok?.model === "grok-4.6", "fresh installs default new Grok members to 4.6");

  await post("/api/parties", { name: "Live Grok 4.6" });
  const created = await post("/api/party/members", {
    name: "grok-46-live",
    runtime: "grok",
    model: "grok-4.6",
    effort: "xhigh",
    permissionMode: "plan",
    requirement: "Verify a real Grok 4.6 response through AgentParty.",
  });
  assert(created.member?.model === "grok-4.6", "Grok 4.6 member is persisted without fallback");
  assert(created.member?.effort === "xhigh", "Grok 4.6 member persists xhigh effort");
  const started = await post("/api/party/members/grok-46-live/start", {});
  assert(started.session?.snapshot?.model === "grok-4.6", "official Grok ACP session starts on Grok 4.6");
  assert(started.session?.snapshot?.effort === "xhigh", "official Grok ACP session starts with xhigh effort");

  await post("/api/party/members/grok-46-live/message", {
    text: `Reply with exactly ${expectedReply}. Do not use tools.`,
  });
  await waitForReply();
  console.log("LIVE GROK 4.6 APP E2E PASSED");
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
    const transcript = await get("/api/party/members/grok-46-live/transcript");
    if ((transcript.blocks || []).some((block) => block.kind === "assistant" && String(block.text || "").trim() === expectedReply)) {
      assert(true, "real Grok 4.6 response reached the AgentParty transcript");
      return;
    }
    const state = await get("/api/state");
    const session = state.sessions?.find((item) => item.snapshot?.model === "grok-4.6");
    if (session?.snapshot?.status === "error") {
      throw new Error(`Real Grok 4.6 call failed: ${session.snapshot.lastError || "unknown error"}`);
    }
    await delay(500);
  }
  throw new Error("Real Grok 4.6 response did not arrive within 120 seconds.");
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
