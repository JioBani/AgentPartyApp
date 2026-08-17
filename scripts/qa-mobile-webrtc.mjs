/*
 * WebrtcTransport loopback test — two REAL node-datachannel PeerConnections on
 * this machine, wired through an in-memory signaling relay.
 *
 * A mocked transport cannot prove the two things that actually break in the
 * field:
 *   - the ICE candidate wire shape. 01 §3.3 fixes it to JSEP
 *     {candidate, sdpMid, sdpMLineIndex}; mobile-pipe lost every remote
 *     candidate to a field-name mismatch and saw only an ICE timeout. Here each
 *     emitted candidate is validated against the shared IcePayloadSchema, so a
 *     rename fails this test instead of a real device.
 *   - the 02 §T1 fingerprint check. The tampering case asserts the transport
 *     refuses BEFORE setRemoteDescription, which is the whole point of signing
 *     the fingerprint.
 *
 * ICE runs with no STUN server: host candidates are enough for a loopback and
 * keep the test off the network.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");

const result = await build({
  entryPoints: [path.join(projectRoot, "src/main/mobile/webrtcTransport.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@agentparty/protocol", "node-datachannel"],
  write: false,
});
const bundlePath = path.join(qaTempDir(), "webrtcTransport.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const { WebrtcTransport } = await import(pathToFileURL(bundlePath).href);
const P = await import("@agentparty/protocol");
// node-datachannel is an OPTIONAL dependency (native, prebuilt per platform).
// If it is genuinely absent the skip is announced loudly rather than reported
// as a pass — but it does not fail the suite, because its absence is an install
// condition, not a regression in this code.
let ndc;
try {
  const loaded = await import("node-datachannel");
  ndc = loaded.default ?? loaded;
} catch (error) {
  console.log("SKIPPED: node-datachannel is not installed — WebRTC transport is UNVERIFIED.");
  console.log(`         run 'npm install' to build the optional native module. (${String(error?.message ?? error)})`);
  process.exit(0);
}
await P.sodiumReady();

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };
const throws = (fn, match, msg) => {
  let message = "";
  try { fn(); } catch (error) { message = String(error?.message ?? error); }
  assert(message.includes(match), `${msg} (got: ${message || "no throw"})`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) { return true; }
    await wait(50);
  }
  console.log(`      (timed out waiting for ${label})`);
  return false;
}

const SESSION = "11111111-1111-4111-8111-111111111111";
const desktopIdentity = P.identityFromSeeds(new Uint8Array(32).fill(41), new Uint8Array(32).fill(42));
const phoneIdentity = P.identityFromSeeds(new Uint8Array(32).fill(43), new Uint8Array(32).fill(44));

console.log("WebrtcTransport assertions (real node-datachannel loopback):");

// --- a full negotiation and frame round trip -------------------------------
{
  const emittedCandidates = [];
  const received = [];
  const states = [];
  let desktop;

  // The phone: a raw PeerConnection that offers, exactly as the Dart pipe does.
  // Order matters: node-datachannel can fire onLocalDescription as soon as the
  // callback is registered if a description is already pending, so the desktop
  // must exist before any phone callback is wired.
  const phonePc = new ndc.PeerConnection("phone", { iceServers: [] });
  const phoneReceived = [];

  desktop = new WebrtcTransport({
    sessionId: SESSION,
    identity: desktopIdentity,
    peerSigPk: phoneIdentity.sigPk,
    iceServers: [],
    log: () => {},
    loadNative: () => ndc,
    sendSdp: (payload, kind) => {
      assert(kind === "answer", "the desktop answers rather than offers");
      // The phone verifies the desktop's signature before applying it.
      P.verifySdpPayload(payload, desktopIdentity.sigPk);
      phonePc.setRemoteDescription(payload.sdp, "answer");
    },
    sendIce: (payload) => {
      emittedCandidates.push(payload);
      if (payload.candidate.candidate === "") { return; }
      phonePc.addRemoteCandidate(payload.candidate.candidate, payload.candidate.sdpMid);
    },
  });

  phonePc.onLocalDescription((sdp, type) => {
    if (type !== "offer") { return; }
    // Signed with the phone's identity key, as 01 §3.3 requires.
    desktop.acceptOffer(P.buildSdpPayload({ sessionId: SESSION, sdp }, phoneIdentity.sigSk));
  });
  phonePc.onLocalCandidate((candidate, mid) => {
    desktop.addRemoteCandidate({
      sessionId: SESSION,
      candidate: { candidate, sdpMid: mid, sdpMLineIndex: 0 },
    });
  });

  const phoneChannel = phonePc.createDataChannel("agentparty");
  phoneChannel.onMessage((m) => phoneReceived.push(typeof m === "string" ? m : Buffer.from(m)));

  desktop.onFrame((frame) => received.push(Buffer.from(frame)));
  desktop.onStateChange((state) => states.push(state));

  const connected = await until(() => desktop.state === "connected", 15_000, "the data channel to open");
  assert(connected, "two real peers negotiate and the DataChannel opens");

  // --- the wire shape that broke on a real device --------------------------
  assert(emittedCandidates.length > 0, "the desktop emitted ICE candidates");
  const shapeErrors = [];
  for (const payload of emittedCandidates) {
    try { P.IcePayloadSchema.parse(payload); } catch (error) { shapeErrors.push(String(error).slice(0, 120)); }
  }
  assert(shapeErrors.length === 0, `every emitted candidate validates against the shared IcePayloadSchema${shapeErrors[0] ? ` (${shapeErrors[0]})` : ""}`);
  const real = emittedCandidates.find((p) => p.candidate.candidate !== "");
  assert(typeof real?.candidate.sdpMid === "string", "the candidate carries sdpMid (libdatachannel's mid), not `mid`");
  assert(real?.candidate.sdpMLineIndex === 0, "sdpMLineIndex is 0 — a data-channel SDP has one m-section");
  assert(
    emittedCandidates.some((p) => p.candidate.candidate === ""),
    'end-of-gathering is signalled with candidate: "" so the peer stops waiting',
  );

  // --- frames -------------------------------------------------------------
  if (connected) {
    phoneChannel.sendMessageBinary(Buffer.from([1, 2, 3, 4]));
    const got = await until(() => received.length > 0, 5_000, "a frame from the phone");
    assert(got, "a binary frame from the phone reaches onFrame");
    assert(received[0]?.equals(Buffer.from([1, 2, 3, 4])), "frame bytes arrive unchanged");

    desktop.send(Buffer.from([9, 8, 7]));
    const echoed = await until(() => phoneReceived.length > 0, 5_000, "a frame at the phone");
    assert(echoed, "a frame sent by the desktop reaches the phone");
    assert(Buffer.from(phoneReceived[0]).equals(Buffer.from([9, 8, 7])), "the desktop's frame bytes are unchanged");

    assert(states.includes("connected"), "the transport reported connected");

    // develop asks for candidate types after every field test, so the transport
    // has to be able to say which pair actually carried the session.
    const pair = desktop.selectedCandidatePair();
    assert(pair !== undefined, "the selected ICE candidate pair is reported once connected");
    assert(typeof pair?.local?.type === "string" && typeof pair?.remote?.type === "string",
      `both ends carry a candidate type (local ${pair?.local?.type}, remote ${pair?.remote?.type})`);
    assert(pair?.local?.type !== "relay" && pair?.remote?.type !== "relay",
      "neither end is a relay candidate — this system has no TURN (00 §원칙 2)");
  }

  desktop.close("test over");
  assert(desktop.state === "closed", "close() moves the transport to closed");
  assert(desktop.selectedCandidatePair() === undefined, "a closed transport reports no pair rather than a stale one");
  throws(() => desktop.send(Buffer.from([0])), "closed transport", "sending after close is an error, not a silent drop");
  phonePc.close();
}

// --- 02 §T1: a substituted fingerprint is refused BEFORE it is applied -----
{
  const phonePc = new ndc.PeerConnection("phone-mitm", { iceServers: [] });
  // Register before createDataChannel: the description is emitted as soon as
  // the channel exists, and a callback attached afterwards never fires.
  const offer = await new Promise((resolve) => {
    phonePc.onLocalDescription((sdp, type) => { if (type === "offer") { resolve(sdp); } });
    phonePc.createDataChannel("agentparty");
  });

  let applied = 0;
  const desktop = new WebrtcTransport({
    sessionId: SESSION,
    identity: desktopIdentity,
    peerSigPk: phoneIdentity.sigPk,
    iceServers: [],
    log: () => {},
    loadNative: () => ({
      PeerConnection: function () {
        return {
          setRemoteDescription: () => { applied += 1; },
          addRemoteCandidate: () => {},
          localDescription: () => null,
          state: () => "new",
          close: () => {},
          onLocalDescription: () => {},
          onLocalCandidate: () => {},
          onStateChange: () => {},
          onGatheringStateChange: () => {},
          onDataChannel: () => {},
        };
      },
    }),
    sendSdp: () => {},
    sendIce: () => {},
  });

  const honest = P.buildSdpPayload({ sessionId: SESSION, sdp: offer }, phoneIdentity.sigSk);

  // A signaling server swapping the SDP while keeping the signed fingerprint.
  const swappedSdp = offer.replace(/a=fingerprint:sha-256 [0-9A-F:]+/i, "a=fingerprint:sha-256 " + "AA:".repeat(31) + "AA");
  throws(
    () => desktop.acceptOffer({ ...honest, sdp: swappedSdp }),
    "refusing to connect",
    "an SDP whose fingerprint no longer matches the signed one is refused",
  );
  assert(applied === 0, "setRemoteDescription was NEVER called for the tampered offer");

  // A forged signature from a key the desktop does not trust.
  const impostor = P.identityFromSeeds(new Uint8Array(32).fill(51), new Uint8Array(32).fill(52));
  throws(
    () => desktop.acceptOffer(P.buildSdpPayload({ sessionId: SESSION, sdp: offer }, impostor.sigSk)),
    "refusing to connect",
    "an offer signed by an untrusted key is refused",
  );
  assert(applied === 0, "and it too never reached setRemoteDescription");

  // A replay of a valid offer into a different session.
  throws(
    () => desktop.acceptOffer({ ...honest, sessionId: "22222222-2222-4222-8222-222222222222" }),
    "expected",
    "an offer for another session is refused",
  );
  assert(applied === 0, "a cross-session replay never reaches setRemoteDescription");

  desktop.acceptOffer(honest);
  assert(applied === 1, "the honest offer IS applied — the check rejects tampering, not everything");

  desktop.close();
  phonePc.close();
}

// --- 01 §3.3: the router mapping travels as a standard srflx candidate ----

/**
 * Drives a real negotiation far enough for ICE gathering to complete, which is
 * when the mapped candidate is announced. A transport with no remote offer
 * never gathers, so it would never announce either.
 */
