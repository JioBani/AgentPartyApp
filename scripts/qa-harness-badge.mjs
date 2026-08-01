/*
 * [P-8] The harness a member runs on, shown where the member is identified.
 *
 * A member displayed only its MODEL, but the same model runs differently on
 * Claude Code / Codex / Cursor (different tools, permissions, behaviour), so the
 * model alone never said what a member was.
 *
 * Two layers:
 *   1. harnessLabel (pure): full + short names per harness, and an UNKNOWN id
 *      surfaced as-is rather than mapped to a guess.
 *   2. TabStrip (DOM): each tab carries its own harness badge with the full name
 *      in the tab tooltip, and the badge yields to the member name when narrow.
 *
 * The sidebar row's badge is covered by qa-render (which mounts the real app).
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
async function bundle(entry, name, external = []) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external, write: false });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}

// ---- Layer 1: the shared label helper ---------------------------------------
const H = await bundle("src/renderer/workbench/harnessLabel.ts", "harness-label.mjs", []);
console.log("\nharnessLabel:");
assert(H.harnessLabel("claude-code") === "Claude Code", "claude-code → Claude Code");
assert(H.harnessLabel("codex") === "Codex", "codex → Codex");
assert(H.harnessLabel("cursor") === "Cursor CLI", "cursor → Cursor CLI");
assert(H.harnessShort("claude-code") === "CC" && H.harnessShort("codex") === "CDX" && H.harnessShort("cursor") === "CUR", "short badges are distinct per harness");
// A harness this build does not know about must not be dressed up as a known
// one — it shows its own id, which is the honest signal that it is unmapped.
assert(H.harnessLabel("gemini-cli") === "gemini-cli", "an unknown harness id is surfaced as-is, never mapped to a guess");
assert(H.harnessLabel(undefined) === "" && H.harnessShort(undefined) === "", "a member with no harness recorded shows nothing, not a default");

// ---- Layer 2: TabStrip DOM ---------------------------------------------------
const { TabStrip } = await bundle("src/renderer/workbench/TabStrip.tsx", "harness-tabstrip.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const React = await import("react");
const reactDom = await import("react-dom/client");

const view = (name, runtime) => [name, {
  name, color: "#888", member: { name, partyId: "p1", status: "idle", runtime, role: "" },
  status: "idle", transcript: [], subagents: [], unread: 0, pendingApproval: false, busy: false,
  model: "sonnet", effort: "medium", permissionMode: "default", effortOptions: [], autoCompact: { on: false, at: 80 }, compacting: false,
}];
const views = new Map([view("claudey", "claude-code"), view("codexy", "codex"), view("cursory", "cursor")]);
const panel = { id: "p", tabs: ["claudey", "codexy", "cursory"], active: "claudey" };
const noop = () => {};
const mount = (density) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  reactDom.createRoot(host).render(React.createElement(TabStrip, {
    panel, views, density, draggingMember: null, canAdd: true,
    onSelect: noop, onClose: noop, onAdd: noop, onSplit: noop, onTabPointerDown: noop,
  }));
  return host;
};
const settle = () => new Promise((r) => setTimeout(r, 60));

console.log("\nTabStrip DOM:");
const wide = mount("wide");
await settle();
const badges = [...wide.querySelectorAll(".wb-tab .wb-harness-chip")].map((el) => el.textContent);
assert(badges.join(",") === "CC,CDX,CUR", "each tab carries ITS OWN harness badge (not the panel's or the first tab's)");
const tips = [...wide.querySelectorAll(".wb-tab")].map((el) => el.getAttribute("title"));
assert(tips[1] === "codexy · Codex", "the tab tooltip names the member and its harness in full");

const narrow = mount("narrow");
await settle();
assert(narrow.querySelectorAll(".wb-tab").length === 3 && narrow.querySelectorAll(".wb-harness-chip").length === 0,
  "when narrow the badge yields to the member name (tooltip still carries the harness)");
assert([...narrow.querySelectorAll(".wb-tab")].every((el) => /Claude Code|Codex|Cursor CLI/.test(el.getAttribute("title") || "")),
  "…so the harness is still reachable at every width");

console.log(failures.length ? `\nHARNESS BADGE FAILED (${failures.length})` : "\nHARNESS BADGE PASSED");
process.exit(failures.length ? 1 : 0);
