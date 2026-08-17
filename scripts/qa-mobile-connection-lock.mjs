/* Desktop connection-lock verifier and persistent failure-ledger QA. */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");
const outDir = qaTempDir();
const result = await build({
  entryPoints: [path.join(projectRoot, "src/main/mobile/connectionLockStore.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@agentparty/protocol"],
  write: false,
});
const bundlePath = path.join(outDir, "connectionLockStore.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const { ConnectionLockStore } = await import(pathToFileURL(bundlePath).href);
const P = await import("@agentparty/protocol");
await P.sodiumReady();

const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

function fakeCipher(key = 0x5a) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from([...Buffer.from(text, "utf8")].map((byte) => byte ^ key)),
    decryptString: (buffer) => Buffer.from([...buffer].map((byte) => byte ^ key)).toString("utf8"),
  };
}

const workDir = path.join(outDir, "connection-lock-work");
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
let now = 1_700_000_000_000;
const logs = [];
const warnings = [];
const cipher = fakeCipher();
const deps = () => ({
  userDataPath: workDir,
  secretCipher: cipher,
  log: (level, message, detail) => logs.push({ level, message, detail }),
  onSecurityWarning: (warning) => warnings.push(warning),
  now: () => now,
});

console.log("ConnectionLockStore assertions:");
let store = await ConnectionLockStore.open(deps());
assert(store.status().configured === false, "a fresh desktop has no connection lock");

store.configure("pin", "123456");
assert(store.status().kind === "pin", "a six-digit PIN can be configured");
const disk = JSON.parse(readFileSync(path.join(workDir, "mobile-connection-lock.json"), "utf8"));
assert(disk.encrypted === true, "the verifier and failure ledger are OS-store encrypted");
assert(!JSON.stringify(disk).includes("123456"), "the persisted file contains no plaintext PIN");
const plaintext = cipher.decryptString(Buffer.from(disk.payload, "base64"));
const decoded = JSON.parse(plaintext);
assert(!plaintext.includes("123456"), "even the encrypted payload's plaintext contains only a verifier, not the PIN");
assert(
  P.sodium().crypto_pwhash_str_verify(decoded.lock.verifier, "pin\0" + "123456"),
  "the verifier uses the documented pin domain",
);
assert(
  !P.sodium().crypto_pwhash_str_verify(decoded.lock.verifier, "pattern\0" + "123456"),
  "PIN and pattern verifiers are domain-separated",
);

for (let attempt = 1; attempt <= 9; attempt += 1) {
  const rejected = store.verify("phone-a", "000000");
  assert(!rejected.unlocked && rejected.state.attemptsLeft === 10 - attempt,
    `wrong attempt ${attempt} leaves ${10 - attempt} attempt(s)`);
}
assert(store.stateFor("phone-b").attemptsLeft === 10, "failure counts are isolated per deviceId");

store = await ConnectionLockStore.open(deps());
assert(store.stateFor("phone-a").attemptsLeft === 1, "nine failures survive a desktop restart");
const tenth = store.verify("phone-a", "000000");
assert(tenth.state.error === "locked_out", "the tenth wrong submission enters locked_out");
assert(tenth.state.lockedUntil === now + 30 * 60_000, "locked_out lasts exactly 30 minutes");
assert(!store.verify("phone-a", "123456").unlocked, "the correct PIN cannot bypass an active lockout");

store = await ConnectionLockStore.open(deps());
assert(store.stateFor("phone-a").error === "locked_out", "lockout survives another desktop restart");
now += 30 * 60_000;
assert(store.stateFor("phone-a").attemptsLeft === 10, "expiry automatically resets the device counter");
assert(store.verify("phone-a", "123456").unlocked, "the correct PIN works after expiry");

store.verify("phone-a", "000000");
assert(store.stateFor("phone-a").attemptsLeft === 9, "a later wrong attempt starts a fresh count");
assert(store.verify("phone-a", "123456").unlocked, "a correct submission succeeds");
assert(store.stateFor("phone-a").attemptsLeft === 10, "success resets the count to zero");

store.configure("pattern", "012345");
assert(store.verify("phone-a", "012345").unlocked, "a canonical six-point pattern is accepted");
for (const invalid of ["01234", "012340", "012349", "0-1-2-3-4-5"]) {
  let rejected = false;
  try { store.configure("pattern", invalid); } catch { rejected = true; }
  assert(rejected, `invalid pattern ${JSON.stringify(invalid)} is rejected locally`);
}

store.verify("phone-a", "876543");
store.forgetDevice("phone-a");
assert(store.stateFor("phone-a").attemptsLeft === 10, "deleting a device deletes its failure ledger");
assert(warnings.length === 0, "an available OS keychain raises no degraded-security warning");

const serializedLogs = JSON.stringify(logs);
assert(!serializedLogs.includes("123456") && !serializedLogs.includes("012345"),
  "logs contain neither submitted secrets nor verifier transcripts");
assert(!serializedLogs.includes(decoded.lock.verifier), "logs contain no password verifier");

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
