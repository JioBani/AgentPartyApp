/*
 * Product E2E across the real link: the real desktop app, the real pipe, and
 * the real phone app on a device or emulator.
 *
 * Drives the PHONE's automation API (port 8182, the app's own surface) rather
 * than the pipe's, because the thing under test is what a user touches — a run
 * against the pipe alone would prove the transport and nothing about the app
 * (AGENTS.md: product E2E drives the real application).
 *
 * Covers: pairing → workspace → member create → message → streaming receipt →
 * approval response.
 *
 * Prerequisites (this script does NOT create them, and says so rather than
 * quietly passing):
 *   1. A phone/emulator with the app built against the REAL pipe:
 *      flutter build apk --debug --dart-define=AGENTPARTY_MOCK_PIPE=false
 *   2. adb forward tcp:8182 tcp:8182
 *   3. A reachable signalling server set on the desktop. The shipped default
 *      (sig.agentparty.app) does not resolve, and the phone STORES whatever
 *      address the QR carries — pairing against a dead one is not undoable
 *      from this side.
 *
 * Run: node scripts/e2e-mobile-device.mjs [--signaling wss://…] [--phone http://127.0.0.1:8182]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const SIGNALING = arg("--signaling", process.env.AGENTPARTY_MOBILE_SIGNALING_URL || "");
const PHONE = arg("--phone", "http://127.0.0.1:8182");

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, init) {
  const res = await fetch(url, init);
  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }
  return { status: res.status, body: parsed };
}
const post = (base, p, body) => json(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
const get = (base, p) => json(base + p);

/** Fails loudly when a prerequisite is absent, rather than reporting a green run that tested nothing. */
async function requirePhone() {
  try {
    const { status, body } = await get(PHONE, "/");
    if (status !== 200) throw new Error(`status ${status}`);
    return body;
  } catch (error) {
    throw new Error(
      `No phone automation API at ${PHONE} (${error.message}).\n` +
      "  - is the app installed and running, built with --dart-define=AGENTPARTY_MOCK_PIPE=false?\n" +
      "  - did you run: adb forward tcp:8182 tcp:8182 ?",
    );
  }
}

async function desktopBaseUrl(workspace) {
  const dir = path.join(workspace, ".agent_party_app", "instances");
  for (let i = 0; i < 60; i += 1) {
    try {
      const files = readdirSync(dir);
      if (files.length) return JSON.parse(readFileSync(path.join(dir, files[0]), "utf8")).baseUrl;
    } catch {}
    await delay(1000);
  }
  throw new Error("the desktop app never advertised itself");
}

