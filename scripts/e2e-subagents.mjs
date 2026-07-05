/*
 * Full-process e2e for the subagent-observation UI, driven ENTIRELY by mock
 * injection (no real subagent is ever spawned — the mock-driven design principle).
 *
 * Launches the REAL app (QA mode) on the LEFT monitor, seeds two mock members,
 * and injects a named subagent scenario into each through the new endpoint
 * `POST /api/qa/members/:name/subagents`:
 *   - tester  ← claude-test-shards (Claude Agent/Task fan-out, 6 shard-runners)
 *   - backend ← codex-call-tracer  (Codex collab thread, one call-tracer)
 * The events flow through the exact same normalization + renderer fold a live
 * harness would, proving the whole pipeline end-to-end, then captures a
 * screenshot of the rendered dock for visual review.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = "C:\\Project\\AgentPartyApp";
const ws = path.join(os.tmpdir(), "agentparty-subagents-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-subagents-e2e-user-data");
const port = Number(process.env.AGENTPARTY_SUBAGENTS_E2E_PORT || "") || 48937;
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
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_AUTOMATION_PORT: String(port),
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
    await post("/api/windows/win-1/workspace", { workspacePath: ws });
    await post("/api/qa/reset").catch(() => {});
    await post("/api/qa/seed", {
      party: "subagents e2e",
      members: [
        { name: "tester", model: "claude-sonnet-4.5", role: "회귀 테스트" },
        { name: "backend", model: "claude-sonnet-4.5", role: "백엔드" },
      ],
    });
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["tester"], ["backend"]] });

    // Inject the two scenarios — the ONLY step needed to demo/QA the subagent UI.
    const shards = await post("/api/qa/members/tester/subagents", { scenario: "claude-test-shards" });
    assert(shards.ok && shards.scenario === "claude-test-shards" && shards.count > 0, `claude-test-shards injected (${shards.count} events)`);
    const tracer = await post("/api/qa/members/backend/subagents", { scenario: "codex-call-tracer" });
    assert(tracer.ok && tracer.count > 0, `codex-call-tracer injected (${tracer.count} events)`);

    // An unknown scenario must fail loudly (no silent no-op).
    const bad = await postRaw("/api/qa/members/tester/subagents", { scenario: "does-not-exist" });
    assert(bad.status >= 400, `unknown scenario rejected (status ${bad.status})`);

    await delay(700);
    const shot = path.join(os.tmpdir(), "subagents.png");
    const cap = await post("/api/capture", { path: shot });
    assert(cap.ok, `captured rendered subagent dock → ${cap.path}`);

    await post("/api/window/close", {});
    await waitForExit(child);
    console.log("SUBAGENTS E2E PASSED");
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try { if ((await getJson("/api/health")).ok) return; } catch {}
    await delay(500);
  }
  throw new Error("Automation API did not start.");
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

async function postRaw(u, b) {
  const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
  return { status: r.status };
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
