/*
 * Full-process e2e: TWO windows of ONE process (the `agent-party`-run-twice case)
 * have INDEPENDENT active parties. Reproduces the user's report — running
 * `agent-party` twice on the same cwd opens a second WINDOW in the first process
 * (the launcher delegates via POST /api/windows), and both windows used to share
 * one active party so switching in one switched the other.
 *
 * Proves: one process, two windows; selecting a party in window A does NOT move
 * window B, and each window's GET /api/party (addressed by ?window=<id>) reports
 * its own current party. Offline (no model).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBaseUrls } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "ap-2win-ud-"));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ap-2win-ws-"));
const otherWs = fs.mkdtempSync(path.join(os.tmpdir(), "ap-2win-other-ws-"));
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(workspace) {
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), `--workspace=${workspace}`], {
    cwd: root, stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
    env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_USER_DATA: ud, AGENTPARTY_WINDOW_DISPLAY: "left" },
  });
  child.on("error", (e) => console.error("launch error:", e.message));
  return child;
}
async function reachable(baseUrl) { try { const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } }
async function liveUrls(workspace) { const urls = discoverBaseUrls(workspace); const live = []; for (const u of urls) if (await reachable(u)) live.push(u); return live; }
async function waitCount(workspace, n) { for (let i = 0; i < 80; i++) { if ((await liveUrls(workspace)).length >= n) return true; await delay(500); } return false; }
function kill(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
async function post(baseUrl, u, b) { const r = await fetch(`${baseUrl}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return r.json(); }
async function postRaw(baseUrl, u, b) {
  const response = await fetch(`${baseUrl}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
  return { status: response.status, body: await response.json() };
}
async function get(baseUrl, u) { const r = await fetch(`${baseUrl}${u}`); return r.json(); }
async function waitFor(probe, matches, attempts = 200) {
  let value;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    value = await probe();
    if (matches(value)) return value;
    await delay(50);
  }
  return value;
}

const proc = launch(ws);
try {
  const started = await waitCount(ws, 1);
  assert(started, "the app process came up on the workspace");
  if (!started) {
    throw new Error("Electron app did not expose its automation API");
  }
  const [base] = await liveUrls(ws);

  // Second `agent-party` on the same cwd = a second WINDOW in THIS process.
  const initial = (await get(base, "/api/windows")).windows || [];
  const win1 = initial[0]?.id;
  const opened = await post(base, "/api/windows", { workspacePath: ws });
  const win2 = opened?.id;
  const after = (await get(base, "/api/windows")).windows || [];
  assert(Boolean(win1 && win2 && win1 !== win2), `two distinct windows exist (#1=${win1}, #2=${win2})`);
  assert(after.length === 2, `the process now hosts TWO windows (${after.length})`);
  assert((await liveUrls(ws)).length === 1, "still ONE process serves the workspace (not two)");

  // Two parties (shared on disk); createParty response's currentPartyId is the new id.
  const idA = (await post(base, "/api/parties", { name: "WIN-A" }))?.currentPartyId;
  const idB = (await post(base, "/api/parties", { name: "WIN-B" }))?.currentPartyId;
  assert(Boolean(idA && idB && idA !== idB), "created two distinct parties");

  // Creation legitimately leaves the creating window on the newest party, so
  // seed both windows explicitly before testing their independent selections.
  await post(base, `/api/parties/${idA}/select?window=${win1}`, {});
  await post(base, `/api/parties/${idA}/select?window=${win2}`, {});
  const seed1 = (await get(base, `/api/party?window=${win1}`)).currentPartyId;
  const seed2 = (await get(base, `/api/party?window=${win2}`)).currentPartyId;
  assert(seed1 === idA && seed2 === idA, `both windows start on A (#1=${seed1}, #2=${seed2})`);

  // Window #2 selects B — window #1 (which never re-selected) must stay on A.
  await post(base, `/api/parties/${idB}/select?window=${win2}`, {});
  const cur1 = (await get(base, `/api/party?window=${win1}`)).currentPartyId;
  const cur2 = (await get(base, `/api/party?window=${win2}`)).currentPartyId;
  assert(cur1 === idA, `window #1 STAYED on A after window #2 selected B (got ${cur1})`);
  assert(cur2 === idB, `window #2 moved to its OWN party B (got ${cur2})`);
  // And #1's view still carries A's full members (not another party's) — the
  // asymmetry the user saw ("only main in the other window") was this bug.
  const members1 = (await get(base, `/api/party?window=${win1}`)).members || [];
  assert(members1.every((m) => m.partyId === idA), "window #1's members all belong to party A (no cross-party leak)");

  // Window #1 now selects B too — window #2 must stay on B (no reverse drag).
  await post(base, `/api/parties/${idB}/select?window=${win1}`, {});
  const cur2again = (await get(base, `/api/party?window=${win2}`)).currentPartyId;
  assert(cur2again === idB, `window #2 stayed on B while window #1 moved to B (got ${cur2again})`);

  // The public workspace API still promises a complete state even when it is
  // already on that workspace. Only the sidebar's internal preparation opts
  // out of hydrating this duplicate response.
  const unchangedWorkspaceState = await post(base, `/api/windows/${encodeURIComponent(win1)}/workspace`, { workspacePath: ws });
  assert(
    unchangedWorkspaceState?.workspace?.uri === ws && Array.isArray(unchangedWorkspaceState?.party?.members),
    "same-workspace public API still returns its documented fresh state",
  );

  // Cross-workspace routing regression: identical party names are legal, but
  // opening must use the exact workspace + id pair. An id from this workspace
  // must never silently fall back to the current party in another workspace.
  const otherWindow = await post(base, "/api/windows", { workspacePath: otherWs });
  const otherWindowId = otherWindow?.id;
  assert(Boolean(otherWindowId), "opened a window on a second workspace");
  const sameNameHere = (await post(base, `/api/parties?window=${win1}`, { name: "SAME-PARTY-NAME" }))?.currentPartyId;
  const sameNameThere = (await post(base, `/api/parties?window=${otherWindowId}`, { name: "SAME-PARTY-NAME" }))?.currentPartyId;
  assert(Boolean(sameNameHere && sameNameThere && sameNameHere !== sameNameThere), "same party name can exist in two workspaces with distinct ids");

  // The app-global grouped sidebar can point at a party outside this window's
  // current workspace. Exercise the actual renderer click: it must let the main
  // process make the authoritative same/different-workspace decision, route the
  // selection, and replace the renderer's old workspace state.
  // `otherWindow` is the focused window after opening it. Drive that real
  // foreground surface back to the original workspace's party.
  const switchWindowId = otherWindowId;
  const measureInSwitchWindow = (selector, body = {}) => post(
    base,
    `/api/measure?window=${encodeURIComponent(switchWindowId)}`,
    { selector, ...body },
  );
  const sourceWorkspace = await waitFor(
    () => measureInSwitchWindow(".screen-repo"),
    (measurement) => measurement?.elements?.[0]?.text === otherWs,
  );
  assert(sourceWorkspace?.elements?.[0]?.text === otherWs, `source renderer finished its initial workspace load (${sourceWorkspace?.elements?.[0]?.text})`);
  const crossPartySelector = `.wb-party-row[data-party-id=${JSON.stringify(sameNameHere)}]`;
  const crossGroupSelector = `.wb-party-group:has(${crossPartySelector}) > .wb-group-row`;
  const registeredRow = await waitFor(
    () => measureInSwitchWindow(crossPartySelector),
    (measurement) => measurement?.elements?.length === 1,
    100,
  );
  assert(registeredRow?.elements?.length === 1, "cross-workspace party reached the grouped sidebar");
  const crossGroup = await measureInSwitchWindow(crossGroupSelector, {
    attributes: ["aria-expanded"],
  });
  if (crossGroup?.elements?.[0]?.attributes?.["aria-expanded"] !== "true") {
    await post(base, `/api/qa/pointer?window=${encodeURIComponent(switchWindowId)}`, {
      steps: [{ selector: crossGroupSelector, action: "click" }],
      delayMs: 0,
    });
  }
  const visibleRow = await waitFor(
    () => measureInSwitchWindow(crossPartySelector),
    (measurement) => measurement?.elements?.[0]?.box?.height > 0,
    40,
  );
  assert(visibleRow?.elements?.[0]?.box?.height > 0, "cross-workspace party row is visible before the real click");
  const pointer = await post(base, `/api/qa/pointer?window=${encodeURIComponent(switchWindowId)}`, {
    steps: [{ selector: crossPartySelector, action: "click" }],
    delayMs: 0,
  });
  assert(pointer?.ok === true, "real pointer click reached the cross-workspace party row");
  const routed = await waitFor(async () => ({
    window: ((await get(base, "/api/windows")).windows || []).find((entry) => entry.id === switchWindowId),
    partyId: (await get(base, `/api/party?window=${switchWindowId}`)).currentPartyId,
  }), (value) => value.window?.workspacePath === ws && value.partyId === sameNameHere, 400);
  const renderedWorkspace = await waitFor(
    () => measureInSwitchWindow(".screen-repo"),
    (measurement) => measurement?.elements?.[0]?.text === ws,
  );
  const routedWindow = routed?.window;
  const routedParty = routed?.partyId;
  assert(routedWindow?.workspacePath === ws, `sidebar click moved the window to the party's workspace (${routedWindow?.workspacePath})`);
  assert(routedParty === sameNameHere, `sidebar click selected the exact cross-workspace party (${routedParty})`);
  assert(renderedWorkspace?.elements?.[0]?.text === ws, `renderer applied the destination workspace state (${renderedWorkspace?.elements?.[0]?.text})`);

  const exactWindow = await post(base, "/api/windows", { workspacePath: ws, partyId: sameNameHere });
  const exactParty = (await get(base, `/api/party?window=${exactWindow?.id}`)).currentPartyId;
  assert(exactParty === sameNameHere, `valid workspace + party id opens the exact party (got ${exactParty})`);

  const beforeMismatch = (await get(base, "/api/windows")).windows?.length || 0;
  const mismatch = await postRaw(base, "/api/windows", { workspacePath: otherWs, partyId: sameNameHere });
  const afterMismatch = (await get(base, "/api/windows")).windows?.length || 0;
  assert(mismatch.status === 500 && /does not exist in workspace/.test(mismatch.body?.error || ""), "cross-workspace party id is rejected visibly");
  assert(afterMismatch === beforeMismatch, "rejected workspace + party id does not create an orphan window");
} catch (error) {
  console.error(error);
  failures.push(String(error?.message || error));
} finally {
  kill(proc.pid);
  await delay(500);
  for (const p of [ud, ws, otherWs]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
}

console.log("");
if (failures.length) { console.log(`TWO-WINDOW PARTY E2E FAILED: ${failures.length}`); process.exit(1); }
console.log("TWO-WINDOW PARTY E2E PASSED (one process, two windows, independent active parties)");
process.exit(0);
