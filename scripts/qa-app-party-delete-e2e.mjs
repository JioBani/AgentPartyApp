/*
 * FULL-PROCESS e2e for party deletion, driven over the HTTP automation API only
 * (exactly as an external QA agent). Self-launching: it boots a real Electron
 * app on an isolated userData + temp workspace (so it never touches a dev app or
 * the installed app's data), then verifies the whole delete path through the
 * actual AppController → engine → repository stack:
 *
 *   create party A + B  →  delete B  →  A remains & becomes current
 *                       →  delete A  →  no parties left, currentPartyId cleared
 *
 * No model turns are involved (party CRUD is pure state), so this runs offline
 * and is safe in the suite-adjacent "live app" tier. Not billed.
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = String(process.pid);
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-party-del-ws-"));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-party-del-ud-"));
const disco = path.join(userData, "automation.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const env = {
  ...process.env,
  AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
  AGENTPARTY_USER_DATA: userData,
  AGENTPARTY_WINDOW_DISPLAY: "left",
};
delete env.ELECTRON_RUN_AS_NODE;

console.log(`Party-delete full-process e2e (isolated userData=${path.basename(userData)}):`);
const child = spawn(process.execPath, [path.join(projectRoot, "scripts/launch-electron.mjs"), "--workspace", workspace], { stdio: "inherit", env });

async function stop() {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch {}
  await sleep(300);
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
}

let baseUrl = "";
try {
  // 1) Wait for the app to publish its automation URL, then for health.
  for (let i = 0; i < 120 && !baseUrl; i++) {
    if (fs.existsSync(disco)) {
      try { baseUrl = JSON.parse(fs.readFileSync(disco, "utf8")).baseUrl || ""; } catch {}
    }
    if (!baseUrl) await sleep(500);
  }
  assert(Boolean(baseUrl), `app published automation.json (${baseUrl || "MISSING"})`);
  if (!baseUrl) throw new Error("no baseUrl");

  const get = (p) => fetch(baseUrl + p).then((r) => r.json());
  const post = (p, body) => fetch(baseUrl + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then((r) => r.json());

  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    healthy = (await get("/api/health").catch(() => null))?.ok === true;
    if (!healthy) await sleep(500);
  }
  assert(healthy, "GET /api/health is ok");

  // 2) Create two parties. Each is born with a 'main' member.
  const a = await post("/api/parties", { name: `A-${stamp}` });
  const idA = a.currentPartyId;
  assert(Boolean(idA), `created party A (${idA})`);
  const b = await post("/api/parties", { name: `B-${stamp}` });
  const idB = b.currentPartyId;
  assert(Boolean(idB) && idB !== idA, `created party B (${idB}), distinct from A`);
  assert((b.members || []).some((m) => m.name === "main"), "party B has a 'main' member");

  // 3) Delete B (the active one). A must remain and become current.
  const afterB = await post(`/api/parties/${encodeURIComponent(idB)}/delete`, {});
  const idsAfterB = (afterB.parties || []).map((p) => p.id);
  assert(!idsAfterB.includes(idB), "party B is gone from the listing after delete");
  assert(idsAfterB.includes(idA), "party A still present after deleting B");
  assert(afterB.currentPartyId === idA, `focus fell back to A after deleting active B (got ${afterB.currentPartyId})`);
  // B's on-disk storage is removed.
  const bDir = path.join(workspace, ".agent_party_app", "parties", idB.replace(/[^a-zA-Z0-9._-]/g, "-"));
  assert(!fs.existsSync(bDir), "party B's on-disk storage directory was removed");

  // 4) Delete the last remaining party. No parties left; current cleared.
  const afterA = await post(`/api/parties/${encodeURIComponent(idA)}/delete`, {});
  assert((afterA.parties || []).length === 0, "no parties remain after deleting the last one");
  assert(!afterA.currentPartyId, "currentPartyId is cleared when the last party is deleted");
  assert((afterA.members || []).length === 0, "no members remain after deleting the last party");

  // 5) Deleting a non-existent party surfaces an error (no silent success).
  const bad = await post(`/api/parties/does-not-exist/delete`, {});
  assert(bad.ok === false || /does not exist|error/i.test(bad.message || bad.error || ""), "deleting a missing party is reported as an error, not a silent no-op");
} catch (error) {
  assert(false, `e2e threw: ${error?.message || error}`);
} finally {
  await stop();
}

console.log(failures.length ? `\nPARTY DELETE e2e FAILED (${failures.length})` : "\nPARTY DELETE e2e PASSED (real app, HTTP API only)");
process.exit(failures.length ? 1 : 0);
