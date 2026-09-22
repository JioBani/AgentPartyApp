/* Real-app E2E: AgentParty -> WSL engine -> official Muse MSP -> party MCP -> transcript. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distro = process.env.AGENTPARTY_WSL_DISTRO || "Ubuntu-20.04";
const port = Number(process.env.AGENTPARTY_LIVE_MUSE_PORT || "") || 48958;
const base = `http://127.0.0.1:${port}`;
const runId = `${process.pid}-${Date.now()}`;
const userData = path.join(os.tmpdir(), `agentparty-live-muse-${runId}-user-data`);
const screenshot = path.join(os.tmpdir(), `agentparty-live-muse-${runId}-usage.png`);
const workspace = `/tmp/agentparty-live-muse-${runId}`;
const mcpOut = `/tmp/agentparty-live-muse-mcp-${runId}.jsonl`;
const workspaceUri = `wsl+${distro}:${workspace}`;
const memberName = "muse-live";
const sentinel = `peer-${runId}`;
let child;

function wsl(args) {
  return execFileSync("wsl.exe", ["-d", distro, "-e", ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

try {
  wsl(["bash", "-lc", `rm -rf ${quote(workspace)} ${quote(mcpOut)}; mkdir -p ${quote(workspace)}`]);
  child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_AUTOMATION_PORT: String(port),
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      AGENTPARTY_CODEX_MCP_OUT: mcpOut,
    },
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  await waitForApi();
  const models = await get("/api/models");
  const museRoutes = models.modelRoutes?.filter((item) => item.harnessId === "muse") || [];
  const route = museRoutes.find((item) => item.model === "muse-spark-1.3-contributor") || museRoutes[0];
  assert(models.museModels?.status === "ready", `Muse model discovery settled: ${models.museModels?.error || models.museModels?.status}`);
  assert(
    ["muse-spark-1.3", "muse-spark-1.3-contributor", "muse-spark-1.2", "muse-spark-1.2-contributor"]
      .every((id) => museRoutes.some((item) => item.model === id))
      && museRoutes.every((item) => item.model !== "muse-default"),
    "all four measured Muse routes replace the compatibility fallback",
  );
  assert(route?.providerId === "meta", "Muse provider catalog route is published");
  assert(route?.capabilities?.effort?.mutableDuringSession === true, "Muse effort is live-mutable");

  const windows = await get("/api/windows");
  const windowId = windows.windows?.[0]?.id;
  assert(windowId, "test window discovered");
  await post(`/api/windows/${encodeURIComponent(windowId)}/workspace`, { workspacePath: workspaceUri });
  await post("/api/parties", { name: "live muse msp e2e" });
  await post("/api/qa/members", { name: sentinel, role: "hidden random peer", autoReply: false });
  const created = await post("/api/party/members", {
    name: memberName,
    runtime: "muse",
    model: route.model,
    effort: "high",
    permissionMode: "bypassPermissions",
    requirement: "Verify the real Muse MSP and AgentParty party tool path.",
  });
  assert(created.member?.runtime === "muse", "Muse member is persisted without harness fallback");
  const started = await post(`/api/party/members/${memberName}/start`, {});
  const sessionId = await waitForSession(started.session?.id);
  assert(sessionId, "Muse member session started in WSL");

  await post(`/api/party/members/${memberName}/message`, {
    text: [
      "You MUST call the tool named `list` from the MCP server `agentparty-app` exactly once before answering.",
      "Its fully-qualified compatibility spelling may be `mcp__agentparty-app__list`.",
      "After it returns, reply with exactly the name of the party member whose name starts with `peer-`.",
      "Do not edit files or run shell commands.",
    ].join(" "),
  });
  const transcript = await waitForReply(sessionId);
  const body = JSON.stringify(transcript);
  assert(body.includes(sentinel), "real Muse response reached the AgentParty transcript");
  const calls = readMcpCalls();
  if (!calls.length) console.error("Muse transcript without MCP call:", body);
  assert(calls.some((call) => call.member === memberName && call.name === "list"), "Muse invoked the real session-scoped AgentParty MCP server");
  assert(!/not logged in|authRequired|unknown MCP server/i.test(body), "Muse turn has no auth or MCP wiring failure");
  // Muse's MSP usage surface is last-observed: a fresh host truthfully returns
  // no subscription snapshot until the provider has completed its first call.
  const usage = await waitForMuseUsage();
  assert(usage.available === true, "Muse subscription usage is available after the first provider call");
  assert(usage.windows.some((window) => window.kind === "five_hour" && Number.isFinite(window.utilization)), "Muse current-window utilization reached /api/usage");
  assert(usage.windows.some((window) => window.kind === "weekly" && Number.isFinite(window.utilization)), "Muse weekly utilization reached /api/usage");
  await post("/api/capture", { path: screenshot });
  assert(fs.existsSync(screenshot), "Muse usage UI rendered in the real app window");

  await post(`/api/party/members/${memberName}/close`, {}).catch(() => undefined);
  console.log("LIVE MUSE APP E2E PASSED");
  await closeWindow();
  await waitForExitOrKill(child);
} catch (error) {
  if (child?.pid) killTree(child.pid);
  throw error;
} finally {
  try { wsl(["bash", "-lc", `rm -rf ${quote(workspace)} ${quote(mcpOut)}`]); } catch {}
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
}

async function waitForApi() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { if ((await get("/api/health")).ok) return; } catch {}
    await delay(500);
  }
  throw new Error("AgentParty automation API did not start.");
}

async function waitForSession(initialId) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const state = await get("/api/state").catch(() => ({}));
    const member = state.party?.members?.find((item) => item.name === memberName);
    const id = member?.sessionId || initialId;
    const session = state.sessions?.find((item) => item.id === id);
    if (session?.snapshot?.status === "error") throw new Error(session.snapshot.lastError || "Muse session failed to start.");
    if (id && session?.snapshot?.harnessAlive) return id;
    await delay(1000);
  }
  throw new Error("Muse session did not start within 150 seconds.");
}

async function waitForReply(sessionId) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const transcript = await get(`/api/party/members/${memberName}/transcript`).catch(() => ({}));
    const body = JSON.stringify(transcript);
    if (body.includes(sentinel) && body.includes("turn complete")) return transcript;
    const state = await get("/api/state").catch(() => ({}));
    const session = state.sessions?.find((item) => item.id === sessionId);
    if (session?.snapshot?.status === "error") throw new Error(session.snapshot.lastError || "Muse turn failed.");
    await delay(1000);
  }
  throw new Error("Muse response did not arrive within 240 seconds.");
}

async function waitForMuseUsage() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const usage = (await get("/api/usage").catch(() => ({}))).usage?.muse;
    if (usage?.windows?.length >= 2) return usage;
    await delay(1000);
  }
  throw new Error("Muse subscription usage did not reach /api/usage within 60 seconds.");
}

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
  return response.json();
}
async function post(route, body) {
  const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
  return response.json();
}
function quote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }
function readMcpCalls() {
  try {
    return wsl(["bash", "-lc", `cat ${quote(mcpOut)} 2>/dev/null || true`]).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(value, message) { if (!value) throw new Error(`Assertion failed: ${message}`); console.log(`  ok: ${message}`); }
async function closeWindow() { try { await post("/api/window/close", {}); } catch {} }
function waitForExitOrKill(proc) { return new Promise((resolve) => { const timer = setTimeout(() => { killTree(proc.pid); resolve(); }, 10_000); proc.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
function killTree(pid) { try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
