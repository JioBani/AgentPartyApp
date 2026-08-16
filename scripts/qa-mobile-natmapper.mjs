/*
 * NatMapper test (04 §NAT 매핑·진단).
 *
 * A port mapping is a best-effort optimisation: with endpoint-independent NAT
 * the connection already works without one. So the properties that matter are
 * not "does it map" but "does a failure stay non-fatal, is the reason kept, and
 * is the port released when nothing needs it" (02 §T6). Those are asserted
 * against protocol doubles.
 *
 * The wire encoders for NAT-PMP and PCP are checked byte by byte against the
 * RFCs, because a field at the wrong offset produces a silent refusal that
 * looks exactly like a router with the feature switched off.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import dgram from "node:dgram";
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

const { NatMapper } = await load("src/main/mobile/natMapper.ts", "natMapper.mjs");
const PM = await load("src/main/mobile/portMapping.ts", "portMapping.mjs");

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const router = { address: "192.168.1.1", localAddress: "192.168.1.50", controlUrl: "http://192.168.1.1/ctl", serviceType: "urn:x" };

function clock() {
  let now = 1_000_000, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const target = now + ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= target) { timers.delete(id); now = t.at; t.fn(); }
      }
      now = target;
    },
  };
}

const protocolDouble = (via, behaviour) => {
  const calls = { map: 0, unmap: 0 };
  return {
    calls,
    via,
    map: async (request) => { calls.map += 1; return behaviour(request, calls.map); },
    unmap: async () => { calls.unmap += 1; },
  };
};

console.log("NatMapper behaviour:");

// --- a router that answers --------------------------------------------------
{
  const time = clock();
  const upnp = protocolDouble("upnp", (request) => ({
    externalPort: request.internalPort,
    externalAddress: "203.0.113.7",
    lifetimeSeconds: 3600,
    via: "upnp",
  }));
  const mapper = new NatMapper({
    log: () => {}, port: 51820, protocols: [upnp],
    discover: async () => router, ...time,
  });

  const mapping = await mapper.start();
  assert(mapping?.externalPort === 51820, "a granted mapping is returned");
  assert(mapping?.via === "upnp", "the protocol that succeeded is recorded");
  assert(mapping?.externalAddress === "203.0.113.7", "the router's WAN address is carried through for diagnostics");
  assert(mapping?.expiresAt === time.now() + 3_600_000, "expiry is derived from the granted lifetime, not the requested one");
  assert(mapper.current() === mapping, "current() exposes it to diagnostics");

  // 04: renew at half the lifetime.
  time.advance(1_799_000);
  assert(upnp.calls.map === 1, "no renewal before half the lease has passed");
  time.advance(2_000);
  assert(upnp.calls.map === 2, "the lease is renewed at half its lifetime");

  // stop() lands while the renewal above is still in flight. Both the committed
  // mapping and the one that arrives late must be released — a late arrival that
  // silently re-mapped the port would leave it open with nothing renewing it.
  await mapper.stop();
  assert(upnp.calls.unmap >= 1, "stop() releases the mapping");
  assert(mapper.current() === undefined, "and clears it");
  assert(upnp.calls.unmap === 2, "the renewal that completed after stop() is released too, not committed");
  time.advance(10_000_000);
  assert(upnp.calls.map === 2, "a stopped mapper stops renewing");
}

// --- protocols are tried in order, and every refusal is kept ----------------
{
  const time = clock();
  const pcp = protocolDouble("pcp", () => { throw new Error("PCP: router refused with result code 2"); });
  const pmp = protocolDouble("nat-pmp", () => { throw new Error("NAT-PMP: truncated answer"); });
  const upnp = protocolDouble("upnp", (request) => ({
    externalPort: request.internalPort, externalAddress: undefined, lifetimeSeconds: 600, via: "upnp",
  }));
  const mapper = new NatMapper({
    log: () => {}, port: 51820, protocols: [pcp, pmp, upnp],
    discover: async () => router, ...time,
  });

  const mapping = await mapper.start();
  assert(pcp.calls.map === 1 && pmp.calls.map === 1 && upnp.calls.map === 1, "each protocol is tried in turn");
  assert(mapping?.via === "upnp", "the first one that answers wins");
  const history = mapper.history();
  assert(history.some((a) => a.via === "pcp" && !a.ok && a.detail.includes("result code 2")), "PCP's refusal is kept verbatim");
  assert(history.some((a) => a.via === "nat-pmp" && !a.ok), "so is NAT-PMP's");
  assert(history.some((a) => a.via === "upnp" && a.ok), "and the success");
  assert(mapping?.externalAddress === undefined, "a protocol that reports no address leaves it undefined rather than guessing");
}

// --- nothing works: non-fatal, and the reason survives ----------------------
{
  const time = clock();
  const dead = protocolDouble("upnp", () => { throw new Error("UPnP AddPortMapping: error 718 (ConflictInMappingEntry)"); });
  const mapper = new NatMapper({ log: () => {}, port: 51820, protocols: [dead], discover: async () => router, ...time });

  const mapping = await mapper.start();
  assert(mapping === undefined, "a router that refuses yields no mapping — and does not throw");
  assert(mapper.current() === undefined, "nothing is reported as mapped");
  assert(mapper.history().some((a) => a.detail.includes("718")), "the router's own error code is what diagnostics can show");
  await mapper.stop();
  assert(dead.calls.unmap === 0, "there is nothing to release");
}

// --- no router at all -------------------------------------------------------
{
  const time = clock();
  const never = protocolDouble("upnp", () => { throw new Error("unreachable"); });
  const mapper = new NatMapper({ log: () => {}, port: 51820, protocols: [never], discover: async () => undefined, ...time });
  const mapping = await mapper.start();
  assert(mapping === undefined, "no SSDP answer yields no mapping");
  assert(never.calls.map === 0, "and no protocol is attempted without a router address");
  assert(mapper.history().some((a) => a.via === "discovery" && !a.ok), "discovery failure is recorded as its own step");
  assert(mapper.history()[0].detail.includes("UPnP"), "the reason names the likely cause for the user");
}

// --- discovery that throws is still non-fatal -------------------------------
{
  const time = clock();
  const mapper = new NatMapper({
    log: () => {}, port: 51820, protocols: [],
    discover: async () => { throw new Error("socket bind refused"); }, ...time,
  });
  assert((await mapper.start()) === undefined, "a throwing discovery does not propagate");
  assert(mapper.history().some((a) => a.detail.includes("bind refused")), "its cause is kept");
}
console.log("\nWire protocols, driven against stand-in routers:");

/** Answers on a local UDP port and keeps exactly what the protocol sent. */
async function fakeUdpRouter(reply) {
  const socket = dgram.createSocket("udp4");
  const received = [];
  await new Promise((r) => socket.bind(0, "127.0.0.1", r));
  socket.on("message", (message, remote) => {
    received.push(Buffer.from(message));
    const response = reply(Buffer.from(message));
    if (response) { socket.send(response, remote.port, remote.address); }
  });
  return { port: socket.address().port, received, close: () => socket.close() };
}

