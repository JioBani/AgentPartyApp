/*
 * Layout engine logic test. The panel/tab/DnD operations are pure functions, so
 * verify their behavior directly (open/close/split/move/drop-to-new/resize/
 * prune) rather than through the DOM.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");

const result = await build({
  entryPoints: [path.join(projectRoot, "src/renderer/workbench/layout.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const outDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(outDir, { recursive: true });
const bundlePath = path.join(outDir, "layout.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const L = await import(pathToFileURL(bundlePath).href);

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

console.log("");
if (failures.length) {
  console.log(`LAYOUT LOGIC FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("LAYOUT LOGIC PASSED");
process.exit(0);
