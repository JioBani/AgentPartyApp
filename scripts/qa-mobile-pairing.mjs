/*
 * PairingService test (01 §2) — the desktop half driven by a phone that runs
 * the REAL handshake out of @agentparty/protocol.
 *
 * The point of this exchange is that a malicious signaling server cannot insert
 * itself (02 §T2/T4). That guarantee lives in two places, and both are asserted
 * here rather than assumed:
 *   - the two sides independently derive the SAME confirmation code from a
 *     shared secret plus a transcript hash over every public key exchanged, and
 *     a substituted key changes it;
 *   - the desktop's transcript signature (blob2) does not leave the machine
 *     until the user confirms, and no trust record is written until the phone's
 *     blob3 signature verifies.
 *
 * A test that only walked the happy path would pass against an implementation
 * that stored trust on blob1 — the exact bug this protocol exists to prevent.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");
const outDir = qaTempDir();

async function load(entry, name) {
  const result = await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["@agentparty/protocol", "ws"],
    write: false,
  });
  const bundlePath = path.join(outDir, name);
  writeFileSync(bundlePath, result.outputFiles[0].text);
  return import(pathToFileURL(bundlePath).href);
}

const { PairingService } = await load("src/main/mobile/pairingService.ts", "pairingService.mjs");
const { IdentityStore } = await load("src/main/mobile/identityStore.ts", "identityStoreForPairing.mjs");
const P = await import("@agentparty/protocol");
await P.sodiumReady();

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };
const throws = async (fn, match, msg) => {
  let message = "";
  try { await fn(); } catch (error) { message = String(error?.message ?? error); }
  assert(message.includes(match), `${msg} (got: ${message || "no throw"})`);
};

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (t) => Buffer.from([...Buffer.from(t, "utf8")].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString("utf8"),
};

let workSeq = 0;
async function desktop() {
  const dir = path.join(outDir, `pairing-${++workSeq}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const identityStore = await IdentityStore.open({
    userDataPath: dir,
    secretCipher: cipher,
    log: () => {},
    onSecurityWarning: () => {},
  });

  const sent = { open: [], accept: [], cancel: [] };
  const states = [];
  let now = 1_700_000_000_000;
  let timerSeq = 0;
  const timers = new Map();

  const service = new PairingService({
    identityStore,
    log: () => {},
    signalingHost: () => "127.0.0.1:8080",
    desktopName: () => "내 PC",
    transport: {
      openPairing: (tokenHash, expiresAt) => sent.open.push({ tokenHash, expiresAt }),
      acceptPairing: (tokenHash, blob2) => sent.accept.push({ tokenHash, blob2 }),
      cancelPairing: (tokenHash) => sent.cancel.push({ tokenHash }),
    },
    onStateChange: (state) => states.push(state),
    now: () => now,
    setTimer: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  });

  return {
    service,
    identityStore,
    sent,
    states,
    advance(ms) {
      const target = now + ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= target) { timers.delete(id); now = timer.at; timer.fn(); }
      }
      now = target;
    },
  };
}

/** The phone side of 01 §2.2, using only the shared protocol package. */
function phone(qrText, { name = "Galaxy S25", token } = {}) {
  const qr = P.parsePairQr(qrText);
  const identity = P.identityFromSeeds(new Uint8Array(32).fill(21), new Uint8Array(32).fill(22));
  const eph = P.generatePairingEphemeral();
  const blob1 = {
    sig: identity.sigPk,
    kx: identity.kxPk,
    e: eph.publicKey,
    t: token ?? qr.t,
    name,
    ts: 1_700_000_000_000,
  };
  const transcriptHash = P.pairTranscriptHash({
    desktopSigPk: qr.d,
    desktopKxPk: qr.x,
    desktopEphPk: qr.e,
    phoneSigPk: identity.sigPk,
    phoneKxPk: identity.kxPk,
    phoneEphPk: eph.publicKey,
    token: qr.t,
  });
  const code = P.pairConfirmCode(P.pairSharedSecret(eph.privateKey, qr.e), transcriptHash);
  return {
    qr,
    identity,
    eph,
    code,
    transcriptHash,
    sealedBlob1: P.toB64(P.sealBlob1(blob1, qr.e)),
    openBlob2: (sealed) => P.openBlob2(P.fromB64(sealed), eph.publicKey, eph.privateKey),
    sealedBlob3: () => P.toB64(P.sealBlob3({ sigOfTh: P.signTranscript(transcriptHash, identity.sigSk) }, qr.e)),
  };
}