// --- NAT-PMP (RFC 6886 §3.3) -----------------------------------------------
{
  const fake = await fakeUdpRouter((request) => {
    const response = Buffer.alloc(16);
    response.writeUInt8(0, 0);
    response.writeUInt8(129, 1);              // 128 + opcode
    response.writeUInt16BE(0, 2);             // result code: success
    response.writeUInt32BE(12345, 4);
    response.writeUInt16BE(request.readUInt16BE(4), 8);
    response.writeUInt16BE(41000, 10);        // granted external port
    response.writeUInt32BE(1800, 12);         // granted lifetime
    return response;
  });
  const endpoint = { address: "127.0.0.1", localAddress: "127.0.0.1", pmpPort: fake.port };
  const result = await PM.natPmpProtocol.map({ internalPort: 51820, lifetimeSeconds: 3600, description: "x" }, endpoint);

  const sent = fake.received[0];
  assert(sent.length === 12, "the request this protocol actually sends is 12 bytes");
  assert(sent.readUInt8(0) === 0 && sent.readUInt8(1) === 1, "version 0, opcode 1 (map UDP)");
  assert(sent.readUInt16BE(4) === 51820, "the internal port sits at offset 4");
  assert(sent.readUInt16BE(6) === 51820, "the suggested external port at offset 6");
  assert(sent.readUInt32BE(8) === 3600, "the requested lifetime at offset 8");
  assert(result.externalPort === 41000, "the port the ROUTER granted is used, not the one requested");
  assert(result.lifetimeSeconds === 1800, "and the lifetime it granted, not the one requested");
  assert(result.via === "nat-pmp", "the result names the protocol");
  fake.close();
}

