/*
 * Full-process e2e for the party coordination surface — offline (mock members,
 * no model calls). Launches the REAL app on an isolated userData + temp
 * workspace (per-workspace instance discovery, never a fixed port) and drives
 * the HTTP endpoints agents' party tools route through:
 *
 *   - GET  /api/party/status                        (turn state, all members)
 *   - POST /api/party/members/:name/status          (turn state, one member)
 *   - POST /api/party/members/:name/interrupt       (stop one member's turn)
 *   - POST /api/party/interrupt                     (stop all, with exclude)
 *   - POST /api/party/members/:name/send + interrupt:true (interrupt-and-inject)
 *   - POST /api/party/broadcast                     (message every other member)
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-coord-ws-"));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-coord-ud-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const env = { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_ALLOW_MULTI_INSTANCE: "1", AGENTPARTY_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
child.stderr.on("data", () => {});

function discover() {
  try {
    const dir = path.join(workspace, ".agent_party_app", "instances");
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).baseUrl || ""; } catch { return ""; } })
      .filter(Boolean)[0] || "";
  } catch { return ""; }
}

try {
  let baseUrl = "";
  for (let i = 0; i < 120 && !baseUrl; i++) { baseUrl = discover(); if (!baseUrl) await sleep(500); }
  if (!baseUrl) throw new Error("app did not publish per-workspace discovery");
  const get = async (p) => { const r = await fetch(baseUrl + p); if (!r.ok) throw new Error(`GET ${p} -> ${r.status}: ${await r.text()}`); return r.json(); };
  const post = async (p, body) => {
    const r = await fetch(baseUrl + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { ok = (await get("/api/health").catch(() => null))?.ok === true; if (!ok) await sleep(500); }
  assert(ok, "real app healthy over per-workspace discovery");

  // The new endpoints are registered in the machine-readable spec (AGENTS.md rule).
  const spec = await get("/api/spec");
  for (const ep of ["POST /api/party/members/:name/status", "POST /api/party/members/:name/interrupt", "GET /api/party/status", "POST /api/party/interrupt", "POST /api/party/broadcast"]) {
    assert(spec.endpoints.includes(ep), `spec registers '${ep}'`);
  }

  // Seed: alpha idle, beta mid-turn (mock "working" = snapshot 'responding').
  await post("/api/qa/reset");
  const seeded = await post("/api/qa/seed", { party: "coord", members: [{ name: "alpha", role: "r" }, { name: "beta", role: "r", status: "working" }, { name: "gamma", role: "r", status: "working" }] });
  assert(seeded.status === 200, "seeded a party with mock members (alpha idle, beta+gamma working)");

  // --- member-status ---------------------------------------------------------
  const all = await get("/api/party/status");
  const byName = Object.fromEntries((all.members || []).map((m) => [m.name, m]));
  assert(byName.alpha?.running === true && byName.alpha?.turnActive === false, "status: idle member reads running + not turnActive");
  assert(byName.beta?.turnActive === true && byName.beta?.status === "responding", "status: mid-turn member reads turnActive=true");
  const one = await post("/api/party/members/beta/status", {});
  assert(one.status === 200 && one.body.members?.length === 1 && one.body.members[0].name === "beta", "single-member status returns exactly that member");
  const ghost = await post("/api/party/members/ghost/status", {});
  assert(ghost.status === 500 && /does not exist/i.test(ghost.body.error || ""), "status for a nonexistent member errors");

  // --- interrupt one ---------------------------------------------------------
  const stop = await post("/api/party/members/beta/interrupt", {});
  assert(stop.status === 200 && stop.body.interrupted === true, "interrupting a busy member reports interrupted=true");
  await sleep(300);
  const afterStop = await get("/api/party/status");
  assert(afterStop.members.find((m) => m.name === "beta")?.turnActive === false, "interrupted member is no longer mid-turn");
  const stopIdle = await post("/api/party/members/alpha/interrupt", {});
  assert(stopIdle.status === 200 && stopIdle.body.interrupted === false, "interrupting an idle member reports interrupted=false (not an error)");

  // --- interrupt all (with exclude) ------------------------------------------
  const stopAll = await post("/api/party/interrupt", { exclude: "main" });
  assert(stopAll.status === 200 && stopAll.body.interrupted.includes("gamma") && !stopAll.body.interrupted.includes("main"), "party-wide interrupt stops busy members and honors exclude");

  // --- interrupt-and-inject send ---------------------------------------------
  const inject = await post("/api/party/members/alpha/send", { from: "user", content: "주입 메시지", interrupt: true });
  assert(inject.status === 200 && inject.body.partyMessage?.delivered === true, "send with interrupt:true delivers to the member");

  // --- broadcast ---------------------------------------------------------------
  const bc = await post("/api/party/broadcast", { from: "main", content: "전체 공지: 상태를 보고하세요" });
  assert(bc.status === 200 && Array.isArray(bc.body.delivered), "broadcast returns per-member delivery");
  for (const name of ["alpha", "beta", "gamma"]) {
    assert(bc.body.delivered.includes(name), `broadcast delivered to '${name}'`);
  }
  assert(!bc.body.delivered.includes("main"), "broadcast excludes the sender");
  const empty = await post("/api/party/broadcast", { from: "main", content: "" });
  assert(empty.status === 500 && /non-empty/i.test(empty.body.error || ""), "broadcast with empty content is rejected, not a silent no-op");

  await post("/api/window/close", {}).catch(() => {});
  await sleep(1500);
} catch (error) {
  console.error("ERROR:", error.message);
  failures.push(error.message);
} finally {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch {}
  await sleep(300);
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
}
console.log(failures.length ? `\nPARTY COORDINATION E2E FAILED (${failures.length})` : "\nPARTY COORDINATION E2E PASSED");
process.exit(failures.length ? 1 : 0);
