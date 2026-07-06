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

const { buildModelRoutes } = await load("src/core/modelRegistry.ts", "mr.mjs");
const { openRouterAliasMap, openRouterModels, modelCatalog, catalogModelById, catalogModelByRuntime, parseContextTokens } = await load("src/shared/modelCatalog.ts", "cat.mjs");

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

console.log("\nModel catalog / registry assertions:");
const routes = buildModelRoutes("sonnet", [], []);
const byId = Object.fromEntries(routes.map((r) => [r.model, r]));

// Leaderboard OR-O set must be exactly these, with concrete OR ids.
const expectedOr = ["GLM-5.2", "Gemini 3.5 Flash", "Qwen3.7 Max", "DeepSeek V4 Pro", "MiniMax M3", "Gemini 3.x Pro", "Kimi K2.7 Code", "Kimi K2.6", "Grok Build 0.1", "Qwen3.7 Plus", "Grok 4.3"];
// OpenRouter models appear on BOTH harnesses: as claude-code routes (router-backed)
// and as codex routes (Phase 2, modelProvider=openrouter). `byId` keys off the
// claude-code label; codex OR routes are keyed by the orModelId slug.
const orClaudeRoutes = routes.filter((r) => r.providerId === "openrouter" && r.harnessId === "claude-code");
assert(orClaudeRoutes.length === expectedOr.length, `exactly ${expectedOr.length} OpenRouter models on the claude-code harness (got ${orClaudeRoutes.length})`);
assert(expectedOr.every((id) => byId[id]), "all leaderboard OR-O models are present");
const orCodexRoutes = routes.filter((r) => r.providerId === "openrouter" && r.harnessId === "codex");
assert(orCodexRoutes.length === expectedOr.length, `all ${expectedOr.length} OpenRouter models also exposed as codex routes (got ${orCodexRoutes.length})`);
assert(orCodexRoutes.every((r) => r.modelProvider === "openrouter" && /.+\/.+/.test(r.model)), "codex OR routes pin modelProvider=openrouter + carry the orModelId slug");

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

// Leaderboard metrics flow onto routes.
assert(byId["MiniMax M3"].meta?.perf === 2 && byId["MiniMax M3"].meta?.costTier === 1, "MiniMax M3 perf/cost from leaderboard");
assert(byId["MiniMax M3"].meta?.ioPerM === 0.53, "MiniMax M3 io price present");
assert(byId["Claude Opus 4.8"] === undefined && byId["opus[1m]"].meta?.perf === 5, "Opus mapped to opus[1m] with perf 5");

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
// Routes = every catalog entry (claude-code) + the static Codex account fallback
// + one codex OpenRouter route per OpenRouter catalog model (Phase 2).
assert(modelCatalog().length + 1 + openRouterModels().length === routes.length, "catalog + Codex default + codex OpenRouter routes all produced");

// Stale-model healing (guards the member-create bug where a legacy persisted
// model — "GLM-5.2 (OpenRouter)" — was selectable and only failed at chat time).
console.log("\nStale model healing assertions:");
const legacy = "GLM-5.2 (OpenRouter)";
assert(!catalogModelById(legacy) && !catalogModelByRuntime(legacy), "legacy 'GLM-5.2 (OpenRouter)' is not catalogued (settings sanitize resets it)");
assert(Boolean(catalogModelById("GLM-5.2")) && byId["GLM-5.2"].providerId === "openrouter", "clean 'GLM-5.2' is a routable OpenRouter model");
assert(buildModelRoutes(legacy, [], []).some((r) => r.model === legacy), "an unroutable current model injects a selectable fallback route — the bug source");
assert(!buildModelRoutes("sonnet", [], []).some((r) => r.model === legacy), "a sanitized (catalog) current model never surfaces the legacy id");

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