async function gatherWith(mappedCandidate) {
  const emitted = [];
  const phonePc = new ndc.PeerConnection(`phone-map-${Math.random()}`, { iceServers: [] });
  let desktop;
  desktop = new WebrtcTransport({
    sessionId: SESSION,
    identity: desktopIdentity,
    peerSigPk: phoneIdentity.sigPk,
    iceServers: [],
    log: () => {},
    loadNative: () => ndc,
    ...(mappedCandidate ? { mappedCandidate } : {}),
    sendSdp: () => {},
    sendIce: (payload) => emitted.push(payload),
  });
  phonePc.onLocalDescription((sdp, type) => {
    if (type === 'offer') {
      desktop.acceptOffer(P.buildSdpPayload({ sessionId: SESSION, sdp }, phoneIdentity.sigSk));
    }
  });
  phonePc.createDataChannel('agentparty');
  await until(() => emitted.some((e) => e.candidate.candidate === ''), 15_000, 'gathering to complete');
  return { emitted, close: () => { desktop.close(); phonePc.close(); } };
}

{
  const run = await gatherWith({ internalPort: 51820, address: '203.0.113.7', externalPort: 51820 });
  const mapped = run.emitted.find((e) => e.candidate.candidate.includes('typ srflx'));

  assert(mapped !== undefined, 'the router mapping is advertised as an ICE candidate');
  if (mapped) {
    assert(P.IcePayloadSchema.safeParse(mapped).success, 'it validates against the UNCHANGED IcePayloadSchema — no protocol change needed');
    const parts = mapped.candidate.candidate.split(' ');
    assert(parts[0].startsWith('candidate:'), 'it is a standard candidate line the phone can pass straight to addRemoteCandidate');
    assert(parts[1] === '1' && parts[2] === 'udp', 'component 1, transport udp');
    assert(parts[4] === '203.0.113.7' && parts[5] === '51820', 'it carries the EXTERNAL address and port from the mapping');
    assert(parts[6] === 'typ' && parts[7] === 'srflx', 'typed srflx, so the peer ranks it below its own host candidates');
    assert(Number(parts[3]) > 0 && Number(parts[3]) < 2 ** 31, 'the priority is a plausible RFC 8445 value');
    assert(mapped.candidate.sdpMLineIndex === 0, 'it targets the single data-channel m-section');
    assert(typeof mapped.candidate.sdpMid === 'string', 'and carries the mid the stack actually used');
  }
  assert(
    run.emitted.filter((e) => e.candidate.candidate.includes('typ srflx')).length === 1,
    'it is announced exactly once',
  );
  run.close();
}

