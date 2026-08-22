/* Full-process, offline E2E for window-scoped composer drafts. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ap-draft-e2e-ws-"));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ap-draft-e2e-ud-"));
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let base = "";

const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), `--workspace=${ws}`], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    AGENTPARTY_QA: "1",
    AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
    AGENTPARTY_USER_DATA: userData,
    AGENTPARTY_WINDOW_DISPLAY: "left",
  },
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  await waitForApi();
  const windows = (await get("/api/windows")).windows || [];
  const win1 = windows[0]?.id;
  assert(Boolean(win1), "real app window is available");

  const partyA = await post("/api/qa/seed", { party: "draft-A", members: [
    { name: "alpha", role: "draft e2e", autoReply: false },
    { name: "beta", role: "draft e2e", autoReply: false },
    { name: "gamma", role: "draft e2e", autoReply: false },
  ] });
  const idA = partyA.currentPartyId;
  const partyB = await post("/api/qa/seed", { party: "draft-B", members: [
    { name: "alpha", role: "same name, another party", autoReply: false },
  ] });
  const idB = partyB.currentPartyId;
  assert(Boolean(idA && idB && idA !== idB), "two isolated parties were seeded");

  await select(win1, idA);
  await post(q(win1, "/api/navigation"), { view: "workbench" });
  await open(win1, [["alpha"]]);
  await input(win1, { text: "A-window-one" });

  await pointer(win1, ".wb-party-drawer .wb-drawer-head .wb-icon-btn");
  await pointer(win1, ".wb-drawer-rail.is-party");
  assert(await draftIs(win1, "A-window-one"), "party drawer collapse and expand preserves the draft");
  await pointer(win1, ".wb-member-drawer .wb-drawer-head .wb-icon-btn");
  await pointer(win1, ".wb-drawer-rail.is-member");
  assert(await draftIs(win1, "A-window-one"), "member drawer collapse and expand preserves the draft");

  await post(q(win1, "/api/navigation"), { view: "runtime" });
  await post(q(win1, "/api/navigation"), { view: "workbench" });
  assert(await draftIs(win1, "A-window-one"), "menu round trip preserves the draft");
  await post(q(win1, "/api/qa/window/bounds"), { width: 1100, height: 760 });
  await post(q(win1, "/api/qa/window/bounds"), { width: 1450, height: 900 });
  assert(await draftIs(win1, "A-window-one"), "window resize preserves the draft");

  await open(win1, []);
  await open(win1, [["alpha"]]);
  assert(await draftIs(win1, "A-window-one"), "closing and reopening the member tab restores the draft");

  await open(win1, [["beta"]]);
  await input(win1, { text: "beta-private" });
  await open(win1, [["gamma"], ["alpha", "beta"]]);
  await open(win1, [["alpha"], ["gamma", "beta"]]);
  assert(await draftIs(win1, "A-window-one"), "member switching and tab/panel reordering restores the selected member draft");
  await open(win1, [["beta"]]);
  assert(await draftIs(win1, "beta-private"), "another member keeps its own draft after reordering");

  await select(win1, idB);
  await open(win1, [["alpha"]]);
  assert(await draftIs(win1, ""), "same-named member in another party starts empty");
  await input(win1, { text: "B-window-one" });
  await select(win1, idA);
  await open(win1, [["alpha"]]);
  assert(await draftIs(win1, "A-window-one"), "party selection round trip restores only the original party's draft");

  const opened = await post("/api/windows", { workspacePath: ws });
  const win2 = opened.id;
  await select(win2, idA);
  await post(q(win2, "/api/navigation"), { view: "workbench" });
  await open(win2, [["alpha"]]);
  assert(await draftIs(win2, ""), "a second window does not receive the first window's draft");
  await input(win2, { text: "A-window-two" });
  assert(await draftIs(win1, "A-window-one"), "typing in the second window does not alter the first window");

  await post(q(win1, "/api/qa/members/alpha/emit"), { events: [{ type: "status", status: "responding" }], status: "working" });
  await input(win1, { key: "Enter", modifiers: ["control"] });
  await delay(400);
  assert(await draftIs(win1, ""), "successful queued send clears only the current target");
  await open(win1, [["beta"]]);
  assert(await draftIs(win1, "beta-private"), "queued send leaves another member's draft intact");

  await post(q(win1, "/api/party/members/beta/remove"), {});
  await post(q(win1, "/api/qa/members"), { name: "beta", role: "recreated", autoReply: false });
  await open(win1, [["beta"]]);
  assert(await draftIs(win1, ""), "actual member deletion followed by recreation does not revive the old draft");

  await post(q(win1, "/api/window/close"), {});
  await post(q(win2, "/api/window/close"), {}).catch(() => {});
  await waitForExit(child);
  console.log(failures.length ? `\nCOMPOSER DRAFT E2E FAILED (${failures.length})` : "\nCOMPOSER DRAFT E2E PASSED");
  process.exit(failures.length ? 1 : 0);
} catch (error) {
  console.error(error);
  if (base) {
    try {
      const live = (await get("/api/windows")).windows || [];
      for (const window of live) await post(q(window.id, "/api/window/close"), {}).catch(() => {});
    } catch {}
  }
  process.exitCode = 1;
}

function q(windowId, endpoint) {
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}window=${encodeURIComponent(windowId)}`;
}
async function select(windowId, partyId) {
  await post(q(windowId, `/api/parties/${encodeURIComponent(partyId)}/select`), {});
  await delay(250);
}
async function open(windowId, panels) {
  await post(q(windowId, "/api/qa/open"), { panels });
  if (panels.flat().length) await waitForEditor(windowId);
  else await delay(200);
}
async function input(windowId, body) {
  return post(q(windowId, "/api/qa/input"), { selector: ".wb-composer-editor", ...body });
}
async function draftIs(windowId, expected) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const state = await input(windowId, {}).catch(() => null);
    if (state?.draft === expected) return true;
    await delay(100);
  }
  return false;
}
async function waitForEditor(windowId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const state = await input(windowId, {});
      if (typeof state?.draft === "string") return state;
    } catch {}
    await delay(100);
  }
  throw new Error(`composer did not render in window ${windowId}`);
}
async function pointer(windowId, selector) {
  await post(q(windowId, "/api/qa/pointer"), { steps: [{ selector, action: "click" }], delayMs: 0 });
  await delay(200);
}
async function waitForApi() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    base = firstBaseUrl(ws);
    if (base) {
      try { if ((await get("/api/health")).ok) return; } catch {}
    }
    await delay(500);
  }
  throw new Error("automation API did not start");
}
async function get(endpoint) {
  const response = await fetch(base + endpoint);
  if (!response.ok) throw new Error(`${endpoint} returned ${response.status}: ${await response.text()}`);
  return response.json();
}
async function post(endpoint, body) {
  const response = await fetch(base + endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`${endpoint} returned ${response.status}: ${await response.text()}`);
  return response.json();
}
function waitForExit(process) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("app did not exit")), 10_000);
    process.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}
