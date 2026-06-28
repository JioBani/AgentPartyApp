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
const { openRouterAliasMap, openRouterModels, modelCatalog } = await load("src/shared/modelCatalog.ts", "cat.mjs");

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

console.log("\nModel catalog / registry assertions:");
const routes = buildModelRoutes("sonnet", [], []);
const byId = Object.fromEntries(routes.map((r) => [r.model, r]));

// Leaderboard OR-O set must be exactly these, with concrete OR ids.
const expectedOr = ["GLM-5.2", "Gemini 3.5 Flash", "Qwen3.7 Max", "DeepSeek V4 Pro", "MiniMax M3", "Gemini 3.x Pro", "Kimi K2.7 Code", "Kimi K2.6", "Grok Build 0.1", "Qwen3.7 Plus", "Grok 4.3"];
const orRoutes = routes.filter((r) => r.providerId === "openrouter");
assert(orRoutes.length === expectedOr.length, `exactly ${expectedOr.length} OpenRouter models exposed (got ${orRoutes.length})`);
assert(expectedOr.every((id) => byId[id]), "all leaderboard OR-O models are present");

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

assert(modelCatalog().length === routes.length, "every catalog entry produced a route");

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nMODEL CATALOG PASSED");
process.exit(failures.length ? 1 : 0);