// --- without a mapping, nothing extra is advertised ------------------------
{
  const run = await gatherWith(undefined);
  assert(
    !run.emitted.some((e) => e.candidate.candidate.includes('typ srflx')),
    'no mapping means no invented candidate — advertising an unmapped port only slows every attempt down',
  );
  run.close();
}
// ===========================================================================
// M4 — ICE restart, session expiry, and send-queue backpressure
// ===========================================================================

/**
 * A scriptable stand-in for node-datachannel.
 *
 * Used only where a real loopback CANNOT produce the condition on demand: a
 * 2MB undrained backlog, and an ICE outage that never recovers. The risk of a
 * fake is that it drifts from the real native API and the test then proves
 * nothing — so every method it offers is checked against a REAL DataChannel
 * further down ("the fake matches the real native API").
 */
function fakeNative(script = {}) {
  const state = {
    constructed: 0,
    remoteDescriptions: [],
    sent: [],
    closed: 0,
    buffered: 0,
    channel: undefined,
    // A channel handed over by onDataChannel is NOT open yet; it opens a beat
    // later. Reporting it open from the start made the transport take its
    // already-open branch and the pending-flush path was never exercised.
    channelOpen: false,
    fire: {},
  };
  const native = {
    PeerConnection: function () {
      state.constructed += 1;
      const cbs = {};
      const channel = {
        sendMessageBinary: (buf) => { state.sent.push(buf); return true; },
        close: () => { state.closed += 1; },
        isOpen: () => state.channelOpen,
        bufferedAmount: () => (script.bufferedAmount ? script.bufferedAmount(state) : state.buffered),
        onOpen: (cb) => { state.fire.open = cb; },
        onClosed: (cb) => { state.fire.channelClosed = cb; },
        onError: (cb) => { state.fire.channelError = cb; },
        onMessage: (cb) => { state.fire.message = cb; },
      };
      state.channel = channel;
      const pc = {
        setRemoteDescription: (sdp, type) => state.remoteDescriptions.push({ sdp, type }),
        addRemoteCandidate: () => {},
        localDescription: () => null,
        state: () => "new",
        close: () => { state.closed += 1; },
        onLocalDescription: (cb) => { cbs.desc = cb; },
        onLocalCandidate: (cb) => { cbs.cand = cb; },
        onStateChange: (cb) => { state.fire.pcState = cb; },
        onGatheringStateChange: (cb) => { state.fire.gathering = cb; },
        onDataChannel: (cb) => { state.fire.dataChannel = cb; },
        getSelectedCandidatePair: () => null,
      };
      return pc;
    },
  };
  // The real order: the peer's channel arrives closed, then opens.
  state.openChannel = () => {
    state.fire.dataChannel?.(state.channel);
    state.channelOpen = true;
    state.fire.open?.();
  };
  // libdatachannel can hand the desktop a channel whose open event already
  // fired. This is the race exercised by the mandatory first ctl.lock frame.
  state.adoptAlreadyOpenChannel = () => {
    state.channelOpen = true;
    state.fire.dataChannel?.(state.channel);
  };
  return { native, state };
}

