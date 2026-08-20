/*
 * R-8 / R-9 / F-83 — reasoning options live in ONE catalog surface.
 *
 * Proves:
 *   1. HarnessDefaultsCard opens the catalog with effort+thinking+serviceTier
 *      enabled (no empty config, no outer duplicate segments).
 *   2. Panel header no longer hosts a separate Effort dropdown.
 *   3. HarnessDefaults storage for budget + Cursor speed is reachable via
 *      buildPartyMember (the path new members inherit).
 *   4. ModelCatalogModal still exposes every axis when those flags are on.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };



const outDir = qaTempDir();
async function bundleNode(entry, name) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", packages: "external", write: false });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}
async function bundleBrowser(entry, name, external = []) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external, write: false });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}

console.log("\nSource contracts (R-9 / F-83 wiring):");
const cardSrc = readFileSync(path.join(projectRoot, "src/renderer/app/secondaryViews.tsx"), "utf8");
const panelSrc = readFileSync(path.join(projectRoot, "src/renderer/workbench/Panel.tsx"), "utf8");
const svcSrc = readFileSync(path.join(projectRoot, "src/main/application/partyApplicationService.ts"), "utf8");
assert(cardSrc.includes("config={{ effort: true, thinking: true, serviceTier: true }}"), "HarnessDefaultsCard enables all catalog reasoning axes");
assert(!/config=\{\{\}\}/.test(cardSrc.match(/function HarnessDefaultsCard[\s\S]*?export function SettingsView/)?.[0] || ""), "HarnessDefaultsCard no longer opens the catalog with empty config");
assert(!(cardSrc.match(/function HarnessDefaultsCard[\s\S]*?export function SettingsView/)?.[0] || "").includes('set-field-label">추론 강도'), "outer effort segment removed from harness defaults");
assert(!(cardSrc.match(/function HarnessDefaultsCard[\s\S]*?export function SettingsView/)?.[0] || "").includes('set-field-label">추론 모드'), "outer thinking-mode segment removed from harness defaults");
assert(cardSrc.includes("reasoningBudget") && cardSrc.includes("serviceTier: serviceTier || undefined"), "save patch persists thinking budget + Cursor speed");
assert(!panelSrc.includes('title="Effort"') && !panelSrc.includes("actions.setEffort"), "Panel header Effort dropdown is gone");
assert(panelSrc.includes("모델 · 추론 설정"), "model pill is the single header entry for runtime reasoning");
assert(svcSrc.includes("defaults.reasoningBudget") && svcSrc.includes("defaults.serviceTier"), "session start falls back to harness-default budget + speed");

console.log("\nbuildPartyMember inherits the previously-dead defaults:");
const D = await bundleNode("src/main/application/partyDomain.ts", "party-domain-reasoning.mjs");
const settings = {
  selectedHarnessId: "claude-code",
  harnessDefaults: {
    "claude-code": { model: "sonnet", effort: "high", reasoning: "enabled", reasoningBudget: 4096, permissionMode: "default" },
    cursor: { model: "Grok 4.5", effort: "high", serviceTier: "fast", cursorPolicy: { mode: "agent", approval: "allowlist" } },
    codex: { model: "gpt-5.4-mini", effort: "low", codexPolicy: { sandbox: "read-only", approval: "on-request", guardian: false } },
  },
};
const claude = D.buildPartyMember({ partyId: "p1", name: "cc", role: "r", runtime: "claude-code" }, settings);
assert(claude.reasoningBudget === 4096 && claude.reasoning === "enabled", "Claude member inherits thinking budget + mode from harness defaults");
const cursor = D.buildPartyMember({ partyId: "p1", name: "cu", role: "r", runtime: "cursor" }, settings);
assert(cursor.serviceTier === "fast", "Cursor member inherits speed grade from harness defaults");

console.log("\nModelCatalogModal exposes every axis when enabled:");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const [n, v] of Object.entries({ window, document: window.document, HTMLElement: window.HTMLElement, getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0), cancelAnimationFrame: clearTimeout })) {
  try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {}
}
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;
const React = await import("react");
const reactDom = await import("react-dom/client");
const { ModelCatalogModal } = await bundleBrowser("src/renderer/workbench/ModelCatalogModal.tsx", "catalog-reasoning.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);

const routes = [
  {
    harnessId: "claude-code", providerId: "anthropic", model: "sonnet", label: "Claude Sonnet",
    meta: { perf: 5, costTier: 3, context: "1M" },
    capabilities: {
      effort: { supported: true, defaultValue: "medium", options: [{ id: "low", label: "Low" }, { id: "high", label: "High" }] },
      thinking: { supported: true, defaultValue: "adaptive", modes: [{ id: "adaptive", label: "adaptive" }, { id: "enabled", label: "enabled" }, { id: "disabled", label: "disabled" }], budget: { min: 1024, max: 81920, default: 8192 } },
      serviceTier: { supported: true, defaultValue: "standard", options: [{ id: "standard", label: "Standard" }, { id: "fast", label: "Fast" }] },
    },
  },
];
let applied = null;
document.body.innerHTML = "";
const host = document.createElement("div"); document.body.appendChild(host);
reactDom.createRoot(host).render(React.createElement(ModelCatalogModal, {
  title: "defaults",
  routes,
  value: { model: "sonnet", effort: "medium", thinkingMode: "adaptive", thinkingBudget: 8192, serviceTier: "standard" },
  config: { effort: true, thinking: true, serviceTier: true },
  applyLabel: "선택",
  onApply: (next) => { applied = next; },
  onClose: () => {},
}));
await new Promise((r) => setTimeout(r, 30));
const heads = [...document.body.querySelectorAll(".wb-detail-section-head")].map((el) => (el.textContent || "").trim());
assert(heads.some((t) => /Effort/i.test(t)), `effort section present (${heads.join(" | ")})`);
assert(heads.some((t) => /Thinking/i.test(t)), `thinking section present (${heads.join(" | ")})`);
assert(heads.some((t) => /Service mode/i.test(t)), `Cursor speed section present (${heads.join(" | ")})`);
assert(Boolean(document.body.querySelector("input[type=range]")), "thinking budget slider present");
[...document.body.querySelectorAll(".wb-segment")].find((el) => el.textContent.trim() === "High")
  ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
[...document.body.querySelectorAll(".wb-segment")].find((el) => el.textContent.trim() === "enabled")
  ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
[...document.body.querySelectorAll(".wb-segment")].find((el) => el.textContent.trim() === "Fast")
  ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const range = document.body.querySelector("input[type=range]");
if (range) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(range, "4096");
  range.dispatchEvent(new window.Event("input", { bubbles: true }));
  range.dispatchEvent(new window.Event("change", { bubbles: true }));
}
[...document.body.querySelectorAll("button")].find((el) => (el.textContent || "").includes("선택"))
  ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 20));
assert(applied?.effort === "high", `apply returns effort high (got ${applied?.effort})`);
assert(applied?.thinkingMode === "enabled", `apply returns thinking mode (got ${applied?.thinkingMode})`);
assert(applied?.serviceTier === "fast", `apply returns Cursor speed (got ${applied?.serviceTier})`);
assert(applied?.thinkingBudget === 4096, `apply returns thinking budget (got ${applied?.thinkingBudget})`);

console.log(failures.length ? `\nREASONING UNIFY FAILED (${failures.length})\n` + failures.map((f) => ` - ${f}`).join("\n") : "\nREASONING UNIFY PASSED");
process.exit(failures.length ? 1 : 0);
