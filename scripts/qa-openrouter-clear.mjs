/*
 * R-25 — stored OpenRouter key can be cleared from Authentication.
 * Source contracts + authService clear behavior. Does not call the network.
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaRunDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

console.log("\nSource contracts (Auth UI wires clear):");
const authView = fs.readFileSync(path.join(root, "src/renderer/app/secondaryViews.tsx"), "utf8");
const appSrc = fs.readFileSync(path.join(root, "src/renderer/App.tsx"), "utf8");
const preload = fs.readFileSync(path.join(root, "src/preload/preload.ts"), "utf8");
assert(authView.includes("onClear:"), "AuthView accepts an onClear handler");
assert(authView.includes('data-auth-clear={provider.id}'), "clear button is addressable per provider");
assert(authView.includes("키 지우기"), "clear button label is present");
assert(appSrc.includes("clearApiKey") && appSrc.includes("onClear={clearApiKey}"), "App wires clear into AuthView");
assert(appSrc.includes("clearOpenRouterKey"), "App clears OpenRouter through the existing bridge");
assert(preload.includes("clearOpenRouterKey:"), "preload already exposes clearOpenRouterKey");

console.log("\nauthService clears the stored key:");
// Fresh per run: a userData tree lives beside the bundle, and a stored key left
// over from a previous run would make "the key was cleared" untestable.
const outDir = qaRunDir("openrouter-clear");
const out = path.join(outDir, "auth-clear.mjs");
const userData = path.join(outDir, "user-data");
fs.mkdirSync(userData, { recursive: true });
process.env.AGENTPARTY_USER_DATA = userData;
await build({
  entryPoints: [path.join(root, "src/main/authService.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const auth = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);
auth.setOpenRouterKey("sk-or-test-clear-me-please-123456");
let state = auth.getAuthState();
const before = state.find((p) => p.id === "openrouter");
assert(before?.status === "configured" && Boolean(before?.maskedValue), "key is configured after save");
auth.clearOpenRouterKey();
state = auth.getAuthState();
const after = state.find((p) => p.id === "openrouter");
assert(after?.status === "missing" && !after?.maskedValue, "clear removes the stored OpenRouter key");
assert(after?.status !== "configured", "cleared provider is not still configured");

console.log("");
if (failures.length) {
  console.log(`OPENROUTER CLEAR QA FAILED: ${failures.length}`);
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
console.log("OPENROUTER CLEAR QA PASSED");