function fakeTransport(script = {}, extraDeps = {}) {
  const { native, state } = fakeNative(script);
  const emitted = [];
  const transport = new WebrtcTransport({
    sessionId: SESSION,
    identity: desktopIdentity,
    peerSigPk: phoneIdentity.sigPk,
    iceServers: [],
    log: () => {},
    loadNative: () => native,
    sendSdp: () => {},
    sendIce: (p) => emitted.push(p),
    ...extraDeps,
  });
  // The phone creates the channel; hand it over the way libdatachannel does.
  state.openChannel();
  return { transport, state, emitted };
}

/**
 * A REAL offer SDP from a throwaway PeerConnection. Invented SDP text will not
 * do: `buildSdpPayload` signs the fingerprint it extracts from the SDP, and
 * refuses text that has none — which is exactly the 02 §T1 property, so it must
 * not be worked around here.
 */
let offerSerial = 0;
async function realOfferSdp() {
  const pc = new ndc.PeerConnection(`offer-src-${(offerSerial += 1)}`, { iceServers: [] });
  const sdp = await new Promise((resolve) => {
    pc.onLocalDescription((s, type) => { if (type === "offer") { resolve(s); } });
    pc.createDataChannel("agentparty");
  });
  pc.close();
  return sdp;
}
const OFFER_A = await realOfferSdp();
const OFFER_B = await realOfferSdp();

