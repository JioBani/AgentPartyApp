/*
 * Renders the real MemberWizard in jsdom and walks the current three-step flow
 * (identity, runtime, permission). This protects the payload contract used by
 * party member-create, including the selected effort and execution location.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;
const define = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {}
};
define("window", window);
define("document", window.document);
define("HTMLElement", window.HTMLElement);
define("getComputedStyle", window.getComputedStyle.bind(window));
define("requestAnimationFrame", (callback) => setTimeout(() => callback(Date.now()), 0));
define("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = window.ResizeObserver;

const outDir = qaTempDir();
const result = await build({
  entryPoints: [path.join(projectRoot, "src/renderer/workbench/MemberWizard.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"development"' },
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  write: false,
});
const bundlePath = path.join(outDir, "member-wizard.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const reactDom = await import("react-dom/client");
const React = await import("react");
const { MemberWizard } = await import(pathToFileURL(bundlePath).href);

const routes = [
  {
    harnessId: "claude-code",
    providerId: "anthropic",
    model: "sonnet",
    label: "Claude Sonnet 4.6",
    meta: { perf: 5, costTier: 3, inPerM: 3, outPerM: 15, ioPerM: 0, context: "1M" },
    capabilities: {
      effort: {
        supported: true,
        defaultValue: "low",
        options: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
      },
      thinking: {
        supported: true,
        defaultValue: "enabled",
        modes: [{ id: "enabled", label: "On" }, { id: "disabled", label: "Off" }],
        budget: { default: 8192, min: 1024, max: 32768 },
      },
    },
  },
  {
    harnessId: "claude-code",
    providerId: "openrouter",
    model: "MiniMax M3",
    label: "MiniMax M3",
    meta: { perf: 4, costTier: 2, inPerM: 1, outPerM: 2, ioPerM: 0, context: "256K" },
    capabilities: { effort: { supported: false, options: [] }, thinking: { supported: false } },
  },
  {
    harnessId: "codex",
    providerId: "openai",
    model: "gpt-5.4",
    label: "GPT-5.4 (Codex)",
    meta: { perf: 5, costTier: 4, context: "256K" },
    capabilities: { effort: { supported: false, options: [] }, thinking: { supported: false } },
  },
];

let created = null;
let cancelled = 0;
const defaultProfile = { harness: "claude-code", model: "sonnet", effort: "low", permissionMode: "default" };
const harnessDefaults = {
  "claude-code": { model: "sonnet", effort: "low", permissionMode: "default" },
  codex: {
    model: "gpt-5.5",
    effort: "medium",
    codexPolicy: { sandbox: "workspace-write", approval: "on-request", guardian: false },
  },
};
const cwdPrefs = {
  windowsDefault: { env: "windows", cwd: "C:\\qa" },
  windowsRecent: [],
  wslRecent: [],
  sshRecent: [],
};
const root = reactDom.createRoot(document.getElementById("root"));
root.render(React.createElement(MemberWizard, {
  routes,
  defaultProfile,
  harnessDefaults,
  cwdPrefs,
  appWorkspaceRoot: "C:\\qa",
  now: Date.now(),
  onBrowseCwd: async () => null,
  onCancel: () => { cancelled += 1; },
  onCreate: (input) => { created = input; },
}));
await tick(80);

const q = (selector) => document.querySelector(selector);
const all = (selector) => [...document.querySelectorAll(selector)];
const click = (element) => element?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const setInput = (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
};
const setTextarea = (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
};
const nextButton = () => all(".wb-wizard-foot .wb-btn-accent")[0];
const text = () => document.body.textContent || "";

console.log("\nMember wizard assertions:");
assert(all(".wb-wizard-step").length === 3, "three task-oriented steps render (identity, runtime, permission)");
q(".wb-modal-scrim")?.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
await tick(40);
assert(cancelled === 0 && Boolean(q(".wb-wizard")), "clicking outside does not cancel a half-filled wizard");

// Identity: the name gates progress; the role remains optional.
assert(nextButton().disabled, "Next is disabled with an empty name");
setInput(q(".wb-wizard-input"), "reviewer");
await tick(30);
assert(!nextButton().disabled, "Next is enabled with a valid name");
setInput(q(".wb-wizard-input"), "1bad");
await tick(30);
assert(nextButton().disabled, "Next is disabled for an invalid name");
setInput(q(".wb-wizard-input"), "reviewer");
setTextarea(q(".wb-wizard-textarea"), "Reviews backend APIs");
await tick(30);
click(nextButton());
await tick(50);

// Runtime: use the same catalog as the runtime settings screen and stage a
// non-default effort. The saved cwd makes the step actionable.
assert(Boolean(q(".wb-wizard-runtime")), "runtime step uses the shared model catalog entry point");
assert((q(".wb-wizard-runtime-model")?.textContent || "").includes("Claude Sonnet"), "saved default model is selected");
assert(!nextButton().disabled, "saved Windows cwd makes the runtime step actionable");
click(q(".wb-wizard-runtime"));
await tick(50);
assert(Boolean(q(".wb-modal-catalog")), "model catalog opens from the runtime step");
for (const group of all('.wb-model-provider-btn[aria-expanded="false"]')) click(group);
await tick(40);
assert(all(".wb-model-row").length === 2, "both Claude harness routes are listed");
assert(text().includes("MiniMax M3"), "OpenRouter model is grouped into the catalog");
assert(all(".wb-stat-cell").length === 4, "selected model shows performance, cost, context and vision details");
assert((q(".wb-model-detail")?.textContent || "").includes("1M"), "selected model detail shows its context window");
const highEffort = all(".wb-segment").find((segment) => segment.textContent.trim() === "High");
click(highEffort);
await tick(30);
const applyRuntime = q(".wb-modal-catalog .wb-btn-accent");
assert(!applyRuntime?.disabled, "changing effort enables the catalog apply action");
click(applyRuntime);
await tick(50);
assert(!q(".wb-modal-catalog"), "applying runtime returns to the wizard");
click(nextButton());
await tick(40);

// Permission: saved default is visible and the staged change reaches create.
const permissionSelect = q("select.wb-wizard-input");
assert(permissionSelect?.value === "default", "Claude permission is seeded from its harness default");
permissionSelect.value = "plan";
permissionSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
await tick(30);
assert(!nextButton().disabled, "Create is enabled with valid identity and location");
click(nextButton());
await tick(50);

assert(created !== null, "onCreate fired");
assert(created?.name === "reviewer", "payload carries the name");
assert(created?.runtime === "claude-code", "payload carries the harness");
assert(created?.model === "sonnet", "payload carries the chosen model");
assert(created?.requirement === "Reviews backend APIs", "payload carries the role");
assert(created?.effort === "high", "payload carries the chosen effort");
assert(created?.reasoning === "enabled", "payload carries the thinking mode");
assert(created?.reasoningBudget === 8192, "payload carries the thinking budget");
assert(created?.permissionMode === "plan", "payload carries the chosen initial permission");
assert(created?.location?.env === "windows" && created?.location?.cwd === "C:\\qa", "payload carries the seeded execution location");

console.log(failures.length ? `\nMEMBER WIZARD FAILED (${failures.length})` : "\nMEMBER WIZARD PASSED");
process.exit(failures.length ? 1 : 0);

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
