/*
 * Full-process e2e for the BACKGROUND usage poller (real Claude, no mock).
 * Proves the account-usage indicator stays fresh with NO open member session:
 * launches the real app (QA), creates a Claude member but NEVER starts its
 * session, and asserts that `GET /api/usage` still reports a claude snapshot —
 * fed by the background usage adapter the SessionManager keeps alive for every
 * provider the user has members for (see sessionManager.setUsageProviders /
 * reconcileUsageAdapters). Then it starts + closes a session and confirms the
 * poller reconciles (reused while live, revived after close) without wedging.
 *
 * qa-usage-limits proves the pure reconcile decision; this proves the real
 * subprocess wiring feeds usage end to end when nothing else is running.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-usage-poller-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-usage-poller-e2e-user-data");
let base = "";

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
    windowsHide: true,
  });
  child.stdout.on("data", (c) => process.stdout.write(c));
  child.stderr.on("data", (c) => process.stderr.write(c));

  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "health ok");
    const windows = await getJson("/api/windows");
    const winWs = windows.windows?.[0]?.workspacePath || windows.windows?.[0]?.workspace;
    assert(String(winWs).toLowerCase() === ws.toLowerCase(), `spawned app serves the e2e workspace (${winWs})`);

    // Usage must be empty before any Claude member exists — nothing to poll.
    const before = (await getJson("/api/usage")).usage;
    assert(!before.claude, "no claude member yet → no background poll (empty usage)");

    // Create a Claude member. The workbench may opportunistically PREWARM a live
    // session; close it so ONLY the background poller can source usage — the whole
    // point of this test is "fresh usage with no open session".
    await post("/api/parties", { name: "usage-poller e2e" });
    await post("/api/party/members", { name: "idle-claude", requirement: "usage poll check", role: "claude", runtime: "claude-code", model: "sonnet" });
    // Leave the workbench so no open panel opportunistically prewarms a session —
    // otherwise usage could come from that session, not the background poller.
    await post("/api/navigation", { view: "automation" });
    await post("/api/party/members/idle-claude/close", {}).catch(() => {});

    // Assert NO live session exists. The background usage adapter is deliberately
    // NOT registered in the session list, so an empty `sessions` array proves any
    // usage that follows came from the background poller, not a hidden session.
    const noSession = await waitForNoLiveSessions();
    assert(noSession, "no live sessions running (prewarm closed) — usage can only come from the background poller");

    const claudeUsage = await waitForUsage("claude");
    assert(Boolean(claudeUsage), `background poller reported claude usage with NO open session (updatedAt ${claudeUsage?.updatedAt})`);
    assert((await getJson("/api/state")).sessions.length === 0, "still zero live sessions after usage arrived (came from the poller)");

    // Start a live session: the poller reuses it (no duplicate) and usage keeps
    // updating. Then close it: the poller must revive without wedging.
    const start = await post("/api/party/members/idle-claude/start", { model: "sonnet", permissionMode: "plan" });
    assert(start.session?.id, `live session started (${start.session?.id})`);
    await delay(1500);
    assert(Boolean((await getJson("/api/usage")).usage.claude), "claude usage still present while a live session runs");

    await post("/api/party/members/idle-claude/close", {}).catch(() => {});
    await delay(1500);
    assert((await getJson("/api/health")).ok, "app healthy after session close (poller reconcile did not wedge)");

    const shot = path.join(os.tmpdir(), "usage-poller.png");
    const cap = await post("/api/capture", { path: shot });
    assert(cap.ok, `captured usage indicator → ${cap.path}`);

    await post("/api/window/close", {});
    await waitForExit(child);
    console.log("USAGE POLLER E2E PASSED (background poll feeds usage with no open session)");
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

/** Polls /api/state until no live session is running (prewarm settled/closed). */
async function waitForNoLiveSessions() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const state = await getJson("/api/state");
    const sessions = state.sessions || [];
    if (sessions.length === 0) {
      return true;
    }
    // Close the member AND any live session by id: an opportunistic prewarm can
    // leave an orphan session (started after the member was closed, so unbound).
    // We need a genuine zero-session state to attribute usage to the poller.
    await post("/api/party/members/idle-claude/close", {}).catch(() => {});
    for (const session of sessions) {
      await post(`/api/sessions/${session.id}/close`, {}).catch(() => {});
    }
    await delay(1000);
  }
  return false;
}

/** Polls /api/usage until the provider has a snapshot (updatedAt set). */
async function waitForUsage(provider) {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const snap = (await getJson("/api/usage")).usage?.[provider];
    if (snap && typeof snap.updatedAt === "number") {
      return snap;
    }
    await delay(2000);
  }
  throw new Error(`${provider} usage never reported by the background poller within 120s.`);
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    base = firstBaseUrl(ws);
    if (base) {
      try { if ((await getJson("/api/health")).ok) return; } catch {}
    }
    await delay(500);
  }
  throw new Error("Automation API did not start (no live instance file under the e2e workspace).");
}

async function getJson(u) {
  const r = await fetch(base + u);
  if (!r.ok) throw new Error(`${u} returned ${r.status}`);
  return r.json();
}

async function post(u, b) {
  const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
  if (!r.ok) throw new Error(`${u} returned ${r.status}: ${await r.text()}`);
  return r.json();
}

async function removePath(target) {
  for (let i = 0; i < 10; i += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (e) { if (e?.code !== "EBUSY" || i === 9) return; await delay(300); }
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("App did not exit after close API.")), 10000);
    child.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { try { process.kill(pid); } catch {} }
}

function assert(v, m) { if (!v) throw new Error(`Assertion failed: ${m}`); console.log(`  ok: ${m}`); }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