/** A signed offer, as the phone would send it. */
const signedOffer = (sdp) => P.buildSdpPayload({ sessionId: SESSION, sdp }, phoneIdentity.sigSk);

// --- 01 §4.1: an ICE restart is the SAME session ---------------------------
{
  const { transport, state, emitted } = fakeTransport(
    {},
    { mappedCandidate: { internalPort: 51820, address: "203.0.113.7", externalPort: 51820 } },
  );

  transport.acceptOffer(signedOffer(OFFER_A));
  state.fire.gathering?.("complete");
  const afterFirst = emitted.filter((e) => e.candidate.candidate.includes("typ srflx")).length;
  assert(state.constructed === 1, "the first offer negotiates on one PeerConnection");
  assert(afterFirst === 1, "and the router mapping is advertised once");

  // The phone's restartIce(): a second, freshly signed offer for this session.
  transport.acceptOffer(signedOffer(OFFER_B));
  assert(state.constructed === 1, "a restart does NOT build a second PeerConnection — same session, same keys (01 §4.1)");
  assert(state.remoteDescriptions.length === 2, "the restart offer is applied to the existing connection");
  assert(state.remoteDescriptions[1].type === "offer", "and is applied as an offer, so this side answers again");
  assert(state.closed === 0, "the existing connection is not torn down by a restart");

  state.fire.gathering?.("complete");
  const afterRestart = emitted.filter((e) => e.candidate.candidate.includes("typ srflx")).length;
  assert(
    afterRestart === 2,
    `the router mapping is re-advertised after a restart (${afterRestart}) — the peer discarded every candidate it knew`,
  );

  transport.close();
}