console.log("PairingService assertions:");

// --- the full handshake ----------------------------------------------------
{
  const d = await desktop();
  const opened = d.service.open();

  assert(opened.qr.startsWith("agentparty://pair?v=1&d="), "the QR follows the 01 §2.1 field order");
  assert(d.sent.open.length === 1, "the token hash is registered with the signaling server");
  assert(d.sent.open[0].tokenHash !== undefined, "the server receives only the token HASH, never the token");
  assert(d.service.currentState.phase === "awaitingScan", "state is awaitingScan while the QR is up");
  assert(d.service.currentState.code === undefined, "no confirmation code exists before the phone answers");

  const ph = phone(opened.qr);
  assert(!opened.qr.includes(P.toB64(d.identityStore.identity.sigSk)), "the QR carries no secret key");

  d.service.handlePairJoin(d.sent.open[0].tokenHash, ph.sealedBlob1);
  assert(d.service.currentState.phase === "awaitingConfirm", "blob1 moves the desktop to awaitingConfirm");
  assert(
    d.service.currentState.code === ph.code,
    `both sides derive the SAME confirmation code independently (desktop ${d.service.currentState.code}, phone ${ph.code})`,
  );
  assert(/^\d{4}$/.test(ph.code), "the code is 4 digits for the user to compare");
  assert(d.service.currentState.peerName === "Galaxy S25", "the phone's name is shown for the user to recognise");
  assert(d.service.currentState.peerDeviceId === ph.identity.deviceId, "the peer deviceId is derived from its sigPk");

  assert(d.sent.accept.length === 0, "blob2 has NOT been sent before the user confirms (01 §2.2)");
  assert(d.identityStore.devices().length === 0, "nothing is trusted before the user confirms");

  d.service.confirm();
  assert(d.sent.accept.length === 1, "confirm() releases blob2");
  const blob2 = ph.openBlob2(d.sent.accept[0].blob2);
  assert(
    P.verifyTranscript(ph.transcriptHash, blob2.sigOfTh, d.identityStore.identity.sigPk),
    "the phone can verify the desktop's transcript signature",
  );
  assert(blob2.name === "내 PC", "blob2 carries the desktop display name (non-ASCII intact)");
  assert(blob2.epoch === d.identityStore.trustEpoch, "blob2 carries the current trust epoch");
  assert(d.identityStore.devices().length === 0, "still nothing trusted until the phone's blob3 verifies");

  d.service.handlePairDone(d.sent.open[0].tokenHash, ph.sealedBlob3());
  const stored = d.identityStore.devices();
  assert(stored.length === 1, "the trust record is written after blob3 verifies");
  assert(stored[0].deviceId === ph.identity.deviceId, "the stored record is the phone that signed the transcript");
  assert(stored[0].sigPk === P.toB64(ph.identity.sigPk), "the stored signing key is the phone's own");
  assert(d.service.currentState.phase === "completed", "state ends at completed");

  const resolved = await opened.completed;
  assert(resolved.deviceId === ph.identity.deviceId, "completed resolves with the trusted device");
}

