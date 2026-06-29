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
  width: 240, routes: [], defaultProfile: { harness: "claude-code", model: "sonnet", effort: "medium", permissionMode: "default" },
  onSelectParty: () => {}, onCreateParty: () => {}, onCreateMember: () => {}, onOpenMember: () => {},
  onRemoveMember: (name) => removed.push(name), onCollapse: () => {},
};
reactDom.createRoot(document.getElementById("root")).render(React.createElement(PartySidebar, props));
await new Promise((r) => setTimeout(r, 80));

const click = (el) => el?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const rightClick = (el) => el?.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 50 }));
const rows = [...document.querySelectorAll(".wb-member-row")];
const rowFor = (name) => rows.find((row) => row.querySelector(".wb-member-name")?.textContent === name);
const tick = () => new Promise((r) => setTimeout(r, 30));

console.log("\nMember-remove (right-click context menu) assertions:");
assert(rows.length === 2, "both members rendered");

// Right-click 'main' → no menu (main is not removable).
rightClick(rowFor("main")); await tick();
assert(!document.querySelector(".wb-ctx-menu"), "right-click on 'main' shows no context menu");

// Right-click 'alice' → a context menu with a delete item appears; no removal yet.
rightClick(rowFor("alice")); await tick();
const ctx = document.querySelector(".wb-ctx-menu");
assert(Boolean(ctx), "right-click on 'alice' opens a context menu");
const del = ctx && [...ctx.querySelectorAll(".wb-ctx-item")].find((b) => /삭제하기/.test(b.textContent || ""));
assert(Boolean(del), "context menu shows a '삭제하기' item");
assert(removed.length === 0, "opening the menu does not remove anything yet");

// Click '삭제하기' → onRemoveMember('alice'), menu closes.
click(del); await tick();
assert(removed.length === 1 && removed[0] === "alice", "clicking '삭제하기' calls onRemoveMember('alice')");
assert(!document.querySelector(".wb-ctx-menu"), "menu closes after deleting");

console.log(failures.length ? `\nMEMBER REMOVE FAILED (${failures.length})` : "\nMEMBER REMOVE PASSED");
process.exit(failures.length ? 1 : 0);
