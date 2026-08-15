/*
 * Full-process e2e for the MOBILE LINK's app-side layer — OFFLINE (no model
 * call, no network, no billing).
 *
 * Launches the REAL Electron app on an isolated userData + temp workspace,
 * discovers it through the per-workspace instance file, and drives the whole
 * `/api/mobile/*` surface plus the phone side of the link.
 *
 * SCOPE, stated plainly: the pipe underneath is desktop-pipe's MOCK gateway
 * (`createMobileGateway({implementation:"mock"})`), because the real one does
 * not exist yet — the factory throws for `"real"` rather than pretending. So
 * this proves everything desktop-app owns: pairing/device/session/diagnostics
 * endpoints, the capability table being published to the phone, one handler
 * serving both transports, workspace-scoped event delivery, and the resume
 * snapshot. It does NOT prove signaling, WebRTC, or encryption. The M1 product
 * E2E (real phone or the interop client, real `sys.ping` round trip) is a
 * separate run that lands with the real gateway.
 *
 * Run: node scripts/e2e-mobile-link.mjs   (after `npm run build`)
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForLiveBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-mobile-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-mobile-e2e-user-data");

let base = "";
/** The mock phone's session id, set once it dials in. */
let phoneSession = "";
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));

  const launchedAt = Date.now();
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_AUTOMATION_PORT: "",
    },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    base = await waitForLiveBaseUrl(ws, { since: launchedAt, timeoutMs: 60_000 });
    assert((await get("/api/health")).ok !== false, `app is up at ${base}`);
    // The build under test must be THIS worktree, not the user's installed app.
    const appRoot = (await get("/api/state")).runtime?.appRoot || "";
    assert(Boolean(appRoot) && (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep),
      `running build is THIS worktree (appRoot=${appRoot || "<missing>"})`);

    await specPublishesBothTransports();
    await linkIsOffUntilEnabled();
    await pairingRoundTrip();
    await phoneDialsIn();
    await phoneAndHttpShareOneHandler();
    await eventsFollowTheWorkspaceSubscription();
    await snapshotAnswersARewind();
    await liveSessionIsVisibleAndCuttable();
    await revokingForgetsTheDevice();
    await settingsPersistThroughTheGateway();
    await diagnosticsReportAReason();

    await post("/api/window/close", {}).catch(() => {});
    await waitForExit(child);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }

  console.log(failures.length ? `\nMOBILE LINK E2E FAILED (${failures.length})` : "\nMOBILE LINK E2E PASSED");
  process.exit(failures.length ? 1 : 0);
}

/** One table, two transports: the spec must say so, and the lists must agree. */
async function specPublishesBothTransports() {
  console.log("\n[spec] the capability table is published to both transports");
  const spec = await get("/api/spec");
  assert(spec.endpoints.includes("GET /api/party"), "endpoints list the HTTP surface");
  assert(spec.methods.includes("party.list"), "methods list what a phone may call");
  assert(spec.methods.length < spec.endpoints.length, "methods are a strict subset (desktop-local routes excluded)");
  assert(!spec.methods.includes("window.minimize"), "window chrome is not offered to a phone");
  assert(!spec.methods.includes("mobile.pairOpen"), "opening a pairing QR stays desktop-only");
  assert(spec.endpoints.includes("POST /api/mobile/pair/open"), "…but it IS an HTTP endpoint QA can drive");
}

/** The link ships OFF; enabling it is a deliberate user action in 설정. */
async function linkIsOffUntilEnabled() {
  console.log("\n[status] off by default, running once enabled");
  const initial = (await get("/api/mobile/status")).status;
  assert(initial.running === false, "the link is off on a fresh install");
  assert(initial.signaling === "disabled", "and reports that plainly rather than 'connecting'");
  assert(typeof initial.bootId === "string" && initial.bootId.length > 0, "bootId is set (the phone keys resume on it)");
  assert(initial.pairing.phase === "idle", "no pairing in progress at startup");
  assert(initial.sessions.length === 0, "no phone sessions yet");
  assert((await get("/api/mobile/devices")).devices.length === 0, "no trusted devices yet");

  const enabled = (await post("/api/mobile/settings", { enabled: true })).settings;
  assert(enabled.enabled === true, "the user turns it on in 설정 → 모바일 연결");
  assert((await get("/api/mobile/status")).status.running === true, "the gateway comes up");
}