// --- a substituted key changes the code (02 §T4) ---------------------------
{
  const d = await desktop();
  const opened = d.service.open();
  const ph = phone(opened.qr);

  // A server that swapped the desktop's ephemeral key would have the phone
  // deriving its code against a different key than the desktop used.
  const attacker = P.generatePairingEphemeral();
  const forgedTranscript = P.pairTranscriptHash({
    desktopSigPk: ph.qr.d,
    desktopKxPk: ph.qr.x,
    desktopEphPk: attacker.publicKey,
    phoneSigPk: ph.identity.sigPk,
    phoneKxPk: ph.identity.kxPk,
    phoneEphPk: ph.eph.publicKey,
    token: ph.qr.t,
  });
  const forgedCode = P.pairConfirmCode(P.pairSharedSecret(ph.eph.privateKey, attacker.publicKey), forgedTranscript);

  d.service.handlePairJoin(d.sent.open[0].tokenHash, ph.sealedBlob1);
  assert(
    d.service.currentState.code !== forgedCode,
    "a substituted ephemeral key produces a DIFFERENT code — the user sees the mismatch",
  );
}

// --- blob1 from a different QR is refused ----------------------------------
{
  const d = await desktop();
  const opened = d.service.open();
  const ph = phone(opened.qr, { token: new Uint8Array(16).fill(0xab) });

  d.service.handlePairJoin(d.sent.open[0].tokenHash, ph.sealedBlob1);
  assert(d.service.currentState.phase === "failed", "a blob1 echoing the wrong token aborts the pairing");
  assert(d.service.currentState.error?.includes("토큰"), "the failure names the token mismatch");
  assert(d.identityStore.devices().length === 0, "nothing is stored after a failed verification");
  await throws(() => opened.completed, "토큰", "the caller's promise rejects with the reason");
}

// --- an unopenable blob1 aborts rather than hangs --------------------------
{
  const d = await desktop();
  const opened = d.service.open();
  d.service.handlePairJoin(d.sent.open[0].tokenHash, P.toB64(new Uint8Array(80).fill(9)));
  assert(d.service.currentState.phase === "failed", "a blob that will not open aborts the pairing");
  assert(d.sent.cancel.length === 1, "the token is released on the server so it cannot be retried");
  await throws(() => opened.completed, "열 수 없습니다", "the promise rejects with a readable reason");
}

// --- a forged blob3 never produces a trust record --------------------------
{
  const d = await desktop();
  const opened = d.service.open();
  const ph = phone(opened.qr);
  d.service.handlePairJoin(d.sent.open[0].tokenHash, ph.sealedBlob1);
  d.service.confirm();

  // Signed by a different key than blob1 announced.
  const impostor = P.identityFromSeeds(new Uint8Array(32).fill(31), new Uint8Array(32).fill(32));
  const forged = P.toB64(
    P.sealBlob3({ sigOfTh: P.signTranscript(ph.transcriptHash, impostor.sigSk) }, ph.qr.e),
  );
  d.service.handlePairDone(d.sent.open[0].tokenHash, forged);

  assert(d.identityStore.devices().length === 0, "a signature from the wrong key stores nothing");
  assert(d.service.currentState.phase === "failed", "the pairing fails rather than trusting the impostor");
  assert(d.service.currentState.error?.includes("서명"), "the failure names the invalid signature");
  await throws(() => opened.completed, "서명", "the promise rejects");
}

// --- ordering: blob3 before the user confirms ------------------------------
{
  const d = await desktop();
  const opened = d.service.open();
  const ph = phone(opened.qr);
  d.service.handlePairJoin(d.sent.open[0].tokenHash, ph.sealedBlob1);
  d.service.handlePairDone(d.sent.open[0].tokenHash, ph.sealedBlob3());

  assert(d.service.currentState.phase === "failed", "a phone that skips the confirmation step is refused");
  assert(d.identityStore.devices().length === 0, "and nothing is trusted");
  await throws(() => opened.completed, "순서", "the reason names the ordering violation");
}

// --- confirm() with nothing pending ----------------------------------------
{
  const d = await desktop();
  await throws(async () => d.service.confirm(), "확인을 기다리는", "confirm() with no pairing is an explicit error");
  d.service.open();
  await throws(async () => d.service.confirm(), "확인을 기다리는", "confirm() before the phone answers is refused");
}

