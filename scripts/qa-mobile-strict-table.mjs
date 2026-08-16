/*
 * §3 strict receive — the allowed-field table, taken from the SPEC.
 *
 * Why this file is separate from the sender audit: strict rejection has two
 * failure directions and they need opposite evidence.
 *
 *   - too loose  → an unknown field slips through (the sender audit's concern)
 *   - too strict → a LEGITIMATE frame is refused and the connection dies
 *
 * The second is far worse and is what this file guards. mobile-pipe raised it:
 * build the allowed set from what a parser happens to read and strict will
 * refuse real frames — for them, every pairing frame would have died on the
 * correlation `id` and `tokenHash` their parser ignored. A desktop that
 * refuses `pair.join` cannot pair at all, and the symptom is "pairing just
 * doesn't work" with the cause invisible.
 *
 * So the table below is enumerated from 01 §3.1–3.4, not from this pipe's
 * reader, and every entry must be ACCEPTED. The rule itself is the shared
 * package's (`ServerMessageStrictSchema` / `outOfSpecFields`), never a second
 * copy here.
 *
 * On the correlation `id` specifically (01 §3.4): the server echoes it on
 * RESPONSES and errors. A relayed frame is not a response to anything this
 * desktop asked, and AgentPartyServer's connection.ts confirms it: `pair.joined`
 * carries `idField(message.id)` back to the requesting phone, while the relayed
 * `pair.join` / `pair.done` / `pair.closed` are sent without one. Both shapes
 * are asserted, so if either side changes this it surfaces here rather than as
 * a dead pairing screen.
 */
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";

const P = await import("@agentparty/protocol");
await P.sodiumReady();

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

if (typeof P.ServerMessageStrictSchema !== "object" || typeof P.outOfSpecFields !== "function") {
  console.log("  ✗ @agentparty/protocol is missing the strict surface — reinstall (>=0.4.0)");
  process.exit(1);
}

const DEVICE = "AAAAAAAAAAAAAAAAAAAAAA";
const BOX = P.toB64(new Uint8Array(48).fill(1));
const NONCE = P.toB64(new Uint8Array(32).fill(2));

/**
 * Every server -> client frame in 01 §3, each in the shapes the server can
 * really send it. Adding a row here is how a new §3 frame gets covered.
 */
const SPEC_FRAMES = [
  ["§3.1 challenge", { t: "challenge", nonce: NONCE, serverId: "sig.agentparty.app", ts: 1 }],
  ["§3.1 challenge + id", { t: "challenge", nonce: NONCE, serverId: "sig.agentparty.app", ts: 1, id: "req-1" }],
  ["§3.1 ok", { t: "ok" }],
  ["§3.1 ok + iceServers", { t: "ok", iceServers: ["stun:stun.cloudflare.com:3478"] }],
  ["§3.1 ok + id", { t: "ok", id: "req-1" }],
  ["§3.1a err", { t: "err", code: "peer_offline" }],
  ["§3.1a err + id", { t: "err", code: "peer_offline", id: "req-1" }],
  ["§3.1a err + message", { t: "err", code: "peer_offline", message: "상대가 접속해 있지 않습니다." }],
  ["§3.1 pong", { t: "pong" }],
  ["§3.1 pong + id", { t: "pong", id: "req-1" }],
  ["§3.2 relay", { t: "relay", from: DEVICE, kind: "offer", box: BOX }],
  ["§3.2 relay + id", { t: "relay", from: DEVICE, kind: "offer", box: BOX, id: "req-1" }],
  ["§3.4 presence", { t: "presence", of: DEVICE, online: true }],
  ["§3.4 presence + id", { t: "presence", of: DEVICE, online: false, id: "req-1" }],
  // §2.2 pairing. `pair.opened` / `pair.joined` are RESPONSES and carry the
  // optional `id`; the rest are relays and do not (01 §3.4 — "응답·err").
  ["§2.2 pair.opened", { t: "pair.opened", tokenHash: "th-1" }],
  ["§2.2 pair.opened + id", { t: "pair.opened", tokenHash: "th-1", id: "req-1" }],
  ["§2.2 pair.joined", { t: "pair.joined", tokenHash: "th-1" }],
  ["§2.2 pair.joined + id", { t: "pair.joined", tokenHash: "th-1", id: "req-1" }],
  ["§2.2 pair.join", { t: "pair.join", tokenHash: "th-1", blob1: "b1" }],
  // Relayed to the PHONE, not to this desktop, but the schema is shared and a
  // gap in the table is a gap regardless of which side receives it.
  ["§2.2 pair.accept", { t: "pair.accept", tokenHash: "th-1", blob2: "b2" }],
  ["§2.2 pair.done", { t: "pair.done", tokenHash: "th-1", blob3: "b3" }],
  ["§2.2 pair.closed", { t: "pair.closed", tokenHash: "th-1", reason: "expired" }],
];