/** QR → phone scans → confirmation code → user confirms → trusted device. */
async function pairingRoundTrip() {
  console.log("\n[pairing] QR, confirmation code, and trust");
  const opened = await post("/api/mobile/pair/open");
  assert(typeof opened.qr === "string" && opened.qr.startsWith("agentparty://pair?"), `QR string is issued (${String(opened.qr).slice(0, 28)}…)`);
  assert(opened.expiresAt > Date.now(), "QR carries a future expiry");

  const beforeScan = (await get("/api/mobile/status")).status.pairing;
  assert(beforeScan.phase === "awaitingScan", "phase is awaitingScan before the phone acts");
  assert(!beforeScan.code, "no confirmation code before the phone proves itself");

  await post("/api/qa/mobile/scan", { deviceName: "Galaxy S25" });
  const scanned = (await get("/api/mobile/status")).status.pairing;
  assert(scanned.phase === "awaitingConfirm", "phase moves to awaitingConfirm after the scan");
  assert(/^\d{4}$/.test(String(scanned.code)), `a 4-digit confirmation code appears (${scanned.code})`);
  assert(scanned.peerName === "Galaxy S25", "the phone's announced name is shown for comparison");

  await post("/api/mobile/pair/confirm");
  const devices = (await get("/api/mobile/devices")).devices;
  assert(devices.length === 1 && devices[0].name === "Galaxy S25", "the phone is now a trusted device");
}

/** A trusted phone dials in; everything after this runs on a live session. */
async function phoneDialsIn() {
  console.log("\n[session] the phone connects");
  const { result } = await post("/api/qa/mobile/connect", { workspaces: [] });
  phoneSession = result.sessionId;
  assert(Boolean(phoneSession), `a session is established (${phoneSession})`);
  assert((await get("/api/mobile/status")).status.sessions.length === 1, "the desktop sees exactly one phone session");
}

/**
 * The claim the whole refactor exists for: a phone's `party.list` and a local
 * `GET /api/party` are the SAME handler, so they cannot answer differently.
 */
async function phoneAndHttpShareOneHandler() {
  console.log("\n[dispatch] the phone and HTTP run one handler");
  await post("/api/qa/seed", { party: "mobile e2e", members: [{ name: "backend", model: "claude-sonnet-4.5", role: "모바일 e2e" }] });

  const overHttp = await get("/api/party");
  const overLink = (await post("/api/qa/mobile/request", { method: "party.list", params: { workspacePath: ws } })).result;
  assert(JSON.stringify(namesOf(overLink)) === JSON.stringify(namesOf(overHttp)),
    `party.list over the link matches GET /api/party (${namesOf(overHttp).join(", ")})`);

  const state = (await post("/api/qa/mobile/request", { method: "state.get", params: { workspacePath: ws } })).result;
  assert(state?.settings !== undefined, "state.get answers over the link too");

  // A method the table marks desktop-only must not be reachable from a phone,
  // and the pipe must say so rather than quietly doing nothing.
  const refused = await post("/api/qa/mobile/request", { method: "window.minimize", params: {} }).catch((error) => String(error.message));
  assert(typeof refused === "string" && /method_not_found/.test(refused), "a desktop-only method answers method_not_found");
}

async function eventsFollowTheWorkspaceSubscription() {
  console.log("\n[events] delivery follows the phone's workspace subscription");
  const sessionId = phoneSession;

  // Unsubscribed: 01 §5.2 says a phone receives no workspace events until it
  // sends `ctl.subscribe`. Nothing is a PASS here, not a missing feature.
  await post("/api/party/members/backend/status", {});
  const beforeSubscribe = (await post("/api/qa/mobile/delivered", { sessionId })).result.events;
  assert(beforeSubscribe.every((event) => event.type !== "party:update"),
    "no workspace events before the phone subscribes");

  await post("/api/qa/mobile/subscribe", { sessionId, workspaces: [ws] });
  await post("/api/party/members", { name: "mobile-watcher", requirement: "이벤트 전달 확인", role: "관찰" });
  await delay(400);
  const delivered = (await post("/api/qa/mobile/delivered", { sessionId })).result.events;
  const partyEvents = delivered.filter((event) => event.type === "party:update");
  assert(partyEvents.length > 0, `party:update reaches the subscribed session (${partyEvents.length})`);
  assert(partyEvents.every((event) => typeof event.seq === "number"), "the pipe stamped a sequence number on each");
  assert(namesOf(partyEvents.at(-1).d).includes("mobile-watcher"), "the payload is the renderer's, unaltered");

  const other = path.join(os.tmpdir(), "agentparty-mobile-e2e-other");
  await post("/api/qa/mobile/subscribe", { sessionId, workspaces: [other] });
  const countBefore = (await post("/api/qa/mobile/delivered", { sessionId })).result.events.length;
  await post("/api/party/members/mobile-watcher/status", {});
  await delay(300);
  const countAfter = (await post("/api/qa/mobile/delivered", { sessionId })).result.events.length;
  assert(countAfter === countBefore, "events for an unsubscribed workspace are not delivered");
  await post("/api/qa/mobile/subscribe", { sessionId, workspaces: [ws] });
}

