/*
 * Full-process e2e for the usage-limit indicator — offline (mock member, no
 * model). Launches the REAL app on an isolated userData + temp workspace and
 * proves, in the actual app path, that provider rate-limit usage injected over
 * `POST /api/qa/usage` is aggregated per provider (merging separate window
 * reports), served by `GET /api/usage`, and pushed to the window so the titlebar
 * pill paints. The renderer's always-visible Claude/Codex empty state is locked
 * by qa-usage-limits; this full-process test captures the real window for visual
 * review and verifies the injected data path end to end.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = "C:\\Project\\AgentPartyApp";
const ws = path.join(os.tmpdir(), "ap-usage-e2e-ws");
const userData = path.join(os.tmpdir(), "ap-usage-e2e-ud");
const port = Number(process.env.AGENTPARTY_USAGE_PORT || "") || 48951;
const base = `http://127.0.0.1:${port}`;
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

async function main() {
  rm(ws); rm(userData); fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws, automationApiPort: port }, null, 2));

  const child = await launch();
  try {
    await waitApi();

    // Seed one member to exercise member counts; the pill itself shows both
    // providers even when no provider has members or data.
    await post("/api/qa/reset").catch(() => {});
    await post("/api/qa/seed", { party: "usage", members: [{ name: "worker", role: "r" }] });

    // Empty until the first report: the API never fabricates 0%; the renderer
    // still shows Claude/Codex as loading from the shared view model.
    let usage = (await get("/api/usage")).usage;
    assert(!usage.claude && !usage.codex, "no usage reported yet → empty snapshot (not 0%)");

    // Inject the 5-hour window, then the weekly window SEPARATELY — proving the
    // merge keeps both (real providers report one window at a time).
    const soon = Date.now() + 2 * 3600_000 + 12 * 60_000;
    await post("/api/qa/usage", { provider: "claude", available: true, windows: [{ kind: "five_hour", utilization: 63, resetsAt: soon }] });
    await post("/api/qa/usage", { provider: "claude", windows: [{ kind: "weekly", utilization: 41, resetsAt: Date.now() + 4 * 86400_000 }] });
    await post("/api/qa/usage", { provider: "codex", available: true, windows: [{ kind: "five_hour", utilization: 24 }, { kind: "weekly", utilization: 17 }] });

    usage = (await get("/api/usage")).usage;
    assert(usage.claude?.windows?.length === 2, "claude snapshot merged 5-hour + weekly (separate reports preserved)");
    assert(usage.claude.windows.find((w) => w.kind === "five_hour")?.utilization === 63, "claude 5-hour utilization served");
    assert(usage.claude.windows.find((w) => w.kind === "weekly")?.utilization === 41, "claude weekly utilization served");
    assert(usage.codex?.windows?.length === 2, "codex snapshot has both windows");
    assert(usage.codex.windows.find((w) => w.kind === "five_hour")?.utilization === 24, "codex primary→5-hour utilization served");

    // Updating one window replaces only that window (merge by kind).
    await post("/api/qa/usage", { provider: "claude", windows: [{ kind: "five_hour", utilization: 88 }] });
    usage = (await get("/api/usage")).usage;
    assert(usage.claude.windows.find((w) => w.kind === "five_hour")?.utilization === 88, "re-report updates the 5-hour window");
    assert(usage.claude.windows.find((w) => w.kind === "weekly")?.utilization === 41, "re-report leaves weekly untouched");

    // Let the push settle in the renderer before the screenshot.
    await delay(1500);
    // Capture the titlebar pill + popover for visual reference (not asserted).
    const shot = path.join(os.tmpdir(), "usage-limits.png");
    const cap = await post("/api/capture", { path: shot });
    assert(cap.ok, `captured titlebar usage pill → ${cap.path || shot}`);

    // --- Source-change purge regression (active-source dedupe) -------------
    // Until now QA injection stamped no sourceId, so any seed of Claude or
    // Codex member "won" the active-source slot and its session id was tracked.
    // Closing the only member for a provider must clear the snapshot — that's
    // the "stale rate limit" bug the dedupe fix targets. E2E mode suppresses
    // background polling, so with no foreground session the snapshot is empty.
    await post("/api/qa/usage", { provider: "claude", windows: [{ kind: "five_hour", utilization: 12 }] });
    usage = (await get("/api/usage")).usage;
    assert(usage.claude?.windows?.find((w) => w.kind === "five_hour")?.utilization === 12, "before close: injected 12% on the five-hour window is reflected");

    // The seeded "worker" is the only Claude session. Closing it should
    // release the active-source slot and purge the snapshot.
    await post("/api/party/members/worker/close").catch(() => {});
    usage = (await get("/api/usage")).usage;
    assert(!usage.claude, "after closing the only Claude member: snapshot purged (no stale data)");

    // Re-open the snapshot via QA (the qa source id always passes the filter)
    // — proves the dedupe doesn't lock QA out, only non-active foreground sources.
    await post("/api/qa/usage", { provider: "claude", windows: [{ kind: "five_hour", utilization: 9 }] });
    usage = (await get("/api/usage")).usage;
    assert(usage.claude?.windows?.find((w) => w.kind === "five_hour")?.utilization === 9, "QA bypass re-publishes the snapshot after the purge");

    // Final cleanup: drop the lingering snapshot before we tear down.
    await post("/api/qa/reset").catch(() => {});

    await post("/api/window/close").catch(() => {});
    await waitExit(child);
  } catch (error) {
    kill(child?.pid);
    throw error;
  }

  console.log("");
  if (failures.length) { console.log(`USAGE LIMITS E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("USAGE LIMITS E2E PASSED (inject → merge → GET /api/usage → titlebar pill, in the real app)");
}

function launch() {
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_ALLOW_MULTI_INSTANCE: "1", AGENTPARTY_AUTOMATION_PORT: String(port), AGENTPARTY_USER_DATA: userData, AGENTPARTY_WINDOW_DISPLAY: "left", AGENTPARTY_WORKSPACE: ws },
  });
  child.stderr.on("data", (c) => process.stderr.write(c));
  return child;
}
async function waitApi() {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(base + "/api/health"); if (r.ok && (await r.json()).ok) { await bindWorkspace(); return; } } catch {} await delay(500); }
  throw new Error("API did not start");
}
async function bindWorkspace() {
  const wins = (await get("/api/windows")).windows || [];
  if (wins[0] && wins[0].workspacePath !== ws) { await post(`/api/windows/${wins[0].id}/workspace`, { workspacePath: ws }); }
}
async function get(u) { const r = await fetch(base + u); if (!r.ok) throw new Error(`${u} ${r.status}`); return r.json(); }
async function post(u, b) { const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error(`${u} ${r.status}: ${await r.text()}`); return r.json(); }
function waitExit(child) { return new Promise((res) => { const t = setTimeout(res, 8000); child.once("exit", () => { clearTimeout(t); res(); }); }); }
function kill(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
