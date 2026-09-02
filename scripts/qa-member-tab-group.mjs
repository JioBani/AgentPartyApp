/*
 * Member-create tab-group UI contract. Renders the real wizard, selects an
 * existing workbench group, and uses the real defaults shortcut so the emitted
 * CreateMemberInput is exactly what AppController receives.
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
for (const [name, value] of Object.entries({
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: clearTimeout,
})) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = window.ResizeObserver;

const built = await build({
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
const bundlePath = path.join(qaTempDir(), "member-tab-group.mjs");
writeFileSync(bundlePath, built.outputFiles[0].text);
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemberWizard } = await import(pathToFileURL(bundlePath).href);

let created;
createRoot(document.getElementById("root")).render(React.createElement(MemberWizard, {
  routes: [{
    harnessId: "claude-code",
    providerId: "anthropic",
    model: "sonnet",
    label: "Claude Sonnet",
    capabilities: { effort: { supported: false, options: [] }, thinking: { supported: false } },
  }],
  tabGroups: [
    { id: "panel-main", label: "main · auth" },
    { id: "panel-source", label: "source" },
  ],
  defaultTabGroupId: "panel-source",
  defaultProfile: { harness: "claude-code", model: "sonnet", permissionMode: "default" },
  harnessDefaults: { "claude-code": { model: "sonnet", permissionMode: "default" } },
  cwdPrefs: { windowsDefault: { env: "windows", cwd: "C:\\Project\\QA" }, windowsRecent: [], wslRecent: [] },
  appWorkspaceRoot: "C:\\Project\\QA",
  now: Date.now(),
  onBrowseCwd: async () => null,
  onCancel: () => undefined,
  onCreate: (input) => { created = input; },
}));
await tick(60);

const inputs = [...document.querySelectorAll(".wb-wizard-input")];
const nameInput = inputs.find((element) => element.tagName === "INPUT");
const groupSelect = inputs.find((element) => element.tagName === "SELECT");
assert(groupSelect?.options[0]?.textContent.includes("새 탭 그룹"), "new tab group remains available");
assert([...groupSelect.options].some((option) => option.value === "panel-main" && option.textContent === "main · auth"), "existing workbench groups are listed by their tabs");
assert(groupSelect?.value === "panel-source", "focused workbench group is selected by default");

setValue(nameInput, "impl", window.HTMLInputElement.prototype);
await tick(30);
const defaultsButton = [...document.querySelectorAll("button")].find((button) => button.textContent.includes("기본 설정으로 만들기"));
defaultsButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await tick(40);

assert(created?.name === "impl", "wizard emits the member identity");
assert(created?.tabGroup === "panel-source", "quick-default creation emits the focused tab-group id");

console.log(failures.length ? `\nMEMBER TAB GROUP FAILED (${failures.length})` : "\nMEMBER TAB GROUP PASSED");
process.exit(failures.length ? 1 : 0);

function setValue(element, value, prototype, event = "input") {
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
  element.dispatchEvent(new window.Event(event, { bubbles: true }));
}

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