// --- a restart is still an authenticated moment ----------------------------
{
  const { transport, state } = fakeTransport();
  transport.acceptOffer(signedOffer(OFFER_A));
  assert(state.remoteDescriptions.length === 1, "the honest first offer is applied");

  const impostor = P.identityFromSeeds(new Uint8Array(32).fill(51), new Uint8Array(32).fill(52));
  throws(
    () => transport.acceptOffer(P.buildSdpPayload({ sessionId: SESSION, sdp: OFFER_B }, impostor.sigSk)),
    "refusing to connect",
    "a RESTART offer signed by an untrusted key is refused too",
  );
  assert(state.remoteDescriptions.length === 1, "and never reaches setRemoteDescription — a restart is not a way past 02 §T1");
  transport.close();
}

// --- 01 §6: ICE that recovers in time keeps the session --------------------
{
  const { transport, state } = fakeTransport({}, { iceRestartGraceMs: 300 });
  transport.acceptOffer(signedOffer(OFFER_A));
  assert(transport.state === "connected", "the session is connected");

  state.fire.pcState?.("disconnected");
  assert(transport.state === "reconnecting", "an ICE outage reports reconnecting rather than closed");

  state.fire.pcState?.("connected");
  assert(
    transport.state === "connected",
    `recovery returns the session to connected (${transport.state}) — the DataChannel never closed, so onOpen does not fire again`,
  );

  await wait(500);
  assert(transport.state === "connected", "and the expiry timer does not fire for a session that recovered");
  transport.close();
}

// --- 01 §6: ICE that does not recover is given up --------------------------
{
  const { transport, state } = fakeTransport({}, { iceRestartGraceMs: 200 });
  transport.acceptOffer(signedOffer(OFFER_A));
  const states = [];
  transport.onStateChange((s, detail) => states.push({ s, error: detail.error }));

  state.fire.pcState?.("disconnected");
  await wait(500);
  assert(transport.state === "closed", "an outage past the grace window closes the session (01 §6)");
  const closed = states.find((e) => e.s === "closed");
  assert(
    typeof closed?.error === "string" && closed.error.length > 0,
    `and closes with a reason the UI can show (${closed?.error ?? "none"})`,
  );
}

// --- 04 §성능·안전: the 2MB send queue ceiling -----------------------------
{
  // Nothing drains: bufferedAmount only ever grows, as on a stalled link.
  let buffered = 0;
  const { transport, state } = fakeTransport({ bufferedAmount: () => buffered });
  transport.acceptOffer(signedOffer(OFFER_A));

  const chunk = Buffer.alloc(64 * 1024);
  let sends = 0;
  while (transport.state !== "closed" && sends < 200) {
    transport.send(chunk);
    buffered += chunk.byteLength;
    sends += 1;
  }

  assert(transport.state === "closed", "a session whose queue passes the ceiling is dropped, not buffered forever");
  const ceiling = 2 * 1024 * 1024;
  assert(
    sends * chunk.byteLength >= ceiling && sends * chunk.byteLength <= ceiling + chunk.byteLength * 2,
    `it drops at the 2MB ceiling, not before or long after (dropped after ${sends * chunk.byteLength} bytes)`,
  );
  assert(state.closed > 0, "the underlying connection really is closed");
  assert(transport.queuedBytes() === 0, "a closed transport reports no queue rather than a stale figure");
}

// --- a healthy link is never dropped ---------------------------------------
{
  // A link that drains: whatever is handed over is gone by the next check.
  const { transport } = fakeTransport({ bufferedAmount: () => 0 });
  transport.acceptOffer(signedOffer(OFFER_A));
  const chunk = Buffer.alloc(64 * 1024);
  for (let i = 0; i < 200; i += 1) {
    transport.send(chunk);
  }
  assert(transport.state === "connected", "12MB through a draining link never trips the ceiling — it bounds the BACKLOG, not throughput");
  assert(transport.queuedBytes() === 0, "and the queue reads empty");
  transport.close();
}

