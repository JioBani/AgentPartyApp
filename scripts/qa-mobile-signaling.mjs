/*
 * SignalingClient test (01 §3).
 *
 * The fake server here does the REAL signature check with
 * verifySignalingAuth. That matters: the challenge `nonce` arrives as base64url
 * TEXT, and signSignalingAuth happily accepts a string too — hashing the text
 * as UTF-8 and producing a signature the server rejects as `auth_failed` with
 * no hint as to the cause (01 §0 forbids hashing b64url text). A test that
 * merely asserted "an auth message was sent" would have passed while the pipe
 * could never connect to anything real.
 *
 * The rest covers the rules whose violation looks like an unexplained
 * disconnect: outbound pacing under the server's per-socket rate limit,
 * ICE batching, backoff, and the terminal errors that must NOT be retried.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");

const result = await build({
  entryPoints: [path.join(projectRoot, "src/main/mobile/signalingClient.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  // libsodium is WASM; `ws` is native-ish. Resolve both at runtime.
  external: ["@agentparty/protocol", "ws"],
  write: false,
});
const bundlePath = path.join(qaTempDir(), "signalingClient.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const SC = await import(pathToFileURL(bundlePath).href);
const { SignalingClient, acceptIceServers } = SC;
const P = await import("@agentparty/protocol");
await P.sodiumReady();

const failures = [];
let blocked = 0;
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

/** Virtual clock: the pacing rules are about time, so time is controlled. */
function clock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    /** Advances time, firing due timers in order. */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) { break; }
        const [id, timer] = due[0];
        timers.delete(id);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
  };
}

/** A socket the test drives, standing in for `ws`. */
function fakeSocket() {
  const sent = [];
  const socket = {
    sent,
    closed: false,
    send: (data) => sent.push(JSON.parse(data)),
    close: () => { socket.closed = true; },
    onOpen: (fn) => { socket.open = fn; },
    onMessage: (fn) => { socket.message = fn; },
    onClose: (fn) => { socket.close_ = fn; },
    onError: (fn) => { socket.error = fn; },
    deliver: (message) => socket.message(JSON.stringify(message)),
  };
  return socket;
}

function harness({ identity, url = "ws://127.0.0.1:8080/v1/ws" } = {}) {
  const time = clock();
  const sockets = [];
  const phases = [];
  const received = { relay: [], pairJoin: [], pairDone: [], pairClosed: [] };
  const client = new SignalingClient({
    url,
    identity,
    log: () => {},
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    openSocket: () => { const s = fakeSocket(); sockets.push(s); return s; },
  });
  client.start({
    onRelay: (from, kind, box) => received.relay.push({ from, kind, box }),
    onPairJoin: (tokenHash, blob1) => received.pairJoin.push({ tokenHash, blob1 }),
    onPairDone: (tokenHash, blob3) => received.pairDone.push({ tokenHash, blob3 }),
    onPairClosed: (tokenHash, reason) => received.pairClosed.push({ tokenHash, reason }),
    onPhaseChange: (phase, detail) => phases.push({ phase, error: detail.error }),
  });
  return { client, time, sockets, phases, received, socket: () => sockets[sockets.length - 1] };
}

/** Drives the real 01 §3.1 handshake and reports whether the signature verified. */
function completeHandshake(h, identity, { serverId = "sig.test" } = {}) {
  const socket = h.socket();
  socket.open();
  const hello = socket.sent.at(-1);
  const nonce = P.newChallengeNonce();
  const ts = h.time.now();
  socket.deliver({ t: "challenge", nonce: P.toB64(nonce), serverId, ts });
  const auth = socket.sent.at(-1);
  const verified = auth?.t === "auth" && P.verifySignalingAuth(P.fromB64(auth.sig), nonce, serverId, ts, identity.sigPk);
  if (verified) { socket.deliver({ t: "ok" }); }
  return { hello, auth, verified };
}

const identity = P.identityFromSeeds(new Uint8Array(32).fill(3), new Uint8Array(32).fill(4));

console.log("SignalingClient assertions:");

