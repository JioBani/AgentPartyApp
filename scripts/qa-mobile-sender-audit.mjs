/*
 * §3 sender audit — what this pipe actually puts on the wire.
 *
 * This exists so "zero out-of-spec fields" is a MEASUREMENT and not an
 * artefact of how the measurement was taken. server (e974af9) found that their
 * harness had been sending `ClientMessageSchema.parse(message)`, and parse
 * DROPS unknown keys — so their client could not physically emit an
 * out-of-spec field and "zero" was structurally guaranteed rather than
 * observed. The same trap would apply here if this read anything other than
 * the bytes handed to the socket.
 *
 * So: the capture point is the socket's `send(data: string)`, the raw text,
 * and the pipe's own encoder (`canonicalJson`) performs no schema parse. The
 * field check is server's `outOfSpecFields` from the shared package rather
 * than a second copy of the rule here.
 *
 * Two things stop this from passing vacuously:
 *   - every client message type must be observed, so producing nothing fails
 *   - a deliberately injected field must be CAUGHT, proving the check can fail
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");

const result = await build({
  entryPoints: [path.join(projectRoot, "src/main/mobile/signalingClient.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@agentparty/protocol", "ws"],
  write: false,
});
const bundlePath = path.join(qaTempDir(), "senderAudit.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const { SignalingClient } = await import(pathToFileURL(bundlePath).href);
const P = await import("@agentparty/protocol");
await P.sodiumReady();

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

if (typeof P.outOfSpecFields !== "function") {
  // Re-implementing the rule here would defeat the point of a shared package.
  console.log("  ✗ @agentparty/protocol does not export outOfSpecFields — rebuild the package");
  process.exit(1);
}

/** Every §3 message this pipe can send. Missing one would hide it from the audit. */
const EXPECTED_TYPES = ["hello", "auth", "relay", "pair.open", "pair.accept", "pair.cancel", "ping"];

const identity = P.identityFromSeeds(new Uint8Array(32).fill(3), new Uint8Array(32).fill(4));
const phone = P.identityFromSeeds(new Uint8Array(32).fill(9), new Uint8Array(32).fill(10));

/**
 * Client-direction samples for the `t` values that exist in BOTH directions.
 * Keyed by `t` so the vector's list drives which ones are exercised.
 */
const SHARED_CLIENT_SHAPES = {
  relay: { t: "relay", to: phone.deviceId, kind: "offer", box: P.toB64(new Uint8Array(48).fill(1)) },
  presence: { t: "presence", of: phone.deviceId },
  "pair.join": { t: "pair.join", tokenHash: "th-1", blob1: "b1" },
  "pair.accept": { t: "pair.accept", tokenHash: "th-1", blob2: "b2" },
  "pair.done": { t: "pair.done", tokenHash: "th-1", blob3: "b3" },
};

function clock() {
  let now = 1_700_000_000_000;
  const timers = new Map();
  let id = 0;
  return {
    now: () => now,
    setTimer: (fn, ms) => { const t = ++id; timers.set(t, { fn, at: now + ms }); return t; },
    clearTimer: (t) => timers.delete(t),
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [t, timer] = due[0];
        timers.delete(t);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
  };
}

/**
 * Captures the RAW string given to the socket. Nothing between the client and
 * this array may parse or re-serialize, or the audit measures its own filter.
 */
