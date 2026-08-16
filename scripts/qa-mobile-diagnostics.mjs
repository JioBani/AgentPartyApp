/*
 * NAT diagnostics test (04 §NAT 매핑·진단).
 *
 * Two halves, because they fail differently:
 *
 *   - the verdict rules are pure and are asserted exhaustively against
 *     synthetic observations. A wrong rule tells the user "your router blocks
 *     P2P" when it does not, which is worse than saying nothing.
 *   - the STUN client is exercised against REAL public servers, because the
 *     thing that actually breaks is byte-level parsing of a real answer. That
 *     half needs the network, so it reports a loud SKIP when UDP cannot get
 *     out rather than failing the suite on someone's firewall.
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

const D = await load("src/main/mobile/diagnostics.ts", "diagnostics.mjs");
const S = await load("src/main/mobile/stun.ts", "stun.mjs");

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

console.log("Address classification:");
{
  for (const address of ["10.0.0.1", "172.16.3.4", "172.31.255.254", "192.168.1.1", "169.254.1.1", "127.0.0.1"]) {
    assert(D.isPrivateV4(address), `${address} is private`);
  }
  for (const address of ["172.15.0.1", "172.32.0.1", "8.8.8.8", "203.0.113.7", "100.63.0.1", "100.128.0.1"]) {
    assert(!D.isPrivateV4(address), `${address} is not private`);
  }
  assert(D.isCgnat("100.64.0.1") && D.isCgnat("100.127.255.254"), "the CGNAT range is 100.64/10");
  assert(!D.isCgnat("100.63.255.255") && !D.isCgnat("100.128.0.0"), "and its edges are exclusive");
  assert(!D.isPrivateV4("not.an.address"), "a malformed address is not reported as private");
}

console.log("\nVerdict rules:");
{
  // A fake STUN server lets the whole probe run without the network, so the
  // reason rules are exercised end to end rather than in isolation.
  const dgram = await import("node:dgram");

  async function fakeStun(reply) {
    const socket = dgram.createSocket("udp4");
    await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
    socket.on("message", (message, remote) => {
      const transactionId = message.subarray(8, 20);
      const { address, port } = reply(remote);
      const octets = address.split(".").map(Number);
      const value = Buffer.alloc(8);
      value.writeUInt8(0, 0);
      value.writeUInt8(1, 1);
      value.writeUInt16BE(port ^ 0x2112, 2);
      const cookie = Buffer.from([0x21, 0x12, 0xa4, 0x42]);
      for (let i = 0; i < 4; i += 1) { value.writeUInt8(octets[i] ^ cookie[i], 4 + i); }
      const response = Buffer.alloc(20 + 4 + value.length);
      response.writeUInt16BE(0x0101, 0);
      response.writeUInt16BE(4 + value.length, 2);
      response.writeUInt32BE(0x2112a442, 4);
      transactionId.copy(response, 8);
      response.writeUInt16BE(0x0020, 20);
      response.writeUInt16BE(value.length, 22);
      value.copy(response, 24);
      socket.send(response, remote.port, remote.address);
    });
    return { port: socket.address().port, close: () => socket.close() };
  }

  async function diagnose(reply, extra = {}) {
    const a = await fakeStun(reply);
    const b = await fakeStun(reply);
    try {
      const probe = new D.NatDiagnosticsProbe({
        log: () => {},
        stunServers: [`127.0.0.1:${a.port}`, `127.0.0.1:${b.port}`],
        timeoutMs: 2_000,
        ...extra,
      });
      return await probe.run();
    } finally {
      a.close();
      b.close();
    }
  }

  const stable = await diagnose(() => ({ address: "203.0.113.7", port: 40000 }));
  assert(stable.mappingKind === "endpointIndependent", "the same reflexive port to both servers is endpoint-independent");
  assert(stable.reason === "ok_direct", "endpoint-independent mapping on a public address reads as ok_direct");
  assert(stable.wanAddress === "203.0.113.7", "the reflexive address is reported");
  assert(stable.wanIsPrivate === false, "a public address is not flagged private");
  assert(stable.probes.filter((p) => p.name.startsWith("stun:") && p.ok).length === 2, "both probes are recorded as successful");

  let port = 40000;
  const symmetric = await diagnose(() => ({ address: "203.0.113.7", port: port++ }));
  assert(symmetric.mappingKind === "portDependent", "a different port per destination is port-dependent");
  assert(symmetric.reason === "symmetric_nat", "port-dependent mapping reads as symmetric_nat");

  const cgnat = await diagnose(() => ({ address: "100.90.1.2", port: 40000 }));
  assert(cgnat.reason === "cgnat_100_64", "a CGNAT reflexive address wins over the mapping verdict");

  const privateWan = await diagnose(() => ({ address: "192.168.8.8", port: 40000 }));
  assert(privateWan.reason === "private_wan", "a private reflexive address means another NAT upstream");

  const doubleNat = await diagnose(() => ({ address: "203.0.113.7", port: 40000 }), {
    portMapping: () => ({
      protocol: "udp",
      internalPort: 51820,
      externalPort: 51820,
      externalAddress: "192.168.1.50",
      via: "upnp",
      expiresAt: 0,
    }),
  });
  assert(doubleNat.reason === "double_nat", "a mapping on an address the world cannot see is double NAT");
  assert(doubleNat.portMapping?.via === "upnp", "the mapping result is carried into the report");

  // Nothing answers: the probe must still return a verdict and say why.
  const dead = new D.NatDiagnosticsProbe({ log: () => {}, stunServers: ["127.0.0.1:1"], timeoutMs: 300 });
  const blocked = await dead.run();
  assert(blocked.mappingKind === "blocked", "no answer at all is reported as blocked");
  assert(["unknown", "ipv6_only"].includes(blocked.reason), "and yields a verdict rather than throwing");
  assert(blocked.errors.length > 0, "the failure is surfaced in errors, not swallowed");
  assert(blocked.probes.some((p) => !p.ok), "the failed probe is listed with its reason");

  // Concurrent callers share one run.
  const shared = new D.NatDiagnosticsProbe({ log: () => {}, stunServers: ["127.0.0.1:1"], timeoutMs: 300 });
  const [first, second] = await Promise.all([shared.run(), shared.run()]);
  assert(first === second, "concurrent runs share one probe instead of doubling STUN load");
}

console.log("\nReal STUN servers:");
{
  let reachable = false;
  try {
    const result = await S.stunProbe({ server: "stun.l.google.com:19302", timeoutMs: 4_000 });
    reachable = true;
    assert(/^\d+\.\d+\.\d+\.\d+$/.test(result.address), `a real STUN answer parses to an IPv4 address (${result.address})`);
    assert(result.port > 0 && result.port < 65536, `and a plausible port (${result.port})`);
    assert(result.family === 4, "the family is reported");
  } catch (error) {
    console.log(`  ! SKIPPED: no UDP answer from a public STUN server — parsing is UNVERIFIED. (${String(error.message).slice(0, 80)})`);
  }
  if (reachable) {
    const probe = new D.NatDiagnosticsProbe({ log: () => {}, timeoutMs: 4_000 });
    const real = await probe.run();
    assert(real.probes.length >= 3, "the real run records both STUN probes and the interface scan");
    assert(typeof real.reason === "string", `a real network yields a verdict (${real.reason}, mapping=${real.mappingKind})`);
    assert(real.wanAddress !== undefined, `and a reflexive address (${real.wanAddress})`);
  }
}

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
