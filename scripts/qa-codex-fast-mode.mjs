/*
 * Codex Fast service-tier wiring contract.
 *
 * The live catalog and UI already carry the native tier id. This test guards
 * the final hop that previously dropped it between member start and app-server.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const adapter = read("src/core/codexAdapter.ts");
const registry = read("src/core/modelRegistry.ts");
const sessions = read("src/main/sessionManager.ts");
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
assert(/model\.serviceTiers\.length > 0[\s\S]*?defaultValue: "standard"[\s\S]*?id: "standard", label: "Standard"[\s\S]*?\.map\(\(tier\) => \(\{ id: tier\.id, label: tier\.name/.test(registry), "Codex routes expose reversible Standard and native Fast options to the UI/API");
assert(/new CodexAdapter\(\{[\s\S]*?serviceTier: request\.serviceTier \|\| harnessDefaults\.serviceTier,/.test(sessions), "session creation passes member/default service tier into Codex");
assert(/serviceTierParam\(\): string \| null \| undefined[\s\S]*?tier === "standard" \|\| tier === "default" \? null : tier/.test(adapter), "Standard clears Fast while an absent legacy value stays omitted");
assert(requestBody("thread/start").includes("serviceTier: this.serviceTierParam()"), "new threads receive the tier");
assert(requestBody("thread/resume").includes("serviceTier: this.serviceTierParam()"), "resumed threads receive the tier");
assert(requestBody("turn/start").includes("serviceTier: this.serviceTierParam()"), "every turn receives the tier");
assert(api.includes('"serviceTier": "priority"') && /Omitting\s+`serviceTier` preserves Codex's Standard\/default behavior/.test(api), "automation API documents Fast and the default-preserving omission");

console.log(failures.length ? `\nCODEX FAST QA FAILED (${failures.length})` : "\nCODEX FAST QA PASSED");
process.exit(failures.length ? 1 : 0);