function run() {
  const time = clock();
  const wire = [];
  const sockets = [];
  const client = new SignalingClient({
    url: "ws://127.0.0.1:8080/v1/ws",
    identity,
    log: () => {},
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    openSocket: () => {
      const socket = {
        send: (data) => wire.push(data),
        close: () => {},
        onOpen: (fn) => { socket.open = fn; },
        onMessage: (fn) => { socket.message = fn; },
        onClose: (fn) => { socket.close_ = fn; },
        onError: (fn) => { socket.error = fn; },
        deliver: (m) => socket.message(JSON.stringify(m)),
      };
      sockets.push(socket);
      return socket;
    },
  });
  client.start({
    onRelay: () => {}, onPairJoin: () => {}, onPairDone: () => {},
    onPairClosed: () => {}, onPhaseChange: () => {},
  });

  const socket = sockets[0];
  socket.open();                                   // -> hello
  const nonce = P.newChallengeNonce();
  socket.deliver({ t: "challenge", nonce: P.toB64(nonce), serverId: "sig.test", ts: time.now() });
  socket.deliver({ t: "ok" });                     // -> auth, then connected

  client.relay(phone.deviceId, "offer", P.toB64(new Uint8Array(48).fill(1)));
  client.relay(phone.deviceId, "ice", P.toB64(new Uint8Array(48).fill(2)));
  client.openPairing("token-hash-1", time.now() + 120_000);
  client.acceptPairing("token-hash-1", "blob2-payload");
  client.cancelPairing("token-hash-1");
  time.advance(120_000);                           // -> ping (keepalive)

  return { wire, client, time, socket };
}

console.log("§3 sender audit (raw wire, shared outOfSpecFields):");

const { wire } = run();

// --- the audit --------------------------------------------------------------
const seen = new Map();
const offenders = [];
for (const text of wire) {
  // Parsed only to read it; the TEXT is what was sent, and nothing re-encodes it.
  const message = JSON.parse(text);
  const extras = P.outOfSpecFields(message, "client");
  seen.set(message.t, (seen.get(message.t) ?? 0) + 1);
  if (extras.length > 0) {
    offenders.push({ t: message.t, fields: extras });
  }
}

console.log(`  observed ${wire.length} outbound messages: ${[...seen.keys()].sort().join(", ")}`);

for (const type of EXPECTED_TYPES) {
  assert(seen.has(type), `${type} was actually emitted and audited`);
}
assert(
  offenders.length === 0,
  `zero out-of-spec fields across all outbound messages${offenders.length ? ` — ${JSON.stringify(offenders)}` : ""}`,
);

