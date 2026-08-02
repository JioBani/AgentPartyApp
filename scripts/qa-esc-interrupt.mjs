/*
 * Esc turn interrupt (R-12) with popup-first priority (R-13), jsdom.
 *
 * Escape on a focused busy panel interrupts that member. The same key with an
 * Escape-owning popup open must close the popup and leave the turn alone.
 *
 * Writes its bundle under node_modules/.qa — only run when main has granted
 * this lane the unit-test slot (shared .qa collision).
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log("  " + (c ? "PASS" : "FAIL") + " " + m); if (!c) failures.push(m); };

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const def = (n, v) => { try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {} };
def("window", window); def("document", window.document); def("HTMLElement", window.HTMLElement);
def("getComputedStyle", window.getComputedStyle.bind(window));
def("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0)); def("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;

const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });
async function bundle(entry, name, external = []) {
  const r = await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true, format: "esm", platform: "browser", jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"development"' },
    external, write: false,
  });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}

const pop = await bundle("src/renderer/workbench/workbenchPopups.ts", "workbench-popups.mjs", []);
const { workbenchPopupOpen } = pop;

console.log("\nPopup detection (R-13):");
assert(!workbenchPopupOpen(document), "empty document has no popup");
const modal = document.createElement("div");
modal.className = "wb-tool-modal";
document.body.appendChild(modal);
assert(workbenchPopupOpen(document), "tool modal counts as popup");
modal.remove();
const palette = document.createElement("div");
palette.className = "wb-cmd-palette";
document.body.appendChild(palette);
assert(workbenchPopupOpen(document), "command palette counts as popup");
palette.remove();

const interrupts = [];
const panelMod = await bundle("src/renderer/workbench/Panel.tsx", "panel-esc.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "lucide-react"]);
const { Panel } = panelMod;
const React = await import("react");
const reactDom = await import("react-dom/client");

const snapshot = { id: "s1", cwd: "/ws", model: "sonnet", effort: "medium", permissionMode: "default", status: "responding", startedAt: "", debugMode: false, turnCount: 1, queuedTurnCount: 0, pendingApprovalCount: 0 };
const view = {
  name: "worker", color: "#888",
  member: { name: "worker", partyId: "p1", status: "running", runtime: "claude-code", role: "", sessionId: "s1", model: "sonnet", queue: { items: [] } },
  session: { id: "s1", title: "sonnet", workspace: "/ws", snapshot },
  status: "working", unread: 0, pendingApproval: false, busy: true, model: "sonnet", effort: "medium", permissionMode: "default",
  transcript: [], subagents: [], effortOptions: [],
};
const panel = { id: "pa", tabs: ["worker"], active: "worker", weight: 1 };
const actions = {
  interrupt: (name) => interrupts.push(name),
  forceStop: () => {},
  prewarm: () => {},
  setEffort: () => {},
  setCodexPolicy: () => {},
  setCursorPolicy: () => {},
  respawn: () => {},
  compact: () => {},
  restart: () => {},
  runQueueCommand: async () => null,
};

const props = {
  panel, views: new Map([["worker", view]]), focused: true, draggingMember: null, dropTarget: false, canAdd: false,
  actions, onFocus: () => {}, onSelectTab: () => {}, onCloseTab: () => {}, onAdd: () => {}, onSplit: () => {},
  onOpenRuntime: () => {}, onOpenMcp: () => {}, onOpenCompact: () => {}, onOpenGate: () => {}, onTabPointerDown: () => {},
  onToggleSubDock: () => {}, onOpenSub: () => {}, onCloseSub: () => {},
};

const root = reactDom.createRoot(document.getElementById("root"));
root.render(React.createElement(Panel, props));
await new Promise((r) => setTimeout(r, 80));

console.log("\nEsc interrupt (R-12):");
window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
assert(interrupts.length === 1 && interrupts[0] === "worker", "Esc interrupts the focused busy member");

interrupts.length = 0;
const overlay = document.createElement("div");
overlay.className = "wb-tool-modal";
document.body.appendChild(overlay);
window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
assert(interrupts.length === 0, "Esc with a popup open does not interrupt");
overlay.remove();

view.busy = false;
view.status = "idle";
snapshot.status = "idle";
root.render(React.createElement(Panel, { ...props, views: new Map([["worker", { ...view }]]) }));
await new Promise((r) => setTimeout(r, 80));
window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
assert(interrupts.length === 0, "Esc on an idle member does not interrupt");

console.log(failures.length ? ("\nESC INTERRUPT FAILED (" + failures.length + ")") : "\nESC INTERRUPT PASSED");
process.exit(failures.length ? 1 : 0);

