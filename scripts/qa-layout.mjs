/*
 * Layout engine logic test. The panel/tab/DnD operations are pure functions, so
 * verify their behavior directly (open/close/split/move/drop-to-new/resize/
 * prune) rather than through the DOM.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");

const result = await build({
  entryPoints: [path.join(projectRoot, "src/renderer/workbench/layout.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});

const outDir = qaTempDir();
const bundlePath = path.join(outDir, "layout.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const L = await import(pathToFileURL(bundlePath).href);

// The shared module is bundled separately so the sanitize/adoption path (what a
// stored or broadcast layout goes through) is exercised as its own entry point.
const sharedResult = await build({
  entryPoints: [path.join(projectRoot, "src/shared/workbenchLayout.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const sharedPath = path.join(outDir, "workbenchLayout.mjs");
writeFileSync(sharedPath, sharedResult.outputFiles[0].text);
const S = await import(pathToFileURL(sharedPath).href);

const failures = [];
function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  } else {
    console.log(`  ✓ ${message}`);
  }
}

console.log("Layout engine assertions:");

// open into empty -> single panel
let s = L.openMember(L.emptyLayout(), "backend");
assert(s.panels.length === 1 && s.panels[0].tabs.length === 1, "open into empty creates one panel/tab");
const firstPanel = s.panels[0].id;

// open second member into focused panel -> same panel, two tabs, active=new
s = L.openMember(s, "frontend");
assert(s.panels.length === 1 && s.panels[0].tabs.length === 2, "second open adds a tab to focused panel");
assert(s.panels[0].active === "frontend", "newly opened member becomes active");

// re-open existing member just focuses it
s = L.openMember(s, "backend");
assert(s.panels[0].active === "backend" && s.panels[0].tabs.length === 2, "re-open focuses existing tab, no duplicate");

// split -> new panel seeded with active member
s = L.splitPanel(s, firstPanel);
assert(s.panels.length === 2, "split creates a second panel");
assert(s.panels[1].tabs.length === 1 && s.panels[1].tabs[0] === "backend", "split seeds new panel with active member");
const secondPanel = s.panels[1].id;

// move frontend into the second panel
s = L.moveTab(s, "frontend", secondPanel);
const pa = s.panels.find((p) => p.id === firstPanel);
const pb = s.panels.find((p) => p.id === secondPanel);
assert(!pa.tabs.includes("frontend"), "moveTab removes from source panel");
assert(pb.tabs.includes("frontend") && pb.active === "frontend", "moveTab adds to target panel and activates");

// close last tab of source panel removes the panel
s = L.closeTab(s, firstPanel, "backend");
assert(!s.panels.some((p) => p.id === firstPanel) || s.panels.find((p) => p.id === firstPanel)?.tabs.length > 0, "closing only-tab drops the panel");

// resize adjusts adjacent weights and conserves their sum
let r = L.openMember(L.emptyLayout(), "a");
r = L.openMember(r, "b");
r = L.splitPanel(r, r.panels[0].id);
const [lp, rp] = r.panels;
const before = lp.weight + rp.weight;
const resized = L.resizeAt(r, lp.id, rp.id, 0.2);
const lp2 = resized.panels.find((p) => p.id === lp.id);
const rp2 = resized.panels.find((p) => p.id === rp.id);
assert(lp2.weight > lp.weight, "resize grows the left panel for a positive delta");
assert(Math.abs((lp2.weight + rp2.weight) - before) < 1e-6, "resize conserves the pair's total weight");

// resize clamps so a panel can't collapse past the minimum
const overdriven = L.resizeAt(r, lp.id, rp.id, -5);
const lp3 = overdriven.panels.find((p) => p.id === lp.id);
assert(lp3.weight > 0, "resize clamps to a positive minimum weight");

// prune drops tabs for members that no longer exist
let p = L.openMember(L.emptyLayout(), "x");
p = L.openMember(p, "y");
p = L.pruneLayout(p, new Set(["x"]));
assert(p.panels[0].tabs.length === 1 && p.panels[0].tabs[0] === "x", "prune removes tabs for missing members");

// moveTabToNewPanel pulls a tab out into its own panel
let m = L.openMember(L.emptyLayout(), "one");
m = L.openMember(m, "two");
m = L.moveTabToNewPanel(m, "two");
assert(m.panels.length === 2, "drop-to-new-panel creates an extra panel");
assert(m.panels.some((pan) => pan.tabs.length === 1 && pan.tabs[0] === "two"), "moved tab is alone in the new panel");

// openMemberInNewPanel: a created member lands in its OWN new region, not the focused panel's tabs
let n = L.openMember(L.emptyLayout(), "alpha");
n = L.openMember(n, "beta"); // alpha + beta share one panel
assert(n.panels.length === 1 && n.panels[0].tabs.length === 2, "baseline: two members in one panel");
n = L.openMemberInNewPanel(n, "spawned");
assert(n.panels.length === 2, "openMemberInNewPanel appends a new panel (new region)");
const spawnedPanel = n.panels[n.panels.length - 1];
assert(spawnedPanel.tabs.length === 1 && spawnedPanel.tabs[0] === "spawned", "new member is alone in the appended panel");
assert(n.panels[0].tabs.length === 2 && !n.panels[0].tabs.includes("spawned"), "existing panel is untouched (not merged into)");
assert(n.focusedPanelId === spawnedPanel.id && spawnedPanel.active === "spawned", "the new panel is focused with the member live");
// re-opening an already-open member just focuses it (no duplicate panel)
const reopened = L.openMemberInNewPanel(n, "alpha");
assert(reopened.panels.length === 2, "openMemberInNewPanel on an existing member does not add a panel");

const grouped = L.openMemberInTabGroup(n, "partner", n.panels[0].id);
const betaGroup = grouped?.panels.find((panel) => panel.tabs.includes("beta"));
assert(betaGroup?.tabs.join(",") === "alpha,beta,partner", "openMemberInTabGroup appends to the exact panel id");
assert(betaGroup?.active === "partner" && grouped.focusedPanelId === betaGroup.id, "targeted tab-group member becomes active and focused");
assert(L.openMemberInTabGroup(n, "lost", "closed") === undefined, "unknown/closed tab-group id is rejected without fallback");

// --- Grid geometry --------------------------------------------------------
// The panel list says WHAT is open; the grid says WHERE. These check the two
// never disagree, which is the only corruption the split tree can have.
const leafIds = (node) => (!node ? [] : node.type === "leaf" ? [node.panelId] : node.children.flatMap(leafIds));
const depthDirs = (node) => (!node || node.type === "leaf" ? [] : [node.dir, ...node.children.flatMap(depthDirs)]);

let g = L.openMember(L.emptyLayout(), "top");
g = L.openMember(g, "under");
const topPanel = g.panels[0].id;
g = L.splitPanel(g, topPanel, "bottom");
assert(g.grid?.type === "split" && g.grid.dir === "column", "split bottom stacks the panels in a column");
assert(leafIds(g.grid).length === 2, "the column holds both panels");

// a row split inside the column -> a 2x2 grid
const bottomPanel = g.panels.find((panel) => panel.id !== topPanel).id;
g = L.splitPanel(g, bottomPanel, "right");
g = L.splitPanel(g, topPanel, "right");
assert(g.panels.length === 4, "four panels after splitting both rows");
assert(depthDirs(g.grid).join(",") === "column,row,row", "2x2 grid is a column of two rows");
assert(new Set(leafIds(g.grid)).size === 4 && leafIds(g.grid).every((id) => g.panels.some((panel) => panel.id === id)),
  "every grid leaf points at a live panel, with no duplicates");
assert(g.panels.every((panel) => leafIds(g.grid).includes(panel.id)), "every panel has a slot in the grid");

// a same-axis drop becomes a SIBLING rather than nesting another split
let sib = L.openMember(L.emptyLayout(), "a");
sib = L.openMember(sib, "b");
sib = L.splitPanel(sib, sib.panels[0].id, "right");
sib = L.splitPanel(sib, sib.panels[0].id, "right");
assert(depthDirs(sib.grid).join(",") === "row", "three panels in a row stay one split, not a nested tower");
assert(sib.grid.children.length === 3, "the row holds all three side by side");

// closing a panel collapses the split it was alone in
let c = L.openMember(L.emptyLayout(), "keep");
c = L.openMember(c, "drop");
const keepPanel = c.panels[0].id;
c = L.moveTabToNewPanel(c, "drop", keepPanel, "bottom");
assert(c.grid.type === "split" && c.grid.dir === "column", "edge drop splits the panel along that edge");
const dropped = c.panels.find((panel) => panel.tabs.includes("drop"));
c = L.closeTab(c, dropped.id, "drop");
assert(c.grid.type === "leaf" && c.grid.panelId === keepPanel, "closing the last tab of a slot collapses the split back to one panel");

// resizing a column divider moves only that pair, on the vertical axis
let rz = L.openMember(L.emptyLayout(), "u");
rz = L.openMember(rz, "d");
rz = L.splitPanel(rz, rz.panels[0].id, "bottom");
const beforeTop = rz.grid.children[0].weight;
const rzed = L.resizeSplit(rz, rz.grid.id, 0, 0.2);
assert(rzed.grid.children[0].weight > beforeTop, "resizing a column divider grows the upper slot");
assert(Math.abs(rzed.grid.children[0].weight + rzed.grid.children[1].weight - 2) < 1e-6, "the column pair conserves its total weight");
const clamped = L.resizeSplit(rz, rz.grid.id, 0, -5);
assert(clamped.grid.children[0].weight > 0, "column resize clamps to a positive minimum");

// a layout stored before grids existed is still a valid one row
const legacy = S.sanitizeLayout({ panels: [
  { id: "p1", tabs: ["one"], active: "one", weight: 1 },
  { id: "p2", tabs: ["two"], active: "two", weight: 1 },
], focusedPanelId: "p1" });
assert(depthDirs(legacy.grid).join(",") === "row" && leafIds(legacy.grid).join(",") === "p1,p2",
  "a gridless (older) layout is adopted as a single left-to-right row");

// a grid that disagrees with the panels is repaired, not honoured
const repaired = S.sanitizeLayout({
  panels: [{ id: "p1", tabs: ["one"], active: "one", weight: 1 }],
  focusedPanelId: "p1",
  grid: { type: "split", id: "s1", dir: "row", weight: 1, children: [
    { type: "leaf", panelId: "p1", weight: 1 },
    { type: "leaf", panelId: "ghost", weight: 1 },
  ] },
});
assert(leafIds(repaired.grid).join(",") === "p1", "a slot for a panel that does not exist is dropped");

console.log("");
if (failures.length) {
  console.log(`LAYOUT LOGIC FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("LAYOUT LOGIC PASSED");
process.exit(0);