// --- 01 §3.1 handshake, verified with real crypto --------------------------
{
  const h = harness({ identity });
  const { hello, verified } = completeHandshake(h, identity);

  assert(hello.t === "hello" && hello.role === "desktop", "the desktop announces itself as the desktop role");
  assert(hello.deviceId === identity.deviceId, "hello carries the deviceId derived from the signing key");
  assert(hello.sigPk === P.toB64(identity.sigPk), "hello carries the signing public key the server verifies against");
  assert(verified, "the auth signature VERIFIES server-side (nonce decoded from b64url, not hashed as text)");
  assert(h.client.currentPhase === "connected", "the client reaches connected after ok");
  assert(h.phases.map((p) => p.phase).join(">") === "connecting>authenticating>connected", "phases advance in order");
}

// --- a signature over the b64url TEXT would be rejected --------------------
{
  const nonce = P.newChallengeNonce();
  const overText = P.signSignalingAuth(P.toB64(nonce), "sig.test", 1700, identity.sigSk);
  assert(
    !P.verifySignalingAuth(overText, nonce, "sig.test", 1700, identity.sigPk),
    "signing the base64url TEXT instead of the bytes fails verification — the trap this client must avoid",
  );
}

// --- outbound pacing under the server's rate limit -------------------------
{
  const h = harness({ identity });
  completeHandshake(h, identity);
  const socket = h.socket();
  const before = socket.sent.length;

  for (let n = 0; n < 25; n += 1) {
    h.client.relay("phone-1", "hello", `box-${n}`);
  }
  const firstWindow = socket.sent.length - before;
  assert(firstWindow === 10, `at most 10 messages leave in the first second (sent ${firstWindow})`);

  h.time.advance(1_000);
  assert(socket.sent.length - before === 20, "the queue drains at the same rate in the next second");
  h.time.advance(1_000);
  assert(socket.sent.length - before === 25, "everything queued is eventually delivered, nothing dropped");
  assert(socket.sent.at(-1).box === "box-24", "order is preserved across the pacing windows");
}

// --- ICE batching (01 §3.4) ------------------------------------------------
{
  const h = harness({ identity });
  completeHandshake(h, identity);
  const socket = h.socket();
  const before = socket.sent.length;

  for (let n = 0; n < 5; n += 1) {
    h.client.relay("phone-1", "ice", `cand-${n}`);
  }
  assert(socket.sent.length === before, "ICE candidates are held, not sent one per burst");
  h.time.advance(100);
  const iceSent = socket.sent.slice(before);
  assert(iceSent.length === 5, "the batch window releases the collected candidates");
  assert(iceSent.every((m) => m.kind === "ice" && m.to === "phone-1"), "batched candidates keep their peer and kind");
  assert(iceSent.map((m) => m.box).join(",") === "cand-0,cand-1,cand-2,cand-3,cand-4", "candidate order is preserved");
}

// --- stale ICE is dropped when the socket dies (server requirement) --------
{
  const h = harness({ identity });
  completeHandshake(h, identity);
  const socket = h.socket();

  // One batch still inside the 100ms window, plus a queue that pacing has not
  // drained yet: both belong to the negotiation that is about to die.
  for (let n = 0; n < 15; n += 1) { h.client.relay("phone-1", "ice", `queued-${n}`); }
  h.time.advance(100);
  for (let n = 0; n < 3; n += 1) { h.client.relay("phone-1", "ice", `batched-${n}`); }
  const sentBeforeClose = socket.sent.length;

  socket.close_("1006 abnormal");
  h.time.advance(1_000);
  completeHandshake(h, identity);
  h.time.advance(5_000);

  const afterReconnect = h.socket().sent.filter((m) => m.kind === "ice");
  assert(afterReconnect.length === 0, "no stale candidate is replayed into the new connection");
  assert(sentBeforeClose > 0, "candidates sent before the drop had already gone out");
}

