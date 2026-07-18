/*
 * Full-process e2e for per-member auto-compaction — OFFLINE (mock member, no
 * model). Launches the REAL app on an isolated userData + temp workspace and
 * proves, through the actual app path (HTTP → AppController → engine → party
 * repository), that:
 *   - POST /api/party/members/:name/auto-compact persists a member's threshold,
 *     reflected on GET /api/state AND written to the on-disk party.json,
 *   - clearing it (autoCompact:null) removes the override,
 *   - POST /api/settings { compactDefault } persists the global default,
 *   - the workbench renders with the member open (toolbar pill + sidebar badge)
 *     — captured for visual review.
 * The crossing-trigger + inheritance logic is locked deterministically by
 * scripts/qa-auto-compact.mjs (in test:ui). Not billed. See
 * docs/디자인 핸드오프/design_handoff_workbench.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-autocompact-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-autocompact-e2e-user-data");
let base = "";
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

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

    await post("/api/qa/reset").catch(() => {});
    await post("/api/qa/seed", { party: "auto-compact e2e", members: [{ name: "backend", role: "r" }, { name: "frontend", role: "r" }] });

    // 1) Set a per-member threshold — reflected on state AND written to disk.
    await post("/api/party/members/backend/auto-compact", { autoCompact: { on: true, at: 60 } });
    let member = await memberOf("backend");
    assert(member?.autoCompact?.on === true && member.autoCompact.at === 60, `backend threshold persists on state (${JSON.stringify(member?.autoCompact)})`);
    assert(diskAutoCompact("backend")?.at === 60, "backend threshold written to on-disk party.json");

    // Out-of-band values clamp into the settable band (below 10 and above 95 blocked).
    await post("/api/party/members/backend/auto-compact", { autoCompact: { on: true, at: 5 } });
    member = await memberOf("backend");
    assert(member?.autoCompact?.at === 10, `5% clamps up to the floor (10) — below 10% blocked (got ${member?.autoCompact?.at})`);
    await post("/api/party/members/backend/auto-compact", { autoCompact: { on: true, at: 99 } });
    member = await memberOf("backend");
    assert(member?.autoCompact?.at === 95, `99% clamps down to the ceiling (95) — above 95% blocked (got ${member?.autoCompact?.at})`);

    // 2) Clearing the override removes it (member then inherits the global default).
    await post("/api/party/members/backend/auto-compact", { autoCompact: null });
    member = await memberOf("backend");
    assert(!member?.autoCompact, "clearing sets member.autoCompact back to undefined (inherits default)");

    // Re-set so the captured UI shows the on-state pill + sidebar badge.
    await post("/api/party/members/backend/auto-compact", { autoCompact: { on: true, at: 65 } });

    // 3) Global default persists through the settings path.
    await post("/api/settings", { compactDefault: { on: true, at: 75 } });
    const state = await getJson("/api/state");
    assert(state.settings?.compactDefault?.on === true && state.settings.compactDefault.at === 75, `global compactDefault persists (${JSON.stringify(state.settings?.compactDefault)})`);

    // 4) Render the workbench with the member open (toolbar pill + sidebar badge).
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["backend"]] });
    await delay(700);
    const shot = path.join(os.tmpdir(), "auto-compact-e2e.png");
    const cap = await post("/api/capture", { path: shot });
    assert(cap.ok && cap.bytes > 0, `captured workbench with auto-compact UI → ${cap.path} (${cap.bytes} bytes)`);

    await post("/api/window/close", {});
    await waitForExit(child);
    console.log(failures.length ? `\nAUTO-COMPACT E2E FAILED (${failures.length})` : "\nAUTO-COMPACT E2E PASSED");
    process.exit(failures.length ? 1 : 0);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

async function memberOf(name) {
  const state = await getJson("/api/state");
  return (state.party?.members || []).find((m) => m.name === name);
}

/** Reads the member's persisted autoCompact straight off the on-disk party.json. */
function diskAutoCompact(name) {
  const dir = path.join(ws, ".agent_party_app", "parties");
  if (!fs.existsSync(dir)) return undefined;
  for (const id of fs.readdirSync(dir)) {
    const file = path.join(dir, id, "party.json");
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const member = (data.members || []).find((m) => m.name === name);
      if (member) return member.autoCompact;
    } catch { /* keep scanning */ }
  }
  return undefined;
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    base = firstBaseUrl(ws);
    if (base) { try { if ((await getJson("/api/health")).ok) return; } catch {} }
    await delay(500);
  }
  throw new Error("Automation API did not start (no live instance file under the e2e workspace).");
}

async function getJson(u) { const r = await fetch(base + u); if (!r.ok) throw new Error(`${u} returned ${r.status}`); return r.json(); }
async function post(u, b) { const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error(`${u} returned ${r.status}: ${await r.text()}`); return r.json(); }
async function removePath(target) { for (let i = 0; i < 10; i += 1) { try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (e) { if (e?.code !== "EBUSY" || i === 9) return; await delay(300); } } }
function waitForExit(child) { return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("App did not exit after close API.")), 10000); child.once("exit", () => { clearTimeout(t); resolve(); }); }); }
function killProcessTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { try { process.kill(pid); } catch {} } }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
