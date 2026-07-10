/*
 * Default creation profile + harness lock.
 *   1. defaultMemberProfileOf (pure): the single member-creation default is
 *      derived from the runtime defaults on AppSettings.
 *   2. RuntimeModal (DOM): the model list shows ONE harness at a time (the same
 *      model may be reachable from both harnesses — no duplicate rows); the
 *      harness switcher is locked to the current harness once a turn has run
 *      (turnCount > 0), and free to switch before the first turn.
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

// ---- Layer 1: per-harness derivation ----------------------------------------
const { defaultMemberProfileOf, harnessDefaultsOf } = await bundle("src/shared/types.ts", "types-profile.mjs", []);
console.log("\ndefaultMemberProfileOf (per-harness defaults, single source):");
const settings = {
  selectedHarnessId: "claude-code",
  harnessDefaults: {
    "claude-code": { model: "kimi", effort: "high", reasoning: "enabled", reasoningBudget: 4096, permissionMode: "plan" },
    codex: { model: "gpt-5.4-mini", effort: "low", codexPolicy: { sandbox: "read-only", approval: "on-request", guardian: false } },
  },
};
const profile = defaultMemberProfileOf(settings);
assert(profile.harness === "claude-code" && profile.model === "kimi", "default harness + its model come from harnessDefaults");
assert(profile.effort === "high" && profile.reasoning === "enabled" && profile.reasoningBudget === 4096, "effort + reasoning come from the harness's defaults");
assert(profile.permissionMode === "plan", "claude-code permission mode comes from its defaults");
// A DIFFERENT harness resolves to ITS OWN defaults (the whole point of the change).
const codexProfile = defaultMemberProfileOf(settings, "codex");
assert(codexProfile.harness === "codex" && codexProfile.model === "gpt-5.4-mini" && codexProfile.effort === "low", "codex profile uses the codex harness defaults, not claude's");
assert(codexProfile.codexPolicy?.sandbox === "read-only", "codex profile carries the codex 2-axis policy default");
assert(harnessDefaultsOf(settings, "codex").model === "gpt-5.4-mini" && harnessDefaultsOf(settings).model === "kimi", "harnessDefaultsOf resolves per harness (and defaults to the selected harness)");

// ---- Layer 2: RuntimeModal harness lock -------------------------------------
const { RuntimeModal } = await bundle("src/renderer/workbench/RuntimeModal.tsx", "runtime-modal.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const React = await import("react");
const reactDom = await import("react-dom/client");

const routes = [
  { harnessId: "claude-code", providerId: "anthropic", model: "sonnet", label: "Claude Sonnet", meta: { perf: 5, costTier: 3, context: "1M" }, capabilities: { effort: { supported: true, defaultValue: "medium", options: [] }, thinking: { supported: false } } },
  { harnessId: "codex", providerId: "openai", model: "gpt-5", label: "GPT-5 (Codex)", meta: { perf: 5, costTier: 4, context: "256K" }, capabilities: { effort: { supported: false, options: [] }, thinking: { supported: false } } },
];
const mkView = (turnCount) => ({
  name: "main", color: "#888", member: { name: "main", partyId: "p1", status: "running", runtime: "claude-code", role: "" },
  status: "idle", unread: 0, pendingApproval: false, busy: false, model: "sonnet", effort: "medium", permissionMode: "default", transcript: [],
  session: { id: "s1", title: "t", workspace: "/w", snapshot: { id: "s1", cwd: "/w", model: "sonnet", effort: "medium", status: "idle", startedAt: "", debugMode: false, turnCount, queuedTurnCount: 0 } },
});

function render(view) {
  const host = document.createElement("div"); document.body.appendChild(host);
  reactDom.createRoot(host).render(React.createElement(RuntimeModal, { view, routes, debugEnabled: false, actions: {}, onClose: () => {} }));
  return host;
}
const codexRow = (host) => [...host.querySelectorAll(".wb-model-row")].find((b) => (b.textContent || "").includes("GPT-5"));
const codexSegment = (host) => [...host.querySelectorAll(".wb-segment")].find((b) => (b.textContent || "") === "Codex");
const click = (el) => el?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

console.log("\nRuntimeModal single-harness list + harness lock:");
const locked = render(mkView(1));
await new Promise((r) => setTimeout(r, 80));
assert(!codexRow(locked), "other-harness models are NOT listed (one harness at a time, no duplicates)");
assert([...locked.querySelectorAll(".wb-model-row")].some((b) => (b.textContent || "").includes("Claude Sonnet")), "the member's own harness models are listed");
assert(codexSegment(locked)?.disabled === true && codexSegment(locked)?.className.includes("is-locked"), "the harness switcher is LOCKED after a turn (turnCount=1)");
assert(Boolean(locked.querySelector(".wb-modal-note")), "a harness-lock note is shown");

const free = render(mkView(0));
await new Promise((r) => setTimeout(r, 80));
assert(codexSegment(free)?.disabled === false && !codexSegment(free)?.className.includes("is-locked"), "the harness switcher is free before the first turn (turnCount=0)");
assert(!free.querySelector(".wb-modal-note"), "no lock note before any turn");
click(codexSegment(free));
await new Promise((r) => setTimeout(r, 80));
const switchedRow = codexRow(free);
assert(Boolean(switchedRow), "switching harness swaps the model list to that harness");
assert(switchedRow?.className.includes("is-selected"), "the selection moves onto the switched harness's list");
assert(![...free.querySelectorAll(".wb-model-row")].some((b) => (b.textContent || "").includes("Claude Sonnet")), "the previous harness's models leave the list (no cross-harness duplicates)");

console.log(failures.length ? `\nDEFAULT PROFILE FAILED (${failures.length})` : "\nDEFAULT PROFILE PASSED");
process.exit(failures.length ? 1 : 0);
