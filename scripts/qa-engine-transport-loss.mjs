/*
 * Engine transport-loss QA.
 *
 * A remote engine (the WSL case) can die at any moment. Before this behaviour
 * existed, nothing rejected the requests already waiting on it: `RemoteEngineClient`
 * only failed pending calls when the transport PROMISE rejected or when the
 * client was explicitly disposed, so a mid-flight engine exit left every caller
 * pending forever. That is how a dead distro engine turned ordinary requests —
 * `/api/health` among them — into an indefinite hang instead of a visible,
 * recoverable error, and it is the failure this asserts can no longer happen.
 *
 * Drives the real client over an in-memory stream pair: no distro, no bundle of
 * the engine server, so it runs anywhere in about a second.
 */
import { build } from "esbuild";
import { PassThrough } from "node:stream";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = qaTempDir();

const built = await build({
  entryPoints: [path.join(projectRoot, "src/main/engine/transport/remoteEngineClient.ts")],
  bundle: true, format: "esm", platform: "node", write: false, external: ["electron"],
});
const bundlePath = path.join(qaDir, "engine-client.mjs");
writeFileSync(bundlePath, built.outputFiles[0].text);
const { RemoteEngineClient } = await import(pathToFileURL(bundlePath).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Rejects rather than hanging, so a regression fails the run instead of stalling it. */
async function settles(promise, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} never settled — the hang this test exists to catch`)), 5_000);
  });
  try {
    return { ok: true, value: await Promise.race([promise, guard]) };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

console.log("Engine transport loss:");

const input = new PassThrough();
const output = new PassThrough();
const lost = [];
const client = new RemoteEngineClient(
  { input, output },
  "wsl+Ubuntu-QA:/home/qa/ws",
  undefined,
  {},
  (error) => lost.push(error),
);

// A request is in flight when the engine exits.
const inFlight = client.listParty();
await tick();
input.end();

const first = await settles(inFlight, "the in-flight call");
assert(!first.ok, "a call waiting on the engine rejects when the transport closes");
assert(/exited|closed/i.test(String(first.error?.message)), `the reason names the transport (got: ${first.error?.message})`);

// Everything after must fail fast rather than queue behind a peer that is gone.
const later = await settles(client.listParty(), "a call made after the close");
assert(!later.ok, "a call made after the transport closed fails immediately");

assert(lost.length === 1, `the owner is told exactly once so it can respawn the engine (got ${lost.length})`);

// A disposed client must not also report a transport loss: that would evict a
// registry entry the owner already replaced.
const quiet = new PassThrough();
const quietOut = new PassThrough();
const disposedNotices = [];
const disposable = new RemoteEngineClient({ input: quiet, output: quietOut }, "wsl+Ubuntu-QA:/home/qa/ws2", undefined, {}, (error) => disposedNotices.push(error));
await tick();
disposable.dispose();
quiet.end();
await tick();
assert(disposedNotices.length === 0, `an explicit dispose does not report a transport loss (got ${disposedNotices.length})`);

if (failures.length) {
  console.log(`\nENGINE TRANSPORT LOSS FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("\nENGINE TRANSPORT LOSS PASSED");
