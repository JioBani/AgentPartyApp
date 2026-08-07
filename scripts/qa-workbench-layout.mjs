/*
 * The party's tab layout — the shape the main process stores and broadcasts.
 *
 * Two things are pinned here. First, sanitising: the main process persists this
 * and must not write nonsense a renderer would then have to defend against.
 * Second, `openMemberTab`, which has two callers that must agree — a click on a
 * sidebar row and `POST /api/party/members/:name/open`. The HTTP one used to set
 * a status flag and answer "Member 'X' opened." while no tab appeared anywhere,
 * so an agent asking for a member could not get one.
 */
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = await build({
  entryPoints: [path.join(projectRoot, "src/shared/workbenchLayout.ts")],
  bundle: true, format: "esm", platform: "node", write: false, external: ["electron"],
});
const bundlePath = path.join(qaTempDir(), "workbench-layout.mjs");
writeFileSync(bundlePath, built.outputFiles[0].text);
const { EMPTY_LAYOUT, layoutsEqual, openMemberTab, panelOf, sanitizeLayout } = await import(pathToFileURL(bundlePath).href);

let failures = 0;
const assert = (condition, label, detail) => {
  console.log(`  ${condition ? "✓" : "✗"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!condition) failures += 1;
};

const two = {
  panels: [
    { id: "pa", tabs: ["main", "impl"], active: "main", weight: 1 },
    { id: "pb", tabs: ["review"], active: "review", weight: 1 },
  ],
  focusedPanelId: "pb",
};

console.log("\nOpening a member:");
const added = openMemberTab(two, "test");
assert(panelOf(added, "test")?.id === "pb", "lands in the FOCUSED panel", panelOf(added, "test")?.id);
assert(panelOf(added, "test")?.active === "test", "and becomes its frontmost tab");
assert(added.panels[0].tabs.join(",") === "main,impl", "leaving the other panel untouched", added.panels[0].tabs.join(","));

const refocused = openMemberTab(two, "impl");
assert(refocused.panels.flatMap((p) => p.tabs).filter((t) => t === "impl").length === 1, "an already-open member is not duplicated");
assert(panelOf(refocused, "impl")?.active === "impl", "it is brought to the front");
assert(refocused.focusedPanelId === "pa", "and its panel takes focus", refocused.focusedPanelId);

// The empty case is the one an HTTP caller hits on a fresh party: with no panel
// to add to, "open" must still produce a tab rather than silently do nothing.
const first = openMemberTab(EMPTY_LAYOUT, "main");
assert(first.panels.length === 1 && first.panels[0].tabs[0] === "main", "opening into an empty layout creates a panel");
assert(first.focusedPanelId === first.panels[0].id, "which is focused");

console.log("\nSanitising what gets stored:");
assert(sanitizeLayout(undefined) === undefined, "no layout at all is undefined, not an empty one");
assert(sanitizeLayout({ panels: [] })?.panels.length === 0, "but a layout with zero panels survives as itself");
// "nothing stored" and "every tab closed" are different facts: reseeding the
// second would reopen tabs the user just closed.
assert(sanitizeLayout({ panels: [] }) !== undefined, "so the two are distinguishable");

const dirty = sanitizeLayout({
  panels: [
    { id: "ok", tabs: ["a", "", 7], active: "nope", weight: "x" },
    { id: "", tabs: ["b"] },
    { id: "empty", tabs: [] },
    "not an object",
  ],
  focusedPanelId: "gone",
});
assert(dirty?.panels.length === 1, "panels without an id or tabs are dropped", `${dirty?.panels.length} kept`);
assert(dirty?.panels[0].tabs.join(",") === "a", "non-string tabs are dropped", dirty?.panels[0].tabs.join(","));
assert(dirty?.panels[0].active === "a", "an active naming no surviving tab falls back to the first");
assert(dirty?.panels[0].weight === 1, "a non-numeric weight falls back to 1");
assert(dirty?.focusedPanelId === "ok", "a focus naming no surviving panel falls back to the first", dirty?.focusedPanelId);

console.log("\nEquality (suppresses echo saves and no-op broadcasts):");
assert(layoutsEqual(two, JSON.parse(JSON.stringify(two))), "same content is equal");
assert(!layoutsEqual(two, added), "a new tab is not");
assert(layoutsEqual(undefined, undefined), "and two absences are equal");

console.log("");
if (failures) {
  console.log(`WORKBENCH LAYOUT FAILED (${failures})`);
  process.exit(1);
}
console.log("WORKBENCH LAYOUT PASSED");
