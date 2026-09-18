/*
 * Real-app regression for party ordering and active-party reveal.
 *
 * Runs the shipping Electron renderer, AppController, HTTP capability and disk
 * store. Parties are QA fixtures with no members, so no model/provider call is
 * made and there is no test-only product path for either behavior.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, delay, removePath } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = `agentparty-party-order-${process.pid}-${Date.now()}`;
const workspace = path.join(os.tmpdir(), `${token}-workspace`);
const userData = path.join(os.tmpdir(), `${token}-user-data`);
const port = 46400 + Math.floor(Math.random() * 500);
const app = createElectronE2eApp({ root, workspace, userData, port, args: ["--remote-debugging-port=0"] });
const failures = [];
let cdp;

const assert = (condition, message, detail = "") => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}${detail ? ` (${detail})` : ""}`);
  if (!condition) failures.push(message);
};
const windows = async () => (await app.get("/api/windows")).windows || [];
const measure = (windowId, selector, body = {}) => app.post(
  `/api/measure?window=${encodeURIComponent(windowId)}`,
  { selector, ...body },
);
const maybeMeasure = async (...args) => {
  try { return await measure(...args); } catch { return { count: 0, elements: [] }; }
};
const waitFor = async (probe, match, attempts = 160) => {
  let value;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    value = await probe();
    if (match(value)) return value;
    await delay(50);
  }
  return value;
};
const rowSelector = (partyId) => `.wb-party-row[data-party-id=${JSON.stringify(partyId)}]`;

try {
  await app.prepare();
  await app.launch();
  const windowId = (await windows())[0]?.id;
  assert(Boolean(windowId), "the real app opened a window");
  await app.post(`/api/qa/window/bounds?window=${encodeURIComponent(windowId)}`, { width: 1120, height: 700 });
  const initialGroups = await app.get("/api/party-groups");
  const defaultGroup = initialGroups.groups.find((group) => group.kind === "default");
  assert(Boolean(defaultGroup), "the default party group is available");

  const partyIds = [];
  for (let index = 0; index < 20; index += 1) {
    const seeded = await app.post(`/api/qa/seed?window=${encodeURIComponent(windowId)}`, {
      party: `ORDER-${String(index).padStart(2, "0")}`,
      members: [],
    });
    partyIds.push(seeded.currentPartyId);
    // QA seed deliberately creates the smallest possible party and carries no
    // group filing. File it through the production capability before testing
    // ordering; real UI creation already supplies this group id.
    await app.post(`/api/parties/${encodeURIComponent(seeded.currentPartyId)}/group`, { groupId: defaultGroup.id });
  }
  await app.post(`/api/navigation?window=${encodeURIComponent(windowId)}`, { view: "workbench" });
  const listed = await waitFor(
    () => app.get("/api/party-groups"),
    (state) => {
      const fallback = state.groups?.find((group) => group.kind === "default")?.id;
      return Boolean(fallback) && partyIds.every((id) => state.parties?.some((party) => party.id === id && party.groupId === fallback));
    },
    300,
  );
  assert(
    partyIds.every((id) => listed.parties.some((party) => party.id === id && party.groupId === defaultGroup?.id)),
    "all QA parties finished registry reconciliation before interaction",
    `default=${defaultGroup?.id} actual=${[...new Set(listed.parties.map((party) => party.groupId))].join(",")}`,
  );
  await waitFor(() => maybeMeasure(windowId, ".wb-party-row"), (result) => result.count >= partyIds.length);

  console.log("\nSelected party reveal:");
  await measure(windowId, ".wb-party-scroll", { scroll: { selector: ".wb-party-scroll", to: "top" } });
  const selectedId = partyIds.at(-2);
  await app.post(`/api/parties/${encodeURIComponent(selectedId)}/select?window=${encodeURIComponent(windowId)}`, {});
  const revealed = await waitFor(
    () => measure(windowId, ".wb-party-scroll"),
    (result) => Number(result.elements?.[0]?.scroll?.top || 0) > 0,
  );
  assert(Number(revealed.elements?.[0]?.scroll?.top || 0) > 0, "selecting a lower party scrolls the party drawer to it");

  cdp = await attachRenderer(userData);
  const visibleSelection = await cdp.eval(`(() => {
    const box = document.querySelector(".wb-party-scroll");
    const row = [...document.querySelectorAll(".wb-party-row[data-party-id]")]
      .find((entry) => entry.dataset.partyId === ${JSON.stringify(selectedId)} && entry.offsetParent !== null);
    if (!(box instanceof HTMLElement) || !(row instanceof HTMLElement)) return undefined;
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return { visible: r.top >= b.top && r.bottom <= b.bottom, active: row.classList.contains("is-active") };
  })()`);
  assert(visibleSelection?.visible && visibleSelection?.active, "the selected party row is fully visible and marked active");

  console.log("\nDrag order inside one group:");
  await app.post(`/api/parties/${encodeURIComponent(partyIds[0])}/select?window=${encodeURIComponent(windowId)}`, {});
  await measure(windowId, ".wb-party-scroll", { scroll: { selector: ".wb-party-scroll", to: "top" } });
  const dragged = partyIds[2];
  const target = partyIds[0];
  const started = await cdp.eval(`(() => {
    const source = document.querySelector(${JSON.stringify(rowSelector(dragged))});
    if (!(source instanceof HTMLElement)) return undefined;
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    return { draggable: source.draggable, types: [...transfer.types] };
  })()`);
  assert(started?.draggable && started?.types?.includes("application/x-agentparty-party"), "party rows expose the production native drag payload");
  await delay(80);
  const beforeDrag = await app.get("/api/party-groups");
  const storedDefaultIds = beforeDrag.parties.filter((party) => party.groupId === defaultGroup.id).map((party) => party.id);
  const renderedDefaultIds = await cdp.eval(`[...document.querySelectorAll('[data-group-id=${JSON.stringify(defaultGroup.id)}] .wb-party-row[data-party-id]')].map((row) => row.dataset.partyId)`);
  assert(
    renderedDefaultIds.every((id) => storedDefaultIds.includes(id)),
    "every rendered reorder id belongs to the same stored group",
    `extra=${renderedDefaultIds.filter((id) => !storedDefaultIds.includes(id)).join(",") || "none"}`,
  );
  const point = await cdp.eval(`(() => {
    const row = document.querySelector(${JSON.stringify(rowSelector(target))});
    if (!(row instanceof HTMLElement)) return undefined;
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + Math.max(2, r.height * .2) };
  })()`);
  if (point) {
    const data = { items: [{ mimeType: "application/x-agentparty-party", data: dragged }], dragOperationsMask: 16 };
    await cdp.drag("dragEnter", point.x, point.y, data);
    await cdp.drag("dragOver", point.x, point.y, data);
    const marker = await cdp.eval(`document.querySelector(${JSON.stringify(rowSelector(target))})?.classList.contains("is-insert-before")`);
    assert(marker === true, "the target row shows the exact insertion position");
    await cdp.drag("drop", point.x, point.y, data);
    await cdp.eval(`document.querySelector(${JSON.stringify(rowSelector(dragged))})?.dispatchEvent(new DragEvent("dragend", { bubbles: true }))`);
  }
  const reordered = await waitFor(
    () => app.get("/api/party-groups"),
    (state) => state.parties?.filter((party) => party.groupId === defaultGroup.id)?.[0]?.id === dragged,
  );
  const order = reordered.parties.filter((party) => party.groupId === defaultGroup.id).map((party) => party.id);
  assert(order.slice(0, 3).join() === [dragged, target, partyIds[1]].join(), "dropping a party before another persists the new group-local order", order.slice(0, 3).join(","));

  const otherGroup = (await app.post("/api/party-groups", { name: "OTHER-GROUP" })).group;
  await app.post(`/api/parties/${encodeURIComponent(partyIds[18])}/group`, { groupId: otherGroup.id });
  await app.post(`/api/parties/${encodeURIComponent(partyIds[19])}/group`, { groupId: otherGroup.id });
  const otherOrderBefore = (await app.get("/api/party-groups")).parties.filter((party) => party.groupId === otherGroup.id).map((party) => party.id);
  await app.post(`/api/party-groups/${encodeURIComponent(defaultGroup.id)}/parties/reorder`, { order: [target, dragged] });
  const apiOrdered = await app.get("/api/party-groups");
  assert(apiOrdered.parties.filter((party) => party.groupId === defaultGroup.id).slice(0, 2).map((party) => party.id).join() === [target, dragged].join(), "the public automation API uses the same reorder controller");
  assert(apiOrdered.parties.filter((party) => party.groupId === otherGroup.id).map((party) => party.id).join() === otherOrderBefore.join(), "reordering one group leaves every other group untouched");

  console.log("\nPersistence and favourite-first reveal:");
  cdp.close();
  cdp = undefined;
  await app.close();
  await app.launch();
  const restartedWindowId = (await windows())[0]?.id;
  const persisted = await app.get("/api/party-groups");
  assert(persisted.parties.filter((party) => party.groupId === defaultGroup.id).slice(0, 2).map((party) => party.id).join() === [target, dragged].join(), "party order survives an app restart");

  await app.post(`/api/navigation?window=${encodeURIComponent(restartedWindowId)}`, { view: "workbench" });
  await app.post(`/api/parties/${encodeURIComponent(partyIds[0])}/select?window=${encodeURIComponent(restartedWindowId)}`, {});
  const favoriteId = partyIds.at(-3);
  await app.post("/api/settings", {
    favoriteParties: [favoriteId],
    sidebarGroupFolds: { party: ["favorites"], member: [] },
  });
  await waitFor(() => maybeMeasure(restartedWindowId, '[data-group-id="favorites"]'), (result) => result.count === 1);
  await measure(restartedWindowId, ".wb-party-scroll", { scroll: { selector: ".wb-party-scroll", to: "bottom" } });
  await app.post(`/api/parties/${encodeURIComponent(favoriteId)}/select?window=${encodeURIComponent(restartedWindowId)}`, {});
  const openedFavorite = await waitFor(
    () => maybeMeasure(restartedWindowId, '[data-group-id="favorites"] > .wb-group-row', { attributes: ["aria-expanded"] }),
    (result) => result.elements?.[0]?.attributes?.["aria-expanded"] === "true",
  );
  assert(openedFavorite.elements?.[0]?.attributes?.["aria-expanded"] === "true", "selecting a favourite opens its folded favourite group");

  cdp = await attachRenderer(userData);
  const favoriteReveal = await waitFor(
    () => cdp.eval(`(() => {
      const box = document.querySelector(".wb-party-scroll");
      const rows = [...document.querySelectorAll(".wb-party-row[data-party-id]")]
        .filter((entry) => entry.dataset.partyId === ${JSON.stringify(favoriteId)});
      const favorite = rows.find((entry) => entry.closest(".wb-party-group")?.dataset.groupId === "favorites");
      if (!(box instanceof HTMLElement) || !(favorite instanceof HTMLElement) || favorite.offsetParent === null) return undefined;
      const b = box.getBoundingClientRect();
      const r = favorite.getBoundingClientRect();
      return { count: rows.length, visible: r.top >= b.top && r.bottom <= b.bottom, scrollTop: box.scrollTop };
    })()`),
    (value) => value?.count === 2 && value.visible,
  );
  assert(favoriteReveal?.count === 2 && favoriteReveal?.visible, "a starred selection reveals the favourite mirror, not its lower original row");
} catch (error) {
  console.error(error);
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  cdp?.close();
  await app.close().catch(() => app.kill());
  for (const target of [workspace, userData]) {
    await removePath(target).catch(() => {});
  }
}

console.log("");
if (failures.length) {
  console.log(`PARTY ORDER + REVEAL E2E FAILED (${failures.length})`);
  process.exit(1);
}
console.log("PARTY ORDER + REVEAL E2E PASSED");

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
      await send("Input.dispatchDragEvent", { type, x: Math.round(x), y: Math.round(y), data });
    },
    close() { socket.close(); },
  };
}
