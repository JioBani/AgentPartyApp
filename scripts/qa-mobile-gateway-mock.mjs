/*
 * MockMobileGateway contract test.
 *
 * The mock is what the app member builds the mobile-link UI, automation routes
 * and method handlers against before the real pipe exists, so its behaviour IS
 * a contract: pairing phases, reserved-method protection, workspace-scoped
 * event delivery (01 §5.2), snapshot provision and session teardown. If this
 * drifts, every screen built on top drifts with it.
 *
 * Pure in-memory module — no Electron, no sockets, no crypto.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");

const result = await build({
  entryPoints: [path.join(projectRoot, "src/main/mobile/index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  // libsodium is a WASM module: bundling it detaches its crypto binding
  // ("No secure random number generator found"). Resolve it at runtime.
  // index.ts now also reaches the real gateway, which lazily requires the
  // native WebRTC module. The bundler follows that require statically even
  // though it only runs when a transport is constructed.
  external: ["@agentparty/protocol", "ws", "node-datachannel"],
  write: false,
});

const outDir = qaTempDir();
const bundlePath = path.join(outDir, "mobileGateway.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const M = await import(pathToFileURL(bundlePath).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };
const throws = async (fn, match, msg) => {
  let message = "";
  try { await fn(); } catch (error) { message = String(error?.message ?? error); }
  assert(message.includes(match), `${msg} (got: ${message || "no throw"})`);
};

console.log("MockMobileGateway assertions:");

// --- factory honesty -------------------------------------------------------
await throws(
  () => M.createMobileGateway({ implementation: "real", deps: undefined }),
  "requires MobileGatewayDeps",
  "createMobileGateway('real') without deps fails loudly",
);
const real = M.createMobileGateway({
  implementation: "real",
  deps: {
    userDataPath: qaTempDir(),
    secretCipher: { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t), decryptString: (b) => b.toString() },
    log: () => {},
    onSecurityWarning: () => {},
    readSettings: () => ({}),
    writeSettings: () => {},
    defaultDeviceName: "QA Desktop",
    appVersion: "0.0.0",
  },
});
assert(real.mock === undefined, "createMobileGateway('real') never returns the mock simulator");
assert(typeof real.onRequest === "function", "the real gateway satisfies the same interface");
assert(typeof M.createMobileGateway({ implementation: "mock" }).mock === "object", "'mock' returns the simulator");

// --- lifecycle -------------------------------------------------------------
const gateway = M.createMockMobileGateway();
assert(gateway.getStatus().running === false, "starts stopped");
await gateway.start();
assert(gateway.getStatus().running === false, "start() respects enabled:false (no silent auto-enable)");
await gateway.start({ force: true });
assert(gateway.getStatus().running === true, "start({force}) runs without changing the user's setting");
assert(gateway.getSettings().enabled === false, "force did not write back enabled");

// --- status stream ---------------------------------------------------------
let pushes = 0;
const unsubscribe = gateway.status$.subscribe(() => { pushes += 1; });
assert(gateway.status$.current === gateway.getStatus(), "status$.current and getStatus() are the same value");

// --- reserved methods ------------------------------------------------------
await throws(
  () => gateway.onRequest("sys.ping", async () => ({})),
  "cannot be overridden",
  "a reserved pipe method rejects app registration",
);
const unregister = gateway.onRequest("party.list", async (params, ctx) => ({ params, seenBy: ctx.deviceId }));
await throws(
  () => gateway.onRequest("party.list", async () => ({})),
  "already registered",
  "duplicate registration is an error, not last-writer-wins",
);
assert(gateway.registeredMethods().includes("sys.ping"), "registeredMethods() reports the pipe's reserved methods");
assert(gateway.registeredMethods().includes("party.list"), "registeredMethods() reports app methods");

// --- pairing ---------------------------------------------------------------
const session = await gateway.pairing.openQr();
assert(session.qr.startsWith("agentparty://pair?v=1&d="), "QR uses the 01 §2.1 field order");
assert(gateway.pairing.state$.current.phase === "awaitingScan", "pairing waits for a scan");
assert(session.code$.current === "", "no confirmation code before the phone answers");

gateway.mock.scanQr({ deviceName: "Galaxy S25", deviceId: "phone-1" });
assert(gateway.pairing.state$.current.phase === "awaitingConfirm", "scan moves pairing to awaitingConfirm");
assert(session.code$.current.length === 4, "a 4-digit confirmation code appears for the user to compare");
assert(gateway.pairing.devices().length === 0, "nothing is trusted before the user confirms (01 §2.2)");

await gateway.pairing.confirm();
const paired = await session.completed;
assert(paired.deviceId === "phone-1", "completed resolves with the trusted device");
assert(gateway.pairing.devices().length === 1, "the phone is trusted only after confirm()");
assert(gateway.getStatus().pairing.phase === "completed", "status carries the pairing phase for the HTTP route");

const cancelled = await gateway.pairing.openQr();
await gateway.pairing.cancel();
await throws(() => cancelled.completed, "취소", "cancel() rejects the pending pairing rather than hanging");
await throws(() => gateway.pairing.confirm(), "확인을 기다리는", "confirm() with no pairing is an explicit error");

// --- sessions and workspace-scoped events (01 §5.2) ------------------------
gateway.emit("usage:update", { tokens: 1 });
assert(gateway.mock.emitted().length === 0, "emit() is a no-op with no session (04 §성능·안전)");

const sessionId = gateway.mock.connect({ deviceId: "phone-1" });
gateway.mock.subscribe(sessionId, ["C:/proj/a"]);

gateway.emit("session:events", { block: 1 }, { workspacePath: "C:/proj/a" });
gateway.emit("session:events", { block: 2 }, { workspacePath: "C:/proj/b" });
gateway.emit("usage:update", { tokens: 2 });

const delivered = gateway.mock.deliveredTo(sessionId);
assert(delivered.length === 2, "unsubscribed workspaces are filtered out");
assert(delivered[0].type === "session:events" && delivered[0].d.block === 1, "the subscribed workspace is delivered");
assert(delivered[1].type === "usage:update", "an unscoped event reaches every session");
assert(delivered[0].seq === 1 && delivered[1].seq === 3, "seq is global and monotonic across all events");
assert(gateway.getStatus().events.maxSeq === 3, "status reports the ring-buffer window");

gateway.mock.subscribe(sessionId, []);
gateway.emit("session:events", { block: 3 }, { workspacePath: "C:/proj/a" });
assert(gateway.mock.deliveredTo(sessionId).length === 2, "an empty subscription set means zero workspace events");

// --- request dispatch ------------------------------------------------------
const answered = await gateway.mock.request("party.list", { workspacePath: "C:/proj/a" });
assert(answered.seenBy === "phone-1", "the handler receives a verified deviceId in its context");
await throws(() => gateway.mock.request("nope.method"), "method_not_found", "an unregistered method is method_not_found");
unregister();
await throws(() => gateway.mock.request("party.list"), "method_not_found", "unregister() removes the handler");

// --- snapshot --------------------------------------------------------------
await throws(() => gateway.mock.snapshot(), "스냅샷 제공자", "a missing snapshot provider is an error, not an empty snapshot");
gateway.setSnapshotProvider((ctx) => ({ workspaces: ctx.workspaces, ok: true }));
const snapshot = await gateway.mock.snapshot(sessionId);
assert(snapshot.ok === true, "the registered snapshot provider is used for out-of-window resume");

// --- teardown --------------------------------------------------------------
assert(gateway.getStatus().sessions.length === 1, "the live session is visible for the 'mobile is driving' badge");
await gateway.disconnect(sessionId);
assert(gateway.getStatus().sessions.length === 0, "disconnect(sessionId) drops just that session");
await gateway.disconnect("does-not-exist");
assert(true, "disconnecting an unknown session is a no-op");

gateway.mock.connect({ deviceId: "phone-1" });
await gateway.pairing.revoke("phone-1");
assert(gateway.pairing.devices().length === 0, "revoke() forgets the device");
assert(gateway.getStatus().sessions.length === 0, "revoke() also drops the device's live sessions");

// --- diagnostics -----------------------------------------------------------
gateway.mock.setDiagnostics("symmetric_nat");
const diagnostics = await gateway.diagnostics();
assert(diagnostics.reason === "symmetric_nat", "diagnostics report the configured reason code");
assert(diagnostics.errors.length > 0, "a failing diagnosis carries a surfaced error string");
await throws(
  async () => gateway.mock.setDiagnostics("made_up_code"),
  "알 수 없는 진단 사유",
  "an unknown reason code is rejected instead of rendering as a blank verdict",
);

assert(pushes > 0, "status$ pushed updates to its subscriber");
unsubscribe();

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