// --- a pairing step in flight survives the reconnect -----------------------
{
  const h = harness({ identity });
  completeHandshake(h, identity);
  const socket = h.socket();
  for (let n = 0; n < 15; n += 1) { h.client.relay("phone-1", "hello", `box-${n}`); }
  socket.close_("1006 abnormal");
  h.time.advance(1_000);
  completeHandshake(h, identity);
  h.time.advance(5_000);

  const delivered = h.socket().sent.filter((m) => m.kind === "hello");
  assert(delivered.length === 5, "non-ICE envelopes queued during the outage are still delivered");
  assert(delivered[0].box === "box-10", "they resume from where pacing left off, in order");
}

// --- inbound routing -------------------------------------------------------
{
  const h = harness({ identity });
  completeHandshake(h, identity);
  const socket = h.socket();
  // `from` must be a real 22-char deviceId: the server's schema enforces the
  // shape, so a placeholder here would test a message the server can never send.
  const phone = P.identityFromSeeds(new Uint8Array(32).fill(9), new Uint8Array(32).fill(10));
  const sealed = P.toB64(new Uint8Array(48).fill(1));
  socket.deliver({ t: "relay", from: phone.deviceId, kind: "offer", box: sealed });
  socket.deliver({ t: "pair.join", tokenHash: "th-1", blob1: "b1" });
  socket.deliver({ t: "pair.done", tokenHash: "th-1", blob3: "b3" });
  socket.deliver({ t: "pair.closed", tokenHash: "th-1", reason: "done" });

  assert(h.received.relay[0]?.kind === "offer", "a relay envelope reaches the handler");
  assert(h.received.relay[0]?.from === phone.deviceId, "the sender deviceId is passed through");
  assert(h.received.relay[0]?.box === sealed, "the box is handed over untouched — the client never opens it");
  assert(h.client.currentPhase === "connected", "a well-formed relay does not disturb the connection");
  assert(h.received.pairJoin[0]?.blob1 === "b1", "pair.join is routed with its blob");
  assert(h.received.pairDone[0]?.blob3 === "b3", "pair.done is routed with its blob");
  assert(h.received.pairClosed[0]?.reason === "done", "pair.closed carries the reason");
}

// --- reconnect with backoff ------------------------------------------------
{
  const h = harness({ identity });
  completeHandshake(h, identity);
  h.socket().close_("1006 abnormal");

  assert(h.client.currentPhase === "backoff", "an unexpected close moves to backoff, not failed");
  assert(h.sockets.length === 1, "backoff waits before redialing");
  h.time.advance(1_000);
  assert(h.sockets.length === 2, "the first retry happens after the shortest backoff");

  h.socket().close_("1006 abnormal");
  h.time.advance(1_000);
  assert(h.sockets.length === 2, "the second retry waits longer than the first");
  h.time.advance(1_000);
  assert(h.sockets.length === 3, "the backoff grows rather than hammering the server");

  completeHandshake(h, identity);
  h.socket().close_("1006 abnormal");
  h.time.advance(1_000);
  assert(h.sockets.length === 4, "a successful connection resets the backoff");
}

// --- 01 §3 strict (develop 6aa15a1): unknown fields are refused ------------
{
  // The reason this is receive-side and not cosmetic: silently stripping an
  // unknown field is how three separate protocol mismatches in this project
  // presented as "it just doesn't work" with nothing in any log.
  const h = harness({ identity });
  completeHandshake(h, identity);
  const phone = P.identityFromSeeds(new Uint8Array(32).fill(9), new Uint8Array(32).fill(10));

  h.socket().deliver({
    t: "relay",
    from: phone.deviceId,
    kind: "offer",
    box: P.toB64(new Uint8Array(48).fill(1)),
    serverBuild: "2.0.1",
  });

  assert(h.received.relay.length === 0, "a message carrying an unknown field is NOT delivered to the handler");
  assert(h.client.currentPhase !== "connected", "and the connection does not carry on as if nothing happened");
  const reported = h.phases.find((p) => typeof p.error === "string" && p.error.includes("serverBuild"));
  assert(reported !== undefined, `the offending field is named for the UI (${reported?.error ?? "not reported"})`);
}

