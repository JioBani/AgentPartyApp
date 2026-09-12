/* Message Gate duplex model: migration, axis independence, reviewer priority. */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (condition, message) => { console.log(`  ${condition ? "✓" : "✗"} ${message}`); if (!condition) failures.push(message); };
const output = await build({ entryPoints: [path.join(root, "src/shared/messageGate.ts")], bundle: true, format: "cjs", platform: "node", write: false });
const file = path.join(qaTempDir(), "message-gate.cjs");
writeFileSync(file, output.outputFiles[0].text);
const { applyMemberGatePatch, applyPartyGatePatch, effectiveGate, normalizeMemberGate, normalizePartyGate, resolveGateReviewPlan } = createRequire(import.meta.url)(file);

const DEFAULTS = { model: "default", effort: "low" };
const SEND_REVIEWER = { model: "send-model", effort: "medium" };
const RECV_REVIEWER = { model: "recv-model", effort: "high" };

console.log("\nlegacy migration:");
const party = normalizePartyGate({ enabled: true, rule: "legacy send", reviewer: SEND_REVIEWER });
const member = normalizeMemberGate({ mode: "off", rule: "legacy member" });
assert(party.send.enabled && party.send.rule === "legacy send", "legacy party gate moves losslessly to send");
assert(!party.recv.enabled && party.recv.rule === "", "legacy party gate creates an inactive empty recv axis");
assert(member.send.mode === "off" && member.send.rule === "legacy member", "legacy member override moves losslessly to send");
assert(member.recv === undefined, "legacy member has no recv override");
const fastParty = normalizePartyGate({ enabled: true, rule: "fast", reviewer: { ...SEND_REVIEWER, serviceTier: "priority" } });
assert(fastParty.send.reviewer.serviceTier === "priority", "a concrete reviewer Fast tier survives normalization");
const inheritedTier = normalizePartyGate({ enabled: true, rule: "plain", reviewer: { ...SEND_REVIEWER, serviceTier: "inherit" } });
assert(inheritedTier.send.reviewer.serviceTier === undefined, "headless reviewer never stores the harness-only inherit tier");

console.log("\naxis independence and compatibility defaults:");
let axes = applyMemberGatePatch(undefined, { mode: "on", rule: "send own" });
axes = applyMemberGatePatch(axes, { axis: "recv", mode: "off", rule: "recv own" });
assert(axes.send.mode === "on" && axes.send.rule === "send own", "axis omitted patches send");
assert(axes.recv.mode === "off" && axes.recv.rule === "recv own", "recv patch does not alter send");
const nextParty = applyPartyGatePatch(party, { axis: "recv", enabled: true, rule: "recv global" });
assert(nextParty.send.rule === "legacy send", "party recv patch preserves send");
assert(nextParty.recv.enabled && nextParty.recv.rule === "recv global", "party recv patch applies independently");
assert(effectiveGate("recv", axes, nextParty, DEFAULTS).enabled === false, "member recv off beats party recv on");

console.log("\nsingle-review plan and reviewer priority:");
const both = resolveGateReviewPlan(
  { send: { mode: "on", rule: "sender", reviewer: SEND_REVIEWER } },
  { recv: { mode: "on", rule: "recipient", reviewer: RECV_REVIEWER } },
  { send: { enabled: false, rule: "" }, recv: { enabled: false, rule: "" } },
  DEFAULTS,
);
assert(both.active && both.scope === "both", "two active axes form one combined review plan");
assert(both.reviewer.model === "recv-model", "explicit recipient reviewer beats explicit sender reviewer");
const senderWins = resolveGateReviewPlan(
  { send: { mode: "on", rule: "sender", reviewer: SEND_REVIEWER } },
  { recv: { mode: "on", rule: "recipient" } },
  undefined,
  DEFAULTS,
);
assert(senderWins.reviewer.model === "send-model", "unset recipient reviewer does not suppress explicit sender reviewer");
const fallback = resolveGateReviewPlan(
  { send: { mode: "on", rule: "sender" } },
  { recv: { mode: "on", rule: "recipient" } },
  undefined,
  DEFAULTS,
);
assert(fallback.reviewer.model === "default", "settings reviewer is the final fallback");
const inactive = resolveGateReviewPlan(undefined, undefined, undefined, DEFAULTS);
assert(!inactive.active && inactive.scope === undefined, "two inactive axes skip review");

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exitCode = failures.length ? 1 : 0;
