/*
 * Live demo of the subagent-observation UI, driven purely by mock injection.
 * Launches the REAL app (QA mode), seeds mock members, injects named subagent
 * scenarios, and captures the rendered dock in two arrangements:
 *   1) one wide panel (full dock + live one-liner + task text)
 *   2) a responsive split (wide / mid / narrow docks side by side)
 * No real subagent is ever spawned. Screenshots are written to the temp dir.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = "C:\\Project\\AgentPartyApp";
const ws = path.join(os.tmpdir(), "agentparty-subagents-demo-workspace");
const userData = path.join(os.tmpdir(), "agentparty-subagents-demo-user-data");
const port = Number(process.env.AGENTPARTY_SUBAGENTS_DEMO_PORT || "") || 48939;
const base = `http://127.0.0.1:${port}`;
const outDir = os.tmpdir();

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
    await post("/api/windows/win-1/workspace", { workspacePath: ws });
    await post("/api/qa/reset").catch(() => {});
    await post("/api/qa/seed", {
      party: "subagents demo",
      members: [
        { name: "tester", model: "claude-sonnet-4.5", role: "회귀 테스트" },
        { name: "backend", model: "claude-sonnet-4.5", role: "백엔드" },
        { name: "reviewer", model: "claude-sonnet-4.5", role: "리뷰" },
        { name: "docs", model: "claude-sonnet-4.5", role: "문서" },
      ],
    });
    await post("/api/navigation", { view: "workbench" });

    // Inject scenarios (the only step needed to demo the whole UI).
    await post("/api/qa/members/tester/subagents", { scenario: "claude-test-shards" });
    await post("/api/qa/members/backend/subagents", { scenario: "codex-call-tracer" });
    await post("/api/qa/members/reviewer/subagents", { scenario: "claude-test-shards" });

    // Capture 1 — one wide panel: the full dock, live one-liner, task text.
    await post("/api/qa/open", { panels: [["tester"]] });
    await delay(700);
    const wide = path.join(outDir, "subagents-demo-wide.png");
    console.log("capture wide:", (await post("/api/capture", { path: wide })).path);

    // Capture 2 — responsive split: docks persist and compact at narrow widths.
    await post("/api/qa/open", { panels: [["tester"], ["backend"], ["reviewer", "docs"]] });
    await delay(700);
    const split = path.join(outDir, "subagents-demo-split.png");
    console.log("capture split:", (await post("/api/capture", { path: split })).path);

    // Capture 3 — the drill-in DETAIL of a running shard on a wide panel (feels
    // like being inside the subagent's session: breadcrumb + delegated task +
    // its own transcript with tool cards + live typing).
    await post("/api/qa/open", { panels: [["tester"]] });
    await post("/api/qa/members/tester/subagents/open", { subId: "shard-billing" });
    await delay(700);
    const detail = path.join(outDir, "subagents-demo-detail.png");
    console.log("capture detail:", (await post("/api/capture", { path: detail })).path);

    await post("/api/window/close", {});
    await waitForExit(child);
    console.log("DEMO DONE");
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try { const r = await fetch(base + "/api/health"); if (r.ok && (await r.json()).ok) return; } catch {}
    await delay(500);
  }
  throw new Error("Automation API did not start.");
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
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