/** Every `err` code in the 01 §3.1a fixed list — a missing one would break the UI path. */
const ERR_CODES = [
  "bad_message", "unsupported_version", "not_authenticated", "auth_failed", "auth_expired",
  "replaced", "pair_exists", "pair_not_found", "pair_busy", "peer_offline", "rate_limited",
  "too_large", "internal",
];

/** Every relay `kind` in 01 §3.2. */
const RELAY_KINDS = ["offer", "answer", "ice", "hello", "bye"];

console.log("§3 strict receive — spec table (every legitimate frame must be ACCEPTED):");

for (const [label, frame] of SPEC_FRAMES) {
  const result = P.ServerMessageStrictSchema.safeParse(frame);
  const detail = result.success
    ? ""
    : ` :: ${JSON.stringify(result.error.issues.map((i) => `${i.code} ${JSON.stringify(i.keys ?? i.path)}`))}`;
  assert(result.success, `${label} is accepted${detail}`);
}

for (const code of ERR_CODES) {
  assert(
    P.ServerMessageStrictSchema.safeParse({ t: "err", code }).success,
    `§3.1a err code \`${code}\` is accepted`,
  );
}

for (const kind of RELAY_KINDS) {
  assert(
    P.ServerMessageStrictSchema.safeParse({ t: "relay", from: DEVICE, kind, box: BOX }).success,
    `§3.2 relay kind \`${kind}\` is accepted`,
  );
}

// --- the relayed pairing frames carry no correlation id --------------------
{
  // Documented so a change on either side lands here instead of on a user's
  // pairing screen. If the server starts echoing `id` on these, this fails and
  // the schema must be widened BEFORE that ships.
  for (const frame of [
    { t: "pair.join", tokenHash: "th-1", blob1: "b1", id: "req-1" },
    { t: "pair.accept", tokenHash: "th-1", blob2: "b2", id: "req-1" },
    { t: "pair.done", tokenHash: "th-1", blob3: "b3", id: "req-1" },
    { t: "pair.closed", tokenHash: "th-1", reason: "expired", id: "req-1" },
  ]) {
    assert(
      !P.ServerMessageStrictSchema.safeParse(frame).success,
      `${frame.t} + id is refused — matching AgentPartyServer, which sends these relays without one`,
    );
  }
}

// --- the hand table must match the canonical vector ------------------------
{
  // The frames above carry real values, which a generated table cannot. But a
  // hand-written list drifts, and a type or field added to §3 that nobody adds
  // here would simply go untested. So the NAMES are cross-checked against
  // `signalingFields` in the protocol vectors (server 0.5.0): the vector owns
  // the table, this file only owns the values.
  const vectorPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../AgentPartyMobile/docs/아키텍처/vectors/protocol-v1.json",
  );
  let vector;
  try {
    vector = JSON.parse(await readFile(vectorPath, "utf8"));
  } catch (error) {
    // Loud rather than skipped: without this the table above is unguarded.
    assert(false, `the protocol vectors could not be read for the cross-check (${vectorPath}): ${String(error?.message ?? error)}`);
  }

  const table = vector?.signalingFields?.server;
  if (table) {
    const covered = new Set(SPEC_FRAMES.map(([, f]) => f.t));
    for (const type of Object.keys(table)) {
      assert(covered.has(type), `vector type \`${type}\` is covered by a frame above`);
    }

    // And each covered type's optional fields are exercised, since an optional
    // field that no frame carries is exactly where strict quietly over-rejects.
    for (const [type, fields] of Object.entries(table)) {
      const shapes = SPEC_FRAMES.filter(([, f]) => f.t === type).map(([, f]) => Object.keys(f));
      for (const optional of fields.optional ?? []) {
        assert(
          shapes.some((keys) => keys.includes(optional)),
          `\`${type}\` is tested WITH its optional \`${optional}\` — an untested optional is where over-rejection hides`,
        );
      }
    }
  }
}

// --- and the check still catches what it is for ----------------------------
{
  assert(
    P.outOfSpecFields({ t: "pong", serverBuild: "2.0.1" }, "server").join() === "serverBuild",
    "an unknown field is still named — the table is not simply permissive",
  );
  assert(
    P.outOfSpecFields({ t: "ok", iceServers: ["stun:a:3478"] }, "server").length === 0,
    "while a legitimate optional field reports nothing",
  );
}

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
