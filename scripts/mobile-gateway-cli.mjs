/*
 * Runs the REAL mobile gateway outside Electron, with a local HTTP control
 * surface so an agent or a QA script can drive pairing and watch sessions
 * (AGENTS.md: every capability reachable through an automation API).
 *
 * This is the desktop half of the M1 interop check: point it at a signaling
 * server, get a QR, hand the QR to the phone-role harness or a real device, and
 * watch `sys.ping` come back.
 *
 * It is NOT the product. The app itself constructs the same gateway through
 * `createMobileGateway` with Electron's safeStorage; here the identity is
 * stored unencrypted in a scratch directory, and the gateway reports that as a
 * security warning exactly as it would on a Linux box with no keyring.
 *
 *   node scripts/mobile-gateway-cli.mjs \
 *     --signaling ws://127.0.0.1:8080/v1/ws [--port 7100] [--data <dir>]
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const signalingUrl = arg("signaling", "ws://127.0.0.1:8080/v1/ws");
const httpPort = Number(arg("port", "7100"));
const dataDir = arg("data", path.join(qaTempDir(), "gateway-cli"));
const deviceName = arg("name", `${os.hostname()} (CLI)`);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [path.join(projectRoot, "src/main/mobile/index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@agentparty/protocol", "ws", "node-datachannel"],
  write: false,
});
const bundlePath = path.join(qaTempDir(), "mobileGatewayCli.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const { createMobileGateway } = await import(pathToFileURL(bundlePath).href);

// The pipe is bundled to ESM here, where the external `require("node-datachannel")`
// esbuild leaves in place fails with "Dynamic require ... is not supported".
// The module is loaded properly once and injected instead.
const ndcModule = await import("node-datachannel");
const loadWebrtcModule = () => ndcModule.default ?? ndcModule;

mkdirSync(dataDir, { recursive: true });

/**
 * Stands in for Electron's safeStorage. It does NOT encrypt, and says so — the
 * gateway then raises its `identity_unencrypted` warning, which is the same
 * path a keyring-less Linux desktop takes. Pretending to encrypt here would
 * make a real degradation invisible in QA.
 */
const devCipher = {
  isEncryptionAvailable: () => false,
  encryptString: (text) => Buffer.from(text, "utf8"),
  decryptString: (buffer) => buffer.toString("utf8"),
};

let settings = {
  enabled: true,
  signalingUrl,
  pushUrl: "",
  deviceName,
  natMappingEnabled: false,
};