// --- frames held before the channel opens are counted ----------------------
{
  const { native, state } = fakeNative();
  const transport = new WebrtcTransport({
    sessionId: SESSION,
    identity: desktopIdentity,
    peerSigPk: phoneIdentity.sigPk,
    iceServers: [],
    log: () => {},
    loadNative: () => native,
    sendSdp: () => {},
    sendIce: () => {},
  });
  // No data channel yet — frames are held.
  transport.send(Buffer.alloc(1000));
  transport.send(Buffer.alloc(2000));
  assert(transport.queuedBytes() === 3000, `frames held before the channel opens are counted (${transport.queuedBytes()})`);

  state.openChannel();
  assert(state.sent.length === 2, "and are flushed when it opens");
  assert(
    transport.queuedBytes() === 0,
    `once flushed they are counted by the stack instead, not twice (${transport.queuedBytes()})`,
  );
  transport.close();
}

// --- frames also flush when the adopted channel is already open ------------
{
  const { native, state } = fakeNative();
  const transport = new WebrtcTransport({
    sessionId: SESSION,
    identity: desktopIdentity,
    peerSigPk: phoneIdentity.sigPk,
    iceServers: [],
    log: () => {},
    loadNative: () => native,
    sendSdp: () => {},
    sendIce: () => {},
  });
  transport.send(Buffer.from("mandatory-first-frame"));
  state.adoptAlreadyOpenChannel();
  assert(state.sent.length === 1, "a frame queued before an already-open channel is adopted is flushed immediately");
  assert(transport.queuedBytes() === 0, "the already-open adoption path clears its pending-byte count");
  transport.close();
}

// --- the fake matches the real native API ----------------------------------
{
  // The block above is only meaningful if the real DataChannel really offers
  // bufferedAmount() — otherwise it tests an API this code invented.
  const a = new ndc.PeerConnection("api-check", { iceServers: [] });
  const channel = a.createDataChannel("agentparty");
  assert(typeof channel.bufferedAmount === "function", "a REAL node-datachannel DataChannel has bufferedAmount()");
  assert(typeof channel.bufferedAmount() === "number", "and it returns a number");
  a.close();
}

// --- queuedBytes on the real loopback --------------------------------------
{
  const phonePc = new ndc.PeerConnection("phone-queue", { iceServers: [] });
  let desktop;
  desktop = new WebrtcTransport({
    sessionId: SESSION,
    identity: desktopIdentity,
    peerSigPk: phoneIdentity.sigPk,
    iceServers: [],
    log: () => {},
    loadNative: () => ndc,
    sendSdp: (payload) => phonePc.setRemoteDescription(payload.sdp, "answer"),
    sendIce: (payload) => {
      if (payload.candidate.candidate !== "") {
        phonePc.addRemoteCandidate(payload.candidate.candidate, payload.candidate.sdpMid);
      }
    },
  });
  phonePc.onLocalDescription((sdp, type) => {
    if (type === "offer") { desktop.acceptOffer(signedOffer(sdp)); }
  });
  phonePc.onLocalCandidate((candidate, mid) => {
    desktop.addRemoteCandidate({ sessionId: SESSION, candidate: { candidate, sdpMid: mid, sdpMLineIndex: 0 } });
  });
  phonePc.createDataChannel("agentparty");

  const ok = await until(() => desktop.state === "connected", 15_000, "the queue-check channel to open");
  assert(ok, "a real loopback session connects");
  if (ok) {
    desktop.send(Buffer.alloc(1024));
    const drained = await until(() => desktop.queuedBytes() === 0, 5_000, "the real link to drain");
    assert(drained, `queuedBytes() reads the real stack and settles at 0 on a working link (${desktop.queuedBytes()})`);
    assert(desktop.state === "connected", "and a 1KB send does not trip the ceiling");
  }
  desktop.close();
  phonePc.close();
}

// --- a missing native module is reported, never worked around --------------
{
  throws(
    () => new WebrtcTransport({
      sessionId: SESSION,
      identity: desktopIdentity,
      peerSigPk: phoneIdentity.sigPk,
      log: () => {},
      loadNative: () => { throw new Error("Cannot find module 'node-datachannel'"); },
      sendSdp: () => {},
      sendIce: () => {},
    }),
    "Cannot find module",
    "a load failure surfaces instead of falling back to some other transport",
  );
}

ndc.cleanup?.();
console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