/** A rewind that falls outside the ring buffer must get real state, not {}. */
async function snapshotAnswersARewind() {
  console.log("\n[snapshot] an out-of-window resume gets full state");
  const sessionId = (await get("/api/mobile/status")).status.sessions[0]?.sessionId;
  const snapshot = (await post("/api/qa/mobile/snapshot", { sessionId })).result;
  const first = snapshot?.workspaces?.[0];
  assert(first?.workspacePath === ws, "the snapshot covers the subscribed workspace");
  assert(Boolean(first?.state?.settings), "it carries a full state payload, not an empty object");
}

async function liveSessionIsVisibleAndCuttable() {
  console.log("\n[sessions] the desktop can see and cut a phone session");
  await post("/api/qa/mobile/request", { method: "party.status", params: { workspacePath: ws } });
  const session = (await get("/api/mobile/status")).status.sessions[0];
  assert(session?.deviceName === "Galaxy S25", "the live session names the phone");
  assert(session?.lastRequestMethod === "party.status", `the desktop knows what the phone just ran (${session?.lastRequestMethod})`);
  assert(Array.isArray(session?.subscribedWorkspaces) && session.subscribedWorkspaces.includes(ws), "and which workspace it watches");

  const after = await post(`/api/mobile/sessions/${encodeURIComponent(session.sessionId)}/disconnect`, {});
  assert(after.status.sessions.length === 0, "즉시 끊기 drops the session immediately");
  assert((await get("/api/mobile/devices")).devices.length === 1, "…while the pairing survives (disconnect ≠ revoke)");
}

async function revokingForgetsTheDevice() {
  console.log("\n[devices] rename and revoke");
  const deviceId = (await get("/api/mobile/devices")).devices[0].deviceId;
  const renamed = await post(`/api/mobile/devices/${encodeURIComponent(deviceId)}/rename`, { name: "거실 폰" });
  assert(renamed.devices[0].name === "거실 폰", "a device can be renamed (Korean round-trips intact)");

  const revoked = await post(`/api/mobile/devices/${encodeURIComponent(deviceId)}/revoke`, {});
  assert(revoked.devices.length === 0, "revoke forgets the phone");
  assert((await get("/api/mobile/status")).status.trustedDeviceCount === 0, "and the status agrees");
}

async function settingsPersistThroughTheGateway() {
  console.log("\n[settings] the app's store is the source of truth");
  const patched = await post("/api/mobile/settings", { signalingUrl: "ws://127.0.0.1:8080/v1/ws", deviceName: "QA 데스크톱" });
  assert(patched.settings.signalingUrl === "ws://127.0.0.1:8080/v1/ws", "a settings patch is accepted");
  assert((await get("/api/mobile/settings")).settings.deviceName === "QA 데스크톱", "and reads back");
  // Written to settings.json, not just held in the mock's memory — otherwise the
  // user's server URL would silently reset on the next launch.
  const onDisk = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
  assert(onDisk.mobile?.signalingUrl === "ws://127.0.0.1:8080/v1/ws", "…and is persisted to settings.json");
}

async function diagnosticsReportAReason() {
  console.log("\n[diagnostics] a reason code the UI can explain");
  await post("/api/qa/mobile/diagnostics", { reason: "cgnat_100_64" });
  const { diagnostics } = await get("/api/mobile/diagnostics");
  assert(diagnostics.reason === "cgnat_100_64", `the run reports its verdict (${diagnostics.reason})`);
  assert(Array.isArray(diagnostics.probes), "with per-probe detail for a bug report");
  assert(Array.isArray(diagnostics.errors), "and a place failures are surfaced rather than swallowed");
  assert((await get("/api/mobile/status")).status.lastDiagnostics?.reason === "cgnat_100_64", "the status remembers the last run");
}

function namesOf(listing) {
  return (listing?.members || []).map((member) => member.name);
}

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(route, body) {
  const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function removePath(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) return;
      await delay(300);
    }
  }
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { killProcessTree(child.pid); resolve(); }, 10_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

// Only ever this app's own process tree. NEVER a blanket electron kill — the
// user has their own AgentParty running.
function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((error) => { console.error(error); process.exit(1); });