const warnings = [];
const logLines = [];
const log = (level, message, detail) => {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`;
  logLines.push(line);
  if (logLines.length > 500) { logLines.shift(); }
  if (level !== "debug") { console.log(line); }
};

const gateway = createMobileGateway({
  implementation: "real",
  deps: {
    userDataPath: dataDir,
    secretCipher: devCipher,
    log,
    onSecurityWarning: (warning) => { warnings.push(warning); console.log(`SECURITY WARNING ${warning.code}: ${warning.message}`); },
    readSettings: () => settings,
    writeSettings: (next) => { settings = next; },
    defaultDeviceName: deviceName,
    appVersion: "cli",
    loadWebrtcModule,
  },
});

// A resume with no cursor always asks for a snapshot (01 §5.3), and the pipe
// ends the session rather than inventing one. A CLI with no provider would
// therefore drop every phone on its first sync.
gateway.setSnapshotProvider((ctx) => ({
  source: "mobile-gateway-cli",
  workspaces: ctx.workspaces,
  at: Date.now(),
}));

// One app-domain method so a phone can prove the handler path, not just the
// pipe's own reserved methods.
gateway.onRequest("qa.echo", async (params, ctx) => ({
  echoed: params,
  fromDevice: ctx.deviceId,
  workspacePath: ctx.workspacePath ?? null,
}));

/**
 * Machine-readable events on stdout, one JSON object per line, so a QA runner
 * can spawn this process and read the QR without an HTTP round trip.
 * Human-facing lines never start with `{`, so a reader can filter on that.
 */
const emitEvent = (event) => { process.stdout.write(JSON.stringify(event) + String.fromCharCode(10)); };

let pairingSession;

async function openPairing() {
  pairingSession = await gateway.pairing.openQr();
  emitEvent({ event: "qr", qr: pairingSession.qr, expiresAt: pairingSession.expiresAt });
  void pairingSession.completed.then(
    (device) => {
      log("info", "pairing completed", { deviceId: device.deviceId, name: device.name });
      emitEvent({ event: "paired", deviceId: device.deviceId, name: device.name });
    },
    (error) => {
      log("warn", "pairing failed", { error: String(error?.message ?? error) });
      emitEvent({ event: "pairing_failed", error: String(error?.message ?? error) });
    },
  );
  return pairingSession;
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${httpPort}`);
  try {
    if (req.method === "GET" && url.pathname === "/status") {
      return json(res, 200, { status: gateway.getStatus(), settings, warnings });
    }
    if (req.method === "GET" && url.pathname === "/logs") {
      return json(res, 200, { lines: logLines.slice(-200) });
    }
    if (req.method === "GET" && url.pathname === "/diagnostics") {
      return json(res, 200, await gateway.diagnostics());
    }
    if (req.method === "GET" && url.pathname === "/devices") {
      return json(res, 200, { devices: gateway.pairing.devices() });
    }
    if (req.method === "POST" && url.pathname === "/pair/open") {
      const opened = await openPairing();
      return json(res, 200, { qr: opened.qr, expiresAt: opened.expiresAt });
    }
    if (req.method === "POST" && url.pathname === "/pair/confirm") {
      await gateway.pairing.confirm();
      emitEvent({ event: "confirmed", code: gateway.getStatus().pairing.code ?? null });
      return json(res, 200, { ok: true, pairing: gateway.getStatus().pairing });
    }
    if (req.method === "POST" && url.pathname === "/pair/cancel") {
      await gateway.pairing.cancel();
      return json(res, 200, { ok: true });
    }
    const revoke = url.pathname.match(/^\/devices\/([^/]+)\/revoke$/);
    if (req.method === "POST" && revoke) {
      await gateway.pairing.revoke(decodeURIComponent(revoke[1]));
      return json(res, 200, { ok: true });
    }
    const disconnect = url.pathname.match(/^\/sessions\/([^/]+)\/disconnect$/);
    if (req.method === "POST" && disconnect) {
      await gateway.disconnect(decodeURIComponent(disconnect[1]), "QA disconnect");
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/emit") {
      const body = await readBody(req);
      gateway.emit(body.type ?? "qa.event", body.payload ?? {}, body.workspacePath ? { workspacePath: body.workspacePath } : undefined);
      return json(res, 200, { ok: true, events: gateway.getStatus().events });
    }
    return json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  } catch (error) {
    // Surfaced with its message: a QA run must be able to see why a step failed.
    return json(res, 500, { error: String(error?.message ?? error) });
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (error) { reject(error); } });
    req.on("error", reject);
  });
}

// The confirmation code appears only after the phone's blob1 verifies; a QA
// runner needs it to drive the compare-and-confirm step unattended.
const autoConfirm = argv.includes("--auto-confirm");
if (autoConfirm) {
  // 02 §T4 depends on a HUMAN comparing the two codes: that comparison is what
  // detects a swapped QR or a man-in-the-middle. Auto-confirming removes that
  // control, so it is opt-in, announced, and must never reach the product UI.
  console.log("AUTO-CONFIRM ENABLED — the human code comparison (02 §T4) is bypassed. QA only.");
}

let announcedCode;
let announcedSessions = "";
gateway.status$.subscribe((status) => {
  if (status.pairing.code && status.pairing.code !== announcedCode) {
    announcedCode = status.pairing.code;
    emitEvent({ event: "code", code: status.pairing.code, peerName: status.pairing.peerName ?? null });
    if (autoConfirm) {
      void gateway.pairing
        .confirm()
        .then(() => emitEvent({ event: "confirmed", code: announcedCode, auto: true }))
        .catch((error) => emitEvent({ event: "confirm_failed", error: String(error?.message ?? error) }));
    }
  }
  const shape = status.sessions.map((s) => `${s.sessionId}:${s.state}`).join(",");
  if (shape !== announcedSessions) {
    announcedSessions = shape;
    emitEvent({ event: "sessions", sessions: status.sessions.map((s) => ({ id: s.sessionId, state: s.state, device: s.deviceName, transport: s.transport })) });
  }
});

await gateway.start();
emitEvent({ event: "started", deviceId: gateway.getStatus().deviceId, signalingUrl });
if (argv.includes("--pair")) {
  await openPairing();
}

server.listen(httpPort, "127.0.0.1", () => {
  const status = gateway.getStatus();
  console.log(`mobile gateway CLI on http://127.0.0.1:${httpPort}`);
  console.log(`  signaling : ${signalingUrl}`);
  console.log(`  deviceId  : ${status.deviceId}`);
  console.log(`  data dir  : ${dataDir}`);
  console.log("  routes    : GET /status /logs /devices /diagnostics | POST /pair/open /pair/confirm /pair/cancel /emit");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void gateway.stop().finally(() => { server.close(); process.exit(0); });
  });
}
