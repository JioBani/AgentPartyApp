/*
 * Engine → desktop reverse RPC.
 *
 * The engine owns workspace state but cannot reach the provider transports: the
 * subscription bridge and embedded router bind the DESKTOP's 127.0.0.1, which
 * from inside a WSL distro is the distro's own loopback. So the Message Gate
 * review is delegated upward over the same stdio pair the engine is served on.
 *
 * This exercises that channel directly, with no distro and no provider, because
 * the failure it prevents is silent: a review that throws makes the gate
 * fail-open and every message is delivered unreviewed.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { PassThrough } from "node:stream";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const outDir = qaTempDir();

async function load(entry, file) {
  const r = await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true, format: "cjs", platform: "node", write: false, external: ["electron"],
  });
  const out = path.join(outDir, file);
  writeFileSync(out, r.outputFiles[0].text);
  return createRequire(import.meta.url)(out);
}

const { HostChannel } = await load("src/main/engine/transport/hostChannel.ts", "host-channel.cjs");
const { serveEngine } = await load("src/main/engine/transport/engineServer.ts", "engine-server-mod.cjs");
const { RemoteEngineClient } = await load("src/main/engine/transport/remoteEngineClient.ts", "remote-client.cjs");

/** Wires a client and an engine to each other over two in-memory pipes. */
function connect(hostHandlers, engineImpl) {
  const toEngine = new PassThrough();
  const toClient = new PassThrough();
  const channel = new HostChannel(toClient, 3000);
  const stopEngine = serveEngine(engineImpl, toEngine, toClient, channel);
  const client = new RemoteEngineClient({ input: toClient, output: toEngine }, "ws", undefined, hostHandlers);
  return { client, channel, stop: () => { stopEngine(); client.dispose(); channel.dispose(); } };
}

const VERDICT = { verdict: "reject", reason: "한국어로 작성해야 합니다." };

console.log("\nreverse call (engine → desktop):");
{
  const seen = [];
  const { channel, stop } = connect({
    reviewGate: async (message, reviewer) => { seen.push({ message, reviewer }); return VERDICT; },
  }, {});
  const got = await channel.call("reviewGate", { rule: "Korean only", from: "req", to: "main", content: "Hello" }, { model: "haiku", effort: "low" });
  assert(JSON.stringify(got) === JSON.stringify(VERDICT), "the engine receives the desktop's verdict");
  assert(seen.length === 1, "the desktop handler ran exactly once");
  assert(seen[0].message.content === "Hello" && seen[0].reviewer.model === "haiku", "the message and reviewer cross the boundary intact");
  stop();
}

console.log("\nfailures surface (never a silent allow):");
{
  const { channel, stop } = connect({
    reviewGate: async () => { throw new Error("bridge unreachable"); },
  }, {});
  let error;
  try { await channel.call("reviewGate", {}, {}); } catch (e) { error = e; }
  assert(Boolean(error), "a throwing desktop handler rejects the engine's call");
  assert(/bridge unreachable/.test(error?.message || ""), `the real reason crosses back (${error?.message})`);
  stop();
}
{
  const { channel, stop } = connect({}, {});
  let error;
  try { await channel.call("nope"); } catch (e) { error = e; }
  assert(/Unknown host method/.test(error?.message || ""), "an unhandled method rejects rather than hanging");
  stop();
}
{
  // A desktop that never answers must not wedge message delivery forever.
  const { channel, stop } = connect({ reviewGate: () => new Promise(() => {}) }, {});
  const t0 = Date.now();
  let error;
  try { await channel.call("reviewGate"); } catch (e) { error = e; }
  const waited = Date.now() - t0;
  assert(/timed out/.test(error?.message || ""), "an unanswered call times out instead of hanging");
  assert(waited >= 2900 && waited < 6000, `it waits the configured timeout, not forever (${waited}ms)`);
  stop();
}

console.log("\nthe forward direction still works alongside it:");
{
  const engine = { listParty: async (id) => ({ ok: true, echoed: id }) };
  const { client, channel, stop } = connect({ reviewGate: async () => VERDICT }, engine);
  const forward = await client.listParty("party-1");
  assert(forward?.echoed === "party-1", "desktop → engine requests are unaffected by the new frames");
  const reverse = await channel.call("reviewGate");
  assert(reverse.verdict === "reject", "both directions work over the one stream pair");
  stop();
}

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exitCode = failures.length ? 1 : 0;
