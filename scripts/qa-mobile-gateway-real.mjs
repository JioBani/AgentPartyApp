/*
 * RealMobileGateway test — the parts reachable without a socket.
 *
 * Why this file exists: the mock and the real gateway are separate
 * implementations of one interface, and a bug was shipped where a fix landed in
 * the mock only. The mock's test went green while the real gateway — the one
 * the app actually runs — still returned a stale status, and the failure only
 * surfaced during a live device test. Anything asserted about behaviour, rather
 * than about the mock's own simulator controls, has to be asserted here too.
 *
 * `start()` with the mobile link disabled loads identity, the trust store and
 * the event bridge without opening any socket, which is enough to exercise the
 * emit / status / rewind contract against the real code.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");
const outDir = qaTempDir();

const result = await build({
  entryPoints: [path.join(projectRoot, "src/main/mobile/index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@agentparty/protocol", "ws", "node-datachannel"],
  write: false,
});
const bundlePath = path.join(outDir, "realGateway.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const M = await import(pathToFileURL(bundlePath).href);
const P = await import("@agentparty/protocol");
await P.sodiumReady();

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const phone = P.identityFromSeeds(new Uint8Array(32).fill(81), new Uint8Array(32).fill(82));

let seq = 0;
/** A gateway with `paired` trusted phones and no network. */
async function gateway({ paired = 1 } = {}) {
  const dir = path.join(outDir, `real-gw-${++seq}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  if (paired > 0) {
    // Seeded through the trust store's own file format, so the gateway loads it
    // exactly as it would after a real pairing.
    writeFileSync(
      path.join(dir, "mobile-devices.json"),
      JSON.stringify({
        v: 1,
        trustEpoch: 1,
        devices: [
          {
            deviceId: phone.deviceId,
            sigPk: P.toB64(phone.sigPk),
            kxPk: P.toB64(phone.kxPk),
            name: "Galaxy S25",
            pairedAt: 1,
            epoch: 1,
            lastSeenAt: 0,
            push: undefined,
          },
        ],
      }),
    );
  }

  const warnings = [];
  const instance = M.createMobileGateway({
    implementation: "real",
    deps: {
      userDataPath: dir,
      secretCipher: {
        isEncryptionAvailable: () => true,
        encryptString: (t) => Buffer.from(t, "utf8"),
        decryptString: (b) => b.toString("utf8"),
      },
      log: () => {},
      onSecurityWarning: (w) => warnings.push(w),
      // enabled:false — identity, trust store and event bridge load, no socket.
      readSettings: () => ({
        enabled: false,
        signalingUrl: "wss://unused.example/v1/ws",
        pushUrl: "",
        deviceName: "QA Desktop",
        natMappingEnabled: false,
      }),
      writeSettings: () => {},
      defaultDeviceName: "QA Desktop",
      appVersion: "test",
    },
  });
  await instance.start();
  return { instance, warnings, dir };
}

console.log("RealMobileGateway assertions:");

// --- the bug that reached a device test ------------------------------------
{
  const g = await gateway({ paired: 1 });
  assert(g.instance.getStatus().running === false, "with the link disabled it loads but does not dial out");
  assert(g.instance.getStatus().trustedDeviceCount === 1, "the seeded trust record is loaded");

  const before = g.instance.getStatus().events.seq;
  g.instance.emit("session:events", { n: 1 }, { workspacePath: "C:/w" });
  const after = g.instance.getStatus().events.seq;
  assert(after === before + 1, `getStatus() reflects an emit immediately (${before} -> ${after})`);
  assert(g.instance.getStatus().events.count === 1, "and the event is in the ring buffer");
}

// --- 01 §5.3: recorded while the paired phone is away ----------------------
{
  const g = await gateway({ paired: 1 });
  assert(g.instance.getStatus().sessions.length === 0, "no phone is connected");
  g.instance.emit("session:events", { n: 1 }, { workspacePath: "C:/w" });
  g.instance.emit("usage:update", { tokens: 5 });
  const events = g.instance.getStatus().events;
  assert(events.seq === 2, "events published with nobody connected still advance seq");
  assert(events.count === 2, "and are buffered for the phone to rewind to");
}

// --- an unpaired desktop records nothing -----------------------------------
{
  const g = await gateway({ paired: 0 });
  assert(g.instance.getStatus().trustedDeviceCount === 0, "no device is paired");
  g.instance.emit("session:events", { n: 1 }, { workspacePath: "C:/w" });
  const events = g.instance.getStatus().events;
  assert(events.seq === 0, "nothing is recorded — nobody could ever ask for it");
  assert(events.count === 0, "and the buffer stays empty (this is the hot-path guard)");
}

// --- the interface contract holds on the real implementation ---------------
{
  const g = await gateway({ paired: 1 });
  let threw = "";
  try { g.instance.onRequest("sys.ping", async () => ({})); } catch (error) { threw = error.message; }
  assert(threw.includes("cannot be overridden"), "a reserved method is refused by the real gateway too");

  g.instance.onRequest("party.list", async () => ({}));
  threw = "";
  try { g.instance.onRequest("party.list", async () => ({})); } catch (error) { threw = error.message; }
  assert(threw.includes("already registered"), "duplicate registration is refused");
  assert(g.instance.registeredMethods().includes("sys.info"), "reserved methods are listed");

  const payload = { type: "approval", title: "t", body: "b", requestId: "r", expiresAt: 1 };
  threw = "";
  try { await g.instance.push.notify(phone.deviceId, payload); }
  catch (error) { threw = (error && error.code) || String(error && error.message); }
  assert(threw === "no_handle", "a paired phone that never sent push.register is reported as such");

  threw = "";
  try { await g.instance.push.notify("not-a-paired-device", payload); }
  catch (error) { threw = (error && error.code) || String(error && error.message); }
  assert(threw === "not_paired", "an unknown device is its own code");

  // Once a handle exists, the missing relay URL is what is left to complain about.
  g.instance.push.registerHandle(phone.deviceId, "android", "fcm-token");
  threw = "";
  try { await g.instance.push.notify(phone.deviceId, payload); }
  catch (error) { threw = (error && error.code) || String(error && error.message); }
  assert(threw === "not_configured", "with a handle but no relay URL the code points at the setting");

  assert(JSON.stringify(g.instance.status$.current) === JSON.stringify(g.instance.getStatus()), "status$ and getStatus agree");
}

// --- a QR is not minted against a server that has never answered -----------
{
  // Reported by desktop-app. The QR carries `s=` and the phone STORES it, so
  // pairing against an unreachable host is not a retryable failure — the
  // device keeps the dead address after the desktop fixes its setting. The
  // shipped default resolves to nothing, so a first run hits this every time.
  const g = await gateway({ paired: 0 });
  let threw = "";
  try { await g.instance.pairing.openQr(); } catch (error) { threw = String(error?.message ?? error); }
  assert(threw.length > 0, "openQr() is refused while signaling has never connected");
  assert(
    threw.includes("신뢰 기록") || threw.includes("연결되지 않"),
    `and the reason explains the durable consequence, not just "offline" (${threw.slice(0, 50)})`,
  );
  assert(
    g.instance.pairing.state$.current.phase === "idle",
    "no pairing session is left half-open by the refusal",
  );
}

// --- a settings restart keeps the run's start options ----------------------
{
  // Reported by desktop-app: updateSettings() restarted with a bare start(),
  // so toggling `enabled` moved a QA run off its --signaling target onto the
  // persisted URL, and the phone paired with a different server than the one
  // under test.
  const g = await gateway({ paired: 1 });
  await g.instance.stop();
  await g.instance.start({ signalingUrl: "wss://override.example/v1/ws", pairingTtlMs: 60_000 });
  assert(
    g.instance.getStatus().signalingUrl === "wss://override.example/v1/ws",
    `the override is in effect (${g.instance.getStatus().signalingUrl})`,
  );

  // A patch that does not name signalingUrl must not discard it.
  await g.instance.updateSettings({ deviceName: "Renamed Desktop" });
  assert(
    g.instance.getStatus().signalingUrl === "wss://override.example/v1/ws",
    "an unrelated settings change leaves the override alone",
  );

  // Toggling `enabled` forces the restart that used to drop it.
  await g.instance.updateSettings({ enabled: true });
  assert(
    g.instance.getStatus().signalingUrl === "wss://override.example/v1/ws",
    `the override survives the restart that a settings change triggers (${g.instance.getStatus().signalingUrl})`,
  );

  // But naming the URL explicitly is the caller asking for that one.
  await g.instance.updateSettings({ signalingUrl: "wss://chosen.example/v1/ws" });
  assert(
    g.instance.getStatus().signalingUrl === "wss://chosen.example/v1/ws",
    `an explicit signalingUrl patch wins over the override (${g.instance.getStatus().signalingUrl})`,
  );
  await g.instance.stop();
}

// --- a QR TTL beyond the protocol default is announced ---------------------
{
  const g = await gateway({ paired: 1 });
  await g.instance.stop();
  await g.instance.start({ pairingTtlMs: 60 * 60_000 });
  const warning = g.warnings.find((w) => w.code === "pairing_ttl_extended");
  assert(warning !== undefined, "an extended pairing TTL raises a security warning");
  assert(/10분/.test(warning?.message ?? ""), `and reports the capped value, not the requested one (${warning?.message?.slice(0, 40)})`);
}

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
