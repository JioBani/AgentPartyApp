import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = [
  "src/main/application/appController.ts",
  "src/main/subscriptionProxyService.ts",
  "src/main/sessionManager.ts",
  "src/main/engine/engineConnection.ts",
  "src/main/engine/engineRegistry.ts",
  "src/main/engine/localEngine.ts",
  "src/main/engine/transport/remoteEngineClient.ts",
];
const source = sourceFiles.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
const nativeEngineSource = sourceFiles
  .filter((file) => file !== "src/main/subscriptionProxyService.ts")
  .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
  .join("\n");

assert(!fs.existsSync(path.join(root, "src/main/codexAuthenticationStore.ts")), "AgentParty no longer owns a native Codex credential store");
assert(!fs.existsSync(path.join(root, "src/shared/codexAuthentication.ts")), "OAuth token DTOs are removed from the desktop-to-engine protocol");
assert(!source.includes("getCodexAuthentication"), "the subscription bridge cannot export Codex OAuth tokens");
assert(!source.includes("setCodexAuthentication"), "desktop and WSL engines have no credential-copy RPC");
// The subscription bridge may inspect CLI-owned credential metadata to report
// whether a non-Codex subscription is usable. The native Codex engine boundary
// must still never read or propagate refresh tokens.
assert(!nativeEngineSource.includes("refreshToken") && !nativeEngineSource.includes("refresh_token"), "native engine code does not read or propagate Codex refresh tokens");

console.log("CODEX AUTHENTICATION OWNERSHIP QA PASSED");

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}