// --- the rejection comes from the decoder itself (protocol 0.5.0) ----------
{
  // Until 0.5.0 `decodeServerMessage` parsed non-strictly and DROPPED unknown
  // keys, so this pipe pre-checked the raw text. The decoder now rejects, and
  // that single source is what the client relies on — a second copy of the
  // rule here is what drifts.
  let threw = "";
  try { P.decodeServerMessage(JSON.stringify({ t: "ok", serverBuild: "2.0.1" })); }
  catch (error) { threw = String(error?.message ?? error); }
  assert(threw.includes("serverBuild"), `decodeServerMessage itself rejects the unknown field (${threw.slice(0, 60)})`);

  // The names still have to come off the RAW text, because a rejected message
  // produces no decoded object to inspect.
  assert(
    P.outOfSpecFields({ t: "ok", serverBuild: "2.0.1" }, "server").join() === "serverBuild",
    "and the raw message is what names the field for the log",
  );
  assert(
    P.decodeServerMessage(JSON.stringify({ t: "ok", iceServers: ["stun:a:3478"] })).iceServers.length === 1,
    "while a spec-valid optional field still decodes — strictness did not cost a legitimate frame",
  );
}

// --- a spec-conformant server is untouched ---------------------------------
{
  // A strict check that also rejected valid traffic would be worse than none.
  const h = harness({ identity });
  completeHandshake(h, identity);
  const phone = P.identityFromSeeds(new Uint8Array(32).fill(9), new Uint8Array(32).fill(10));
  h.socket().deliver({ t: "relay", from: phone.deviceId, kind: "offer", box: P.toB64(new Uint8Array(48).fill(1)) });
  h.socket().deliver({ t: "pair.join", tokenHash: "th-1", blob1: "b1" });
  h.socket().deliver({ t: "pong" });
  assert(h.received.relay.length === 1, "ordinary relay still arrives");
  assert(h.received.pairJoin.length === 1, "so does pair.join");
  assert(h.client.currentPhase === "connected", "and the connection stays up");
}

// --- M4: a signaling reconnect must not disturb a live session -------------
{
  // A WebRTC session runs peer-to-peer; signaling only carried its setup. So a
  // dropped and redialled socket has to leave the session alone. The mechanism
  // is that the client keeps its handlers and its identity across the redial —
  // if it re-registered from scratch, relay traffic for an in-flight session
  // (an ICE restart's offer, most importantly) would land nowhere and the
  // session would strand with no error anywhere.
  const h = harness({ identity });
  completeHandshake(h, identity);
  const phone = P.identityFromSeeds(new Uint8Array(32).fill(9), new Uint8Array(32).fill(10));

  h.socket().deliver({ t: "relay", from: phone.deviceId, kind: "offer", box: P.toB64(new Uint8Array(48).fill(1)) });
  assert(h.received.relay.length === 1, "a relay arrives before the outage");

  h.socket().close_("1006 abnormal");
  h.time.advance(1_000);
  const second = completeHandshake(h, identity);
  assert(second.verified, "the redial authenticates with the SAME identity — no re-pairing is implied");
  assert(second.hello.deviceId === identity.deviceId, "and announces the same deviceId, so the phone's relays still route here");
  assert(h.client.currentPhase === "connected", "the client is connected again");

  // The restart offer the phone sends after a network change (01 §6).
  h.socket().deliver({ t: "relay", from: phone.deviceId, kind: "offer", box: P.toB64(new Uint8Array(48).fill(2)) });
  assert(h.received.relay.length === 2, "relay for an in-flight session is still routed after the reconnect");
  assert(h.received.relay[1]?.kind === "offer", "including the ICE-restart offer, which is what keeps the session alive");

  const closingPhase = h.phases.find((p) => p.phase === "failed");
  assert(closingPhase === undefined, "a recoverable outage never reports `failed` — that would tell the app to give up");
}