// --- the audit is asking the right direction --------------------------------
{
  // mobile-pipe raised this: `relay` exists in BOTH directions and is not the
  // same frame — the client's carries `to`, the server's carries `from`.
  //
  // For `relay` a wrong direction is loud: the field is reported as
  // out-of-spec, so the audit would fail rather than lie. The genuinely silent
  // case is a DIRECTION-EXCLUSIVE type. `outOfSpecFields` reports nothing when
  // a message fails to parse for any other reason, and a `t` that does not
  // exist in the checked direction is exactly that — so an audit pointed at
  // the wrong table would report a clean zero for every pairing message it
  // sends, no matter what was in them.
  const bogus = { t: "pair.open", tokenHash: "th", exp: 1, notAField: "x" };
  assert(
    P.outOfSpecFields(bogus, "client").join() === "notAField",
    "a client-only message audited as `client` reports its junk field",
  );
  assert(
    P.outOfSpecFields(bogus, "server").length === 0,
    "and audited as `server` reports NOTHING — the silent failure this audit must not have",
  );

  // So every type observed above must actually exist in the client table.
  // Without this, "zero out-of-spec fields" could mean "checked against a
  // table that has never heard of these messages".
  const vectorPath = path.resolve(projectRoot, "../AgentPartyMobile/docs/아키텍처/vectors/protocol-v1.json");
  let clientTable;
  let vectorShared;
  try {
    const vector = JSON.parse(readFileSync(vectorPath, "utf8"));
    clientTable = vector?.signalingFields?.client;
    vectorShared = vector?.signalingSharedNames;
  } catch (error) {
    assert(false, `the protocol vectors could not be read to confirm the direction (${String(error?.message ?? error)})`);
  }
  if (clientTable) {
    for (const type of seen.keys()) {
      assert(
        Object.prototype.hasOwnProperty.call(clientTable, type),
        `\`${type}\` exists in the CLIENT table, so auditing it as \`client\` was a real check`,
      );
    }
  }

  // Why the existence check is the RIGHT guard, and enough on its own.
  //
  // Five `t` values live in both directions with different fields (server
  // 0.7.0 `sharedMessageNames()`, mirrored in the vector). For those, a wrong
  // direction does NOT hide an out-of-spec field — zod reports the
  // unrecognized key alongside the missing-required one — so they are safe
  // either way. Only `relay` additionally flags the direction itself, via
  // `to`/`from`; the rest simply keep working. That distinction is worth
  // stating because "shared names fail loudly" is true of `relay` alone and
  // reads as a general rule.
  //
  // The unsafe case is the direction-EXCLUSIVE type, which reports nothing at
  // all. So checking that each observed type exists in the audited direction
  // covers exactly the gap, and nothing more is needed.
  const shared = vectorShared ?? [];
  assert(shared.length > 0, "the vector lists the shared message names");
  for (const entry of shared) {
    const frame = SHARED_CLIENT_SHAPES[entry.t];
    if (!frame) {
      assert(false, `no client-shaped sample for shared name \`${entry.t}\` — add one`);
      continue;
    }
    const junk = { ...frame, notAField: "x" };
    assert(
      P.outOfSpecFields(junk, "client").includes("notAField"),
      `shared \`${entry.t}\`: junk is caught in the right direction`,
    );
    assert(
      P.outOfSpecFields(junk, "server").includes("notAField"),
      `shared \`${entry.t}\`: junk is caught even in the WRONG direction — shared names cannot hide a field`,
    );
  }

  // Detecting the DIRECTION MISTAKE itself is a different property, and it is
  // asymmetric (server 0.8.0). Only `relay` is caught both ways. `presence` is
  // caught only server->client (via `online`); the pair frames only
  // client->server (via `id`) — and that one depends on the optional `id`
  // actually being present, since without it the two shapes are identical.
  //
  // Pinned because it is the tempting thing to rely on, and it does not hold.
  // The audit must not lean on a wrong direction announcing itself.
  const DIRECTION_TELLS = [
    ["relay", { t: "relay", to: phone.deviceId, kind: "offer", box: P.toB64(new Uint8Array(48).fill(1)) }, true],
    ["presence", { t: "presence", of: phone.deviceId }, false],
    ["pair.join", { t: "pair.join", tokenHash: "th-1", blob1: "b1" }, false],
  ];
  for (const [name, clientFrame, caughtGoingRight] of DIRECTION_TELLS) {
    const caught = P.outOfSpecFields(clientFrame, "server").length > 0;
    assert(
      caught === caughtGoingRight,
      `\`${name}\`: a client frame checked as \`server\` is ${caughtGoingRight ? "caught" : "SILENT"} — direction errors do not reliably announce themselves`,
    );
  }
}

// --- the check can fail -----------------------------------------------------
{
  // server's standard: a measurement nobody has seen fail is not evidence.
  const doctored = { ...JSON.parse(wire.find((w) => JSON.parse(w).t === "hello")), desktopBuild: "1.2.3" };
  const caught = P.outOfSpecFields(doctored, "client");
  assert(
    caught.length === 1 && caught[0] === "desktopBuild",
    `an injected field IS caught, so the zero above is a measurement (${JSON.stringify(caught)})`,
  );
}

// --- and the encoder does not strip -----------------------------------------
{
  // The other half of server's trap: if the pipe's encoder parsed against the
  // schema, an out-of-spec field would never reach the socket and the audit
  // would be measuring the encoder rather than the pipe.
  const encoded = JSON.parse(P.encodeSignalingMessage({ t: "ping", desktopBuild: "1.2.3" }));
  assert(
    encoded.desktopBuild === "1.2.3",
    "the pipe's encoder passes unknown fields THROUGH to the wire — so if the pipe ever added one, this audit would see it",
  );
}

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
