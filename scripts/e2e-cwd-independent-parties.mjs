/*
 * Real-app regression for the cwd-independent party registry and its long-list
 * interaction. Offline: member content is mocked, but Electron, the renderer,
 * AppController, the HTTP API and the on-disk stores are all production paths.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, delay, removePath } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = `agentparty-cwd-independent-${process.pid}-${Date.now()}`;
const workspace = path.join(os.tmpdir(), `${token}-source`);
const otherWorkspace = path.join(os.tmpdir(), `${token}-other`);
const unopenedLegacyWorkspace = path.join(os.tmpdir(), `${token}-unopened-legacy`);
const userData = path.join(os.tmpdir(), `${token}-user-data`);
const recentCwd = path.join(workspace, "fresh-recent-cwd");
const port = 45500 + Math.floor(Math.random() * 1000);
const app = createElectronE2eApp({
  root,
  workspace,
  userData,
  port,
  args: ["--remote-debugging-port=0"],
});
const failures = [];
let cdp;

const assert = (condition, message, detail = "") => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}${detail ? ` (${detail})` : ""}`);
  if (!condition) failures.push(message);
};
const sameWindowsPath = (left, right) => String(left || "").toLowerCase() === String(right || "").toLowerCase();

const windows = async () => (await app.get("/api/windows")).windows || [];
const measure = (windowId, selector, body = {}) => app.post(
  `/api/measure?window=${encodeURIComponent(windowId)}`,
  { selector, ...body },
);
const maybeMeasure = async (...args) => {
  try { return await measure(...args); } catch { return { elements: [] }; }
};
const renderedWorkspace = async (windowId) => (
  await measure(windowId, ".app-shell", { attributes: ["data-workspace"] })
).elements?.[0]?.attributes?.["data-workspace"];
const waitFor = async (probe, match, attempts = 160) => {
  let value;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    value = await probe();
    if (match(value)) return value;
    await delay(50);
  }
  return value;
};
const postRaw = async (route, body) => {
  const response = await fetch(app.baseUrl + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return { status: response.status, body: await response.json() };
};

try {
  await app.prepare();
  fs.mkdirSync(otherWorkspace, { recursive: true });
  fs.mkdirSync(recentCwd, { recursive: true });
  const legacyPartyId = "legacy-unopened-party";
  const legacyGroupId = "default";
  const legacyPartyDir = path.join(unopenedLegacyWorkspace, ".agent_party_app", "parties", legacyPartyId);
  const now = new Date().toISOString();
  fs.mkdirSync(legacyPartyDir, { recursive: true });
  fs.writeFileSync(path.join(unopenedLegacyWorkspace, ".agent_party_app", "parties.json"), JSON.stringify({
    version: 2,
    parties: [{ id: legacyPartyId, name: "UNOPENED-LEGACY-PARTY", createdAt: now, updatedAt: now }],
    lastActivePartyId: legacyPartyId,
  }, null, 2));
  fs.writeFileSync(path.join(legacyPartyDir, "party.json"), JSON.stringify({ version: 2, members: [], messages: [] }, null, 2));
  fs.writeFileSync(path.join(userData, "party-groups.json"), JSON.stringify({
    version: 1,
    groups: [{ id: legacyGroupId, name: "Default Group", kind: "default", createdAt: now, updatedAt: now }],
    parties: [{
      id: legacyPartyId,
      groupId: legacyGroupId,
      name: "UNOPENED-LEGACY-PARTY",
      memberCount: 0,
      runningCount: 0,
      windowsCount: 0,
      wslCount: 0,
      updatedAt: now,
      workspacePath: unopenedLegacyWorkspace,
    }],
  }, null, 2));
  await app.launch();

  const firstWindow = (await windows())[0]?.id;
  await waitFor(() => renderedWorkspace(firstWindow), (value) => sameWindowsPath(value, workspace));

  console.log("\nGlobal migration from a registered, unopened cwd:");
  const importedGroups = await waitFor(
    () => app.get("/api/party-groups"),
    (value) => value.parties?.some((party) => party.id === legacyPartyId),
  );
  const importedLegacy = importedGroups.parties?.find((party) => party.id === legacyPartyId);
  assert(Boolean(importedLegacy), "a party from a registered legacy cwd is visible without opening that cwd");
  assert(importedLegacy?.groupId === legacyGroupId, "automatic global import preserves the party's group filing");
  const globalIndex = JSON.parse(fs.readFileSync(path.join(userData, "party-store", ".agent_party_app", "parties.json"), "utf8"));
  assert(globalIndex.parties.some((party) => party.id === legacyPartyId), "the unopened legacy party was copied into the global store");

  console.log("\nLive cwd preferences:");
  const sourceGroup = (await app.post("/api/party-groups", { name: "SOURCE-BOTTOM" })).group;
  for (let index = 0; index < 16; index += 1) {
    await app.post("/api/party-groups", { name: `FILLER-${String(index).padStart(2, "0")}` });
  }
  const targetGroup = (await app.post("/api/party-groups", { name: "TARGET-TOP" })).group;
  const created = await app.post(`/api/parties?window=${encodeURIComponent(firstWindow)}`, {
    name: "LONG-LIST-PARTY",
    groupId: sourceGroup.id,
    location: recentCwd,
  });
  const partyId = created.currentPartyId;
  const backendPrefs = (await app.get("/api/cwd/preferences")).preferences;
  assert(backendPrefs.windowsRecent?.some((entry) => entry.location?.cwd === recentCwd), "backend remembers the successful cwd");

  await app.post(`/api/navigation?window=${encodeURIComponent(firstWindow)}`, { view: "settings", tab: "workspace" });
  const recentRows = await waitFor(
    () => measure(firstWindow, '[data-layout-card="settings-workspace-recent-windows"] .set-cwd-path'),
    (result) => result.elements?.some((entry) => entry.text?.includes(recentCwd)),
  );
  assert(recentRows.elements?.some((entry) => entry.text?.includes(recentCwd)), "the open renderer receives the new recent cwd without a reload");

  console.log("\nLong-list party drag:");
  await app.post(`/api/navigation?window=${encodeURIComponent(firstWindow)}`, { view: "workbench" });
  await waitFor(
    // Navigation and the 18-group broadcast commit independently. A missing
    // selector during that handoff is "not rendered yet", not a failed API
    // request; keep probing until the actual groups mount.
    () => maybeMeasure(firstWindow, ".wb-party-group"),
    (result) => result.count >= 18,
  );
  const scrollAtBottom = await measure(firstWindow, ".wb-party-scroll", {
    scroll: { selector: ".wb-party-scroll", to: "bottom" },
  });
  assert(scrollAtBottom.elements?.[0]?.scrollable?.vertical === true, "the party group list is genuinely scrollable");
  assert(scrollAtBottom.elements?.[0]?.scroll?.top > 0, "the source party starts below the visible top");

  const partySelector = `.wb-party-row[data-party-id=${JSON.stringify(partyId)}]`;
  cdp = await attachRenderer(userData);
  const geometry = await cdp.eval(`(() => {
    const party = document.querySelector(${JSON.stringify(partySelector)});
    const scroll = document.querySelector(".wb-party-scroll");
    if (!(party instanceof HTMLElement) || !(scroll instanceof HTMLElement)) return undefined;
    const box = scroll.getBoundingClientRect();
    return {
      edge: { x: box.left + box.width / 2, y: box.top + 8 },
      draggable: party.draggable,
    };
  })()`);
  assert(Boolean(geometry?.draggable), "the native drag source and scroll edge are rendered");
  if (geometry) {
    const dragData = {
      items: [{ mimeType: "application/x-agentparty-party", data: partyId }],
      dragOperationsMask: 16,
    };
    await cdp.drag("dragEnter", geometry.edge.x, geometry.edge.y, dragData);
    await cdp.drag("dragOver", geometry.edge.x, geometry.edge.y, dragData);
    // A real user can hold the carried row at the edge. The scroll must keep
    // advancing even when Chromium emits no additional dragover event.
    await delay(1_800);
    // Scrolling changed which DOM node sits under the stationary pointer. Enter
    // that now-visible group explicitly before releasing the carried party.
    await cdp.drag("dragEnter", geometry.edge.x, geometry.edge.y + 1, dragData);
    await cdp.drag("dragOver", geometry.edge.x, geometry.edge.y + 1, dragData);
    const dropTarget = await cdp.eval(`(() => {
      const hit = document.elementFromPoint(${Math.round(geometry.edge.x)}, ${Math.round(geometry.edge.y + 1)});
      const group = hit?.closest(".wb-party-group");
      return {
        name: group?.querySelector(".wb-group-name")?.textContent,
        accepts: group?.classList.contains("is-drop-target"),
      };
    })()`);
    assert(dropTarget?.name === "TARGET-TOP" && dropTarget?.accepts, "the newly revealed top group accepts the held party", JSON.stringify(dropTarget));
    await cdp.drag("drop", geometry.edge.x, geometry.edge.y + 1, dragData);
  }
  const moved = await waitFor(
    () => app.get("/api/party-groups"),
    (state) => state.parties?.find((party) => party.id === partyId)?.groupId === targetGroup.id,
  );
  const scrollAfterDrag = await measure(firstWindow, ".wb-party-scroll");
  assert(scrollAfterDrag.elements?.[0]?.scroll?.top < scrollAtBottom.elements?.[0]?.scroll?.top, "holding the drag at the top edge auto-scrolls upward");
  assert(moved.parties?.find((party) => party.id === partyId)?.groupId === targetGroup.id, "the bottom party drops into the formerly unreachable top group");

  console.log("\nMalformed group order:");
  const duplicate = await postRaw("/api/party-groups/reorder", { order: [targetGroup.id, targetGroup.id] });
  const afterDuplicate = await app.get("/api/party-groups");
  assert(duplicate.status >= 400 && /duplicate id/i.test(duplicate.body?.error || ""), "a duplicate group id is rejected visibly");
  assert(afterDuplicate.groups.filter((group) => group.id === targetGroup.id).length === 1, "the rejected order leaves one target group");

  console.log("\nAtomic stale-party selection:");
  await app.post(`/api/party/members/main/close?window=${encodeURIComponent(firstWindow)}`, {}).catch(() => {});
  const secondWindow = (await app.post("/api/windows", { workspacePath: otherWorkspace })).id;
  const initialUiWorkspace = await waitFor(() => renderedWorkspace(secondWindow), (value) => sameWindowsPath(value, otherWorkspace));
  const initialMainWorkspace = (await windows()).find((entry) => entry.id === secondWindow)?.workspacePath;
  assert(sameWindowsPath(initialMainWorkspace, otherWorkspace), "the second window starts on its requested main-process workspace", String(initialMainWorkspace));
  assert(sameWindowsPath(initialUiWorkspace, otherWorkspace), "the second renderer starts on its requested workspace", String(initialUiWorkspace));
  const staleRow = await waitFor(
    () => maybeMeasure(secondWindow, partySelector),
    (result) => result.elements?.length === 1,
  );
  assert(staleRow.elements?.length === 1, "the registered cross-workspace party is visible in the second window");

  // Parties are Windows-global now; the current window cwd must not influence
  // which index selection validates against.
  const partyIndexPath = path.join(userData, "party-store", ".agent_party_app", "parties.json");
  const partyIndex = JSON.parse(fs.readFileSync(partyIndexPath, "utf8"));
  partyIndex.parties = partyIndex.parties.filter((party) => party.id !== partyId);
  if (partyIndex.lastActivePartyId === partyId) delete partyIndex.lastActivePartyId;
  fs.writeFileSync(partyIndexPath, JSON.stringify(partyIndex, null, 2));

  const containingGroup = `.wb-party-group:has(${partySelector}) > .wb-group-row`;
  const groupRow = await measure(secondWindow, containingGroup, { attributes: ["aria-expanded"] });
  if (groupRow.elements?.[0]?.attributes?.["aria-expanded"] !== "true") {
    await app.post(`/api/qa/pointer?window=${encodeURIComponent(secondWindow)}`, {
      steps: [{ selector: containingGroup, action: "click" }],
      delayMs: 0,
    });
  }
  await app.post(`/api/qa/pointer?window=${encodeURIComponent(secondWindow)}`, {
    steps: [{ selector: partySelector, action: "click" }],
    delayMs: 0,
  });
  const toast = await waitFor(
    () => maybeMeasure(secondWindow, ".app-toast"),
    (result) => Boolean(result.elements?.[0]?.text),
  );
  const mainWorkspace = (await windows()).find((entry) => entry.id === secondWindow)?.workspacePath;
  const uiWorkspace = await renderedWorkspace(secondWindow);
  assert(Boolean(toast.elements?.[0]?.text), "the stale party failure is visible to the user");
  assert(sameWindowsPath(mainWorkspace, otherWorkspace), "main keeps the second window on its original workspace after validation fails", String(mainWorkspace));
  assert(sameWindowsPath(uiWorkspace, otherWorkspace), "renderer and main remain on the same workspace after validation fails", String(uiWorkspace));
} catch (error) {
  console.error(error);
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  cdp?.close();
  await app.close().catch(() => app.kill());
  for (const target of [workspace, otherWorkspace, unopenedLegacyWorkspace, userData]) {
    await removePath(target).catch(() => {});
  }
}

console.log("");
if (failures.length) {
  console.log(`CWD-INDEPENDENT PARTY E2E FAILED (${failures.length})`);
  process.exit(1);
}
console.log("CWD-INDEPENDENT PARTY E2E PASSED");

async function attachRenderer(dataDir) {
  const portFile = path.join(dataDir, "DevToolsActivePort");
  const started = Date.now();
  let debugPort = 0;
  while (Date.now() - started < 30_000) {
    try {
      debugPort = Number(fs.readFileSync(portFile, "utf8").split("\n")[0].trim());
      if (debugPort > 0) break;
    } catch { /* Electron is still starting its debug server. */ }
    await delay(100);
  }
  if (!debugPort) throw new Error(`Electron never wrote ${portFile}.`);

  let target;
  while (Date.now() - started < 30_000) {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    if (target) break;
    await delay(100);
  }
  if (!target) throw new Error("No debuggable AgentParty renderer was found.");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("CDP websocket failed to open."));
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const complete = pending.get(message.id);
    if (complete) {
      pending.delete(message.id);
      complete(message);
    }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (message) => (
      message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)
    ));
    socket.send(JSON.stringify({ id, method, params }));
  });

  return {
    async eval(expression) {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(`Renderer evaluation threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      }
      return result.result.value;
    },
    async drag(type, x, y, data) {
      await send("Input.dispatchDragEvent", {
        type,
        x: Math.round(x),
        y: Math.round(y),
        data,
      });
    },
    close() {
      socket.close();
    },
  };
}
