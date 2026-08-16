/*
 * Long-run soak for the mobile pipe (04 — 게이트웨이 장기 실행 안정성).
 *
 * What this measures: whether repeatedly building and tearing down phone
 * sessions leaks. Each cycle is a REAL one — a real node-datachannel
 * PeerConnection pair negotiating over loopback, a real X25519/XChaCha20
 * secure session on both ends, real RPC envelopes and real event delivery —
 * so native handles, session keys and buffers are all genuinely allocated and
 * released. A cycle built out of mocks would allocate nothing worth watching.
 *
 * What it does NOT cover, and why it is not claimed:
 *   - the real signaling server (sessions here are wired in loopback)
 *   - a real phone and real network transitions
 *   - the Electron process
 * Those are device tests. This answers one question: does the pipe survive
 * thousands of session lifetimes without growing.
 *
 * Usage:
 *   node scripts/qa-mobile-soak.mjs --hours 24
 *   node scripts/qa-mobile-soak.mjs --minutes 5 --out .qa/soak.jsonl
 *
 * Exit code is non-zero if growth exceeds the thresholds below, so this can be
 * run unattended and its result trusted without reading the log.
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

// --- options ---------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const hours = Number(opt("hours", 0));
const minutes = Number(opt("minutes", 0));
const durationMs = hours > 0 || minutes > 0 ? (hours * 60 + minutes) * 60_000 : 24 * 3_600_000;
const sampleEveryMs = Number(opt("sample", 60)) * 1_000;
const outPath = path.resolve(opt("out", ".qa/mobile-soak.jsonl"));
mkdirSync(path.dirname(outPath), { recursive: true });

/**
 * Growth thresholds. A soak that only prints numbers gets skimmed and believed;
 * these make it pass or fail on its own.
 */
const LIMITS = {
  /** Bytes of RSS growth per completed session cycle, averaged over the run. */
  rssPerCycle: 8 * 1024,
  /** Heap growth from the first steady-state sample to the last. */
  heapGrowthRatio: 2.0,
  /** Native handles must not accumulate at all. */
  maxHandleGrowth: 64,
};

// --- load the real modules -------------------------------------------------
const outDir = qaTempDir();
const bundle = async (entry, file) => {
  const r = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["@agentparty/protocol", "node-datachannel", "ws"],
    write: false,
  });
  const p = path.join(outDir, file);
  writeFileSync(p, r.outputFiles[0].text);
  return import(pathToFileURL(p).href);
};

const { WebrtcTransport } = await bundle("src/main/mobile/webrtcTransport.ts", "soak-transport.mjs");
const { SecureSession, newSessionEphemeral } = await bundle("src/main/mobile/secureSession.ts", "soak-secure.mjs");
const { EventBridge } = await bundle("src/main/mobile/eventBridge.ts", "soak-bridge.mjs");
const P = await import("@agentparty/protocol");

let ndc;
try {
  const loaded = await import("node-datachannel");
  ndc = loaded.default ?? loaded;
} catch (error) {
  // Loud, and a failure: a soak that silently measured nothing is worse than
  // no soak, because its "pass" would be quoted later.
  console.error(`FAILED: node-datachannel is not installed — nothing to soak. (${String(error?.message ?? error)})`);
  process.exit(1);
}
await P.sodiumReady();

const desktop = P.identityFromSeeds(new Uint8Array(32).fill(41), new Uint8Array(32).fill(42));
const phone = P.identityFromSeeds(new Uint8Array(32).fill(43), new Uint8Array(32).fill(44));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

/**
 * One complete session lifetime: negotiate, derive keys both ways, exchange
 * encrypted RPC traffic, then tear down. Returns false if the cycle could not
 * complete, which the caller counts as a failure rather than skipping.
 */
let cycleSerial = 0;
async function sessionCycle() {
  const id = `soak-${(cycleSerial += 1)}`;
  const sessionId = "11111111-1111-4111-8111-" + String(cycleSerial % 1_000_000).padStart(12, "0");
  const phonePc = new ndc.PeerConnection(`phone-${id}`, { iceServers: [] });
  const bridge = new EventBridge({ bootId: id });

  // Both ends' ephemeral keys, as 01 §4.1 pairs them.
  const deskEph = newSessionEphemeral();
  const phoneEph = newSessionEphemeral();

  let transport;
  let secure;
  const decoded = [];
  let phoneChannel;

  try {
    transport = new WebrtcTransport({
      sessionId,
      identity: desktop,
      peerSigPk: phone.sigPk,
      iceServers: [],
      log: () => {},
      loadNative: () => ndc,
      sendSdp: (payload) => {
        P.verifySdpPayload(payload, desktop.sigPk);
        phonePc.setRemoteDescription(payload.sdp, "answer");
      },
      sendIce: (payload) => {
        if (payload.candidate.candidate !== "") {
          phonePc.addRemoteCandidate(payload.candidate.candidate, payload.candidate.sdpMid);
        }
      },
    });

    secure = new SecureSession({
      transport,
      role: "server",
      ownEph: deskEph,
      peerEphPk: phoneEph.publicKey,
      log: () => {},
      onPayload: (p) => decoded.push(p),
      onFatal: () => {},
    });

    phonePc.onLocalDescription((sdp, type) => {
      if (type === "offer") {
        transport.acceptOffer(P.buildSdpPayload({ sessionId, sdp }, phone.sigSk));
      }
    });
    phonePc.onLocalCandidate((candidate, mid) => {
      transport.addRemoteCandidate({ sessionId, candidate: { candidate, sdpMid: mid, sdpMLineIndex: 0 } });
    });

    // The phone's side of the secure session, so frames are really decrypted.
    const phoneSession = new P.SecureSession(
      "client",
      P.deriveSessionKeys("client", phoneEph.publicKey, phoneEph.privateKey, deskEph.publicKey),
    );
    phoneChannel = phonePc.createDataChannel("agentparty");
    const fromDesktop = [];
    phoneChannel.onMessage((m) => {
      if (typeof m === "string") return;
      fromDesktop.push(phoneSession.openJson(new Uint8Array(m)));
    });

    if (!(await until(() => transport.state === "connected", 20_000))) {
      return { ok: false, reason: "never connected" };
    }

    // Real encrypted traffic in both directions, including events through the
    // bridge — the per-session objects that actually accumulate.
    bridge.attach({ sessionId, deliver: () => {} });
    for (let n = 0; n < 5; n += 1) {
      secure.send({ k: "res", id: `r${n}`, ok: true, p: { n, pad: "x".repeat(256) } });
      bridge.publish("session:events", { n }, "C:/w");
      phoneChannel.sendMessageBinary(phoneSession.sealJson({ k: "req", id: `q${n}`, m: "sys.ping", p: {} }));
    }
    if (!(await until(() => fromDesktop.length >= 5 && decoded.length >= 5, 10_000))) {
      return { ok: false, reason: `traffic did not round trip (desktop->phone ${fromDesktop.length}, phone->desktop ${decoded.length})` };
    }

    bridge.detach(sessionId);
    return { ok: true };
  } finally {
    try { secure?.close(); } catch { /* teardown must not mask the result */ }
    try { transport?.close("soak cycle over"); } catch { /* as above */ }
    try { phonePc.close(); } catch { /* as above */ }
  }
}

