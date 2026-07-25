/*
 * Context-capacity meter — denominator resolution regression test (offline).
 * The live snapshot reports the adapter's DISPLAY model (a label like "Opus 5" or
 * a raw SDK slug), while routes are keyed by catalog id ("claude-opus-5[1m]"). Exact
 * case-sensitive matching silently dropped the route for every native Anthropic
 * model, so the meter showed "266K" instead of "266K/1M" depending on what
 * happened to be stored in member.model. Locks the tolerant findRoute contract
 * (id / runtimeModel / label, any casing) and the no-fabricated-denominator rule.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const outDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(outDir, { recursive: true });
async function load(entry, name) {
  const bundled = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "neutral", write: false });
  const file = path.join(outDir, name);
  writeFileSync(file, bundled.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}
const { buildMemberView } = await load("src/renderer/workbench/memberStatus.ts", "ctx-member-status.mjs");
const { findRoute } = await load("src/renderer/workbench/routes.ts", "ctx-routes.mjs");

const routes = [
  { harnessId: "claude-code", providerId: "anthropic", model: "claude-opus-5[1m]", label: "Opus 5", meta: { context: "1M" }, capabilities: { vision: { image: true } } },
  { harnessId: "claude-code", providerId: "anthropic", model: "sonnet", label: "Sonnet 4.6", meta: { context: "1M" } },
  { harnessId: "claude-code", providerId: "openai", model: "GPT-5.5", runtimeModel: "claude-gpt-5.5", label: "GPT-5.5", meta: { context: "400K" } },
];

function contextOf(snapshotModel, memberModel, extra = {}) {
  const member = { name: "w", status: "running", runtime: "claude-code", sessionId: "s1", model: memberModel };
  const session = { id: "s1", snapshot: { status: "idle", model: snapshotModel, contextTokens: 266_000, ...extra } };
  return buildMemberView({ member, sessions: [session], transcriptBySession: { s1: [] }, seenCount: 0, routes }).context;
}

/** No live session — the meter must fall back to the member's persisted occupancy. */
function restoredContextOf(memberExtra = {}) {
  const member = { name: "w", status: "closed", runtime: "claude-code", model: "claude-opus-5[1m]", ...memberExtra };
  return buildMemberView({ member, sessions: [], transcriptBySession: {}, seenCount: 0, routes }).context;
}

console.log("\nfindRoute tolerant matching:");
assert(findRoute("claude-opus-5[1m]", routes)?.label === "Opus 5", "matches by exact route id with the versioned display label");
assert(findRoute("Opus 5", routes)?.model === "claude-opus-5[1m]", "matches by display label (the live snapshot's value)");
assert(findRoute("opus 5", routes)?.model === "claude-opus-5[1m]", "matches label case-insensitively ('opus 5')");
assert(findRoute("claude-gpt-5.5", routes)?.model === "GPT-5.5", "matches by runtime id");
assert(findRoute("CLAUDE-GPT-5.5", routes)?.model === "GPT-5.5", "matches runtime id case-insensitively");
assert(findRoute("no-such-model", routes) === undefined, "unknown model resolves to nothing (no silent routes[0])");
assert(findRoute("GPT-5.5", routes)?.runtimeModel === "claude-gpt-5.5", "id match wins before label scan");

console.log("\ncontext meter denominator:");
assert(contextOf("Opus 5", "claude-opus-5[1m]")?.total === 1_000_000, "label snapshot + id member → 1M window");
assert(contextOf("Opus 5", undefined)?.total === 1_000_000, "label snapshot alone resolves the window (was the '266K without /1M' bug)");
assert(contextOf("claude-opus-5-20260701", "claude-opus-5[1m]")?.total === 1_000_000, "raw SDK slug falls back to the member's configured id");
assert(contextOf("claude-opus-5-20260701", "opus 5")?.total === 1_000_000, "lower-cased label stored on the member still resolves");
assert(contextOf("claude-opus-5-20260701", "totally-unknown")?.total === undefined, "no resolvable window → no fabricated denominator");
assert(contextOf("claude-opus-5-20260701", "totally-unknown")?.used === 266_000, "used count still shown without a window");
assert(contextOf("gpt-x", "gpt-x", { contextWindow: 272_000 })?.total === 272_000, "a harness-reported numeric window wins over the catalog");
assert(contextOf("Opus 5", "claude-opus-5[1m]")?.stale === false, "a live snapshot reading is not stale");

console.log("\npersisted (last-known) occupancy — reopened app before first turn:");
assert(restoredContextOf({ lastContextTokens: 266_000 })?.used === 266_000, "no live session → falls back to member.lastContextTokens");
assert(restoredContextOf({ lastContextTokens: 266_000 })?.stale === true, "restored occupancy is flagged stale (meter marks it 'last known')");
assert(restoredContextOf({ lastContextTokens: 266_000 })?.total === 1_000_000, "restored used still resolves the window from the member's model catalog");
assert(restoredContextOf({ lastContextTokens: 266_000, lastContextWindow: 190_000 })?.total === 190_000, "a persisted numeric window wins over the catalog");
assert(restoredContextOf({})?.used === undefined && restoredContextOf({}) === undefined, "no live session AND no persisted occupancy → no meter (nothing invented)");

console.log(failures.length ? `\nCONTEXT METER FAILED (${failures.length})` : "\nCONTEXT METER PASSED");
process.exit(failures.length ? 1 : 0);
