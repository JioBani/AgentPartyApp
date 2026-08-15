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
const { SignalingClient } = await import(pathToFileURL(bundlePath).href);
const P = await import("@agentparty/protocol");
await P.sodiumReady();

const failures = [];
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

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
