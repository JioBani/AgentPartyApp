/*
 * Full-process e2e for the party storage split (Stage 1) — offline (mock members,
 * no model). Launches the REAL app on an isolated userData + temp workspace and
 * proves, in the actual app path:
 *   1) new parties/members persist to the SPLIT layout (parties.json index +
 *      parties/<id>/party.json), never the old single state.json;
 *   2) `lastActivePartyId` is restored across an app RESTART (currentPartyId is
 *      per-process runtime, seeded from the persisted hint);
 *   3) a pre-existing legacy `state.json` migrates on first read with data intact.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = "C:\\Project\\AgentPartyApp";
const ws = path.join(os.tmpdir(), "ap-party-store-e2e-ws");
const userData = path.join(os.tmpdir(), "ap-party-store-e2e-ud");
const port = Number(process.env.AGENTPARTY_PARTY_STORE_PORT || "") || 48942;
const base = `http://127.0.0.1:${port}`;
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const partyRoot = path.join(ws, ".agent_party_app");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

async function main() {
  rm(ws); rm(userData); fs.mkdirSync(ws, { recursive: true });
  // Open the app directly on our temp workspace (isolated userData settings).
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws, automationApiPort: port }, null, 2));

  // --- seed a LEGACY blob so the same run also proves migration -------------
  fs.mkdirSync(partyRoot, { recursive: true });
  fs.writeFileSync(path.join(partyRoot, "state.json"), JSON.stringify({
    version: 1,
    parties: [{ id: "legacy-1", name: "Legacy Party", createdAt: "t", updatedAt: "t" }],
    currentPartyId: "legacy-1",
    members: [{ name: "main", partyId: "legacy-1", status: "idle" }],
    messages: [],
  }));

  let child = await launch();
  try {
    // 1) migration happened on first read
    await waitApi();
    let party = await get("/api/party");
    assert(party.parties.some((p) => p.id === "legacy-1"), "legacy party migrated + visible after launch");
    assert(fs.existsSync(path.join(partyRoot, "parties.json")), "split index parties.json written on migration");
    assert(fs.existsSync(path.join(partyRoot, "parties", "legacy-1", "party.json")), "legacy party's per-party file written");
    assert(readJson(path.join(partyRoot, "parties", "legacy-1", "party.json")).members.some((m) => m.name === "main"), "legacy member preserved in per-party file");

    // 2) new parties/members use the split layout, not state.json
    await post("/api/qa/reset").catch(() => {});
    await post("/api/qa/seed", { party: "alpha", members: [{ name: "aa", role: "r" }] });
    await post("/api/qa/seed", { party: "beta", members: [{ name: "bb", role: "r" }] });
    party = await get("/api/party");
    const alpha = party.parties.find((p) => p.name === "alpha");
    const beta = party.parties.find((p) => p.name === "beta");
    assert(Boolean(alpha && beta), "both new parties created");
    assert(fs.existsSync(path.join(partyRoot, "parties", alpha.id, "party.json")), "alpha detail file exists");
    assert(fs.existsSync(path.join(partyRoot, "parties", beta.id, "party.json")), "beta detail file exists");
    assert(readJson(path.join(partyRoot, "parties", alpha.id, "party.json")).members.some((m) => m.name === "aa"), "alpha's member is in ALPHA's file only");
    assert(!readJson(path.join(partyRoot, "parties", beta.id, "party.json")).members.some((m) => m.name === "aa"), "alpha's member is NOT in beta's file (isolated)");

    // 3) select alpha → lastActivePartyId persisted to the shared index
    await post(`/api/parties/${alpha.id}/select`);
    assert(readJson(path.join(partyRoot, "parties.json")).lastActivePartyId === alpha.id, "selecting alpha persisted lastActivePartyId to the index");

    // --- RESTART the app, same userData + workspace --------------------------
    await post("/api/window/close").catch(() => {});
    await waitExit(child);
    child = await launch();
    await waitApi();

    party = await get("/api/party");
    assert(party.parties.length >= 3, `all parties restored after restart (${party.parties.length})`);
    assert(party.currentPartyId === alpha.id, "currentPartyId restored to last-active (alpha) after restart");
    assert(party.members.some((m) => m.name === "aa"), "restart shows the active party's members (aa)");

    await post("/api/window/close").catch(() => {});
    await waitExit(child);
  } catch (error) {
    kill(child?.pid);
    throw error;
  }

  console.log("");
  if (failures.length) { console.log(`PARTY STORE E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("PARTY STORE E2E PASSED (split layout + last-active restore + legacy migration, in the real app)");
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
  // Point the (only) window at our temp workspace so party ops land there.
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
