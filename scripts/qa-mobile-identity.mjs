/*
 * IdentityStore test — real libsodium keys, real files, no Electron.
 *
 * What matters here is what happens on the bad days, because the good day is
 * obvious: an identity that round-trips through disk must be the SAME key
 * (a phone paired yesterday must still be paired today), a trust store that
 * cannot be decrypted must NOT be silently replaced with a fresh identity
 * (that would unpair every phone and look like a protocol bug), and a machine
 * with no OS keychain must warn rather than quietly store secrets in the clear.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");
const outDir = qaTempDir();

const result = await build({
  entryPoints: [path.join(projectRoot, "src/main/mobile/identityStore.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  // libsodium is WASM: bundling it detaches its crypto binding.
  external: ["@agentparty/protocol"],
  write: false,
});
const bundlePath = path.join(outDir, "identityStore.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const { IdentityStore } = await import(pathToFileURL(bundlePath).href);
const P = await import("@agentparty/protocol");
await P.sodiumReady();

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };
const throws = async (fn, match, msg) => {
  let message = "";
  try { await fn(); } catch (error) { message = String(error?.message ?? error); }
  assert(message.includes(match), `${msg} (got: ${message || "no throw"})`);
};

/** Stands in for Electron safeStorage. XOR is not security — it proves the
 *  bytes went through the cipher and come back, which is what is under test. */
function fakeCipher({ available = true, key = 0x5a } = {}) {
  const warnings = [];
  return {
    warnings,
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from([...Buffer.from(text, "utf8")].map((b) => b ^ key)),
    decryptString: (buf) => Buffer.from([...buf].map((b) => b ^ key)).toString("utf8"),
  };
}

function depsIn(dir, cipher) {
  const warnings = [];
  mkdirSync(dir, { recursive: true });
  return {
    warnings,
    userDataPath: dir,
    secretCipher: cipher,
    log: () => {},
    onSecurityWarning: (w) => warnings.push(w),
  };
}

const workDir = path.join(outDir, "identity-work");
rmSync(workDir, { recursive: true, force: true });

console.log("IdentityStore assertions:");

// --- creation and persistence ---------------------------------------------
const dir = path.join(workDir, "a");
const cipher = fakeCipher();
const first = await IdentityStore.open(depsIn(dir, cipher));

assert(first.deviceId.length === 22, "deviceId is the 22-char base64url form (01 §1)");
assert(first.deviceId === P.deviceIdOf(first.identity.sigPk), "deviceId is derived from the signing key, not stored separately");
assert(existsSync(path.join(dir, "mobile-identity.json")), "the identity file is written on first run");

const stored = JSON.parse(readFileSync(path.join(dir, "mobile-identity.json"), "utf8"));
assert(stored.encrypted === true, "the file records that it was encrypted");
assert(!stored.payload.includes(P.toB64(first.identity.sigSk).slice(0, 16)), "the secret key is not sitting in the file in the clear");

const reopened = await IdentityStore.open(depsIn(dir, cipher));
assert(reopened.deviceId === first.deviceId, "reopening yields the SAME identity — paired phones stay paired");
assert(P.toB64(reopened.identity.sigSk) === P.toB64(first.identity.sigSk), "the secret signing key round-trips byte for byte");
assert(P.toB64(reopened.identity.kxSk) === P.toB64(first.identity.kxSk), "the secret kx key round-trips byte for byte");

// --- an undecryptable identity is an error, never a silent reset ----------
await throws(
  () => IdentityStore.open(depsIn(dir, { ...fakeCipher({ key: 0x11 }), decryptString: () => { throw new Error("wrong user"); } })),
  "could not be decrypted",
  "a key that will not decrypt fails loudly instead of generating a new identity",
);
const afterFailure = await IdentityStore.open(depsIn(dir, cipher));
assert(afterFailure.deviceId === first.deviceId, "the failed open left the stored identity untouched");

// --- no OS keychain: degrade, but say so ----------------------------------
const plainDir = path.join(workDir, "plain");
const plainDeps = depsIn(plainDir, fakeCipher({ available: false }));
const plain = await IdentityStore.open(plainDeps);
assert(plainDeps.warnings.length === 1, "a machine with no keychain raises exactly one security warning");
assert(plainDeps.warnings[0].code === "identity_unencrypted", "the warning carries a code the UI can route on");
assert(JSON.parse(readFileSync(path.join(plainDir, "mobile-identity.json"), "utf8")).encrypted === false, "the file admits it is unencrypted");
const plainReopened = await IdentityStore.open(depsIn(plainDir, fakeCipher({ available: false })));
assert(plainReopened.deviceId === plain.deviceId, "an unencrypted identity still round-trips");

// --- trusted devices -------------------------------------------------------
const phone = P.identityFromSeeds(new Uint8Array(32).fill(7), new Uint8Array(32).fill(8));
const record = {
  deviceId: phone.deviceId,
  sigPk: P.toB64(phone.sigPk),
  kxPk: P.toB64(phone.kxPk),
  name: "Galaxy S25",
  pairedAt: 1000,
  epoch: 1,
  lastSeenAt: 0,
  push: undefined,
};

assert(first.devices().length === 0, "a fresh desktop trusts nothing");
first.addDevice(record);
assert(first.devices().length === 1, "a paired phone is stored");

await throws(
  async () => first.addDevice({ ...record, deviceId: "not-the-real-device-id" }),
  "does not match its own signing key",
  "a record whose deviceId does not derive from its sigPk is rejected",
);

const persisted = await IdentityStore.open(depsIn(dir, cipher));
assert(persisted.devices()[0]?.name === "Galaxy S25", "trusted devices survive a restart");
assert(persisted.find(phone.deviceId) !== undefined, "a stored device is findable by id");

// --- epoch and revocation (01 §2.3, 02 §T5) --------------------------------
assert(persisted.requireTrusted(phone.deviceId, 1).name === "Galaxy S25", "a current epoch is accepted");
assert(persisted.requireTrusted(phone.deviceId, 2).name === "Galaxy S25", "a higher epoch is accepted");
await throws(
  async () => persisted.requireTrusted("who-is-this", 1),
  "not a paired device",
  "an unknown device is refused rather than treated as a new pairing",
);

persisted.renameDevice(phone.deviceId, "내 폰");
persisted.touch(phone.deviceId, 4242);
persisted.setPushHandle(phone.deviceId, "android", "fcm-token", 99);
const updated = persisted.find(phone.deviceId);
assert(updated.name === "내 폰", "rename persists a non-ASCII name");
assert(updated.lastSeenAt === 4242, "lastSeenAt is recorded");
assert(updated.push?.handle === "fcm-token", "the push handle registered by the phone is stored");

const epochBefore = persisted.trustEpoch;
persisted.revokeDevice(phone.deviceId);
assert(persisted.devices().length === 0, "revoke forgets the phone");
assert(persisted.trustEpoch === epochBefore + 1, "revoke raises trustEpoch so a stale hello is refused (02 §T5)");
await throws(async () => persisted.revokeDevice(phone.deviceId), "not a paired device", "revoking twice is an explicit error");

const afterRevoke = await IdentityStore.open(depsIn(dir, cipher));
assert(afterRevoke.trustEpoch === epochBefore + 1, "the raised epoch survives a restart");
assert(afterRevoke.devices().length === 0, "the revocation survives a restart");

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