// --- terminal errors are NOT retried ---------------------------------------
{
  for (const code of ["auth_failed", "unsupported_version", "replaced"]) {
    const h = harness({ identity });
    completeHandshake(h, identity);
    const socketCount = h.sockets.length;
    h.socket().deliver({ t: "err", code, message: "no" });

    assert(h.client.currentPhase === "failed", `${code} is terminal, not a retry loop`);
    h.time.advance(120_000);
    assert(h.sockets.length === socketCount, `${code} does not redial in the background`);
    assert(h.phases.at(-1)?.error !== undefined, `${code} surfaces a reason for the UI`);
  }
}

// --- a non-terminal server error keeps the connection ----------------------
{
  const h = harness({ identity });
  completeHandshake(h, identity);
  h.socket().deliver({ t: "err", code: "peer_offline", message: "phone-1" });
  assert(h.client.currentPhase === "connected", "peer_offline is reported without dropping the connection");
  assert(h.phases.at(-1)?.error?.includes("peer_offline"), "the error still reaches the UI");
}

// --- keepalive -------------------------------------------------------------
{
  const h = harness({ identity });
  completeHandshake(h, identity);
  const socket = h.socket();
  h.time.advance(P.PING_INTERVAL_MS);
  assert(socket.sent.at(-1)?.t === "ping", "a ping goes out on the keepalive interval");
  socket.deliver({ t: "pong" });

  h.time.advance(P.PING_TIMEOUT_MS + P.PING_INTERVAL_MS);
  assert(h.client.currentPhase === "backoff", "a server that stops answering is treated as a dropped connection");
}

// --- stop() is final -------------------------------------------------------
{
  const h = harness({ identity });
  completeHandshake(h, identity);
  h.client.stop();
  assert(h.socket().closed, "stop() closes the socket");
  assert(h.client.currentPhase === "idle", "stop() returns the client to idle");
  h.time.advance(120_000);
  assert(h.sockets.length === 1, "a stopped client never redials");
}

// --- 01 §3.1: ICE servers offered on `ok` ----------------------------------
{
  // Only stun: is honoured. A turn:/turns: entry would route media through
  // someone else's server, which this system does not do (00 §원칙 2) — and
  // the offer comes from a semi-trusted party (02 §신뢰 경계), so it is dropped
  // rather than obeyed.
  const rejected = [];
  const accepted = acceptIceServers(
    ['stun:a.example:3478', 'turn:evil.example:3478', 'turns:evil.example:5349', 'stun:b.example:19302', 42, null],
    (entry) => rejected.push(entry),
  );
  assert(accepted.join(',') === 'stun:a.example:3478,stun:b.example:19302', 'only stun: entries are kept, in order');
  assert(rejected.join(',') === 'turn:evil.example:3478,turns:evil.example:5349', 'turn/turns are dropped and reported, not silently ignored');
  assert(acceptIceServers(undefined).length === 0, 'a server that offers nothing yields an empty list');
  assert(acceptIceServers('stun:a.example').length === 0, 'a non-array offer is refused rather than coerced');

  const h = harness({ identity });
  completeHandshake(h, identity);
  assert(h.client.iceServers.length === 0, 'with no offer the client reports none, so the caller uses its built-in list');
}

// --- the offer only survives if the shared schema carries it ---------------
{
  const h = harness({ identity });
  const socket = h.socket();
  socket.open();
  const nonce = P.newChallengeNonce();
  const ts = h.time.now();
  socket.deliver({ t: 'challenge', nonce: P.toB64(nonce), serverId: 'sig.test', ts });
  socket.deliver({ t: 'ok', iceServers: ['stun:offered.example:3478'] });

  const carried = P.ServerOkSchema.safeParse({ t: 'ok', iceServers: ['stun:x'] });
  const schemaKeeps = carried.success && Array.isArray(carried.data.iceServers);
  if (schemaKeeps) {
    assert(h.client.iceServers[0] === 'stun:offered.example:3478', 'an offered STUN server reaches the transport');
  } else {
    console.log('  ! BLOCKED: @agentparty/protocol ServerOkSchema drops `iceServers`, so a server offer never reaches this client.');
    blocked += 1;
  }
}
if (blocked > 0) {
  console.log(`\n${blocked} check(s) BLOCKED on an @agentparty/protocol update — see above.`);
}
console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
