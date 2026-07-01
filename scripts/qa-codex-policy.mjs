/*
 * Codex two-axis safety model (Item 1). Two layers:
 *   1. codexPolicy (pure): presets map to sandbox×approval, preset detection,
 *      and the legacy permission-mode fallback.
 *   2. RuntimeModal (DOM): a Codex member shows the sandbox/approval preset +
 *      axes + guardian; a Claude member does NOT. Applying emits a codexPolicy.
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

// ---- Layer 1: pure model ----------------------------------------------------
const { CODEX_PRESETS, codexPresetOf, codexPolicyFromPermissionMode, DEFAULT_CODEX_POLICY } = await bundle("src/shared/codexPolicy.ts", "codex-policy.mjs", []);
console.log("\ncodexPolicy model:");
assert(CODEX_PRESETS.auto.sandbox === "workspace-write" && CODEX_PRESETS.auto.approval === "on-request", "Auto preset = workspace-write + on-request");
assert(CODEX_PRESETS["read-only"].sandbox === "read-only", "Read Only preset = read-only sandbox");
assert(CODEX_PRESETS["full-access"].sandbox === "danger-full-access" && CODEX_PRESETS["full-access"].approval === "never", "Full Access = danger-full-access + never");
assert(codexPresetOf({ sandbox: "workspace-write", approval: "on-request" }) === "auto", "policy matching Auto axes is detected as 'auto'");
assert(codexPresetOf({ sandbox: "read-only", approval: "never" }) === "custom", "a non-preset combo is 'custom'");
assert(codexPolicyFromPermissionMode("bypassPermissions").sandbox === "danger-full-access", "legacy bypassPermissions maps to full access");
assert(codexPolicyFromPermissionMode("default").sandbox === "read-only", "legacy default maps to read-only");
assert(DEFAULT_CODEX_POLICY.sandbox === "workspace-write" && DEFAULT_CODEX_POLICY.guardian === false, "default policy is Auto, guardian off");

// ---- Layer 2: RuntimeModal DOM ----------------------------------------------
const { CodexPermissionControl } = await bundle("src/renderer/workbench/CodexPermissionControl.tsx", "codex-perm-control.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const { Composer } = await bundle("src/renderer/workbench/Composer.tsx", "codex-composer.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const React = await import("react");
const reactDom = await import("react-dom/client");

const mount = (el) => { const host = document.createElement("div"); document.body.appendChild(host); reactDom.createRoot(host).render(el); return host; };
const click = (el) => el?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

// ---- Control: shows both axes, opens on click, applies presets live ---------
console.log("\nCodexPermissionControl (composer):");
let changed = null;
const ctrl = mount(React.createElement(CodexPermissionControl, { policy: { sandbox: "workspace-write", approval: "on-request", guardian: false }, onChange: (p) => { changed = p; } }));
await new Promise((r) => setTimeout(r, 60));
const trigger = ctrl.querySelector(".wb-codex-perm-trigger");
assert(Boolean(trigger), "a codex permission trigger renders");
assert((trigger?.textContent || "").includes("write") && (trigger?.textContent || "").includes("ask"), "trigger shows BOTH axes (sandbox 'write' + approval 'ask')");
assert(!ctrl.querySelector(".wb-codex-perm-menu"), "settings popover is closed until clicked");
click(trigger);
await new Promise((r) => setTimeout(r, 40));
assert(Boolean(ctrl.querySelector(".wb-codex-perm-menu")), "clicking the trigger opens the settings popover");
const presets = [...ctrl.querySelectorAll(".wb-segment")].map((b) => b.textContent);
assert(presets.includes("Read Only") && presets.includes("Auto") && presets.includes("Full Access"), "the three presets are shown");
assert(ctrl.textContent.includes("Guardian"), "guardian toggle is present");
click([...ctrl.querySelectorAll(".wb-segment")].find((b) => b.textContent === "Full Access"));
await new Promise((r) => setTimeout(r, 40));
assert(changed?.sandbox === "danger-full-access" && changed?.approval === "never", "picking Full Access applies the policy live (onChange)");

// ---- Composer branches by harness -------------------------------------------
console.log("\nComposer permission control by harness:");
const actions = { sendMessage() {}, compact() {}, restart() {}, interrupt() {}, setCodexPolicy: (_n, p) => { changed = p; }, setPermissionMode() {} };
const mkView = (runtime, policy) => ({
  name: "m", color: "#888", member: { name: "m", partyId: "p1", status: "running", runtime, role: "", codexPolicy: policy },
  status: "idle", unread: 0, pendingApproval: false, busy: false, model: "x", effort: "medium", permissionMode: "default", transcript: [],
  session: { id: "s1", title: "t", workspace: "/w", snapshot: { id: "s1", cwd: "/w", model: "x", effort: "medium", status: "idle", startedAt: "", debugMode: false, turnCount: 0, queuedTurnCount: 0, codexPolicy: policy } },
});
const codexComposer = mount(React.createElement(Composer, { view: mkView("codex", { sandbox: "read-only", approval: "untrusted", guardian: true }), density: "wide", actions }));
await new Promise((r) => setTimeout(r, 80));
assert(Boolean(codexComposer.querySelector(".wb-codex-perm-trigger")), "Codex member's composer shows the codex permission control");
const codexTrigger = codexComposer.querySelector(".wb-codex-perm-trigger");
assert((codexTrigger?.textContent || "").includes("read") && (codexTrigger?.textContent || "").includes("untrusted"), "control reflects the member's live policy (read/untrusted)");

const claudeComposer = mount(React.createElement(Composer, { view: mkView("claude-code"), density: "wide", actions }));
await new Promise((r) => setTimeout(r, 80));
assert(!claudeComposer.querySelector(".wb-codex-perm-trigger"), "Claude member's composer does NOT show the codex control (single mode dropdown instead)");

console.log(failures.length ? `\nCODEX POLICY FAILED (${failures.length})` : "\nCODEX POLICY PASSED");
process.exit(failures.length ? 1 : 0);