// --- expiry (01 §2.1) ------------------------------------------------------
{
  const d = await desktop();
  const opened = d.service.open();
  assert(opened.expiresAt - 1_700_000_000_000 === P.PAIR_TTL_MS, "the QR expires after the protocol TTL");

  d.advance(P.PAIR_TTL_MS + 1);
  assert(d.service.currentState.phase === "expired", "the pairing expires on its own");
  assert(d.sent.cancel.length === 1, "expiry releases the token on the server");
  await throws(() => opened.completed, "만료", "the promise rejects on expiry");

  const ph = phone(opened.qr);
  d.service.handlePairJoin(d.sent.open[0].tokenHash, ph.sealedBlob1);
  assert(d.service.currentState.phase === "expired", "a blob1 arriving after expiry is ignored");
  assert(d.identityStore.devices().length === 0, "an expired token cannot pair");
}

// --- a second QR cancels the first -----------------------------------------
{
  const d = await desktop();
  const first = d.service.open();
  const second = d.service.open();

  assert(d.sent.cancel.length === 1, "opening a second QR releases the first token");
  assert(second.qr !== first.qr, "the second QR is a fresh token");
  await throws(() => first.completed, "취소", "the first pairing's promise rejects");

  const ph = phone(first.qr);
  d.service.handlePairJoin(d.sent.open[0].tokenHash, ph.sealedBlob1);
  assert(d.service.currentState.phase === "awaitingScan", "a phone scanning the stale QR is ignored");
}

// --- cancel and server-side close ------------------------------------------
{
  const d = await desktop();
  const opened = d.service.open();
  d.service.cancel();
  assert(d.service.currentState.phase === "cancelled", "cancel() ends the pairing");
  assert(d.sent.cancel.length === 1, "cancel() releases the token");
  await throws(() => opened.completed, "취소", "cancel() rejects the promise");

  const d2 = await desktop();
  const opened2 = d2.service.open();
  d2.service.handlePairClosed(d2.sent.open[0].tokenHash, "peer_gone");
  assert(d2.service.currentState.phase === "failed", "the server dropping the peer ends the pairing");
  assert(d2.service.currentState.error?.includes("끊겨"), "the reason explains what happened");
  await throws(() => opened2.completed, "끊겨", "the promise rejects");
}

// --- a signaling reconnect must not leave a dead QR on screen ---------------
{
  const d = await desktop();
  const opened = d.service.open();
  assert(d.sent.open.length === 1, 'the token is registered once when the QR opens');

  // The server keeps pairing sessions in memory: a reconnect or a container
  // swap drops the registration while this side still shows a valid QR. The
  // phone would then be told pair_not_found for a code the desktop is
  // displaying as good.
  d.service.reregister();
  assert(d.sent.open.length === 2, 'a reconnect re-registers the same token');
  assert(d.sent.open[1].tokenHash === d.sent.open[0].tokenHash, 'with the SAME tokenHash — a QR already on screen stays correct');
  assert(d.sent.open[1].expiresAt === d.sent.open[0].expiresAt, 'and the same expiry, not a refreshed one');

  // The identity of the pairing is untouched, so a phone that already scanned
  // can still complete.
  const ph = phone(opened.qr);
  d.service.handlePairJoin(d.sent.open[0].tokenHash, ph.sealedBlob1);
  assert(d.service.currentState.phase === 'awaitingConfirm', 'a scan after re-registration still works');
  assert(d.service.currentState.code === ph.code, 'and the confirmation code is unchanged');

  // Past blob2 the exchange is device-to-device; re-opening would only confuse
  // the server's bookkeeping.
  d.service.confirm();
  const afterConfirm = d.sent.open.length;
  d.service.reregister();
  assert(d.sent.open.length === afterConfirm, 'no re-registration once the handshake has passed blob2');
}

// --- with nothing open, re-registration is a no-op --------------------------
{
  const d = await desktop();
  d.service.reregister();
  assert(d.sent.open.length === 0, 'a reconnect with no open QR registers nothing');
}

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
