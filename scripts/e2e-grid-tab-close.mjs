/*
 * Full-process e2e: closing a tab must not rearrange the grid.
 *
 * `closeTab` used to drop the panel's grid slot on EVERY close, not only when
 * the panel actually went away. A panel that survived lost its leaf, the split
 * collapsed for want of a second child, and the reconcile re-appended the panel
 * to the outermost row — so closing one tab of two flattened a nested grid into
 * a single row and reordered it. Repeat it and every nesting is gone.
 *
 * qa-layout covers the same thing on the pure functions. This drives the real
 * window: a grid built through the layout API, a tab closed by clicking its ✕,
 * and the shape read back from both the persisted layout and the live DOM —
 * because the bug was only ever visible as "my split view jumped back to a row".
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-grid-close-ws");
const userData = path.join(os.tmpdir(), "agentparty-grid-close-ud");
const port = Number(process.env.AGENTPARTY_GRID_CLOSE_PORT || "") || 48991;
const base = `http://127.0.0.1:${port}`;
const outDir = process.env.AGENTPARTY_GRID_CLOSE_OUT || os.tmpdir();
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(u) { const r = await fetch(`${base}${u}`); return r.json(); }
async function post(u, b) {
  const r = await fetch(`${base}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
  return r.json();
}
async function waitForApi() {
  for (let i = 0; i < 120; i++) { try { if ((await getJson("/api/health")).ok) return true; } catch {} await delay(500); }
  throw new Error("API never came up");
}
function killTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }

/** One-line shape of a grid tree, so before/after compare at a glance. */
function shape(node, ids) {
  if (!node) return "(none)";
  if (node.type === "leaf") return `L${ids.indexOf(node.panelId)}`;
  return `${node.dir}(${node.children.map((c) => shape(c, ids)).join(",")})`;
}
async function layout() { return (await getJson("/api/party/layout")).layout; }
async function countOf(selector) {
  const res = await post("/api/measure", { selector, limit: 10 });
  return Array.isArray(res.elements) ? res.elements.length : 0;
}

async function main() {
  for (const p of [ws, userData]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  fs.mkdirSync(ws, { recursive: true });

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root, stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
    env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_AUTOMATION_PORT: String(port), AGENTPARTY_USER_DATA: userData, AGENTPARTY_WINDOW_DISPLAY: "left" },
  });

  try {
    await waitForApi();
    const windowId = (await getJson("/api/windows")).windows?.[0]?.id;
    assert(Boolean(windowId), "test window discovered");
    await post(`/api/windows/${encodeURIComponent(windowId)}/workspace`, { workspacePath: ws });

    await post("/api/qa/seed", {
      party: "grid",
      members: ["a", "b", "c", "d"].map((n) => ({ name: n, role: "r", model: "sonnet", status: "idle" })),
    });
    await post("/api/navigation", { view: "workbench" });
    // Panel 0 gets two tabs, so its ✕ closes a tab without removing the panel.
    await post("/api/qa/open", { panels: [["a", "d"], ["b"], ["c"]] });
    await delay(900);

    const flat = await layout();
    const ids = flat.panels.map((p) => p.id);
    assert(ids.length === 3, `three panels seeded (got ${ids.length})`);
    assert(flat.panels[0].tabs.length === 2, "the first panel holds two tabs");

    // A nested grid: a column of two panels beside a third.
    await post("/api/party/layout", { layout: { ...flat, grid: {
      type: "split", id: "split-root", dir: "row", weight: 1,
      children: [
        { type: "split", id: "split-left", dir: "column", weight: 1, children: [
          { type: "leaf", panelId: ids[0], weight: 1 },
          { type: "leaf", panelId: ids[1], weight: 1 },
        ] },
        { type: "leaf", panelId: ids[2], weight: 1 },
      ],
    } } });
    await delay(700);

    const before = await layout();
    const nested = shape(before.grid, ids);
    assert(nested === "row(column(L0,L1),L2)", `nested grid is in place (${nested})`);
    assert(await countOf(".wb-split") === 2, "the DOM shows two nested splits");
    await post("/api/capture", { path: path.join(outDir, "grid-before.png") });

    // --- closing a NON-last tab: the panel survives, so must the grid --------
    const clicked = await post("/api/capture", {
      path: path.join(outDir, "grid-after-tab.png"),
      click: `[data-panel-id="${ids[0]}"] .wb-tab-close`,
    });
    assert(clicked.ok, "clicked a tab's close button in the real UI");
    await delay(700);

    const afterTab = await layout();
    assert(afterTab.panels.length === 3, `closing a non-last tab removed no panel (${afterTab.panels.length})`);
    assert(afterTab.panels.find((p) => p.id === ids[0])?.tabs.length === 1,
      "the tab really was closed, so the shape check below is not vacuous");
    assert(shape(afterTab.grid, ids) === nested,
      `REGRESSION TARGET: the grid is unchanged (${shape(afterTab.grid, ids)})`);
    assert(await countOf(".wb-split") === 2, "the DOM still shows two nested splits");

    // --- closing the LAST tab: the panel goes, its split collapses ----------
    await post("/api/capture", {
      path: path.join(outDir, "grid-after-panel.png"),
      click: `[data-panel-id="${ids[1]}"] .wb-tab-close`,
    });
    await delay(700);

    const afterPanel = await layout();
    assert(afterPanel.panels.length === 2, `closing the last tab removed its panel (${afterPanel.panels.length})`);
    assert(shape(afterPanel.grid, ids) === "row(L0,L2)",
      `the emptied slot's split collapsed and freed its space (${shape(afterPanel.grid, ids)})`);

    await post("/api/window/close", {});
  } catch (error) {
    console.error(error);
    failures.push(String(error?.message || error));
  } finally {
    killTree(child.pid);
    await delay(500);
    for (const p of [ws, userData]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  }

  console.log("");
  if (failures.length) { console.log(`GRID TAB CLOSE E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("GRID TAB CLOSE E2E PASSED");
  process.exit(0);
}

main();
