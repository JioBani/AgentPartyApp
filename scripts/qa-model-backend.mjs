/*
 * Invariant test for the data-driven transport routing (src/shared/modelIdentity.ts).
 * Guards the class of bug this module was built to kill: "native vs router" is
 * derived from the catalog entry's fields, NOT a hardcoded model-name list, so a
 * new catalog entry routes correctly without editing any parallel string list.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
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

const { backendFor, backendSlug, parseModelId, isClaudeNative, executionHarnessFor, executionModelFor } = await load("src/shared/modelIdentity.ts", "identity.mjs");
const { modelCatalog } = await load("src/shared/modelCatalog.ts", "cat2.mjs");

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

console.log("\nBackend derivation (every catalog model routes from its own fields):");
for (const m of modelCatalog()) {
  // claude-code harness expectations by home provider.
  const cc = backendFor(m.id, "claude-code");
  if (m.provider === "anthropic") {
    assert(cc?.kind === "claude-native" && cc.id === m.id, `${m.id}: anthropic → claude-native (${cc?.kind})`);
  } else if (m.runtimeModel) {
    assert(cc?.kind === "claude-router" && cc.alias === m.runtimeModel, `${m.id}: ${m.provider} w/ alias → claude-router (${cc?.kind})`);
  }
  // codex harness expectations.
  const cx = backendFor(m.id, "codex");
  if (m.codexModel) {
    assert(cx?.kind === "codex-account" && cx.slug === m.codexModel, `${m.id}: codexModel → codex-account (${cx?.kind})`);
  } else if (m.claudeSubscriptionModel) {
    assert(cx?.kind === "codex-claude-subscription" && cx.model === m.claudeSubscriptionModel, `${m.id}: claudeSubscriptionModel → codex-claude-subscription (${cx?.kind})`);
  } else if (m.provider === "openrouter" && m.orModelId) {
    assert(cx?.kind === "codex-openrouter" && cx.orModelId === m.orModelId, `${m.id}: orModelId → codex-openrouter (${cx?.kind})`);
  }
  // Every produced backend yields a non-empty egress slug (no route ships blank).
  if (cc) assert(Boolean(backendSlug(cc)), `${m.id}: claude-code backend has an egress slug`);
  if (cx) assert(Boolean(backendSlug(cx)), `${m.id}: codex backend has an egress slug`);
}

console.log("\nNative detection is spelling-independent (the recurring-bug guard):");
// An Anthropic model must resolve to native by ANY spelling — catalog id, label,
// OpenRouter slug, and the harness-reported canonical id — with NO name list. If
// this holds for these it holds for the next Opus generation the same way.
for (const [spelling, why] of [
  ["claude-opus-5[1m]", "catalog id"],
  ["Opus 5", "display label"],
  ["anthropic/claude-opus-5", "OpenRouter slug"],
  ["claude-opus-5", "harness canonical id"],
  ["claude-opus-4-8[1m]", "previous-generation catalog id"],
]) {
  assert(isClaudeNative(backendFor(spelling, "claude-code")), `Opus via ${why} ('${spelling}') → claude-native`);
}
// Router-backed selections stay router.
assert(backendFor("claude-gpt-5.6-sol", "claude-code")?.kind === "claude-router", "GPT-5.6 Sol stays on Claude Code through its router alias");
assert(executionHarnessFor("GPT-5.4 mini", "claude-code") === "claude-code", "Claude-surface GPT mini executes on the Claude Code harness");
assert(executionModelFor("GPT-5.4 mini", "claude-code") === "claude-gpt-5.4-mini", "Claude-surface GPT mini uses the Claude router alias");
assert(executionHarnessFor("sonnet", "claude-code") === "claude-code", "native Sonnet stays on Claude Code");
assert(backendFor("GLM-5.2", "claude-code")?.kind === "claude-router", "GLM-5.2 → claude-router on claude-code");
// Opus on the Codex harness keeps Codex policy while using Claude OAuth.
assert(backendFor("claude-opus-5[1m]", "codex")?.kind === "codex-claude-subscription", "Opus on Codex → Claude subscription (cross feature)");

console.log("\nparseModelId is a closed gate (no silent guess):");
assert(parseModelId("claude-opus-5") === "claude-opus-5[1m]", "canonical id → 'claude-opus-5[1m]'");
assert(parseModelId("Opus 5") === "claude-opus-5[1m]", "label → 'claude-opus-5[1m]'");
assert(parseModelId("totally-unknown") === undefined, "unknown spelling → undefined");
assert(parseModelId(undefined) === undefined, "undefined → undefined");
// An uncatalogued model has no derivable backend (caller falls back to metadata).
assert(backendFor("totally-unknown", "claude-code") === undefined, "uncatalogued model → no backend (explicit)");

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nMODEL BACKEND PASSED");
process.exit(failures.length ? 1 : 0);
