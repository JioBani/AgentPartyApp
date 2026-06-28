/*
 * Regression for the Workbench sidebar member-remove control: each member
 * (except 'main') has a trash button with a two-click confirm; the first click
 * arms, the second calls onRemoveMember. 'main' is not removable.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const def = (n, v) => { try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {} };
def("window", window); def("document", window.document); def("HTMLElement", window.HTMLElement);
def("getComputedStyle", window.getComputedStyle.bind(window));
def("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0)); def("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;

const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });
const r = await build({ entryPoints: [path.join(projectRoot, "src/renderer/workbench/PartySidebar.tsx")], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], write: false });
const bundlePath = path.join(outDir, "sidebar-remove.mjs"); writeFileSync(bundlePath, r.outputFiles[0].text);
const { PartySidebar } = await import(pathToFileURL(bundlePath).href);
const React = await import("react");
const reactDom = await import("react-dom/client");

const mkView = (name) => ({ name, color: "#888", member: { name, partyId: "p1", status: "idle", runtime: "claude-code", role: "" }, status: "idle", unread: 0, pendingApproval: false, busy: false, model: "sonnet", effort: "medium", permissionMode: "default", transcript: [] });
let removed = [];
const props = {
  parties: [{ id: "p1", name: "P", createdAt: "", updatedAt: "" }], activePartyId: "p1", activePartyName: "P",
  views: [mkView("main"), mkView("alice")], openMembers: new Set(), workingByParty: { p1: 0 }, memberCountByParty: { p1: 2 },
  width: 240, routes: [], onSelectParty: () => {}, onCreateParty: () => {}, onCreateMember: () => {}, onOpenMember: () => {},
  onRemoveMember: (name) => removed.push(name), onCollapse: () => {},
};
reactDom.createRoot(document.getElementById("root")).render(React.createElement(PartySidebar, props));
await new Promise((r) => setTimeout(r, 80));

const click = (el) => el?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const rows = [...document.querySelectorAll(".wb-member-row")];
const rowFor = (name) => rows.find((row) => row.querySelector(".wb-member-name")?.textContent === name);

console.log("\nMember-remove sidebar assertions:");
assert(rows.length === 2, "both members rendered");
assert(!rowFor("main")?.querySelector(".wb-member-remove"), "'main' has no remove control");
const aliceRemove = rowFor("alice")?.querySelector(".wb-member-remove");
assert(Boolean(aliceRemove), "'alice' has a remove control");

click(aliceRemove); await new Promise((r) => setTimeout(r, 30));
assert(removed.length === 0, "first click does NOT remove (arms instead)");
assert(Boolean(rowFor("alice")?.querySelector(".wb-member-remove.is-armed")), "first click arms the control");

click(rowFor("alice").querySelector(".wb-member-remove")); await new Promise((r) => setTimeout(r, 30));
assert(removed.length === 1 && removed[0] === "alice", "second click calls onRemoveMember('alice')");

console.log(failures.length ? `\nMEMBER REMOVE FAILED (${failures.length})` : "\nMEMBER REMOVE PASSED");
process.exit(failures.length ? 1 : 0);
