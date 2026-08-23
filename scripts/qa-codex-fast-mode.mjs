/*
 * Codex Fast service-tier wiring contract.
 *
 * Three explicit states, mirroring the UI ("설정 따름 / Standard / Fast"):
 * an unset/inherit tier sends NOTHING so the member follows the user's own
 * Codex config (config.toml service_tier); Standard forces the default tier
 * (wire null); a native id (priority) forces Fast. This test guards every hop
 * that previously forced Standard onto members whose user never chose a tier.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const adapter = read("src/core/codexAdapter.ts");
const registry = read("src/core/modelRegistry.ts");
const sessions = read("src/main/sessionManager.ts");
const shared = read("src/shared/types.ts");
const wizard = read("src/renderer/workbench/MemberWizard.tsx");
const service = read("src/main/application/partyApplicationService.ts");
const domain = read("src/main/application/partyDomain.ts");
const catalogModal = read("src/renderer/workbench/ModelCatalogModal.tsx");
const api = read("docs/API.md");
const failures = [];

function assert(condition, message) {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
}

function requestBody(method) {
  const start = adapter.indexOf(`this.request("${method}", {`);
  if (start < 0) return "";
  return adapter.slice(start, adapter.indexOf("});", start) + 3);
}

console.log("\nCodex Fast service-tier wiring:");
assert(/interface CodexAdapterOptions[\s\S]*?serviceTier\?: string;/.test(adapter), "Codex adapter accepts the selected native service tier");
assert(/SERVICE_TIER_INHERIT = "inherit"/.test(shared) && /normalizeServiceTierSelection/.test(shared), "shared types define the inherit sentinel and its normalizer");
assert(/model\.serviceTiers\.length > 0[\s\S]*?defaultValue: SERVICE_TIER_INHERIT[\s\S]*?id: SERVICE_TIER_INHERIT, label: "설정 따름"[\s\S]*?id: "standard", label: "Standard"[\s\S]*?\.map\(\(tier\) => \(\{/.test(registry), "Codex routes expose 설정 따름 (default) / Standard / native Fast options");
assert(/크레딧 소모 증가/.test(registry), "the Fast option carries the credit-consumption note");
assert(/new CodexAdapter\(\{[\s\S]*?serviceTier: request\.serviceTier \|\| harnessDefaults\.serviceTier,/.test(sessions), "session creation passes member/default service tier into Codex");
assert(/serviceTierParam\(\): string \| null \| undefined[\s\S]*?normalizeServiceTierSelection\(this\.options\.serviceTier\)[\s\S]*?tier === "standard" \|\| tier === "default" \? null : tier/.test(adapter), "inherit/absent stays omitted (config wins) while Standard clears Fast via wire null");
assert(requestBody("thread/start").includes("serviceTier: this.serviceTierParam()"), "new threads receive the tier");
assert(requestBody("thread/resume").includes("serviceTier: this.serviceTierParam()"), "resumed threads receive the tier");
assert(requestBody("turn/start").includes("serviceTier: this.serviceTierParam()"), "every turn receives the tier");
assert(/serviceTier: serviceTierCap\?\.supported \? normalizeServiceTierSelection\(serviceTier\) : undefined/.test(wizard), "wizard omits an untouched tier instead of forcing Standard onto new members");
assert(/setServiceTier\(serviceTierCap\?\.supported \? hDefaults\?\.serviceTier \|\| serviceTierCap\.defaultValue \|\| SERVICE_TIER_INHERIT : ""\)/.test(wizard), "wizard seeds the tier from the inherit default, not a hardcoded Standard");
assert(/member\.serviceTier = input\.serviceTier === undefined\s*\?\s*member\.serviceTier \?\? normalizeServiceTierSelection\(defaults\.serviceTier\)\s*:\s*normalizeServiceTierSelection\(input\.serviceTier\)/.test(service), "respawn/update preserves an omitted tier and lets an explicit inherit clear a stored choice");
assert(/serviceTier: input\.serviceTier === undefined\s*\?\s*normalizeServiceTierSelection\(profile\.serviceTier\)\s*:\s*normalizeServiceTierSelection\(input\.serviceTier\)/.test(domain), "member creation stores only explicit choices; unset stays unset");
assert(/active\?\.description \? <p className="wb-wizard-hint">\{active\.description\}<\/p> : null/.test(catalogModal), "the picker surfaces the selected tier's description (Fast credit note) at decision time");
assert(api.includes('"serviceTier": "priority"') && /Omitting `serviceTier` \(or passing\s+`inherit`\) sends\s+nothing/.test(api) && /`"standard"` explicitly forces/.test(api), "automation API documents the three tier states");

console.log(failures.length ? `\nCODEX FAST QA FAILED (${failures.length})` : "\nCODEX FAST QA PASSED");
process.exit(failures.length ? 1 : 0);