async function main() {
  console.log(`phone: ${PHONE}`);
  const surface = await requirePhone();
  console.log(`phone endpoints: ${Object.keys(surface || {}).length ? "self-described" : "(none reported)"}`);

  const userData = mkdtempSync(path.join(os.tmpdir(), "agentparty-device-ud-"));
  const workspace = path.join(os.tmpdir(), "agentparty-device-ws");
  mkdirSync(workspace, { recursive: true });

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], {
    cwd: root,
    env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_USER_DATA: userData, AGENTPARTY_AUTOMATION_PORT: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (c) => process.stderr.write(c));

  try {
    const desktop = await desktopBaseUrl(workspace);
    console.log(`desktop: ${desktop}\n`);

    console.log("link is up before anything is paired:");
    const settings = { enabled: true, ...(SIGNALING ? { signalingUrl: SIGNALING } : {}) };
    await post(desktop, "/api/mobile/settings", settings);
    let status;
    for (let i = 0; i < 20; i += 1) {
      await delay(1500);
      status = (await get(desktop, "/api/mobile/status")).body.status;
      if (status?.signaling === "connected") break;
    }
    assert(status?.signaling === "connected",
      `signalling connected (${status?.signaling}${status?.signalingError ? ` — ${status.signalingError}` : ""})`);
    // Pairing before this point would hand the phone an address it keeps
    // forever, so the run stops rather than creating a device nobody can fix.
    if (status?.signaling !== "connected") {
      throw new Error("refusing to pair against a signalling server this desktop cannot reach — the phone would store that address permanently");
    }

    console.log("\npairing:");
    const opened = (await post(desktop, "/api/mobile/pair/open")).body;
    assert(opened.ok && typeof opened.qr === "string", "the desktop issued a QR");
    const injected = await post(PHONE, "/pair", { qr: opened.qr });
    assert(injected.status === 200, `the phone accepted the QR (${injected.status})`);
    const phoneCode = injected.body?.confirmationCode;
    let pairing;
    for (let i = 0; i < 20; i += 1) {
      await delay(1000);
      pairing = (await get(desktop, "/api/mobile/status")).body.status?.pairing;
      if (pairing?.phase === "awaitingConfirm") break;
    }
    assert(pairing?.phase === "awaitingConfirm", `the desktop saw the phone (${pairing?.phase})`);
    // The whole point of the code: it must MATCH, not merely exist.
    assert(Boolean(phoneCode) && phoneCode === pairing?.code,
      `the code matches on both screens (phone=${phoneCode}, desktop=${pairing?.code})`);
    await post(desktop, "/api/mobile/pair/confirm");
    const paired = await post(PHONE, "/pair/await", {});
    assert(paired.status === 200 && Boolean(paired.body?.deviceId), "the phone completed pairing");

    console.log("\nsession and subscription:");
    const connected = await post(PHONE, "/connect", { deviceId: paired.body.deviceId });
    assert(connected.status === 200, `the phone connected (${connected.status})`);
    const spaces = await get(PHONE, "/workspaces");
    const uris = (spaces.body?.workspaces || spaces.body || []).map((w) => w.uri || w);
    assert(uris.length > 0, `the phone listed workspaces (${uris.length})`);
    const selected = await post(PHONE, "/workspace/select", { uri: uris[0] });
    // Zero events and "a quiet workspace" look identical, so the subscription
    // is asserted from the confirmed set rather than from event traffic.
    assert(selected.body?.subscribed === true || Array.isArray(selected.body?.subscribed),
      `the subscription was confirmed by the desktop (${JSON.stringify(selected.body?.subscribed)})`);
    assert(!selected.body?.subscriptionGap, `no subscription gap (${JSON.stringify(selected.body?.subscriptionGap)})`);

    console.log("\nparty and member:");
    const member = `e2e-${Date.now().toString(36).slice(-5)}`;
    const created = await post(PHONE, "/rpc", {
      method: "member.create",
      params: { name: member, requirement: "E2E device run", workspacePath: uris[0] },
    });
    assert(created.status === 200, `member.create over the link (${created.status} ${JSON.stringify(created.body).slice(0, 160)})`);
    const parties = await get(PHONE, "/parties");
    const members = parties.body?.members || parties.body?.party?.members || [];
    assert(members.some((m) => m.name === member), `the new member appears in the phone's party list`);
    const withStatus = members.find((m) => m.name === member);
    assert(Boolean(withStatus?.displayStatus), `the member carries a derived displayStatus (${withStatus?.displayStatus})`);

    console.log("\nmessage and streaming:");
    const before = (await get(PHONE, "/events")).body?.events?.length ?? 0;
    const sent = await post(PHONE, "/member/message", { name: member, text: "E2E: reply with the single word ok" });
    assert(sent.status === 200, `the message was accepted (${sent.status})`);
    let after = before;
    let grew = false;
    for (let i = 0; i < 30; i += 1) {
      await delay(1000);
      after = (await get(PHONE, "/events")).body?.events?.length ?? 0;
      if (after > before) { grew = true; break; }
    }
    assert(grew, `events arrived on the phone (${before} → ${after})`);
    const transcript = await get(PHONE, `/member/transcript?name=${encodeURIComponent(member)}`);
    assert((transcript.body?.blocks || []).length > 0, `the phone assembled a transcript (${(transcript.body?.blocks || []).length} blocks)`);

    console.log("\napprovals:");
    const approvals = await get(PHONE, "/approvals");
    assert(approvals.status === 200, `the phone can list pending approvals (${approvals.status})`);
    const pending = approvals.body?.approvals || [];
    if (pending.length) {
      const answered = await post(PHONE, "/approval/respond", { requestId: pending[0].requestId, allow: true });
      assert(["delivered", "already_resolved", "expired", "unknown"].includes(answered.body?.outcome),
        `the outcome is one of the four (${answered.body?.outcome})`);
    } else {
      // Not a failure: this turn may simply not have asked for permission. Said
      // out loud so the run is not read as having exercised the approval path.
      console.log("  – no approval was raised by this turn; the respond path was NOT exercised");
    }

    await post(desktop, "/api/window/close", {});
  } finally {
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
  }

  console.log(failures.length ? `\nDEVICE E2E FAILED (${failures.length})` : "\nDEVICE E2E PASSED");
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nDEVICE E2E ERROR: ${error.message}`);
  process.exit(1);
});
