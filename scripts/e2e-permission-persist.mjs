/*
 * Full-process e2e for runtime setting persistence — offline (mock member, no
 * model calls). Launches the REAL app on an isolated userData + temp workspace
 * and proves, in the actual app path, that Claude permission, Codex policy,
 * MODEL, and EFFORT
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
    const codexInitial = { sandbox: "read-only", approval: "on-request", guardian: false };
    const codexChanged = { sandbox: "workspace-write", approval: "never", guardian: true };
    await post("/api/party/members", {
      partyId: member.partyId,
      name: "codey",
      requirement: "Codex policy persistence QA",
      runtime: "codex",
      model: "gpt-5.4-mini",
      codexPolicy: codexInitial,
    });
    await post("/api/qa/members", { name: "codey", model: "gpt-5.4-mini", autoReply: false });
    party = await get("/api/party");
    const codey = party.members.find((m) => m.name === "codey");
    assert(Boolean(codey?.sessionId), "Codex member started with a live mock adapter");
    const codeyIn = (file) => readJson(file).members.find((m) => m.name === "codey");

    // Change permission mode ("auto" — the mode reported to revert), model, and
    // effort DURING the session, via the same HTTP endpoints the UI drives.
    await post(`/api/sessions/${member.sessionId}/permission`, { permissionMode: "auto" });
    await post(`/api/sessions/${member.sessionId}/model`, { model: "opus[1m]" });
    await post(`/api/sessions/${member.sessionId}/effort`, { effort: "high" });
    await post(`/api/sessions/${codey.sessionId}/codex-policy`, { policy: codexChanged });

    // All three must be persisted to the member's on-disk record immediately.
    assert(memberIn(detailFile)?.permissionMode === "auto", "runtime permission change persisted to member's party.json");
    assert(memberIn(detailFile)?.model === "opus[1m]", "runtime model change persisted to member's party.json");
    assert(memberIn(detailFile)?.effort === "high", "runtime effort change persisted to member's party.json");
    assert(JSON.stringify(codeyIn(detailFile)?.codexPolicy) === JSON.stringify(codexChanged), "runtime Codex policy change persisted to member's party.json");

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
    const restoredCodey = party.members.find((m) => m.name === "codey");
    assert(JSON.stringify(restoredCodey?.codexPolicy) === JSON.stringify(codexChanged), "Codex policy restored after restart");

    // Name-addressed party permission is the shared UI/HTTP/member-tool route
    // and works even while the restored member has no live session.
    const idlePolicy = { sandbox: "danger-full-access", approval: "never", guardian: false };
    await post("/api/party/members/codey/permission", { codexPolicy: idlePolicy });
    party = await get("/api/party");
    assert(JSON.stringify(party.members.find((m) => m.name === "codey")?.codexPolicy) === JSON.stringify(idlePolicy), "name-addressed permission updates an idle member");

    // Member tools keep operating on the party that spawned them even if the
    // desktop window subsequently selects another party.
    const owningPartyId = party.currentPartyId;
    await post("/api/parties", { name: "other active party" });
    const scopedHeaders = { "x-agentparty-party": owningPartyId };
    await post("/api/party/members/worker/permission", { permissionMode: "plan" }, scopedHeaders);
    const scopedParty = await get("/api/harness/party", scopedHeaders);
    assert(scopedParty.currentPartyId === owningPartyId, "member-tool party header resolves the spawning party, not the active window party");
    assert(scopedParty.members.find((m) => m.name === "worker")?.permissionMode === "plan", "scoped member tool changes the intended party member");

    // Runtime settings are the source of truth for NEW members. Exercise the
    // same settings + member-create AppController methods as the UI, omitting
    // permissions from both creates so inheritance itself is under test.
    const claudeDefaults = {
      model: "sonnet",
      effort: "low",
      permissionMode: "dontAsk",
    };
    const codexDefaults = {
      model: "gpt-5.4-mini",
      effort: "low",
      codexPolicy: { sandbox: "read-only", approval: "never", guardian: true },
    };
    await post("/api/settings", {
      selectedHarnessId: "claude-code",
      harnessDefaults: {
        "claude-code": claudeDefaults,
        codex: codexDefaults,
      },
    });
    await post("/api/party/members", {
      partyId: owningPartyId,
      name: "defaults-claude",
      requirement: "Claude runtime-default permission inheritance QA",
      runtime: "claude-code",
    });
    await post("/api/party/members", {
      partyId: owningPartyId,
      name: "defaults-codex",
      requirement: "Codex runtime-default permission inheritance QA",
      runtime: "codex",
    });
    let defaultsParty = await get("/api/harness/party", scopedHeaders);
    const defaultClaude = defaultsParty.members.find((m) => m.name === "defaults-claude");
    const defaultCodex = defaultsParty.members.find((m) => m.name === "defaults-codex");
    assert(defaultClaude?.model === claudeDefaults.model && defaultClaude?.permissionMode === claudeDefaults.permissionMode, "Claude member inherits the runtime default model and permission");
    assert(defaultCodex?.model === codexDefaults.model && JSON.stringify(defaultCodex?.codexPolicy) === JSON.stringify(codexDefaults.codexPolicy), "Codex member inherits the runtime default model and policy");

    // Restart once more to prove both defaults and inherited member values are
    // durable application state, rather than renderer/session-only state.
    await post("/api/window/close").catch(() => {});
    await waitExit(child);
    child = await launch();
    await waitApi();
    const restartedState = await get("/api/state");
    assert(restartedState.settings?.harnessDefaults?.["claude-code"]?.permissionMode === claudeDefaults.permissionMode, "Claude runtime permission default survives app restart");
    assert(JSON.stringify(restartedState.settings?.harnessDefaults?.codex?.codexPolicy) === JSON.stringify(codexDefaults.codexPolicy), "Codex runtime policy default survives app restart");
    defaultsParty = await get("/api/harness/party", scopedHeaders);
    assert(defaultsParty.members.find((m) => m.name === "defaults-claude")?.permissionMode === claudeDefaults.permissionMode, "inherited Claude member permission survives app restart");
    assert(JSON.stringify(defaultsParty.members.find((m) => m.name === "defaults-codex")?.codexPolicy) === JSON.stringify(codexDefaults.codexPolicy), "inherited Codex member policy survives app restart");

    await post("/api/window/close").catch(() => {});
    await waitExit(child);
  } catch (error) {
    kill(child?.pid);
    throw error;
  }

  console.log("");
  if (failures.length) { console.log(`PERMISSION PERSIST E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("RUNTIME PERSIST E2E PASSED (Claude/Codex permission and runtime settings persist across restart, in the real app)");
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
async function get(u, headers = {}) { const r = await fetch(base + u, { headers }); if (!r.ok) throw new Error(`${u} ${r.status}`); return r.json(); }
async function post(u, b, headers = {}) { const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error(`${u} ${r.status}: ${await r.text()}`); return r.json(); }
function waitExit(child) { return new Promise((res) => { const t = setTimeout(res, 8000); child.once("exit", () => { clearTimeout(t); res(); }); }); }
function kill(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
