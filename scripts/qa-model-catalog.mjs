/*
 * Regression test for the data-driven model catalog (src/shared/modelCatalog.json)
 * and the registry that consumes it. Asserts the exposed model list is
 * leaderboard-aligned, OpenRouter models carry a concrete OR id + router alias,
 * leaderboard metrics flow onto routes, and reasoning controls match the spec
 * (effort/thinking/budget per model; none for non-reasoning models).
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const qaDir = qaTempDir();

async function load(entry, name) {
  const out = path.join(qaDir, name);
  await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  return import(pathToFileURL(out).href);
}

const { buildModelRoutes, displayModelFor, runtimeModelFor, inferModelProvider, grokHarnessRoutes } = await load("src/core/modelRegistry.ts", "mr.mjs");
const { openRouterAliasMap, openRouterModels, orRoutedModels, deepseekModels, claudeSubscriptionModels, routerTargetForModel, modelCatalog, catalogModelById, catalogModelByRuntime, resolveCatalogModel, parseContextTokens } = await load("src/shared/modelCatalog.ts", "cat.mjs");
const { findRoute } = await load("src/renderer/workbench/routes.ts", "routes.mjs");
const { PROVIDER_LABELS } = await load("src/renderer/workbench/modelCatalog.ts", "provider-labels.mjs");
const { groupByProvider } = await load("src/renderer/workbench/modelMeters.tsx", "model-meters.mjs");
const { modelMarkForModel } = await load("src/renderer/workbench/modelMark.ts", "model-mark.mjs");
const { claudeRuntimeModelFor } = await load("src/core/claudeAdapter.ts", "claude-adapter.mjs");

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

console.log("\nModel catalog / registry assertions:");
const routes = buildModelRoutes("sonnet", [], []);
const byId = Object.fromEntries(routes.map((r) => [r.model, r]));
const liveSolRoute = buildModelRoutes("sonnet", [], [], [{ model: "gpt-5.6-sol", displayName: "gpt-5.6-sol", isDefault: false, hidden: false, reasoningEfforts: [], serviceTiers: [] }])
  .find((r) => r.harnessId === "codex" && r.model === "gpt-5.6-sol");
assert(liveSolRoute?.label === "GPT-5.6 Sol", "live Codex discovery keeps the shared catalog label (transport slug stays internal)");
const liveAstraRoute = buildModelRoutes("sonnet", [], [], [{ model: "gpt-6-astra", displayName: "GPT-6-Astra", isDefault: true, hidden: false, defaultReasoningEffort: "medium", reasoningEfforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }, { id: "ultra" }], serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }] }])
  .find((r) => r.harnessId === "codex" && r.model === "gpt-6-astra");
assert(liveAstraRoute?.label === "GPT-6 Astra", "live Astra discovery keeps the shared catalog label");
assert(liveAstraRoute?.capabilities.effort.options.at(-1)?.id === "ultra", "live Astra discovery preserves Codex-only ultra effort");
assert(liveAstraRoute?.capabilities.serviceTier?.options.some((option) => option.id === "priority"), "live Astra discovery preserves the Fast tier");
assert(PROVIDER_LABELS.anthropic === "Claude" && PROVIDER_LABELS.openai === "Codex" && PROVIDER_LABELS.cursor === "Cursor" && PROVIDER_LABELS.openrouter === "OpenRouter", "model groups use the same provider names as Authentication");
for (const harnessId of ["claude-code", "codex"]) {
  for (const providerId of ["anthropic", "openai", "cursor", "openrouter"]) {
    assert(routes.some((route) => route.harnessId === harnessId && route.providerId === providerId), `${harnessId} exposes a separate ${PROVIDER_LABELS[providerId]} model group`);
  }
}
const groupedProviders = groupByProvider(
  routes
    .filter((route) => route.harnessId === "claude-code")
    .map((route) => ({ route, meta: { id: route.model, name: route.label, provider: route.providerId, context: "—" } })),
).map((group) => group.provider);
assert(groupedProviders.includes("cursor"), "renderer provider grouping keeps the Cursor bucket visible");

// Model maker and route provider are separate identities. OpenRouter-routed
// models keep their maker mark; the deliberately excluded families stay on the
// neutral model fallback rather than borrowing a related company's logo.
console.log("\nModel-maker mark assertions:");
for (const [model, mark] of [
  ["Gemini 3.7 Flash", "gemini"],
  ["google/gemini-3.7-flash", "gemini"],
  ["Kimi K3", "kimi"],
  ["Kimi K2.6", "kimi"],
  ["Qwen3.7 Max", "qwen"],
  ["DeepSeek V4 Flash", "deepseek"],
  ["Muse Spark 1.1", "meta"],
  ["Laguna XS 2.1", "poolside"],
  ["GLM-5.2", "zai"],
  ["MiniMax M3", "minimax"],
  ["Grok 4.5 Cursor", "grok"],
]) {
  assert(modelMarkForModel(model) === mark, `${model} resolves to the ${mark} model mark`);
}
for (const model of ["Ox Alpha", "KAT-Coder-Air V2.5", "Aion-3.0", "Inkling", "Tencent Hy3", "Nex-N2-Mini"]) {
  assert(modelMarkForModel(model) === undefined, `${model} stays on the neutral model mark`);
}

// Leaderboard OR-O set must be exactly these, with concrete OR ids.
const expectedOr = ["GLM-5.2", "Gemini 3.5 Flash", "Qwen3.7 Max", "DeepSeek V4 Pro", "MiniMax M3", "Gemini 3.x Pro", "Kimi K2.7 Code", "Kimi K2.6", "Grok Build 0.1", "Qwen3.7 Plus", "Grok 4.3"];
// OpenRouter models appear on BOTH harnesses: as claude-code routes (router-backed)
// and as codex routes (Phase 2, modelProvider=openrouter). `byId` keys off the
// claude-code label; codex OR routes are keyed by the orModelId slug.
// Grouped by HOME provider, so a DeepSeek entry that is also OR-routable sits in
// the DeepSeek bucket on claude-code while keeping its codex OpenRouter route.
const orClaudeRoutes = routes.filter((r) => ["openrouter", "deepseek"].includes(r.providerId) && r.harnessId === "claude-code");
assert(orClaudeRoutes.length === orRoutedModels().length + deepseekModels().filter((m) => !m.orModelId).length, `every OR-routable and DeepSeek model is on the claude-code harness (got ${orClaudeRoutes.length})`);
assert(expectedOr.every((id) => byId[id]), "all leaderboard OR-O models are present");
// Only actual OpenRouter catalog models use modelProvider=openrouter.
const orCodexRoutes = routes.filter((r) => r.modelProvider === "openrouter" && r.harnessId === "codex");
assert(orCodexRoutes.length === orRoutedModels().length, `all ${orRoutedModels().length} OR-routable models exposed as codex routes (got ${orCodexRoutes.length})`);
assert(orCodexRoutes.every((r) => /.+\/.+/.test(r.model)), "codex OR routes carry the orModelId slug");
const claudeCodexRoutes = routes.filter((r) => r.modelProvider === "claude-subscription" && r.harnessId === "codex");
assert(claudeCodexRoutes.length === claudeSubscriptionModels().length, `all ${claudeSubscriptionModels().length} Claude subscription models are exposed on Codex`);
for (const [slug, label] of [["claude-fable-5", "Fable"], ["claude-opus-4-8", "Opus 4.8"], ["claude-sonnet-4-6", "Sonnet 4.6"], ["claude-haiku-4-5-20251001", "Haiku"]]) {
  const r = claudeCodexRoutes.find((route) => route.model === slug);
  assert(r?.label === label, `Anthropic '${label}' is a Codex route through Claude OAuth (${slug})`);
  assert(r?.providerId === "anthropic", `Codex '${label}' route remains grouped under Anthropic`);
  assert(r?.pricing?.billing === "subscription", `Codex '${label}' route is Claude-subscription billed`);
}

// Junk/duplicate OR models from the old hardcoded list are gone.
for (const gone of ["Qwen3 Coder", "MiniMax M2.7", "Qwen3 Coder Plus", "GLM-5.2 (OpenRouter)", "openrouter/<provider>/<model>"]) {
  assert(!byId[gone], `removed non-leaderboard model '${gone}'`);
}

// Every OR model maps to a concrete OpenRouter id, both by alias and id.
const alias = openRouterAliasMap();
for (const m of openRouterModels()) {
  assert(/.+\/.+/.test(m.orModelId || ""), `${m.id} has a concrete OR id (${m.orModelId})`);
  assert(alias[(m.runtimeModel || m.id).toLowerCase()] === m.orModelId, `${m.id} alias resolves to ${m.orModelId}`);
}
const gemini37 = routes.find((route) => route.harnessId === "claude-code" && route.model === "Gemini 3.7 Flash");
const gemini37Codex = routes.find((route) => route.harnessId === "codex" && route.model === "google/gemini-3.7-flash");
assert(gemini37?.runtimeModel === "claude-gemini-3-7-flash", "Gemini 3.7 Flash has a dedicated Claude router alias");
assert(alias["claude-gemini-3-7-flash"] === "google/gemini-3.7-flash", "Gemini 3.7 Flash alias resolves to its exact OpenRouter id");
assert(gemini37Codex?.modelProvider === "openrouter" && gemini37Codex.enabled, "Gemini 3.7 Flash is selectable on Codex through OpenRouter");
assert(gemini37?.pricing?.inputUsdPerM === 0.375 && gemini37?.pricing?.outputUsdPerM === 1.875, "Gemini 3.7 Flash exposes current OpenRouter token prices");
const gptMiniClaudeRoute = routes.find((route) => route.harnessId === "claude-code" && route.model === "GPT-5.4 mini");
assert(alias["claude-gpt-5.4-mini"] === undefined, "Claude Code GPT mini is absent from the OpenRouter alias map");
assert(routerTargetForModel("claude-gpt-5.4-mini")?.kind === "codex-subscription", "Claude Code GPT mini targets the Codex subscription proxy");
assert(gptMiniClaudeRoute?.runtimeModel === "claude-gpt-5.4-mini", "Claude Code GPT mini route keeps the Claude harness alias");
assert(gptMiniClaudeRoute?.pricing?.billing === "subscription", "Claude Code GPT mini is billed to the Codex subscription");

// Leaderboard metrics flow onto routes.
assert(byId["MiniMax M3"].meta?.perf === 2 && byId["MiniMax M3"].meta?.costTier === 1, "MiniMax M3 perf/cost from leaderboard");
assert(byId["MiniMax M3"].meta?.ioPerM === 0.53, "MiniMax M3 io price present");
assert(byId["Claude Opus 5"] === undefined && byId["claude-opus-5[1m]"].meta?.perf === 5, "Opus 5 mapped to claude-opus-5[1m] with perf 5");
// Both Opus generations are pinned by FULL id. The CLI's short aliases track
// the latest model ("opus" → claude-opus-5 as of 2.1.220), so an "opus[1m]"
// route labelled "Opus 4.8" would silently serve Opus 5 after a CLI update.
assert(byId["opus[1m]"] === undefined && byId["claude-opus-4-8[1m]"]?.label === "Opus 4.8", "no drifting 'opus' alias route — each Opus generation is pinned by full id");
assert(byId["claude-opus-5[1m]"].capabilities.thinking.defaultValue === "adaptive", "Opus 5 defaults to adaptive thinking (the API default; disabled only holds at effort ≤ high)");
// Fable 5: full model id (no short CLI alias exists), top perf tier, and an
// adaptive-only thinking control — reasoning cannot be turned off, so the
// catalog must not offer a 'disabled' mode (no silent lie in the UI).
const fable = byId["claude-fable-5[1m]"];
assert(fable?.label === "Fable" && fable?.providerId === "anthropic" && fable?.meta?.perf === 5, "Fable 5 is a native anthropic route (claude-fable-5[1m], perf 5)");
assert(byId["fable[1m]"] === undefined && byId["fable"] === undefined, "no 'fable' short alias route (the CLI rejects it — full id only)");
assert(fable?.capabilities.thinking.supported && fable.capabilities.thinking.modes.map((o) => o.id).join() === "adaptive", "Fable 5 thinking is adaptive-only (no 'disabled' mode offered)");
assert(fable?.capabilities.effort.options.some((o) => o.id === "max"), "Fable 5 exposes effort up to max");

// Reasoning controls match the spec per model.
const eff = (id) => byId[id].capabilities.effort;
const th = (id) => byId[id].capabilities.thinking;
assert(th("MiniMax M3").supported && th("MiniMax M3").modes.map((o) => o.id).join() === "enabled,adaptive,disabled", "MiniMax M3 is a 3-mode thinking control");
assert(eff("GLM-5.2").options.map((o) => o.id).join() === "high,max" && th("GLM-5.2").supported, "GLM-5.2 has high/max effort + thinking");
assert(eff("Gemini 3.7 Flash").options.map((o) => o.id).join() === "low,medium,high" && eff("Gemini 3.7 Flash").defaultValue === "medium", "Gemini 3.7 Flash exposes its supported reasoning efforts");
assert(Boolean(th("Qwen3.7 Plus").budget) && th("Qwen3.7 Plus").budget.default === 81920, "Qwen3.7 Plus exposes a thinking budget");
assert(!eff("Kimi K2.7 Code").supported && !th("Kimi K2.7 Code").supported, "Kimi K2.7 Code (always-on) shows no reasoning control");
assert(!eff("Grok Build 0.1").supported && !th("Grok Build 0.1").supported, "Grok Build 0.1 (undocumented) shows no reasoning control");
assert(!eff("haiku").supported && Boolean(th("haiku").budget), "Haiku has no effort but a thinking budget");

const astra = routes.find((route) => route.harnessId === "claude-code" && route.providerId === "openai" && route.model === "GPT-6 Astra");
assert(astra?.runtimeModel === "claude-gpt-6-astra", "Astra has the Claude Code subscription-proxy alias");
assert(astra?.meta?.context === "1.05M" && astra.meta.inPerM === 10 && astra.meta.outPerM === 50, "Astra carries the official context and token prices");
assert(astra?.capabilities.effort.defaultValue === "medium" && astra.capabilities.effort.options.map((o) => o.id).join() === "low,medium,high,xhigh,max", "Astra static route exposes the cross-harness effort subset with measured medium default");
assert(astra?.capabilities.vision.image === true, "Astra static route reports image input support");

assert(routes.some((route) => route.harnessId === "codex" && route.model === "gpt-5.4" && route.enabled), "Codex default route is exposed");

// One catalog entry per MODEL; harness×model cross-routing is derived from its
// fields: every entry is a claude-code route (openai entries via their
// claude-gpt-* router alias — the cross feature), entries with a codexModel are
// ALSO static codex routes, and each OR model adds a codex OpenRouter route.
console.log("\nHarness×model cross-routing (one catalog entry per model):");
const codexAccountCount = modelCatalog().filter((m) => m.provider === "openai" && m.codexModel).length;
const cursorModelCount = modelCatalog().filter((m) => m.cursorModel).length;
const cursorBridgeServesClaudeCode = modelCatalog().some((m) => m.provider === "cursor" && m.cursorAcpModelId);
const unavailableCursorProviderCount = cursorModelCount * (cursorBridgeServesClaudeCode ? 1 : 2);
const deepseekCodexCount = deepseekModels().length;
// One term per route-producing rule in buildModelRoutes, named so that adding a
// harness shows up here as a missing term rather than as an off-by-N on an
// anonymous sum. The Grok Build CLI owns its own model list (the catalog does
// not route it), so its count comes from the registry, not from modelCatalog().
const expectedRouteCount =
  modelCatalog().length            // claude-code: every catalog entry
  + codexAccountCount              // codex: native OpenAI models
  + orRoutedModels().length        // codex: OpenRouter-served models
  + claudeSubscriptionModels().length  // codex: Claude subscription models
  + deepseekCodexCount             // codex: DeepSeek's own API
  + grokHarnessRoutes().length     // grok: what the Grok Build CLI serves
  + modelCatalog().length          // cursor: every catalog entry
  + unavailableCursorProviderCount // cursor-provider models parked on other harnesses
  + 1;                             // cursor: the Auto route
assert(expectedRouteCount === routes.length, `all catalog combinations plus executable Cursor and Grok routes are produced (expected ${expectedRouteCount}, got ${routes.length})`);
// DeepSeek direct API: claude-code reaches every model through the Anthropic
// endpoint; codex only reaches the ones DeepSeek serves on the Responses wire.
console.log("\nDeepSeek direct API routes:");
for (const m of deepseekModels()) {
  assert(routerTargetForModel(m.runtimeModel)?.kind === "deepseek", `${m.id} targets DeepSeek's own API on claude-code`);
  assert(routerTargetForModel(m.runtimeModel)?.model === m.deepseekModel, `${m.id} carries the native slug '${m.deepseekModel}'`);
  const codexRoute = routes.find((r) => r.harnessId === "codex" && r.modelProvider === "deepseek" && r.model === m.deepseekModel);
  assert(Boolean(codexRoute), `${m.id} is listed on the codex harness`);
  assert(codexRoute?.enabled === (m.deepseekResponsesApi === true), `${m.id} codex route enabled matches Responses API support (${m.deepseekResponsesApi === true})`);
  if (!m.deepseekResponsesApi) {
    assert(/Responses API/.test(codexRoute?.unavailableReason || ""), `${m.id} explains why codex cannot run it instead of hiding the route`);
  }
  assert(m.vision?.image === false, `${m.id} is declared text-only (DeepSeek serves no image input)`);
}
assert(deepseekModels().some((m) => m.deepseekResponsesApi === true), "at least one DeepSeek model is executable on codex");

const cursorRoutes = routes.filter((route) => route.harnessId === "cursor");
assert(cursorRoutes.length === modelCatalog().length + 1 && cursorRoutes.some((route) => route.model === "Auto"), "Cursor harness catalogues every model plus Auto");
assert(cursorRoutes.find((route) => route.model === "Auto")?.runtimeModel === "auto", "Cursor Auto route carries the CLI auto slug");
assert(cursorRoutes.find((route) => route.model === "Grok 4.5")?.runtimeModel === "cursor-grok-4.5-high", "Cursor Grok route carries the verified named-model slug");
const grokRoutes = grokHarnessRoutes();
assert(grokRoutes.map((route) => route.model).join(",") === "grok-4.6,grok-4.5", "Grok Build exposes 4.6 first and retains 4.5");
assert(grokRoutes.every((route) => route.pricing.context === "500K"), "Grok Build routes carry the ACP-reported 500K context");
const grok46 = grokRoutes.find((route) => route.model === "grok-4.6");
const grok45 = grokRoutes.find((route) => route.model === "grok-4.5");
assert(grok46?.capabilities.effort.supported && grok46.capabilities.effort.defaultValue === "high" && grok46.capabilities.effort.options.map((option) => option.id).join() === "low,medium,high,xhigh", "Grok 4.6 exposes its measured effort menu and high default");
assert(grok45?.capabilities.effort.supported && grok45.capabilities.effort.defaultValue === "high" && grok45.capabilities.effort.options.map((option) => option.id).join() === "low,medium,high", "Grok 4.5 exposes its measured effort menu and high default");
assert(grokRoutes.every((route) => route.capabilities.effort.mutableDuringSession === false && route.capabilities.thinking.supported === false), "Grok effort is start-time-only and reasoning has no separate toggle");
assert(cursorRoutes.find((route) => route.model === "Grok 4.5")?.capabilities.serviceTier?.options.map((o) => o.id).join() === "standard,fast", "Cursor Grok exposes independent Standard/Fast service modes");
const cursorBridgeRoute = routes.find((route) => route.harnessId === "claude-code" && route.providerId === "cursor" && route.model === "Grok 4.5 Cursor");
assert(cursorBridgeRoute?.enabled === false && cursorBridgeRoute.locked === true, "Claude Code keeps the executable Cursor ACP bridge visible but beta-locked");
assert(!routes.some((route) => route.harnessId === "claude-code" && route.providerId === "cursor" && route.model === "Grok 4.5" && route.enabled === false), "Claude Code omits the obsolete disabled Cursor Grok duplicate");
for (const [id, slug, perf, costTier] of [["GPT-6 Astra", "gpt-6-astra", 5, 5], ["GPT-5.6 Sol", "gpt-5.6-sol", 5, 5], ["GPT-5.6 Terra", "gpt-5.6-terra", 4, 4], ["GPT-5.6 Luna", "gpt-5.6-luna", 3, 3]]) {
  const codexRoute = routes.find((route) => route.harnessId === "codex" && route.model === slug);
  assert(Boolean(codexRoute), `'${slug}' is selectable on the codex harness without discovery`);
  assert(codexRoute?.meta?.perf === perf && codexRoute?.meta?.costTier === costTier, `'${slug}' carries leaderboard meta perf ${perf} / cost ${costTier}`);
  assert(codexRoute?.capabilities.effort.supported && codexRoute.capabilities.effort.options.some((o) => o.id === "max"), `'${slug}' exposes effort up to max (transportable subset)`);
  const claudeRoute = routes.find((route) => route.harnessId === "claude-code" && route.model === id);
  assert(claudeRoute?.runtimeModel === `claude-${slug}`, `'${id}' is ALSO a claude-code route via the claude-${slug} router alias (cross feature)`);
}
assert(routes.some((r) => r.harnessId === "claude-code" && r.runtimeModel === "claude-gpt-5.5"), "GPT-5.5 keeps its claude-code router route (cross feature regression guard)");
// Multiple providers may expose the same model label; only the full
// harness/provider/model identity must remain unique.
for (const harness of ["claude-code", "codex"]) {
  const keys = routes.filter((r) => r.harnessId === harness).map((r) => `${r.harnessId}::${r.providerId}::${r.model}`);
  assert(new Set(keys).size === keys.length, `no duplicate route identities on the ${harness} harness`);
}

// Canonical-spelling resolution (the vanished-Adaptive bug). A live session
// echoes the harness canonical id ("claude-opus-4-8[1m]") and a member once
// persisted the OpenRouter slug ("anthropic/claude-opus-4.8"); every spelling
// must resolve to the SAME catalog entry, or the Runtime modal silently loses
// the model's capabilities (thinking/Adaptive control, context denominator)
// and the adapter routes a subscription model through the router → OpenRouter.
console.log("\nCanonical model-spelling resolution:");
assert(resolveCatalogModel("claude-opus-5")?.id === "claude-opus-5[1m]", "harness canonical 'claude-opus-5' → claude-opus-5[1m]");
assert(resolveCatalogModel("anthropic/claude-opus-5")?.id === "claude-opus-5[1m]", "OpenRouter slug → claude-opus-5[1m]");
assert(resolveCatalogModel("claude-opus-4-8[1m]")?.id === "claude-opus-4-8[1m]", "Opus 4.8 keeps its own entry (never absorbed by the Opus 5 route)");
assert(resolveCatalogModel("claude-sonnet-4-6")?.id === "sonnet", "harness canonical 'claude-sonnet-4-6' → sonnet");
assert(resolveCatalogModel("anthropic/claude-opus-4.8")?.id === "claude-opus-4-8[1m]", "OpenRouter slug → claude-opus-4-8[1m]");
assert(resolveCatalogModel("Opus 5")?.id === "claude-opus-5[1m]", "display label → claude-opus-5[1m]");
assert(resolveCatalogModel("claude-fable-5")?.id === "claude-fable-5[1m]", "bare fable id → the [1m] catalog entry");
assert(resolveCatalogModel("opus[1m]")?.id === "claude-opus-5[1m]", "retired 'opus[1m]' alias resolves to what it actually ran (Opus 5) — persisted members heal instead of dropping out of the catalog");
assert(resolveCatalogModel("totally-unknown-model") === undefined, "unknown model stays unresolved (no silent guess)");
assert(displayModelFor("claude-opus-4-8[1m]") === "Opus 4.8", "displayModelFor resolves the canonical id to the versioned label");
assert(runtimeModelFor("anthropic/claude-opus-4.8") === "claude-opus-4-8[1m]", "runtimeModelFor sends the NATIVE id to the harness (never the slug → router/OR billing)");
assert(inferModelProvider("anthropic/claude-opus-4.8") === "anthropic", "OR slug infers the HOME provider, not 'custom'");
const canonicalRoute = findRoute("claude-opus-4-8[1m]", routes);
assert(canonicalRoute?.harnessId === "claude-code" && canonicalRoute?.model === "claude-opus-4-8[1m]", "findRoute maps the canonical id to the claude-code opus route");
assert(canonicalRoute?.capabilities.thinking.modes.map((o) => o.id).join() === "adaptive,disabled", "…which still carries the Adaptive thinking control");
assert(buildModelRoutes("claude-opus-5", [], []).filter((r) => r.harnessId === "claude-code" && r.providerId === "anthropic" && r.model === "claude-opus-5").length === 0, "a canonical spelling never injects a duplicate fallback route");

// Stale-model healing (guards the member-create bug where a legacy persisted
// model — "GLM-5.2 (OpenRouter)" — was selectable and only failed at chat time).
console.log("\nStale model healing assertions:");
const legacy = "GLM-5.2 (OpenRouter)";
assert(!catalogModelById(legacy) && !catalogModelByRuntime(legacy), "legacy 'GLM-5.2 (OpenRouter)' is not catalogued (settings sanitize resets it)");
assert(Boolean(catalogModelById("GLM-5.2")) && byId["GLM-5.2"].providerId === "openrouter", "clean 'GLM-5.2' is a routable OpenRouter model");
assert(buildModelRoutes(legacy, [], []).some((r) => r.model === legacy), "an unroutable current model injects a selectable fallback route — the bug source");
assert(!buildModelRoutes("sonnet", [], []).some((r) => r.model === legacy), "a sanitized (catalog) current model never surfaces the legacy id");

// A caller can carry transport metadata from a stale/cross-harness route. The
// Claude adapter must keep native Anthropic selections on their subscription
// ids; Codex handles its own OpenRouter route independently.
console.log("\nClaude native runtime boundary assertions:");
assert(claudeRuntimeModelFor("claude-opus-5[1m]", "anthropic", "anthropic/claude-opus-5") === "claude-opus-5[1m]", "Claude Opus ignores an OpenRouter runtime slug and stays native");
assert(claudeRuntimeModelFor("Opus 5", "anthropic", "anthropic/claude-opus-5") === "claude-opus-5[1m]", "display-label Opus 5 also normalizes to the native 1M id");
assert(claudeRuntimeModelFor("GLM-5.2", "openrouter", "claude-glm-5.2") === "claude-glm-5.2", "router-backed Claude aliases remain explicit");

// Context-window parsing feeds the per-member context-capacity meter's denominator.
console.log("\nContext-window parse assertions:");
assert(parseContextTokens("1M") === 1_000_000, "'1M' → 1,000,000");
assert(parseContextTokens("200K") === 200_000, "'200K' → 200,000");
assert(parseContextTokens("1.05M") === 1_050_000, "'1.05M' → 1,050,000");
assert(parseContextTokens("262K") === 262_000, "'262K' → 262,000");
assert(parseContextTokens("—") === undefined, "unknown placeholder '—' → undefined (no fabricated window)");
assert(parseContextTokens(undefined) === undefined, "undefined input → undefined");
assert(parseContextTokens("garbage") === undefined, "unparseable → undefined");
// Every catalogued model either has a parseable window or the explicit unknown.
for (const m of modelCatalog()) {
  const ok = m.context === "—" || typeof parseContextTokens(m.context) === "number";
  assert(ok, `catalog '${m.id}' context '${m.context}' is parseable or explicit unknown`);
}

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nMODEL CATALOG PASSED");
process.exit(failures.length ? 1 : 0);
