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

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(qaDir, { recursive: true });

async function load(entry, name) {
  const out = path.join(qaDir, name);
  await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  return import(pathToFileURL(out).href);
}

const { buildModelRoutes, displayModelFor, runtimeModelFor, inferModelProvider } = await load("src/core/modelRegistry.ts", "mr.mjs");
const { openRouterAliasMap, openRouterModels, orRoutedModels, claudeSubscriptionModels, routerTargetForModel, modelCatalog, catalogModelById, catalogModelByRuntime, resolveCatalogModel, parseContextTokens } = await load("src/shared/modelCatalog.ts", "cat.mjs");
const { findRoute } = await load("src/renderer/workbench/routes.ts", "routes.mjs");
const { PROVIDER_LABELS } = await load("src/renderer/workbench/modelCatalog.ts", "provider-labels.mjs");
const { claudeRuntimeModelFor } = await load("src/core/claudeAdapter.ts", "claude-adapter.mjs");

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

console.log("\nModel catalog / registry assertions:");
const routes = buildModelRoutes("sonnet", [], []);
const byId = Object.fromEntries(routes.map((r) => [r.model, r]));
const liveSolRoute = buildModelRoutes("sonnet", [], [], [{ model: "gpt-5.6-sol", displayName: "gpt-5.6-sol", isDefault: false, hidden: false, reasoningEfforts: [], serviceTiers: [] }])
  .find((r) => r.harnessId === "codex" && r.model === "gpt-5.6-sol");
assert(liveSolRoute?.label === "GPT-5.6 Sol", "live Codex discovery keeps the shared catalog label (transport slug stays internal)");
assert(PROVIDER_LABELS.anthropic === "Claude" && PROVIDER_LABELS.openai === "Codex" && PROVIDER_LABELS.openrouter === "OpenRouter", "model groups use the same three provider names as Authentication");
for (const harnessId of ["claude-code", "codex"]) {
  for (const providerId of ["anthropic", "openai", "openrouter"]) {
    assert(routes.some((route) => route.harnessId === harnessId && route.providerId === providerId), `${harnessId} exposes a separate ${PROVIDER_LABELS[providerId]} model group`);
  }
}

// Leaderboard OR-O set must be exactly these, with concrete OR ids.
const expectedOr = ["GLM-5.2", "Gemini 3.5 Flash", "Qwen3.7 Max", "DeepSeek V4 Pro", "MiniMax M3", "Gemini 3.x Pro", "Kimi K2.7 Code", "Kimi K2.6", "Grok Build 0.1", "Qwen3.7 Plus", "Grok 4.3"];
// OpenRouter models appear on BOTH harnesses: as claude-code routes (router-backed)
// and as codex routes (Phase 2, modelProvider=openrouter). `byId` keys off the
// claude-code label; codex OR routes are keyed by the orModelId slug.
const orClaudeRoutes = routes.filter((r) => r.providerId === "openrouter" && r.harnessId === "claude-code");
assert(orClaudeRoutes.length === expectedOr.length, `exactly ${expectedOr.length} OpenRouter models on the claude-code harness (got ${orClaudeRoutes.length})`);
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
const gptMiniClaudeRoute = routes.find((route) => route.harnessId === "claude-code" && route.model === "GPT-5.4 mini");
assert(alias["claude-gpt-5.4-mini"] === undefined, "Claude Code GPT mini is absent from the OpenRouter alias map");
assert(routerTargetForModel("claude-gpt-5.4-mini")?.kind === "codex-subscription", "Claude Code GPT mini targets the Codex subscription proxy");
assert(gptMiniClaudeRoute?.runtimeModel === "claude-gpt-5.4-mini", "Claude Code GPT mini route keeps the Claude harness alias");
assert(gptMiniClaudeRoute?.pricing?.billing === "subscription", "Claude Code GPT mini is billed to the Codex subscription");

// Leaderboard metrics flow onto routes.
assert(byId["MiniMax M3"].meta?.perf === 2 && byId["MiniMax M3"].meta?.costTier === 1, "MiniMax M3 perf/cost from leaderboard");
assert(byId["MiniMax M3"].meta?.ioPerM === 0.53, "MiniMax M3 io price present");
assert(byId["Claude Opus 4.8"] === undefined && byId["opus[1m]"].meta?.perf === 5, "Opus mapped to opus[1m] with perf 5");
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
assert(Boolean(th("Qwen3.7 Plus").budget) && th("Qwen3.7 Plus").budget.default === 81920, "Qwen3.7 Plus exposes a thinking budget");
assert(!eff("Kimi K2.7 Code").supported && !th("Kimi K2.7 Code").supported, "Kimi K2.7 Code (always-on) shows no reasoning control");
assert(!eff("Grok Build 0.1").supported && !th("Grok Build 0.1").supported, "Grok Build 0.1 (undocumented) shows no reasoning control");
assert(!eff("haiku").supported && Boolean(th("haiku").budget), "Haiku has no effort but a thinking budget");

assert(routes.some((route) => route.harnessId === "codex" && route.model === "gpt-5.4" && route.enabled), "Codex default route is exposed");

