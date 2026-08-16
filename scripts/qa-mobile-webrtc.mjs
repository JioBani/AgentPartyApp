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
  }

  desktop.close("test over");
  assert(desktop.state === "closed", "close() moves the transport to closed");
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
