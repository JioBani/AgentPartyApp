/*
 * Full-process e2e for Codex diagnostics / no-silent-fallback (Item 5), driven by
 * the fake codex app-server. Launches the REAL app on the LEFT monitor, creates a
 * Codex member, and sends a turn whose fake response emits model/rerouted + a
 * sandbox warning + a near-exhausted rate-limit. Asserts the turn completes
 * cleanly (the real adapter classified/surfaced each notification without error),
 * proves session-start `account/rateLimits/read` fills `/api/usage` before the
 * provider's later push notification, and captures a screenshot of the rendered
 * diagnostic banners + header badge.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = "C:\\Project\\AgentPartyApp";
const fakeServer = path.join(root, "scripts", "fake-codex-appserver.mjs");
const ws = path.join(os.tmpdir(), "agentparty-codex-diag-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-codex-diag-e2e-user-data");
const port = Number(process.env.AGENTPARTY_DIAG_E2E_PORT || "") || 48938;
const base = `http://127.0.0.1:${port}`;

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_AUTOMATION_PORT: String(port),
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      AGENTPARTY_CODEX_BIN: process.execPath,
      AGENTPARTY_CODEX_ARGS: JSON.stringify([fakeServer]),
    },
    windowsHide: true,
  });
  child.stdout.on("data", (c) => process.stdout.write(c));
  child.stderr.on("data", (c) => process.stderr.write(c));

  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "health ok");
    await post("/api/windows/win-1/workspace", { workspacePath: ws });
    await post("/api/parties", { name: "diagnostics e2e" });

    const name = "codey";
    await post("/api/party/members", { name, requirement: "diagnostics e2e", runtime: "codex", model: "gpt-5.4-mini", permissionMode: "default" });
    await post(`/api/party/members/${name}/open`, {});
    const initialUsage = await waitForCodexUsage(21);
    assert(initialUsage === 21, "codex session start reads account/rateLimits into /api/usage before a turn");
    await post(`/api/party/members/${name}/send`, { content: "KIND=diagnostics 진단을 보여줘" });

    const session = await waitForTurn();
    assert(session.snapshot.turnCount >= 1, "turn completed (adapter surfaced reroute/warning/rate-limit without error)");
    assert(session.snapshot.status !== "error", `session did not error (status=${session.snapshot.status})`);
    const refreshed = await post("/api/usage/refresh", {});
    assert(refreshed.usage?.codex?.windows?.find((w) => w.kind === "five_hour")?.utilization === 21, "manual usage refresh re-reads Codex account limits through the automation API");

    const shot = path.join(os.tmpdir(), "codex-diagnostics.png");
    const cap = await post("/api/capture", { path: shot });
    assert(cap.ok, `captured rendered diagnostics → ${cap.path}`);

    await post("/api/window/close", {});
    await waitForExit(child);
    console.log("CODEX DIAGNOSTICS E2E PASSED");
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

async function waitForTurn() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const st = await getJson("/api/state");
    const s = st.sessions.find((x) => x.snapshot?.model === "gpt-5.4-mini");
    if (s?.snapshot?.status === "error") {
      throw new Error(s.snapshot.lastError || "session errored");
    }
    if (s && Number(s.snapshot?.turnCount || 0) >= 1 && s.snapshot.status === "idle") {
      return s;
    }
    await delay(400);
  }
  throw new Error("turn did not complete within 30s");
}

async function waitForCodexUsage(expected) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const usage = (await getJson("/api/usage")).usage;
    const five = usage?.codex?.windows?.find((w) => w.kind === "five_hour");
    if (five?.utilization === expected) {
      return five.utilization;
    }
    await delay(300);
  }
  return undefined;
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try { if ((await getJson("/api/health")).ok) return; } catch {}
    await delay(500);
  }
  throw new Error("Automation API did not start.");
}

async function getJson(u) { const r = await fetch(base + u); if (!r.ok) throw new Error(`${u} returned ${r.status}`); return r.json(); }
async function post(u, b) { const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); if (!r.ok) throw new Error(`${u} returned ${r.status}: ${await r.text()}`); return r.json(); }

async function removePath(target) {
  for (let i = 0; i < 10; i += 1) { try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (e) { if (e?.code !== "EBUSY" || i === 9) return; await delay(300); } }
}
function waitForExit(child) { return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("App did not exit after close API.")), 10000); child.once("exit", () => { clearTimeout(t); resolve(); }); }); }
function killProcessTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { try { process.kill(pid); } catch {} } }
function assert(v, m) { if (!v) throw new Error(`Assertion failed: ${m}`); console.log(`  ok: ${m}`); }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
