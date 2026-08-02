/*
 * Per-harness creation defaults (harness-general design). Two layers:
 *   1. types accessors (pure): harnessDefaultsOf / defaultMemberProfileOf resolve
 *      each harness's own defaults; a new harness = a new map entry (no code).
 *   2. buildPartyMember (pure): a member is created from ITS harness's defaults —
 *      a Codex member gets the Codex default model + 2-axis policy, a Claude
 *      member gets the Claude default model + permission mode — not one shared
 *      global profile.
 *   3. settings migration: a legacy flat settings.json (claudeModel/…) migrates
 *      into harnessDefaults["claude-code"] so upgrades keep the prior default.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };



const outDir = qaTempDir();
async function bundleNode(entry, name) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", packages: "external", write: false });
  const p = path.join(outDir, name);
  writeFileSync(p, r.outputFiles[0].text);
  return import(pathToFileURL(p).href);
}

const settings = {
  selectedHarnessId: "claude-code",
  harnessDefaults: {
    "claude-code": { model: "sonnet", effort: "high", reasoning: "adaptive", permissionMode: "plan" },
    codex: { model: "gpt-5.4-mini", effort: "low", codexPolicy: { sandbox: "read-only", approval: "on-request", guardian: false } },
    cursor: { model: "Grok 4.5", effort: "high", cursorPolicy: { mode: "agent", approval: "allowlist" } },
  },
};

// ---- Layer 1: accessors -----------------------------------------------------
const T = await bundleNode("src/shared/types.ts", "types-harness.mjs");
const CP = await bundleNode("src/shared/cursorPolicy.ts", "cursor-policy.mjs");
console.log("\nharness accessors:");
assert(T.harnessDefaultsOf(settings).model === "sonnet", "harnessDefaultsOf defaults to the selected harness");
assert(T.harnessDefaultsOf(settings, "codex").model === "gpt-5.4-mini", "harnessDefaultsOf resolves a specific harness");
assert(T.defaultMemberProfileOf(settings, "codex").codexPolicy?.sandbox === "read-only", "codex profile carries the codex policy default");
assert(T.HARNESS_IDS.join() === "claude-code,codex,cursor", "HARNESS_IDS lists every harness (drives the settings UI + iteration)");
assert(CP.cursorPolicyFromLegacyPermission("plan").mode === "plan", "legacy Cursor plan keeps Plan mode");
assert(CP.cursorPolicyFromLegacyPermission("auto").approval === "auto-review", "legacy Cursor auto keeps Auto-review");
assert(CP.cursorPolicyFromLegacyPermission("bypassPermissions").approval === "unrestricted", "legacy Cursor bypass keeps Run Everything");

// ---- Layer 2: buildPartyMember ----------------------------------------------
const D = await bundleNode("src/main/application/partyDomain.ts", "party-domain.mjs");
console.log("\nbuildPartyMember uses the member's harness defaults:");
const claudeMember = D.buildPartyMember({ partyId: "p1", name: "cc", role: "r", runtime: "claude-code" }, settings);
assert(claudeMember.model === "sonnet" && claudeMember.effort === "high" && claudeMember.permissionMode === "plan", "claude-code member inherits the claude-code defaults");
assert(!claudeMember.codexPolicy, "claude-code member has no codex policy");
const codexMember = D.buildPartyMember({ partyId: "p1", name: "cx", role: "r", runtime: "codex" }, settings);
assert(codexMember.model === "gpt-5.4-mini" && codexMember.effort === "low", "codex member inherits the CODEX defaults (not claude's)");
assert(codexMember.codexPolicy?.sandbox === "read-only", "codex member starts with the codex default 2-axis policy (read-only here)");
const cursorMember = D.buildPartyMember({ partyId: "p1", name: "cursor", role: "r", runtime: "cursor" }, settings);
assert(cursorMember.model === "Grok 4.5" && cursorMember.effort === "high", "cursor member inherits its Grok-only defaults");
assert(!cursorMember.codexPolicy && !cursorMember.permissionMode && cursorMember.cursorPolicy?.mode === "agent" && cursorMember.cursorPolicy?.approval === "allowlist", "cursor member uses Cursor's mode + approval policy");
const explicitCursor = D.buildPartyMember({ partyId: "p1", name: "cursor2", role: "r", runtime: "cursor", cursorPolicy: { mode: "ask", approval: "auto-review" } }, settings);
assert(explicitCursor.cursorPolicy?.mode === "ask" && explicitCursor.cursorPolicy?.approval === "auto-review", "explicit Cursor policy overrides the runtime default");
let invalidCursorPolicyError = "";
try {
  D.buildPartyMember({ partyId: "p1", name: "bad-cursor", role: "r", runtime: "cursor", cursorPolicy: { mode: "agent" } }, settings);
} catch (error) {
  invalidCursorPolicyError = error instanceof Error ? error.message : String(error);
}
assert(invalidCursorPolicyError.includes("Cursor") && invalidCursorPolicyError.includes("approval"), "incomplete Cursor policy is rejected at the domain boundary");
// Explicit input still overrides the harness default.
const override = D.buildPartyMember({ partyId: "p1", name: "cx2", role: "r", runtime: "codex", model: "z-ai/glm-5.2" }, settings);
assert(override.model === "z-ai/glm-5.2", "explicit input model overrides the harness default");
const explicitPolicy = { sandbox: "danger-full-access", approval: "never", guardian: true };
const explicitCodex = D.buildPartyMember({ partyId: "p1", name: "cx3", role: "r", runtime: "codex", codexPolicy: explicitPolicy }, settings);
assert(JSON.stringify(explicitCodex.codexPolicy) === JSON.stringify(explicitPolicy), "explicit initial Codex policy overrides the runtime default");
const crossRouted = D.buildPartyMember({ partyId: "p1", name: "gpt", role: "r", runtime: "claude-code", model: "GPT-5.4 mini" }, settings);
assert(crossRouted.runtime === "claude-code" && crossRouted.permissionMode === "plan" && !crossRouted.codexPolicy, "Claude Code + GPT keeps Claude permission semantics");
let invalidPermissionError = "";
try {
  D.buildPartyMember({ partyId: "p1", name: "bad-claude", role: "r", permissionMode: "invented" }, settings);
} catch (error) {
  invalidPermissionError = error instanceof Error ? error.message : String(error);
}
assert(invalidPermissionError.includes("Unknown Claude permission mode"), "invalid initial Claude permission is rejected at the domain boundary");
let invalidPolicyError = "";
try {
  D.buildPartyMember({ partyId: "p1", name: "bad-codex", role: "r", runtime: "codex", codexPolicy: { sandbox: "read-only" } }, settings);
} catch (error) {
  invalidPolicyError = error instanceof Error ? error.message : String(error);
}
assert(invalidPolicyError.includes("Codex policy requires"), "incomplete initial Codex policy is rejected at the domain boundary");
// A member with no runtime falls back to the selected default harness.
const fallback = D.buildPartyMember({ partyId: "p1", name: "m", role: "r" }, settings);
assert(fallback.runtime === "claude-code" && fallback.model === "sonnet", "a runtime-less member uses the selected default harness");

// ---- Layer 3: legacy settings migration -------------------------------------
const S = await bundleNode("src/main/settings.ts", "settings-migrate.mjs");
// migrateSettings isn't exported; exercise the observable behavior via a fake file is out of scope here,
// so assert the shape guarantees instead: getSettings always yields a full per-harness map.
console.log("\nsettings shape guarantee:");
const live = S.getSettings();
assert(live.harnessDefaults && live.harnessDefaults["claude-code"] && live.harnessDefaults.codex, "getSettings always returns a full per-harness defaults map");
assert(typeof live.harnessDefaults.codex.model === "string" && live.harnessDefaults.codex.codexPolicy, "codex defaults include a model + 2-axis policy");
assert(!("claudeModel" in live), "flat claudeModel is gone from settings (fully abstracted)");

console.log("\nlegacy settings.json migration:");
const migrated = S.migrateSettings({ selectedHarnessId: "claude-code", claudeModel: "MiniMax M3", claudeEffort: "high", claudeReasoning: "enabled", claudePermissionMode: "plan", debugEnabled: true });
assert(migrated.harnessDefaults["claude-code"].model === "MiniMax M3" && migrated.harnessDefaults["claude-code"].effort === "high", "legacy claudeModel/effort migrate into harnessDefaults['claude-code']");
assert(migrated.harnessDefaults["claude-code"].permissionMode === "plan" && migrated.harnessDefaults["claude-code"].reasoning === "enabled", "legacy permission/reasoning migrate too");
assert(migrated.harnessDefaults.codex.model && migrated.harnessDefaults.codex.codexPolicy, "codex gets its built-in defaults on migration");
assert(migrated.debugEnabled === true && !("claudeModel" in migrated), "non-runtime fields kept; flat claude* dropped");
const already = { harnessDefaults: { "claude-code": { model: "x", effort: "low" }, codex: { model: "y", effort: "low" } } };
assert(S.migrateSettings(already) === already, "a settings file already on the new shape is untouched (idempotent)");

console.log(failures.length ? `\nHARNESS DEFAULTS FAILED (${failures.length})` : "\nHARNESS DEFAULTS PASSED");
process.exit(failures.length ? 1 : 0);
