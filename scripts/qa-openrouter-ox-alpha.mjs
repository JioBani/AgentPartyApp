/*
 * Ox Alpha (OpenRouter, `stealth/ox-alpha`) — catalog + routing contract.
 *
 * A model is only usable here if four things agree: the catalog entry, the
 * routes built from it, the router target the shim forwards to, and the
 * provider the icon reads. This checks all four against the ONE thing that is
 * externally fixed — the exact OpenRouter model id — so a half-registration
 * (selectable but unroutable, or routed under a stale slug) fails here rather
 * than at the user's first turn.
 *
 * Offline and free: no network, no key, no provider call.
 */
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

const outDir = qaTempDir();
// `platform` differs per entry: the registry pulls in core modules that import
// node builtins, while the renderer/shared ones must stay platform-neutral.
async function load(entry, name, platform = "neutral") {
  const result = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform, write: false });
  const file = path.join(outDir, name);
  writeFileSync(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const catalog = await load("src/shared/modelCatalog.ts", "ox-catalog.mjs");
const registry = await load("src/core/modelRegistry.ts", "ox-registry.mjs", "node");
const provider = await load("src/renderer/workbench/modelProvider.ts", "ox-provider.mjs");

/** The one externally fixed fact. Everything else is checked against it. */
const OR_MODEL_ID = "stealth/ox-alpha";
const CATALOG_ID = "Ox Alpha";

console.log("\ncatalog entry:");
const entry = catalog.catalogModelById(CATALOG_ID);
assert(Boolean(entry), "Ox Alpha is in the catalog");
assert(entry?.orModelId === OR_MODEL_ID, `it carries OpenRouter's exact model id (${entry?.orModelId})`);
assert(entry?.provider === "openrouter", "it is an OpenRouter model, not a provider of its own");
assert(Boolean(entry?.runtimeModel) && entry.runtimeModel !== OR_MODEL_ID, "it has a router alias distinct from the upstream id, like its 22 siblings");
assert(entry?.subscription === false, "it is token-billed, not a subscription model");
assert(entry?.inPerM === 0 && entry?.outPerM === 0, "the preview's free pricing is recorded rather than guessed at");
assert(catalog.catalogModelByOrModelId(OR_MODEL_ID)?.id === CATALOG_ID, "the upstream id resolves back to this entry");
assert(catalog.resolveCatalogModel("ox alpha")?.id === CATALOG_ID, "a casual spelling still resolves to it");

console.log("\nreasoning — mandatory, and adjustable in three steps:");
const effort = entry?.reasoning?.effort;
assert(effort?.options?.join(",") === "low,high,max", `effort offers exactly low / high / max (got ${effort?.options?.join(",")})`);
assert(effort?.default === "max", "…and defaults to max");
assert(!catalog.thinkingCanDisable(entry?.reasoning?.thinking), "reasoning cannot be turned off — the model has no non-reasoning mode to offer");
assert(entry?.reasoning?.thinking?.default === "enabled", "…so the only thinking mode is the enabled one");

console.log("\nmultimodal input, as OpenRouter publishes it:");
assert(entry?.vision?.image === true && entry?.vision?.video === true, "text, image and video in");

console.log("\nroutes built for it:");
const routes = registry.buildModelRoutes("sonnet", [], [], undefined);
const mine = routes.filter((route) => route.model === CATALOG_ID || route.model === OR_MODEL_ID);
const claudeCode = mine.find((route) => route.harnessId === "claude-code");
const codex = mine.find((route) => route.harnessId === "codex");
const cursor = mine.find((route) => route.harnessId === "cursor");
assert(Boolean(claudeCode) && claudeCode.enabled === true, "the claude-code harness offers it as a usable route");
assert(claudeCode?.providerId === "openrouter", "…under the OpenRouter provider, so it sorts and filters with its siblings");
assert(Boolean(codex) && codex.enabled === true && codex.model === OR_MODEL_ID, "the codex harness offers it through the OpenRouter custom provider, by upstream id");
assert(Boolean(cursor) && cursor.enabled === false && Boolean(cursor.unavailableReason), "Cursor states why it cannot serve it, rather than hiding it");
assert(claudeCode?.capabilities?.effort?.options?.map((option) => option.id).join(",") === "low,high,max", "the route carries the same three effort levels the catalog declares");
assert(claudeCode?.capabilities?.effort?.defaultValue === "max", "…and the same default");
assert(claudeCode?.capabilities?.thinking?.modes?.length === 1, "the route offers no way to switch reasoning off");
assert(claudeCode?.capabilities?.vision?.video === true, "the route carries the video capability through");

console.log("\nwhat the shim will actually send:");
assert(catalog.routerTargetForModel(entry.runtimeModel)?.kind === "openrouter", "the router alias targets OpenRouter");
assert(catalog.routerTargetForModel(entry.runtimeModel)?.model === OR_MODEL_ID, `…and rewrites the request to ${OR_MODEL_ID}`);
assert(catalog.routerTargetForModel(CATALOG_ID)?.model === OR_MODEL_ID, "the catalog id resolves to the same target, so a persisted member cannot drift");

console.log("\nprovider identity (the mark beside a member's name):");
assert(provider.providerForModel(CATALOG_ID) === "openrouter", "it resolves to OpenRouter, not to the harness that runs it");
assert(provider.providerLabel("openrouter") === "OpenRouter", "…and names OpenRouter in its tooltip and label");

console.log("\nno regression for the models it joins:");
const openrouter = catalog.modelCatalog().filter((model) => model.provider === "openrouter");
assert(openrouter.length === 23, `the 22 existing OpenRouter models are still catalogued alongside it (got ${openrouter.length})`);
const ids = openrouter.map((model) => model.orModelId);
assert(new Set(ids).size === ids.length, "no two OpenRouter entries claim the same upstream model");
const aliases = catalog.modelCatalog().map((model) => model.runtimeModel).filter(Boolean);
assert(new Set(aliases).size === aliases.length, "no two catalog entries claim the same router alias");
const enabledOr = routes.filter((route) => route.providerId === "openrouter" && route.enabled);
assert(enabledOr.length >= 44, `every OpenRouter model still has its usable routes (${enabledOr.length})`);

console.log(failures.length ? `\nFAILED: ${failures.length} assertion(s)` : "\nAll Ox Alpha catalog/routing assertions passed");
process.exit(failures.length ? 1 : 0);
