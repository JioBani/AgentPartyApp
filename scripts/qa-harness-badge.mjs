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
 *   2. TabStrip (DOM): each tab carries its harness's official monochrome mark
 *      with the full name in the tab tooltip, and yields when narrow.
 *
 * The sidebar row's badge is covered by qa-render (which mounts the real app).
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

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



const outDir = qaTempDir();
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

// `provider` is the MODEL's company, resolved when the view is built. It is
// deliberately not derived from `runtime` here: the pairing below is the whole
// point — a Codex-harness member answering with an Anthropic model must show
// Anthropic, which is exactly what the old harness badge got wrong.
const view = (name, runtime, provider) => [name, {
  name, color: "#888", member: { name, partyId: "p1", status: "idle", runtime, role: "" },
  status: "idle", transcript: [], subagents: [], unread: 0, pendingApproval: false, busy: false,
  model: "sonnet", effort: "medium", permissionMode: "default", effortOptions: [], provider, autoCompact: { on: false, at: 80 }, compacting: false,
}];
const views = new Map([view("claudey", "claude-code", "anthropic"), view("codexy", "codex", "anthropic"), view("cursory", "cursor", "openrouter")]);
const panel = { id: "p", tabs: ["claudey", "codexy", "cursory"], active: "claudey" };
const noop = () => {};
const mount = (density) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  reactDom.createRoot(host).render(React.createElement(TabStrip, {
    panel, views, density, width: 900, draggingMember: null, canAdd: true,
    onSelect: noop, onClose: noop, onAdd: noop, onSplit: noop, onTabPointerDown: noop,
  }));
  return host;
};
const settle = () => new Promise((r) => setTimeout(r, 60));

console.log("\nTabStrip DOM:");
const wide = mount("wide");
await settle();
const marks = [...wide.querySelectorAll(".wb-tab .wb-member-mark")].map((el) => el.getAttribute("title"));
assert(marks.join(",") === "Anthropic,Anthropic,OpenRouter", "each tab names ITS OWN model provider — the Codex-harness member on an Anthropic model included");
assert(wide.querySelectorAll('.wb-tab .wb-member-mark svg[data-vendor-mark]').length === 2, "providers we hold artwork for render their vector brand mark");
assert(wide.querySelectorAll('.wb-tab .wb-provider-icon-generic').length === 1, "…and one we do not (OpenRouter) gets the neutral mark, not a blank slot or another company's logo");
assert(wide.querySelectorAll(".wb-tab .wb-harness-chip").length === 0, "no second brand mark competes with it on the same tab");
const tips = [...wide.querySelectorAll(".wb-tab")].map((el) => el.getAttribute("title"));
assert(tips[1] === "codexy · Codex", "the harness is still named in full, in the tab's tooltip");

const narrow = mount("narrow");
await settle();
assert(narrow.querySelectorAll(".wb-tab").length === 3 && narrow.querySelectorAll(".wb-tab .wb-member-mark").length === 3,
  "the provider mark is identity, so it survives the narrow density the harness badge used to be dropped at");
assert([...narrow.querySelectorAll(".wb-tab")].every((el) => /Claude Code|Codex|Cursor CLI/.test(el.getAttribute("title") || "")),
  "…and the harness stays reachable at every width");

console.log(failures.length ? `\nHARNESS BADGE FAILED (${failures.length})` : "\nHARNESS BADGE PASSED");
process.exit(failures.length ? 1 : 0);
