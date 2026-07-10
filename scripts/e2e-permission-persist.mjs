/*
 * Full-process e2e for runtime setting persistence — offline (mock member, no
 * model calls). Launches the REAL app on an isolated userData + temp workspace
 * and proves, in the actual app path, that a permission mode, MODEL, and EFFORT
 * changed DURING a session are written back to the owning member and survive an
 * app RESTART (previously these runtime changes reached only the live adapter
 * and were lost on restart, reverting to the start-time values — e.g. an opus
 * session reopening as sonnet, or "auto" permission reverting to default).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = "C:\\Project\\AgentPartyApp";
const ws = path.join(os.tmpdir(), "ap-perm-persist-e2e-ws");
const userData = path.join(os.tmpdir(), "ap-perm-persist-e2e-ud");
const port = Number(process.env.AGENTPARTY_PERM_PERSIST_PORT || "") || 48947;
const base = `http://127.0.0.1:${port}`;
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const partyRoot = path.join(ws, ".agent_party_app");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

async function main() {
  rm(ws); rm(userData); fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws, automationApiPort: port }, null, 2));

  let child = await launch();
  try {
    await waitApi();

    // Seed a party with one mock member (starts a live mock session).
    await post("/api/qa/reset").catch(() => {});
    await post("/api/qa/seed", { party: "perm", members: [{ name: "worker", role: "r" }] });
    let party = await get("/api/party");
    const member = party.members.find((m) => m.name === "worker");
    assert(Boolean(member && member.sessionId), "mock member started with a live session");
    assert((member.permissionMode || "default") === "default", "member starts at default permission mode");

    const detailFile = path.join(partyRoot, "parties", member.partyId, "party.json");
    const memberIn = (file) => readJson(file).members.find((m) => m.name === "worker");

    // Change permission mode ("auto" — the mode reported to revert), model, and
    // effort DURING the session, via the same HTTP endpoints the UI drives.
    await post(`/api/sessions/${member.sessionId}/permission`, { permissionMode: "auto" });
    await post(`/api/sessions/${member.sessionId}/model`, { model: "opus[1m]" });
    await post(`/api/sessions/${member.sessionId}/effort`, { effort: "high" });

    // All three must be persisted to the member's on-disk record immediately.
    assert(memberIn(detailFile)?.permissionMode === "auto", "runtime permission change persisted to member's party.json");
    assert(memberIn(detailFile)?.model === "opus[1m]", "runtime model change persisted to member's party.json");
    assert(memberIn(detailFile)?.effort === "high", "runtime effort change persisted to member's party.json");

    // --- RESTART the app, same userData + workspace -------------------------
    await post("/api/window/close").catch(() => {});
    await waitExit(child);
    child = await launch();
    await waitApi();

    party = await get("/api/party");
    const restored = party.members.find((m) => m.name === "worker");
    assert(restored?.permissionMode === "auto", "permission mode restored to the runtime-chosen value after restart");
    assert(restored?.model === "opus[1m]", "model restored to the runtime-chosen value after restart");
    assert(restored?.effort === "high", "effort restored to the runtime-chosen value after restart");

    await post("/api/window/close").catch(() => {});
    await waitExit(child);
  } catch (error) {
    kill(child?.pid);
    throw error;
  }

  console.log("");
  if (failures.length) { console.log(`PERMISSION PERSIST E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("RUNTIME PERSIST E2E PASSED (runtime permission/model/effort changes persist across restart, in the real app)");
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
