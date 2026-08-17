/*
 * Product E2E for connection lock: real Electron app, real Flutter app,
 * real WebRTC pipe, and a real signaling process. The phone is driven through
 * its shipped debug automation API on port 8182.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const signaling = arg("--signaling", process.env.AGENTPARTY_MOBILE_SIGNALING_URL || "");
const phone = arg("--phone", "http://127.0.0.1:8182");
const pin = "314159";
const wrongPin = "000000";
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(base, route, init) {
  const response = await fetch(base + route, init);
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = { raw }; }
  return { status: response.status, body, raw };
}
const get = (base, route) => json(base, route);
const post = (base, route, body) => json(base, route, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body || {}),
});
const resultOf = (response) => response.body?.result ?? response.body;

async function liveDesktopBase(workspace) {
  const directory = path.join(workspace, ".agent_party_app", "instances");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    let entries = [];
    try {
      entries = readdirSync(directory)
        .map((name) => path.join(directory, name))
        .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
        .sort((left, right) => right.mtime - left.mtime);
    } catch {}
    for (const entry of entries) {
      try {
        const { baseUrl } = JSON.parse(readFileSync(entry.file, "utf8"));
        const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) return baseUrl;
      } catch {}
    }
    await delay(1000);
  }
  throw new Error("the desktop app never advertised a live automation API");
}

async function waitForPhone() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const health = await get(phone, "/health");
      if (health.status === 200) return health.body;
    } catch {}
    await delay(500);
  }
  throw new Error(`no phone automation API at ${phone}`);
}

async function main() {
  if (!signaling) throw new Error("--signaling is required; refusing to pair against an unknown address");
  const phoneHealth = await waitForPhone();
  const phoneHealthResult = phoneHealth?.result ?? phoneHealth;
  assert(phoneHealthResult?.pipe === "real", `the installed phone app uses the real pipe (${phoneHealthResult?.pipe})`);

  const userData = mkdtempSync(path.join(os.tmpdir(), "agentparty-lock-device-ud-"));
  const workspace = mkdtempSync(path.join(os.tmpdir(), "agentparty-lock-device-ws-"));
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_AUTOMATION_PORT: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    const desktop = await liveDesktopBase(workspace);
    console.log(`desktop: ${desktop}\nphone:   ${phone}\nsignal:  ${signaling}`);

    await post(desktop, "/api/mobile/settings", { enabled: true, signalingUrl: signaling });
    let desktopStatus;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await delay(600);
      desktopStatus = (await get(desktop, "/api/mobile/status")).body.status;
      if (desktopStatus?.signaling === "connected") break;
    }
    assert(desktopStatus?.signaling === "connected", `desktop reached signaling (${desktopStatus?.signaling})`);
    if (desktopStatus?.signaling !== "connected") throw new Error("desktop cannot reach signaling; refusing to pair");

    const set = await post(desktop, "/api/qa/mobile/lock-set", { kind: "pin", secret: pin });
    assert(set.status === 200 && set.body?.result?.lock?.kind === "pin", "desktop configured the PIN lock");
    assert(!set.raw.includes(pin), "desktop setup response does not echo the PIN");

    const opened = await post(desktop, "/api/mobile/pair/open", {});
    const pairedStart = await post(phone, "/pair", { qr: opened.body.qr });
    const phoneCode = resultOf(pairedStart)?.confirmationCode;
    let pairing;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await delay(500);
      pairing = (await get(desktop, "/api/mobile/status")).body.status?.pairing;
      if (pairing?.phase === "awaitingConfirm") break;
    }
    assert(Boolean(phoneCode) && phoneCode === pairing?.code, "the QR confirmation code matches on both real apps");
    await post(desktop, "/api/mobile/pair/confirm", {});
    const trust = await post(phone, "/pair/await", {});
    const trustedDesktop = resultOf(trust);
    assert(trust.status === 200 && Boolean(trustedDesktop?.deviceId), "the phone stored the paired desktop");

    const connected = await post(phone, "/connect", { deviceId: trustedDesktop.deviceId });
    const firstConnection = resultOf(connected)?.connection;
    if (connected.status !== 200 || firstConnection?.state !== "locked") {
      console.log(`  connect diagnostic: ${connected.status} ${connected.raw}`);
      console.log(`  phone status: ${JSON.stringify((await get(phone, "/status")).body)}`);
      console.log(`  desktop status: ${JSON.stringify((await get(desktop, "/api/mobile/status")).body)}`);
    }
    assert(connected.status === 200 && firstConnection?.state === "locked", "a new session stops at the PIN screen");
    assert(firstConnection?.kind === "pin" && firstConnection?.attemptsLeft === 10,
      "the phone shows the desktop-owned kind and ten remaining attempts");

    const preAuth = await post(phone, "/rpc", { method: "sys.info", params: {} });
    assert(preAuth.status === 409, "RPC is unavailable before connection unlock");

    const wrong = await post(phone, "/unlock", { secret: wrongPin });
    assert(wrong.status === 409, "a wrong PIN is rejected");
    assert(!wrong.raw.includes(wrongPin), "the wrong-PIN response does not echo the submitted secret");
    const afterWrong = resultOf(await get(phone, "/status")).connection;
    if (afterWrong?.attemptsLeft !== 9) console.log(`  after-wrong diagnostic: ${JSON.stringify(afterWrong)}`);
    assert(afterWrong?.state === "locked" && afterWrong?.attemptsLeft === 9 && afterWrong?.error === "badSecret",
      "the desktop-owned failure count reaches the phone (9 left)");

    const unlocked = await post(phone, "/unlock", { secret: pin });
    if (unlocked.status !== 200) console.log(`  unlock diagnostic: ${unlocked.status} ${unlocked.raw}`);
    assert(unlocked.status === 200 && resultOf(unlocked)?.connection?.state === "connected", "the correct PIN opens the session");
    assert(!unlocked.raw.includes(pin), "the success response does not echo the PIN");
    assert((await get(phone, "/workspaces")).status === 200, "desktop content becomes available only after unlock");

    await post(phone, "/disconnect", {});
    const reconnected = await post(phone, "/connect", { deviceId: trustedDesktop.deviceId });
    const secondConnection = resultOf(reconnected)?.connection;
    assert(secondConnection?.state === "locked", "a hard reconnect asks for the PIN again");
    assert(secondConnection?.attemptsLeft === 10, "the earlier successful unlock reset the device counter");

    await post(desktop, "/api/window/close", {}).catch(() => undefined);
  } finally {
    await delay(1000);
    if (child.exitCode === null) {
      try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    }
  }

  console.log(failures.length ? `\nCONNECTION LOCK DEVICE E2E FAILED (${failures.length})` : "\nCONNECTION LOCK DEVICE E2E PASSED");
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nCONNECTION LOCK DEVICE E2E ERROR: ${error.message}`);
  process.exit(1);
});
