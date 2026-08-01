/*
 * Renders the real MemberWizard in jsdom and walks the 6 steps
 * (name → harness → model → reasoning → permission → role), asserting step
 * gating and that the final payload carries runtime and initial permission —
 * the contract the party member-create relies on.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const define = (n, v) => { try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {} };
define("window", window); define("document", window.document); define("HTMLElement", window.HTMLElement);
define("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0));
define("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = window.ResizeObserver;

const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });
const result = await build({ entryPoints: [path.join(projectRoot, "src/renderer/workbench/MemberWizard.tsx")], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], write: false });
const bundlePath = path.join(outDir, "member-wizard.mjs"); writeFileSync(bundlePath, result.outputFiles[0].text);
const reactDom = await import("react-dom/client");
const React = await import("react");
const { MemberWizard } = await import(pathToFileURL(bundlePath).href);

const cap = { id: "sonnet" };
const routes = [
  {
    harnessId: "claude-code", providerId: "anthropic", model: "sonnet", label: "Claude Sonnet 4.6",
    meta: { perf: 5, costTier: 3, inPerM: 3, outPerM: 15, ioPerM: 0, context: "1M" },
    capabilities: {
      effort: { supported: true, defaultValue: "medium", options: [{ id: "low", label: "Low" }, { id: "high", label: "High" }] },
      thinking: { supported: true, defaultValue: "enabled", modes: [{ id: "enabled", label: "On" }, { id: "disabled", label: "Off" }], budget: { default: 8192, min: 1024, max: 32768 } },
    },
  },
  {
    harnessId: "claude-code", providerId: "openrouter", model: "MiniMax M3", label: "MiniMax M3",
    meta: { perf: 4, costTier: 2, inPerM: 1, outPerM: 2, ioPerM: 0, context: "256K" },
    capabilities: { effort: { supported: false, options: [] }, thinking: { supported: false } },
  },
  {
    harnessId: "codex", providerId: "openai", model: "gpt-5.4", label: "GPT-5.4 (Codex)",
    meta: { perf: 5, costTier: 4, context: "256K" },
    capabilities: { effort: { supported: false, options: [] }, thinking: { supported: false } },
  },
];

let created = null;
const root = reactDom.createRoot(document.getElementById("root"));
const defaultProfile = { harness: "claude-code", model: "sonnet", effort: "medium", permissionMode: "default" };
const harnessDefaults = { "claude-code": { model: "sonnet", effort: "medium", permissionMode: "default" }, codex: { model: "gpt-5.5", effort: "medium", codexPolicy: { sandbox: "workspace-write", approval: "on-request", guardian: false } } };
let cancelled = 0;
root.render(React.createElement(MemberWizard, { routes, defaultProfile, harnessDefaults, onCancel: () => { cancelled += 1; }, onCreate: (input) => { created = input; } }));
await tick(80);

const q = (sel) => document.querySelector(sel);
const all = (sel) => [...document.querySelectorAll(sel)];
const click = (el) => el?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const setInput = (el, value) => { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; setter.call(el, value); el.dispatchEvent(new window.Event("input", { bubbles: true })); };
const setTextarea = (el, value) => { const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set; setter.call(el, value); el.dispatchEvent(new window.Event("input", { bubbles: true })); };
const nextBtn = () => all(".wb-wizard-foot .wb-btn-accent")[0];
const text = () => document.body.textContent || "";

console.log("\nMember wizard assertions:");
assert(all(".wb-wizard-step").length === 6, "6 step indicators rendered (including initial permission)");
// [#16] A stray click outside must not throw away a half-filled wizard.
q(".wb-modal-scrim")?.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
await tick(40);
assert(cancelled === 0 && Boolean(q(".wb-wizard")), "clicking outside does NOT cancel the wizard");

// Step 1 — name
assert(nextBtn().disabled, "Next disabled with empty name");
setInput(q(".wb-wizard-input"), "reviewer"); await tick(30);
assert(!nextBtn().disabled, "Next enabled with a valid name");
setInput(q(".wb-wizard-input"), "1bad"); await tick(30);
assert(nextBtn().disabled, "Next disabled for an invalid name");
setInput(q(".wb-wizard-input"), "reviewer"); await tick(30);
click(nextBtn()); await tick(40);

// Step 2 — harness
assert(text().includes("Codex"), "harness step shows Codex");
const codexCard = all(".wb-wizard-card").find((c) => c.textContent.includes("Codex"));
assert(!codexCard?.disabled, "Codex harness is available");
assert(!nextBtn().disabled, "claude-code is selected by default → Next enabled");
click(nextBtn()); await tick(40);

// Step 3 — model
assert(all(".wb-model-row").length === 2, "both models listed");
assert(text().includes("MiniMax M3"), "openrouter model grouped in");
const sonnetRow = all(".wb-model-row").find((r) => r.textContent.includes("Claude Sonnet"));
click(sonnetRow); await tick(40);
assert(!nextBtn().disabled, "model selected → Next enabled");
// Model detail panel for the selected model.
assert(q(".wb-wizard-model-detail") !== null, "model detail panel shown for the selected model");
assert(all(".wb-wizard-model-detail .wb-stat-card").length === 4, "detail shows performance / cost / context / vision cards");
const detailText = q(".wb-wizard-model-detail")?.textContent || "";
assert(detailText.includes("5 / 5"), "detail shows the model's performance");
assert(detailText.includes("1M"), "detail shows the model's context window");
assert((q(".wb-wizard-model-detail .wb-cost-prices")?.textContent || "").includes("in"), "detail shows per-1M cost prices");
click(nextBtn()); await tick(40);

// Step 4 — reasoning (sonnet supports effort + thinking)
assert(all(".wb-segment").length >= 4, "effort + thinking segments shown for a reasoning model");
const highEffort = all(".wb-segment").find((s) => s.textContent.trim() === "High");
click(highEffort); await tick(30);
click(nextBtn()); await tick(40);

// Step 5 — initial permission
assert(text().includes("초기 권한"), "permission step is shown before creation");
const permissionSelect = q("select.wb-wizard-input");
assert(permissionSelect?.value === "default", "Claude permission is seeded from its harness default");
permissionSelect.value = "plan";
permissionSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
await tick(30);
click(nextBtn()); await tick(40);

// Step 6 — role + confirm
assert(text().includes("확인"), "final step shows a confirm summary");
const createBtn = nextBtn();
assert(createBtn.disabled, "Create disabled until a role is given");
setTextarea(q(".wb-wizard-textarea"), "Reviews backend APIs"); await tick(30);
assert(!nextBtn().disabled, "Create enabled once role is filled");
click(nextBtn()); await tick(50);

assert(created !== null, "onCreate fired");
assert(created?.name === "reviewer", "payload carries the name");
assert(created?.runtime === "claude-code", "payload carries the harness");
assert(created?.model === "sonnet", "payload carries the chosen model");
assert(created?.requirement === "Reviews backend APIs", "payload carries the role");
assert(created?.effort === "high", "payload carries the chosen effort");
assert(created?.reasoning === "enabled", "payload carries the thinking mode");
assert(created?.reasoningBudget === 8192, "payload carries the thinking budget");
assert(created?.permissionMode === "plan", "payload carries the chosen initial permission");

console.log(failures.length ? `\nMEMBER WIZARD FAILED (${failures.length})` : "\nMEMBER WIZARD PASSED");
process.exit(failures.length ? 1 : 0);

function tick(ms) { return new Promise((r) => setTimeout(r, ms)); }