// --- NAT-PMP refusal --------------------------------------------------------
{
  const fake = await fakeUdpRouter(() => {
    const response = Buffer.alloc(16);
    response.writeUInt8(0, 0);
    response.writeUInt8(129, 1);
    response.writeUInt16BE(2, 2);   // 2 = network failure
    return response;
  });
  let message = "";
  try {
    await PM.natPmpProtocol.map({ internalPort: 51820, lifetimeSeconds: 60, description: "x" },
      { address: "127.0.0.1", localAddress: "127.0.0.1", pmpPort: fake.port });
  } catch (error) { message = error.message; }
  assert(message.includes("result code 2"), "a refusal carries the router's result code, not a generic failure");
  fake.close();
}

// --- PCP (RFC 6887 §11.1) ---------------------------------------------------
{
  const fake = await fakeUdpRouter((request) => {
    const response = Buffer.alloc(60);
    response.writeUInt8(2, 0);
    response.writeUInt8(0x81, 1);
    response.writeUInt8(0, 3);                 // result code: success
    response.writeUInt32BE(1200, 4);           // granted lifetime
    request.copy(response, 24, 24, 36);        // echo the nonce
    response.writeUInt16BE(request.readUInt16BE(40), 40);
    response.writeUInt16BE(42000, 42);         // assigned external port
    response.writeUInt16BE(0xffff, 54);        // v4-mapped marker at 44+10
    Buffer.from([203, 0, 113, 9]).copy(response, 56);
    return response;
  });
  const result = await PM.pcpProtocol.map({ internalPort: 51820, lifetimeSeconds: 3600, description: "x" },
    { address: "127.0.0.1", localAddress: "192.168.1.50", pmpPort: fake.port });

  const sent = fake.received[0];
  assert(sent.length === 60, "the PCP request this protocol sends is 60 bytes");
  assert(sent.readUInt8(0) === 2, "version 2 — version 0 would be parsed as NAT-PMP");
  assert(sent.readUInt8(1) === 1, "opcode 1 (MAP)");
  assert(sent.readUInt32BE(4) === 3600, "the requested lifetime sits at offset 4");
  assert(sent.readUInt16BE(18) === 0xffff && [...sent.subarray(20, 24)].join(".") === "192.168.1.50",
    "the client address is v4-mapped into the header");
  assert(sent.readUInt8(36) === 17, "the protocol byte is 17 (UDP)");
  assert(sent.readUInt16BE(40) === 51820, "the internal port sits at offset 40");
  assert(result.externalPort === 42000, "the external port the router assigned is used");
  assert(result.externalAddress === "203.0.113.9", "the v4-mapped external address is decoded");
  assert(result.lifetimeSeconds === 1200, "the granted lifetime is used");
  fake.close();
}

// --- truncated answers are rejected, never read past their end -------------
{
  const shortPmp = await fakeUdpRouter(() => Buffer.alloc(4));
  let pmpError = "";
  try {
    await PM.natPmpProtocol.map({ internalPort: 1, lifetimeSeconds: 1, description: "x" },
      { address: "127.0.0.1", localAddress: "127.0.0.1", pmpPort: shortPmp.port });
  } catch (error) { pmpError = error.message; }
  assert(pmpError.includes("truncated"), "a short NAT-PMP answer is rejected");
  shortPmp.close();

  const shortPcp = await fakeUdpRouter(() => Buffer.alloc(8));
  let pcpError = "";
  try {
    await PM.pcpProtocol.map({ internalPort: 1, lifetimeSeconds: 1, description: "x" },
      { address: "127.0.0.1", localAddress: "127.0.0.1", pmpPort: shortPcp.port });
  } catch (error) { pcpError = error.message; }
  assert(pcpError.includes("truncated"), "and so is a short PCP answer");
  shortPcp.close();
}

// --- a router that never answers -------------------------------------------
{
  let message = "";
  try {
    await PM.natPmpProtocol.map({ internalPort: 1, lifetimeSeconds: 1, description: "x" },
      { address: "127.0.0.1", localAddress: "127.0.0.1", pmpPort: 1 });
  } catch (error) { message = error.message; }
  assert(/did not answer within/.test(message), "silence times out with a message naming the endpoint");
}

// --- exports ----------------------------------------------------------------
{
  assert(typeof PM.discoverRouter === "function", "discovery is exported for the mapper");
  assert(PM.upnpProtocol.via === "upnp" && PM.natPmpProtocol.via === "nat-pmp" && PM.pcpProtocol.via === "pcp",
    "all three protocols are exported and self-identify");
  let refused = "";
  try { await PM.upnpProtocol.map({ internalPort: 1, lifetimeSeconds: 1, description: "x" }, { address: "1.2.3.4", localAddress: "1.2.3.5" }); }
  catch (error) { refused = error.message; }
  assert(refused.includes("no WAN connection service"), "UPnP without a control URL fails with a specific reason");
}

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
