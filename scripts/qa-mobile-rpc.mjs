/*
 * RpcServer test (01 §5) — real envelopes through the real EventBridge.
 *
 * The rules under test are the ones whose violation is invisible to the phone:
 * a request that never gets an answer, a rewind that silently returns partial
 * history, a snapshot that cannot be told apart from "the desktop is empty",
 * and a chunk group that half-arrives. Each of those is asserted to produce a
 * definite outcome the phone can act on.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
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
    external: ["@agentparty/protocol", "ws", "node-datachannel"],
    write: false,
  });
  const bundlePath = path.join(outDir, name);
  writeFileSync(bundlePath, result.outputFiles[0].text);
  return import(pathToFileURL(bundlePath).href);
}

const M = await load("src/main/mobile/rpcServer.ts", "rpcServer.mjs");
const { RpcServer } = M;
const { EventBridge } = await load("src/main/mobile/eventBridge.ts", "eventBridgeForRpc.mjs");
const C = await load("src/main/mobile/chunking.ts", "chunkingForRpc.mjs");
const P = await import("@agentparty/protocol");
await P.sodiumReady();

const failures = [];
let blocked = 0;
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };
const tick = () => new Promise((r) => setImmediate(r));

const SESSION = "s-1";
let idSeq = 0;
const req = (m, p) => ({ k: "req", id: `r-${++idSeq}`, m, ...(p === undefined ? {} : { p }) });

function harness({ handlers = new Map(), snapshotProvider, bootId = "boot-1", bridgeOverride } = {}) {
  const bridge = bridgeOverride ?? new EventBridge({ bootId });
  const sent = [];
  const nonConforming = [];
  const closes = [];
  const pushes = [];
  bridge.attach({ sessionId: SESSION, deliver: (event) => server.deliver(event) });

  const server = new RpcServer({
    link: {
      sessionId: SESSION,
      deviceId: "phone-device-id-000001",
      deviceName: "Galaxy S25",
      transport: "directViaRendezvous",
      send: (envelope) => {
        // server made the §5.1 envelope schemas .strict(), so an out-of-spec
        // field is now a parse error on the phone rather than a silent drop.
        // Every envelope this pipe emits is checked against them here.
        const parsed = P.RpcEnvelopeSchema.safeParse(envelope);
        if (!parsed.success) {
          nonConforming.push({ envelope, issue: parsed.error.issues[0]?.message ?? "" });
        }
        sent.push(envelope);
      },
      close: (reason) => closes.push(reason),
    },
    eventBridge: bridge,
    handlers: () => handlers,
    snapshotProvider: () => snapshotProvider,
    appName: "AgentParty",
    appVersion: "0.2.0",
    signalingUrl: () => "wss://sig.test/v1/ws",
    registerPush: (deviceId, platform, handle) => pushes.push({ deviceId, platform, handle }),
    log: () => {},
    now: () => 1_700_000_000_000,
    newId: () => "grp-1",
  });

  return { server, bridge, sent, closes, pushes, handlers, nonConforming, last: () => sent.at(-1) };
}

console.log("RpcServer assertions:");

// --- reserved methods answered by the pipe ---------------------------------
{
  const h = harness();
  h.server.handle(req("sys.ping"));
  await tick();
  const pong = h.last();
  assert(pong.k === "res" && pong.ok === true, "sys.ping is answered by the pipe");
  assert(P.SysPingResultSchema.safeParse(pong.r).success, "the sys.ping result matches the shared schema");
  assert(pong.r.bootId === "boot-1", "sys.ping reports the desktop's bootId");
  assert(pong.r.transport === "directViaRendezvous", "sys.ping reports the transport actually in use");

  h.bridge.publish("e", {}, undefined);
  h.server.handle(req("sys.info"));
  await tick();
  const info = h.last();
  assert(P.SysInfoResultSchema.safeParse(info.r).success, "the sys.info result matches the shared schema");
  assert(info.r.protocolVersion === P.PROTOCOL_VERSION, "sys.info reports the protocol version");
  assert(info.r.maxSeq === 1, "sys.info reports the live ring-buffer window");

  // 01 ddc2563 — the signaling address is NOT part of trust, so a phone must be
  // able to learn a new one over a LIVE session rather than re-pairing.
  assert(
    info.r.signalingUrl === "wss://sig.test/v1/ws",
    `sys.info carries the desktop's signaling URL (${info.r.signalingUrl})`,
  );
  assert(
    Object.prototype.hasOwnProperty.call(P.SysInfoResultSchema.shape ?? {}, "signalingUrl"),
    "BLOCKED: SysInfoResultSchema does not declare signalingUrl — a phone parsing non-strictly would STRIP it and never see the new address (server: add the field)",
  );

  h.server.handle(req("push.register", { platform: "android", handle: "fcm-token" }));
  await tick();
  assert(h.pushes[0]?.handle === "fcm-token", "push.register stores the handle against the verified device");
  assert(h.pushes[0]?.deviceId === "phone-device-id-000001", "the deviceId comes from the session, not the params");

  h.server.handle(req("push.register", { platform: "windows-phone", handle: "x" }));
  await tick();
  assert(h.last().ok === false, "an invalid push platform is rejected rather than stored");
  assert(h.pushes.length === 1, "and nothing was written");
}

// --- ctx.currentSeq(): the baseline a handler's answer is true as of --------
{
  // It is a function so the CALLER picks the instant. For a handler that reads
  // state, the correct instant is BEFORE the read: state and seq cannot be
  // taken atomically, and of the two possible errors 01 §5.3 chooses the
  // duplicate over the loss. desktop-app caught the earlier guidance here
  // having this backwards.
  const handlers = new Map();
  const readings = [];
  handlers.set("member.transcript", async (params, ctx) => {
    readings.push({ label: "beforeRead", seq: ctx.currentSeq() });
    // The state read lands somewhere in here, at instant T, while events keep
    // arriving.
    await tick();
    h.bridge.publish("session:events", { during: true }, "C:/w");
    await tick();
    readings.push({ label: "afterRead", seq: ctx.currentSeq() });
    return { text: "…" };
  });
  const h = harness({ handlers });

  h.bridge.publish("session:events", { n: 1 }, "C:/w");
  h.bridge.publish("session:events", { n: 2 }, "C:/w");
  h.server.handle(req("member.transcript", { workspacePath: "C:/w" }));
  await tick(); await tick(); await tick();

  const before = readings.find((r) => r.label === "beforeRead");
  const after = readings.find((r) => r.label === "afterRead");
  assert(before?.seq === 2, `currentSeq() reports the seq at the moment it is called (${before?.seq})`);
  assert(
    after?.seq === 3,
    `and a later call sees a later value (${after?.seq}) — the reading is live, which is what lets the caller choose`,
  );
  assert(
    before.seq < after.seq,
    "the two differ, so WHICH instant a handler reports is a real decision and not cosmetic",
  );
  assert(
    h.bridge.window().seq === after.seq,
    "reporting the later seq (3) would tell the phone to skip the mid-read event, which the answer does not contain — that is the silent loss 01 §5.3 forbids",
  );
}

// --- currentSeq() is the counter, unaffected by what the buffer still holds -
{
  // The ring buffer is trimmed, so what it CONTAINS is not the history. The
  // baseline handed to the phone has to be the counter: derived from buffer
  // contents it would move backwards whenever entries were dropped, and the
  // phone would re-apply everything it had already merged.
  const bridge = new EventBridge({ bootId: "boot-1", maxCount: 2 });
  for (let n = 1; n <= 5; n += 1) {
    bridge.publish("session:events", { n }, "C:/w");
  }
  const window = bridge.window();
  assert(window.seq === 5, "five events were published");
  assert(window.count === 2, `but the buffer only kept the newest 2 (count ${window.count})`);
  assert(window.minSeq === 4, `so the buffer starts at seq 4, not 1 (${window.minSeq})`);

  const handlers = new Map();
  let reading;
  handlers.set("party.list", async (params, ctx) => { reading = ctx.currentSeq(); return {}; });
  const h = harness({ handlers, bridgeOverride: bridge });
  h.server.handle(req("party.list", {}));
  await tick();
  assert(reading === 5, `currentSeq() reports the full count 5, not the trimmed buffer's extent (${reading})`);
}

// --- app methods -----------------------------------------------------------
{
  const handlers = new Map();
  let seen;
  handlers.set("party.list", async (params, ctx) => { seen = { params, ctx }; return { members: 2 }; });
  handlers.set("boom", async () => { throw new Error("핸들러 폭발"); });
  const h = harness({ handlers });

  h.server.handle(req("party.list", { workspacePath: "C:/proj/a", extra: 1 }));
  await tick();
  assert(h.last().r?.members === 2, "a registered handler's result is returned");
  assert(seen.params.extra === 1, "params reach the handler untouched");
  assert(seen.ctx.workspacePath === "C:/proj/a", "workspacePath is lifted into the context (04 §3)");
  assert(seen.ctx.deviceId === "phone-device-id-000001", "the context carries the verified device");
  assert(seen.ctx.signal instanceof AbortSignal, "the handler gets an abort signal");
  assert(typeof seen.ctx.currentSeq === "function", "the handler can read the event seq (07 89f5af4)");

  h.server.handle(req("party.list", { workspacePath: 42 }));
  await tick();
  assert(seen.ctx.workspacePath === undefined, "a non-string workspacePath is left absent, not coerced");

  h.server.handle(req("nope.method"));
  await tick();
  const missing = h.last();
  assert(missing.ok === false && missing.e.code === "method_not_found", "an unknown method returns method_not_found");
  assert(h.closes.length === 0, "an unknown method does not end the session");

  h.server.handle(req("boom"));
  await tick();
  const failed = h.last();
  assert(failed.ok === false && failed.e.code === "handler_failed", "a throwing handler still produces a response");
  assert(failed.e.message.includes("핸들러 폭발"), "the handler's message reaches the phone");

  // A handler that could not perform the request answers with its own code.
  // Note this is for genuine exceptions only: an outcome the phone must act on
  // (approval.respond's already_resolved, which carries decision/resolvedAt)
  // belongs in the SUCCESS value — as an error it would reach the phone as a
  // link failure, indistinguishable from "could not reach the PC".
  handlers.set("member.send", async () => { throw new M.RpcError("invalid_params", "text는 문자열이어야 합니다"); });
  h.server.handle(req("member.send"));
  await tick();
  const rejected = h.last();
  assert(rejected.e.code === "invalid_params", "a handler's own RpcError code reaches the phone verbatim");
  assert(rejected.e.message.includes("문자열"), "along with its message");

  // A stray Node error carries an unrelated `code`; it must not become one.
  handlers.set("reads.file", async () => { const error = new Error("no such file"); error.code = "ENOENT"; throw error; });
  h.server.handle(req("reads.file"));
  await tick();
  assert(h.last().e.code === "handler_failed", "a Node error's own code does NOT leak to the phone as a protocol code");
}

// --- 01 §5.2 subscribe -----------------------------------------------------
{
  const h = harness();
  h.server.handle({ k: "ctl", c: "subscribe", workspaces: ["C:/a", "C:/b"] });
  const ack = h.last();
  assert(ack.c === "subscribed", "subscribe is acknowledged");
  assert(ack.workspaces.join(",") === "C:/a,C:/b", "the ack echoes the set now in effect");

  h.bridge.publish("session:events", { n: 1 }, "C:/a");
  h.bridge.publish("session:events", { n: 2 }, "C:/z");
  const events = h.sent.filter((e) => e.k === "evt");
  assert(events.length === 1, "only subscribed workspaces are delivered");

  h.server.handle({ k: "ctl", c: "subscribe", workspaces: [] });
  h.bridge.publish("session:events", { n: 3 }, "C:/a");
  assert(h.sent.filter((e) => e.k === "evt").length === 1, "an empty set replaces the old one");
}

// --- 01 §5.3 rewind --------------------------------------------------------
{
  const h = harness({ snapshotProvider: (ctx) => ({ workspaces: ctx.workspaces, live: true }) });
  h.server.handle({ k: "ctl", c: "subscribe", workspaces: ["C:/a"] });
  h.bridge.publish("session:events", { n: 1 }, "C:/a");
  h.bridge.publish("session:events", { n: 2 }, "C:/a");

  const before = h.sent.length;
  h.server.handle({ k: "ctl", c: "resume", bootId: "boot-1", lastSeq: 1 });
  await tick();
  const replayed = h.sent.slice(before);
  assert(replayed.filter((e) => e.k === "evt").length === 1, "replay resends only events after lastSeq");
  const resumed = replayed.at(-1);
  assert(resumed.c === "resumed", "replay ends with a resumed marker");
  assert(resumed.bootId === "boot-1", "resumed carries bootId so the phone never guesses its cursor");
  assert(resumed.seq === 2, "resumed carries the seq the phone is now caught up to");

  // A phone that has never synced (01 §5.3: null, never a random value).
  // The installed @agentparty/protocol predates that change and its
  // CtlResumeSchema still requires string/number, so decodeRpcEnvelope rejects
  // the spec-conformant envelope. Detected rather than worked around: bypassing
  // the shared decoder here would fork envelope validation.
  if (P.RpcControlSchema.safeParse({ k: "ctl", c: "resume", bootId: null, lastSeq: null }).success) {
    const fresh = h.sent.length;
    h.server.handle({ k: "ctl", c: "resume", bootId: null, lastSeq: null });
    await tick();
    const snapshot = h.sent.slice(fresh).at(-1) ?? {};
    assert(snapshot.c === "snapshot", "a null cursor always produces a snapshot");
    assert(snapshot.bootId === "boot-1", "the snapshot carries bootId");
    assert(typeof snapshot.seq === "number", "the snapshot carries the seq it is current as of");
    assert(snapshot.state.live === true, "the registered provider produced the state");
    assert(snapshot.state.workspaces.join(",") === "C:/a", "the provider sees the session's subscription");
  } else {
    console.log("  ! BLOCKED: @agentparty/protocol CtlResumeSchema rejects the null cursor required by 01 §5.3.");
    console.log("            A first-sync resume is UNVERIFIED until the package accepts bootId/lastSeq null.");
    blocked += 1;
  }

  // A different bootId reaches the same snapshot path and IS decodable today.
  const other = h.sent.length;
  h.server.handle({ k: "ctl", c: "resume", bootId: "a-different-boot", lastSeq: 1 });
  await tick();
  assert(h.sent.slice(other).at(-1).c === "snapshot", "a bootId from a previous desktop run forces a snapshot");
}

// --- a snapshot that cannot be produced is never faked ---------------------
{
  const h = harness();
  h.server.handle({ k: "ctl", c: "resume", bootId: "another-boot", lastSeq: 1 });
  await tick();
  assert(!h.sent.some((e) => e.c === "snapshot"), "no snapshot is sent when there is no provider");
  assert(h.closes.length === 1, "the session ends instead of fabricating an empty state");
  assert(h.closes[0].includes("스냅샷 제공자"), "the close reason names the missing provider");

  const broken = harness({ snapshotProvider: () => { throw new Error("상태를 읽지 못함"); } });
  broken.server.handle({ k: "ctl", c: "resume", bootId: "another-boot", lastSeq: 1 });
  await tick();
  assert(broken.closes[0]?.includes("상태를 읽지 못함"), "a failing provider surfaces its cause in the close reason");
  assert(!broken.sent.some((e) => e.c === "snapshot"), "and sends no snapshot at all");
}

// --- keepalive -------------------------------------------------------------
{
  const h = harness();
  h.server.handle({ k: "ctl", c: "ping" });
  assert(h.last().c === "pong", "ctl.ping is answered with pong");
}

// --- chunking (01 §5.6) ----------------------------------------------------
{
  const handlers = new Map();
  let got;
  handlers.set("big.echo", async (params) => { got = params; return { size: params.text.length }; });
  const h = harness({ handlers });

  // Inbound: a request too large for one frame, arriving as chunks.
  const big = { k: "req", id: "r-big", m: "big.echo", p: { text: "한".repeat(40_000) } };
  const chunks = C.splitEnvelope(JSON.stringify(big), "in-1");
  assert(chunks.length > 1, "the oversize request really is split");
  for (const chunk of chunks) { h.server.handle(chunk); }
  await tick();
  assert(got?.text.length === 40_000, "a chunked request reassembles with multi-byte text intact");

  // Outbound: the response is itself oversize and goes back as chunks.
  const outbound = h.sent.filter((e) => e.c === "chunk");
  assert(h.sent.some((e) => e.k === "res") || outbound.length > 0, "the response was sent");

  // A gap ends the session rather than leaving a half-assembled envelope.
  const h2 = harness();
  const parts = C.splitEnvelope(JSON.stringify(big), "in-2");
  h2.server.handle(parts[0]);
  h2.server.handle(parts[2]);
  assert(h2.closes.length === 1, "a chunk gap ends the session (01 §4.2 rule)");
  assert(h2.closes[0].includes("조립"), "the close reason names the reassembly failure");
}

// --- envelopes that must not arrive ----------------------------------------
{
  const h = harness();
  h.server.handle({ k: "evt", seq: 1, type: "x", d: {}, ts: 1 });
  assert(h.closes.length === 1, "an event from the phone ends the session — events are desktop→phone only");

  const h2 = harness();
  h2.server.handle({ nonsense: true });
  assert(h2.closes.length === 1, "an undecodable payload ends the session instead of being guessed at");
}

// --- teardown --------------------------------------------------------------
{
  const handlers = new Map();
  let aborted = false;
  handlers.set("slow", (params, ctx) => new Promise(() => { ctx.signal.addEventListener("abort", () => { aborted = true; }); }));
  const h = harness({ handlers });
  h.server.handle(req("slow"));
  await tick();
  assert(h.server.activity.inFlight === 1, "an in-flight request is visible for the 'mobile is driving' badge");
  assert(h.server.activity.lastRequestMethod === "slow", "the badge can name the method");

  h.server.dispose();
  await tick();
  assert(aborted, "dispose aborts handlers so they stop work nobody will receive");
  assert(h.server.activity.inFlight === 0, "in-flight requests are cleared");
}

// --- 01 §5.3: no live event may overtake a resume answer -------------------
{
  // A slow snapshot provider is the case that broke: resume() answers
  // asynchronously, so without a gate an event published during the await
  // reaches the phone BEFORE the snapshot. The phone's cursor would then sit
  // ahead of history it never received, and it would never ask for the gap.
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const h = harness({ snapshotProvider: async () => { await slow; return { snapshot: true }; } });
  h.server.handle({ k: 'ctl', c: 'subscribe', workspaces: ['C:/a'] });

  const before = h.sent.length;
  h.server.handle({ k: 'ctl', c: 'resume', bootId: null, lastSeq: null });
  await tick();

  // Live traffic while the provider is still working.
  h.bridge.publish('session:events', { n: 1 }, 'C:/a');
  h.bridge.publish('session:events', { n: 2 }, 'C:/a');
  await tick();
  assert(
    h.sent.slice(before).filter((e) => e.k === 'evt').length === 0,
    'no live event is written while the snapshot is still being produced',
  );

  release();
  await tick();
  await tick();

  const after = h.sent.slice(before);
  const snapshotIndex = after.findIndex((e) => e.c === 'snapshot');
  const firstEventIndex = after.findIndex((e) => e.k === 'evt');
  assert(snapshotIndex >= 0, 'the snapshot is sent once the provider finishes');
  assert(firstEventIndex > snapshotIndex, 'the held events are released only AFTER the snapshot');

  const released = after.filter((e) => e.k === 'evt');
  assert(released.length === 2, 'every held event is released, none dropped');
  assert(released[0].seq < released[1].seq, 'and they go out in seq order');

  // Once the gate is open, live events flow straight through again.
  const settled = h.sent.length;
  h.bridge.publish('session:events', { n: 3 }, 'C:/a');
  assert(h.sent.length === settled + 1, 'later events are written immediately, not queued forever');
}

// --- the same ordering holds on the replay path ----------------------------
{
  const h = harness({ snapshotProvider: () => ({}) });
  h.server.handle({ k: 'ctl', c: 'subscribe', workspaces: ['C:/a'] });
  h.bridge.publish('session:events', { n: 1 }, 'C:/a');
  h.bridge.publish('session:events', { n: 2 }, 'C:/a');

  const before = h.sent.length;
  h.server.handle({ k: 'ctl', c: 'resume', bootId: 'boot-1', lastSeq: 0 });
  await tick();

  const after = h.sent.slice(before);
  const resumedIndex = after.findIndex((e) => e.c === 'resumed');
  assert(resumedIndex === after.length - 1, 'resumed is the last thing written, after the whole replay');
  assert(after.slice(0, resumedIndex).every((e) => e.k === 'evt'), 'only replayed events precede it');
}

// --- every envelope this pipe emits conforms to the strict §5.1 schemas ----
{
  const handlers = new Map();
  handlers.set("ok.method", async () => ({ value: 1 }));
  const h = harness({ handlers, snapshotProvider: () => ({ state: 1 }) });
  h.server.handle({ k: "ctl", c: "subscribe", workspaces: ["C:/a"] });
  h.server.handle({ k: "ctl", c: "ping" });
  h.server.handle(req("ok.method"));
  h.server.handle(req("nope"));
  await tick();
  h.bridge.publish("session:events", { n: 1 }, "C:/a");
  h.server.handle({ k: "ctl", c: "resume", bootId: "boot-1", lastSeq: 0 });
  await tick();
  h.server.handle({ k: "ctl", c: "resume", bootId: null, lastSeq: null });
  await tick();

  // Prove the check can fail: an extra field must be rejected, or the
  // conformance assertion below would pass vacuously.
  assert(
    !P.RpcEnvelopeSchema.safeParse({ k: "ctl", c: "pong", ts: 1, extra: 1 }).success,
    "the schemas really are strict — an unknown field is a parse error",
  );

  const kinds = new Set(h.sent.map((e) => e.c ?? e.k));
  assert(kinds.size >= 5, `the pass exercised several envelope kinds (${[...kinds].join(",")})`);
  const first = h.nonConforming[0];
  assert(
    h.nonConforming.length === 0,
    `no emitted envelope violates the strict schema${first ? ` (${JSON.stringify(first.envelope).slice(0, 80)} -> ${first.issue})` : ""}`,
  );
  assert(h.sent.some((e) => e.c === "snapshot" && e.bootId === "boot-1"), "the null cursor yields a conformant snapshot");
}

if (blocked > 0) {
  console.log(`
${blocked} check(s) BLOCKED on an @agentparty/protocol update — see above.`);
}
console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
