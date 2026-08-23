/*
 * Codex live model catalog (roadmap: Codex 하네스 모델 선택). Three layers:
 *   1. codexModels (pure): model/list normalization — slug/default-first/hidden
 *      filtering and effort/service-tier extraction.
 *   2. modelRegistry: buildModelRoutes with a discovered catalog exposes every
 *      codex model (effort caps + leaderboard meta enrichment), and falls back
 *      to the single static route without one.
 *   3. MemberWizard (DOM): the codex model step lists discovered models, says
 *      when discovery is pending, and surfaces a discovery error with a retry
 *      action (no silent fallback).
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
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty", ".json": "json" }, define: { "process.env.NODE_ENV": '"development"' }, external, write: false });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}

// The real model/list shape observed from codex-cli 0.142.4 (07-model-routing.md §1).
const RAW_MODELS = [
  { id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4", description: "Everyday.", hidden: false, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }, { reasoningEffort: "high", description: "deep" }], serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x" }] },
  { id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5", description: "Frontier.", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }], serviceTiers: [] },
  { id: "gpt-5.4-mini", model: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }], serviceTiers: [] },
  { id: "codex-auto-review", model: "codex-auto-review", displayName: "Reviewer", hidden: true, isDefault: false, supportedReasoningEfforts: [], serviceTiers: [] },
  { displayName: "no-slug entry is dropped" },
];

// ---- Layer 1: normalization --------------------------------------------------
const { normalizeCodexModels, normalizeCodexModel } = await bundle("src/shared/codexModels.ts", "codex-models.mjs", []);
console.log("\ncodexModels normalization:");
const models = normalizeCodexModels(RAW_MODELS);
assert(models.length === 3, "hidden + slugless entries are dropped (3 of 5 kept)");
assert(models[0].model === "gpt-5.5", "the account default model is ordered first");
assert(models[0].reasoningEfforts.map((e) => e.id).join(",") === "low,medium,high,xhigh", "effort options preserved in order");
assert(models[1].serviceTiers[0]?.name === "Fast", "service tiers (Fast) survive normalization");
assert(normalizeCodexModel({ id: "only-id", hidden: false }).model === "only-id", "falls back to `id` when `model` is missing");
assert(normalizeCodexModel(null) === undefined, "null entry normalizes to undefined (not a crash)");

// ---- Layer 2: routes ----------------------------------------------------------
const { buildModelRoutes, codexRouteFromModel } = await bundle("src/core/modelRegistry.ts", "codex-model-routes.mjs", []);
const { claudeSubscriptionModels } = await bundle("src/shared/modelCatalog.ts", "codex-models-catalog.mjs", []);
console.log("\nmodelRegistry codex routes:");
const withCatalog = buildModelRoutes("sonnet", [], [], models);
// Account-catalog codex routes (from model/list) are the openai-provider ones;
// OpenRouter codex routes are asserted separately below (Layer 2b).
const codexRoutes = withCatalog.filter((route) => route.harnessId === "codex" && route.providerId === "openai");
// 3 discovered + the static catalog account models NOT in the discovery (the
// GPT-5.6 trio) — discovered slugs dedupe against their static catalog twins.
assert(codexRoutes.length === 6, `discovered models + undiscovered static catalog models, deduped (got ${codexRoutes.length})`);
assert(codexRoutes.filter((route) => route.model === "gpt-5.5").length === 1, "a discovered slug supersedes its static catalog twin (no duplicate gpt-5.5)");
assert(codexRoutes.some((route) => route.model === "gpt-5.6-sol" && route.label === "GPT-5.6 Sol"), "an undiscovered catalog model (gpt-5.6-sol) stays selectable");
assert(codexRoutes[0].model === "gpt-5.5" && codexRoutes[0].label === "GPT-5.5", "route model/label come from the discovered slug/displayName");
assert(codexRoutes.every((route) => !route.modelProvider), "account-catalog codex routes have no custom provider (built-in openai)");
const gpt54 = codexRoutes.find((route) => route.model === "gpt-5.4");
assert(gpt54?.capabilities.effort.supported && gpt54.capabilities.effort.defaultValue === "medium", "effort capability carries the model's own default");
assert(gpt54?.capabilities.serviceTier?.options.map((option) => option.id).join(",") === "inherit,standard,priority", "Codex service tiers expose inherit (설정 따름) plus Standard and the native Fast id");
assert(gpt54?.capabilities.serviceTier?.defaultValue === "inherit", "inherit is the default so untouched members follow the user's Codex config");
assert(/크레딧/.test(gpt54?.capabilities.serviceTier?.options.find((option) => option.id === "priority")?.description || ""), "the Fast option description carries the credit-consumption note");
assert(gpt54?.capabilities.thinking.supported === false && gpt54?.capabilities.permission.supported === false, "thinking/permission stay unsupported on the codex harness");
const mini = codexRoutes.find((route) => route.model === "gpt-5.4-mini");
assert(mini?.meta?.perf === 1 && mini?.meta?.costTier === 3, "leaderboard meta enriched from the shared catalog ('GPT-5.4 mini' spelling variant)");
assert(codexRouteFromModel(models[0]).runtimeModel === "gpt-5.5", "runtimeModel equals the codex slug (sent verbatim to thread/turn)");

// ---- Layer 2b: codex OpenRouter routes (Phase 2) ------------------------------
console.log("\ncodex OpenRouter routes (Phase 2):");
const orCodex = withCatalog.filter((route) => route.harnessId === "codex" && route.modelProvider === "openrouter");
assert(orCodex.length >= 10, `OpenRouter catalog models are exposed as codex routes (got ${orCodex.length})`);
const glm = orCodex.find((route) => route.model === "z-ai/glm-5.2");
assert(Boolean(glm), "GLM-5.2 is a codex route under the OpenRouter provider");
assert(glm?.model === "z-ai/glm-5.2" && glm?.runtimeModel === "z-ai/glm-5.2", "codex OpenRouter route carries the concrete orModelId slug (sent to thread/start)");
assert(glm?.providerId === "openrouter" && glm?.modelProvider === "openrouter", "route is grouped under openrouter and pins modelProvider=openrouter");
assert(glm?.capabilities.effort.supported && glm.capabilities.effort.options.some((o) => o.id === "max"), "effort options come from the catalog reasoning spec");
assert((glm?.description || "").includes("OpenRouter"), "description warns the model bills via OpenRouter");
assert(glm?.meta?.perf === 4 && glm?.meta?.costTier === 2, "leaderboard meta preserved from the catalog");
const claudeCodex = withCatalog.filter((route) => route.harnessId === "codex" && route.modelProvider === "claude-subscription");
// Count comes from the catalog, not a literal: adding an Anthropic model (e.g.
// Opus 5) must not fail this test, only a model that stops being cross-routed.
assert(claudeCodex.length === claudeSubscriptionModels().length, `Claude catalog models are exposed on Codex through Claude OAuth (${claudeCodex.length}/${claudeSubscriptionModels().length})`);
const sonnet = claudeCodex.find((route) => route.model === "claude-sonnet-4-6");
assert(sonnet?.pricing?.billing === "subscription" && sonnet?.providerId === "anthropic", "Codex Sonnet is an Anthropic subscription route");
// Account catalog + OpenRouter both present without discovery too.
const noDiscovery = buildModelRoutes("sonnet", [], []).filter((route) => route.harnessId === "codex");
assert(noDiscovery.some((r) => r.model === "gpt-5.4") && noDiscovery.some((r) => r.modelProvider === "openrouter"), "without discovery: static account fallback + OpenRouter routes both present");
assert(noDiscovery.filter((r) => r.providerId === "openai").length === 6, "without discovery: every catalog codexModel entry is a static codex route");

// ---- Layer 2c: codexProviders (Phase 2 pure model) ----------------------------
const { codexProviderForModel, codexProviderConfigArgs, CODEX_OPENROUTER_PROVIDER, CODEX_CLAUDE_SUBSCRIPTION_PROVIDER } = await bundle("src/shared/codexProviders.ts", "codex-providers.mjs", []);
console.log("\ncodexProviders mapping:");
assert(codexProviderForModel("z-ai/glm-5.2")?.id === "openrouter", "an OpenRouter slug maps to the openrouter provider");
assert(codexProviderForModel("gpt-5.5") === undefined, "a bare account slug maps to no custom provider (built-in openai)");
assert(codexProviderForModel("claude-sonnet-4-6")?.id === "claude-subscription", "a Claude OAuth model maps to the local subscription provider");
const providerArgs = codexProviderConfigArgs(CODEX_OPENROUTER_PROVIDER);
assert(providerArgs.includes("model_providers.openrouter.wire_api=\"responses\""), "provider config args pin wire_api=responses (chat is removed)");
assert(providerArgs.some((a) => a.includes('base_url="https://openrouter.ai/api/v1"')), "provider config args set the OpenRouter base_url");
assert(providerArgs.some((a) => a.includes("env_key=\"OPENROUTER_API_KEY\"")), "provider config args read the key from OPENROUTER_API_KEY");
const claudeProviderArgs = codexProviderConfigArgs(CODEX_CLAUDE_SUBSCRIPTION_PROVIDER);
assert(claudeProviderArgs.some((a) => a.includes('base_url="http://127.0.0.1:8317/v1"')), "Claude provider config uses local CLIProxyAPI");
assert(claudeProviderArgs.some((a) => a.includes('env_key="AGENTPARTY_SUBSCRIPTION_PROXY_KEY"')), "Claude provider reads the local proxy key env var");
assert(codexProviderConfigArgs(undefined).length === 0, "no override args for the built-in provider");

// ---- Layer 3: MemberWizard DOM ------------------------------------------------
const { MemberWizard } = await bundle("src/renderer/workbench/MemberWizard.tsx", "codex-models-wizard.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const React = await import("react");
const reactDom = await import("react-dom/client");
const mount = (el) => { const host = document.createElement("div"); document.body.appendChild(host); reactDom.createRoot(host).render(el); return host; };
const click = (el) => el?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const tick = () => new Promise((r) => setTimeout(r, 60));
const defaultProfile = { harness: "codex", model: "gpt-5.5", effort: "medium", permissionMode: "default" };
const harnessDefaults = { "claude-code": { model: "sonnet", effort: "medium", permissionMode: "default" }, codex: { model: "gpt-5.5", effort: "medium", codexPolicy: { sandbox: "workspace-write", approval: "on-request", guardian: false } } };

async function openModelStep(host) {
  const input = host.querySelector(".wb-wizard-input");
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setValue.call(input, "tester");
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick();
  const next = () => click([...host.querySelectorAll(".wb-btn-accent")].at(-1));
  next(); await tick(); // 이름 → 하네스
  next(); await tick(); // 하네스 → 모델
}

console.log("\nMemberWizard codex model step:");
const readyHost = mount(React.createElement(MemberWizard, { routes: withCatalog, codexModels: { status: "ready", models }, defaultProfile, harnessDefaults, onCancel: () => {}, onCreate: () => {} }));
await tick();
await openModelStep(readyHost);
const rows = [...readyHost.querySelectorAll(".wb-model-row")];
// Every codex route the registry produced must be listed — account models,
// OpenRouter, Claude-subscription cross-routes, and the explicitly
// unavailable Cursor entries (which stay visible with a reason).
const allCodexRoutes = withCatalog.filter((route) => route.harnessId === "codex");
assert(rows.length === allCodexRoutes.length, `Codex harness lists every codex route (${rows.length}/${allCodexRoutes.length}: account, OpenRouter, Claude-subscription, unavailable)`);
// The shared catalog owns the display identity: a discovered slug with a
// catalog twin (gpt-5.4-mini → "GPT-5.4 mini") renders the catalog label, not
// the raw model/list displayName. Selectability is asserted on that label.
assert(rows.some((row) => row.textContent.includes("GPT-5.4 mini")), "gpt-5.4-mini is selectable (renders its catalog label)");
assert(rows.some((row) => row.textContent.includes("GLM-5.2")), "an OpenRouter model (GLM-5.2) is selectable on the codex harness");
assert(!readyHost.querySelector(".wb-wizard-error"), "no error banner when discovery is ready");

// Selecting an OpenRouter codex model surfaces the billing note.
const glmRow = rows.find((row) => row.textContent.includes("GLM-5.2"));
click(glmRow);
await tick();
assert((readyHost.querySelector(".wb-codex-or-note")?.textContent || "").includes("OpenRouter"), "selecting an OpenRouter codex model shows the OpenRouter billing note");

const pendingHost = mount(React.createElement(MemberWizard, { routes: buildModelRoutes("sonnet", [], []), codexModels: { status: "pending", models: [] }, defaultProfile: { ...defaultProfile, model: "gpt-5.4" }, harnessDefaults, onCancel: () => {}, onCreate: () => {} }));
await tick();
await openModelStep(pendingHost);
assert((pendingHost.textContent || "").includes("불러오는 중"), "pending discovery is stated on the model step");

let retried = false;
const errorHost = mount(React.createElement(MemberWizard, { routes: buildModelRoutes("sonnet", [], []), codexModels: { status: "error", models: [], error: "codex exited with code 1" }, onRefreshCodexModels: () => { retried = true; }, defaultProfile: { ...defaultProfile, model: "gpt-5.4" }, harnessDefaults, onCancel: () => {}, onCreate: () => {} }));
await tick();
await openModelStep(errorHost);
const errorBanner = errorHost.querySelector(".wb-wizard-error");
assert(Boolean(errorBanner), "a discovery failure shows an error banner (no silent fallback)");
assert((errorBanner?.textContent || "").includes("codex exited with code 1"), "the banner carries the actual error message");
click(errorBanner?.querySelector("button"));
await tick();
assert(retried, "the retry button invokes onRefreshCodexModels");

console.log(failures.length ? `\nFAILED: ${failures.length}` : "\nCODEX MODELS QA PASSED");
process.exit(failures.length ? 1 : 0);
