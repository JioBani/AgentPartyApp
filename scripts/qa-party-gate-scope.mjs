/*
 * Party-wide Message Gate: reviewer resolution + override semantics.
 *
 * Two defects this locks down:
 *  - "Overridden" meant "a rule string is stored", not "enforces different
 *    text". The party modal's mode buttons patch only `mode`, so a rule survived
 *    an Inherit click and the badge looked permanently stuck.
 *  - The party gate had no reviewer of its own, so a party could not pick a
 *    model without changing the app-wide setting.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });

const r = await build({
  entryPoints: [path.join(projectRoot, "src/shared/messageGate.ts")],
  bundle: true, format: "cjs", platform: "node", write: false,
});
const file = path.join(outDir, "message-gate.cjs");
writeFileSync(file, r.outputFiles[0].text);
const { applyMemberGatePatch, effectiveGate, normalizePartyGate } = createRequire(import.meta.url)(file);

const DEFAULTS = { model: "GPT-5.6 Terra", effort: "low" };
const PARTY_REVIEWER = { model: "haiku", effort: "high" };
const MEMBER_REVIEWER = { model: "GPT-5.6 Luna", effort: "medium" };
const party = { enabled: true, rule: "전역 규칙" };

console.log("\nreviewer resolution (member → party → settings):");
{
  assert(effectiveGate(undefined, party, DEFAULTS).reviewer.model === "GPT-5.6 Terra", "no party/member reviewer → the settings default");
  assert(
    effectiveGate(undefined, { ...party, reviewer: PARTY_REVIEWER }, DEFAULTS).reviewer.model === "haiku",
    "a party reviewer beats the settings default",
  );
  assert(
    effectiveGate({ mode: "inherit", reviewer: MEMBER_REVIEWER }, { ...party, reviewer: PARTY_REVIEWER }, DEFAULTS).reviewer.model === "GPT-5.6 Luna",
    "a member reviewer still beats the party reviewer",
  );
}

console.log("\nthe party reviewer survives normalization (it is persisted):");
{
  const norm = normalizePartyGate({ enabled: true, rule: "r", reviewer: PARTY_REVIEWER });
  assert(norm.reviewer?.model === "haiku", "a valid party reviewer round-trips");
  assert(!("reviewer" in normalizePartyGate({ enabled: true, rule: "r" })), "an absent reviewer is not invented");
  assert(!("reviewer" in normalizePartyGate({ enabled: true, rule: "r", reviewer: { model: "" } })), "a malformed reviewer is dropped, not stored");
}

console.log("\noverride badge tracks the RULE, not merely a stored string:");
{
  let gate = applyMemberGatePatch(undefined, { mode: "inherit", rule: "멤버 전용 규칙", reviewer: null });
  assert(effectiveGate(gate, party, DEFAULTS).overridden === true, "a differing rule reads as overridden");

  // The party modal's segmented control patches ONLY mode — the rule persists.
  gate = applyMemberGatePatch(gate, { mode: "off" });
  gate = applyMemberGatePatch(gate, { mode: "inherit" });
  assert(gate?.rule === "멤버 전용 규칙", "a mode toggle does NOT silently discard the member's rule");
  assert(effectiveGate(gate, party, DEFAULTS).overridden === true, "so it still reads as overridden — the badge was telling the truth");

  // ...and this is the action the row's badge now performs.
  gate = applyMemberGatePatch(gate, { rule: null });
  assert(effectiveGate(gate, party, DEFAULTS).overridden === false, "clearing the rule drops the override");
  assert(effectiveGate(gate, party, DEFAULTS).rule === "전역 규칙", "and the member falls back to the party rule");

  // A stored rule identical to the party's is not an override.
  const same = applyMemberGatePatch(undefined, { mode: "inherit", rule: "전역 규칙", reviewer: null });
  assert(effectiveGate(same, party, DEFAULTS).overridden === false, "a rule equal to the party's does not read as an override");
}

console.log("\nmode and rule stay independent:");
{
  const offWithOwnRule = applyMemberGatePatch(undefined, { mode: "off", rule: "멤버 전용 규칙" });
  const eff = effectiveGate(offWithOwnRule, party, DEFAULTS);
  assert(eff.enabled === false, "mode off disables the member regardless of the party switch");
  assert(eff.overridden === true, "an off member still reports its rule override");
  assert(eff.active === false, "a disabled gate is never active");
}

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exitCode = failures.length ? 1 : 0;
