/*
 * Multi-window / workspace-scoping verification (requires `npm run start:qa`).
 *
 * Proves the locked model: one main process, many windows; party state scoped
 * per workspace; window-id API addressing; same-workspace windows share state.
 */
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const BASE = process.env.QA_BASE || "http://127.0.0.1:47831";
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  const wsB = path.join(os.tmpdir(), "agentparty-ws-b");
  mkdirSync(wsB, { recursive: true });

  console.log("Multi-window assertions:");

  // One window at start.
  let windows = (await api("GET", "/api/windows")).windows;
  assert(windows.length >= 1, "at least one window open at start");
  const winA = windows[0];
  const wsA = winA.workspacePath;
  assert(Boolean(wsA), `window A workspace resolved (${wsA})`);

  // Open a second window on a different workspace.
  const opened = await api("POST", "/api/windows", { workspacePath: wsB });
  assert(opened.id && opened.workspacePath, "opened window B");
  windows = (await api("GET", "/api/windows")).windows;
  assert(windows.length >= 2, "two windows now open");
  const winB = windows.find((w) => path.resolve(w.workspacePath) === path.resolve(wsB));
  assert(Boolean(winB), "window B reports workspace B");
  assert(path.resolve(winA.workspacePath) !== path.resolve(wsB), "windows A and B have different workspaces");

  // Seed distinct parties in each workspace (addressed by window id).
  await api("POST", `/api/qa/reset?window=${winA.id}`);
  await api("POST", `/api/qa/seed?window=${winA.id}`, { party: "Alpha", members: [{ name: "alpha-1", role: "A" }] });
  await api("POST", `/api/qa/reset?window=${winB.id}`);
  await api("POST", `/api/qa/seed?window=${winB.id}`, { party: "Beta", members: [{ name: "beta-1", role: "B" }] });

  // Isolation: each window sees only its workspace's members.
  const partyA = await api("GET", `/api/party?window=${winA.id}`);
  const partyB = await api("GET", `/api/party?window=${winB.id}`);
  const aNames = partyA.members.map((m) => m.name);
  const bNames = partyB.members.map((m) => m.name);
  assert(aNames.includes("alpha-1") && !aNames.includes("beta-1"), `window A sees only Alpha members (${aNames.join(",")})`);
  assert(bNames.includes("beta-1") && !bNames.includes("alpha-1"), `window B sees only Beta members (${bNames.join(",")})`);

  // Storage went to the new .agent_party_app root (not legacy .agentparty).
  assert(existsSync(path.join(wsB, ".agent_party_app", "state.json")), "workspace B persisted under .agent_party_app/");

  // Same-workspace window C shares workspace A's party.
  const openedC = await api("POST", "/api/windows", { workspacePath: wsA });
  const partyC = await api("GET", `/api/party?window=${openedC.id}`);
  const cNames = partyC.members.map((m) => m.name);
  assert(cNames.includes("alpha-1"), `window C (same workspace as A) shares Alpha members (${cNames.join(",")})`);

  // Capture A and B to show different parties side by side.
  await api("POST", `/api/navigation?window=${winA.id}`, { view: "workbench" });
  await api("POST", `/api/navigation?window=${winB.id}`, { view: "workbench" });
  await new Promise((r) => setTimeout(r, 300));
  const shotA = await api("POST", `/api/capture?window=${winA.id}`, {});
  const shotB = await api("POST", `/api/capture?window=${winB.id}`, {});
  console.log(`\n  window A capture: ${shotA.path}`);
  console.log(`  window B capture: ${shotB.path}`);

  console.log("");
  if (failures.length) {
    console.log(`MULTI-WINDOW FAILED: ${failures.length}`);
    process.exit(1);
  }
  console.log("MULTI-WINDOW PASSED");
}

main().catch((e) => { console.error("driver failed:", e.message); process.exit(1); });