// --- sampling ---------------------------------------------------------------
function sample(cycles, failures) {
  const mem = process.memoryUsage();
  return {
    t: new Date().toISOString(),
    cycles,
    failures,
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    external: mem.external,
    // Native PeerConnections show up here; a leak of them is invisible in heap.
    handles: process._getActiveHandles?.().length ?? -1,
    requests: process._getActiveRequests?.().length ?? -1,
  };
}

const started = Date.now();
const deadline = started + durationMs;
const samples = [];
let cycles = 0;
let failures = 0;
const failureReasons = new Map();

console.log(`mobile pipe soak: ${(durationMs / 3_600_000).toFixed(2)}h, sampling every ${sampleEveryMs / 1000}s`);
console.log(`log: ${outPath}`);

let nextSample = Date.now();
while (Date.now() < deadline) {
  const result = await sessionCycle();
  cycles += 1;
  if (!result.ok) {
    failures += 1;
    failureReasons.set(result.reason, (failureReasons.get(result.reason) ?? 0) + 1);
    console.log(`  cycle ${cycles} FAILED: ${result.reason}`);
  }

  if (Date.now() >= nextSample) {
    if (global.gc) global.gc();
    const s = sample(cycles, failures);
    samples.push(s);
    appendFileSync(outPath, `${JSON.stringify(s)}\n`);
    const mins = ((Date.now() - started) / 60_000).toFixed(1);
    console.log(
      `  [${mins}m] cycles=${cycles} fail=${failures} rss=${(s.rss / 1e6).toFixed(1)}MB ` +
        `heap=${(s.heapUsed / 1e6).toFixed(1)}MB handles=${s.handles}`,
    );
    nextSample = Date.now() + sampleEveryMs;
  }
}

// --- verdict ----------------------------------------------------------------
// The first sample is taken while the process is still warming up, so growth is
// measured from the second one where there is more than one.
const baseline = samples[samples.length > 1 ? 1 : 0];
const last = samples[samples.length - 1];
const problems = [];

if (!baseline || !last || samples.length < 2) {
  problems.push(`too few samples to judge growth (${samples.length}) — run longer than the sample interval`);
} else {
  const cyclesBetween = Math.max(1, last.cycles - baseline.cycles);
  const rssPerCycle = (last.rss - baseline.rss) / cyclesBetween;
  const heapRatio = last.heapUsed / Math.max(1, baseline.heapUsed);
  const handleGrowth = last.handles - baseline.handles;

  console.log("\nresult:");
  console.log(`  cycles completed : ${cycles} (${failures} failed)`);
  console.log(`  rss / cycle      : ${rssPerCycle.toFixed(0)} B (limit ${LIMITS.rssPerCycle})`);
  console.log(`  heap growth      : ${heapRatio.toFixed(2)}x (limit ${LIMITS.heapGrowthRatio}x)`);
  console.log(`  handle growth    : ${handleGrowth} (limit ${LIMITS.maxHandleGrowth})`);

  if (rssPerCycle > LIMITS.rssPerCycle) problems.push(`RSS grows ${rssPerCycle.toFixed(0)}B per session cycle`);
  if (heapRatio > LIMITS.heapGrowthRatio) problems.push(`heap grew ${heapRatio.toFixed(2)}x`);
  if (handleGrowth > LIMITS.maxHandleGrowth) problems.push(`${handleGrowth} native handles accumulated`);
}
if (failures > 0) {
  problems.push(`${failures}/${cycles} session cycles failed: ${[...failureReasons].map(([r, n]) => `${r} x${n}`).join("; ")}`);
}

ndc.cleanup?.();
console.log(problems.length ? `\nFAILED\n  - ${problems.join("\n  - ")}` : "\nAll assertions passed");
process.exit(problems.length ? 1 : 0);