// One catalog entry per MODEL; harness×model cross-routing is derived from its
// fields: every entry is a claude-code route (openai entries via their
// claude-gpt-* router alias — the cross feature), entries with a codexModel are
// ALSO static codex routes, and each OR model adds a codex OpenRouter route.
console.log("\nHarness×model cross-routing (one catalog entry per model):");
const codexAccountCount = modelCatalog().filter((m) => m.provider === "openai" && m.codexModel).length;
assert(modelCatalog().length + codexAccountCount + orRoutedModels().length + claudeSubscriptionModels().length === routes.length, "claude-code catalog routes + Codex account/OpenRouter/Claude-subscription routes all produced");
for (const [id, slug, perf, costTier] of [["GPT-5.6 Sol", "gpt-5.6-sol", 5, 5], ["GPT-5.6 Terra", "gpt-5.6-terra", 4, 4], ["GPT-5.6 Luna", "gpt-5.6-luna", 3, 3]]) {
  const codexRoute = routes.find((route) => route.harnessId === "codex" && route.model === slug);
  assert(Boolean(codexRoute), `'${slug}' is selectable on the codex harness without discovery`);
  assert(codexRoute?.meta?.perf === perf && codexRoute?.meta?.costTier === costTier, `'${slug}' carries leaderboard meta perf ${perf} / cost ${costTier}`);
  assert(codexRoute?.capabilities.effort.supported && codexRoute.capabilities.effort.options.some((o) => o.id === "max"), `'${slug}' exposes effort up to max (transportable subset)`);
  const claudeRoute = routes.find((route) => route.harnessId === "claude-code" && route.model === id);
  assert(claudeRoute?.runtimeModel === `claude-${slug}`, `'${id}' is ALSO a claude-code route via the claude-${slug} router alias (cross feature)`);
}
assert(routes.some((r) => r.harnessId === "claude-code" && r.runtimeModel === "claude-gpt-5.5"), "GPT-5.5 keeps its claude-code router route (cross feature regression guard)");
// No model label appears twice within one harness (the duplicate-exposure bug);
// the SAME label on both harnesses is the cross feature, not a duplicate.
for (const harness of ["claude-code", "codex"]) {
  const labels = routes.filter((r) => r.harnessId === harness).map((r) => r.label);
  assert(new Set(labels).size === labels.length, `no duplicate model labels on the ${harness} harness`);
}

// Canonical-spelling resolution (the vanished-Adaptive bug). A live session
// echoes the harness canonical id ("claude-opus-4-8[1m]") and a member once
// persisted the OpenRouter slug ("anthropic/claude-opus-4.8"); every spelling
// must resolve to the SAME catalog entry, or the Runtime modal silently loses
// the model's capabilities (thinking/Adaptive control, context denominator)
// and the adapter routes a subscription model through the router → OpenRouter.
console.log("\nCanonical model-spelling resolution:");
assert(resolveCatalogModel("claude-opus-4-8[1m]")?.id === "opus[1m]", "harness canonical 'claude-opus-4-8[1m]' → opus[1m]");
assert(resolveCatalogModel("claude-sonnet-4-6")?.id === "sonnet", "harness canonical 'claude-sonnet-4-6' → sonnet");
assert(resolveCatalogModel("anthropic/claude-opus-4.8")?.id === "opus[1m]", "OpenRouter slug → opus[1m]");
assert(resolveCatalogModel("Opus")?.id === "opus[1m]", "display label → opus[1m]");
assert(resolveCatalogModel("claude-fable-5")?.id === "claude-fable-5[1m]", "bare fable id → the [1m] catalog entry");
assert(resolveCatalogModel("totally-unknown-model") === undefined, "unknown model stays unresolved (no silent guess)");
assert(displayModelFor("claude-opus-4-8[1m]") === "Opus 4.8", "displayModelFor resolves the canonical id to the versioned label");
assert(runtimeModelFor("anthropic/claude-opus-4.8") === "opus[1m]", "runtimeModelFor sends the NATIVE id to the harness (never the slug → router/OR billing)");
assert(inferModelProvider("anthropic/claude-opus-4.8") === "anthropic", "OR slug infers the HOME provider, not 'custom'");
const canonicalRoute = findRoute("claude-opus-4-8[1m]", routes);
assert(canonicalRoute?.harnessId === "claude-code" && canonicalRoute?.model === "opus[1m]", "findRoute maps the canonical id to the claude-code opus route");
assert(canonicalRoute?.capabilities.thinking.modes.map((o) => o.id).join() === "adaptive,disabled", "…which still carries the Adaptive thinking control");
assert(!buildModelRoutes("claude-opus-4-8[1m]", [], []).some((r) => r.model === "claude-opus-4-8[1m]"), "a canonical spelling never injects a duplicate fallback route");

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
assert(claudeRuntimeModelFor("opus[1m]", "anthropic", "anthropic/claude-opus-4.8") === "opus[1m]", "Claude Opus ignores an OpenRouter runtime slug and stays native");
assert(claudeRuntimeModelFor("Opus", "anthropic", "anthropic/claude-opus-4.8") === "opus[1m]", "display-label Opus also normalizes to the native 1M id");
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
