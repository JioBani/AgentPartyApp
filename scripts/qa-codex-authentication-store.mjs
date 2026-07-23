import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-codex-auth-store-"));
const storage = path.join(temp, "storage");
const codexHome = path.join(temp, "codex-home");
const out = path.join(temp, "store.cjs");
fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "original" } }));

await build({
  entryPoints: [path.join(root, "src", "main", "codexAuthenticationStore.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
process.env.AGENTPARTY_USER_DATA = storage;
const { CodexAuthenticationStore } = createRequire(import.meta.url)(out);
const store = new CodexAuthenticationStore(storage, codexHome);

try {
  const first = await store.apply(update("generation-a", "account-a"));
  assert(first, "first managed account changes the native store");
  assert(readAuth().tokens.account_id === "account-a", "bridge credential is normalized to native Codex auth.json");
  assert(findBackups().length === 1, "pre-existing native credential is backed up before management");

  const duplicate = await store.apply(update("generation-a", "account-a"));
  assert(!duplicate && findBackups().length === 1, "same generation is idempotent");

  fs.rmSync(path.join(codexHome, "auth.json"));
  const repaired = await store.apply(update("generation-a", "account-a"));
  assert(repaired && readAuth().tokens.account_id === "account-a", "same generation repairs a missing native credential");

  await store.apply(update("generation-b", "account-b"));
  assert(readAuth().tokens.account_id === "account-b", "account switch replaces the native credential");

  await store.apply({ generation: "disconnected" });
  assert(!fs.existsSync(path.join(codexHome, "auth.json")), "disconnect removes only the managed native credential");
  assert(findBackups().some((file) => file.includes("disconnected")), "disconnected credential remains recoverable");

  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "external" } }));
  await store.apply(update("generation-c", "account-c"));
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "user-changed" } }));
  await store.apply({ generation: "disconnected-again" });
  assert(readAuth().tokens.account_id === "user-changed", "disconnect preserves credentials changed outside AgentParty");

  console.log("CODEX AUTHENTICATION STORE QA PASSED");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function update(generation, accountId) {
  return {
    generation,
    credential: {
      authMode: "chatgpt",
      lastRefresh: "2026-07-23T00:00:00.000Z",
      tokens: {
        accessToken: `access-${accountId}`,
        refreshToken: `refresh-${accountId}`,
        idToken: `id-${accountId}`,
        accountId,
      },
    },
  };
}

function readAuth() {
  return JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"));
}

function findBackups() {
  const directory = path.join(storage, "codex-auth-backups");
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}
