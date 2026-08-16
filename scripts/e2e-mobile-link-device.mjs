/*
 * Real-link round trip: the real desktop app, the real pipe, the real
 * signalling server, and a real phone over WebRTC.
 *
 * NOT a product E2E. It drives the pipe's example app on the phone (port 8181),
 * so it proves the transport and the desktop's method handlers — not the
 * AgentParty phone app's own behaviour. A product run needs ux's app installed
 * and its automation API on 8182 (see scripts/e2e-mobile-device.mjs).
 *
 * Prerequisites, asserted rather than assumed:
 *   adb forward tcp:8181 tcp:8181, with the example app running on the device.
 *
 * Run: node scripts/e2e-mobile-link-device.mjs --signaling wss://…
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const SIGNALING = arg("--signaling", process.env.AGENTPARTY_MOBILE_SIGNALING_URL || "");
const PHONE = arg("--phone", "http://127.0.0.1:8181");

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}
const post = (base, p, body) => json(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
const get = (base, p) => json(base + p);
const unwrap = (r) => (r.body && r.body.result !== undefined ? r.body.result : r.body);
/**
 * Finds a field regardless of how many `result` envelopes it sits behind.
 *
 * The phone's automation wraps the desktop's answer, and some desktop handlers
 * return an envelope of their own, so the nesting depth varies by method.
 * Asserting at a fixed depth tests the wrapper rather than the payload — which
 * is exactly how this script first reported a working `approval.list` as broken.
 */
function deepField(value, key, depth = 6) {
  if (!value || typeof value !== "object" || depth < 0) return undefined;
  if (value[key] !== undefined) return value[key];
  return deepField(value.result, key, depth - 1);
}

/**
 * The base URL of a desktop that is actually ANSWERING.
 *
 * A run killed with SIGKILL never removes its discovery file, so the directory
 * accumulates dead entries. Taking the first one hands back a port nothing is
 * listening on, and the failure surfaces much later as a bare "fetch failed"
 * that reads like a broken link rather than a stale file.
 */
async function desktopBaseUrl(workspace) {
  const dir = path.join(workspace, ".agent_party_app", "instances");
  for (let i = 0; i < 60; i += 1) {
    let entries = [];
    try {
      entries = readdirSync(dir)
        .map((name) => path.join(dir, name))
        .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch {}
    for (const entry of entries) {
      try {
        const { baseUrl } = JSON.parse(readFileSync(entry.file, "utf8"));
        const probe = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (probe.ok) return baseUrl;
      } catch {}
    }
    await delay(1000);
  }
  throw new Error("no desktop app answered on any advertised port");
}

async function main() {
  const health = await get(PHONE, "/health").catch(() => null);
  if (!health || health.status !== 200) {
    throw new Error(`No phone automation API at ${PHONE}. Run: adb forward tcp:8181 tcp:8181, with the app running.`);
  }
  console.log(`phone:   ${PHONE}`);
  console.log(`signal:  ${SIGNALING || "(desktop default)"}`);

  // Stable by default, so the desktop keeps one identity across runs.
  //
  // `--fresh-identity` mints a new one instead. That is the path that produced
  // the `internal` connect failure: the phone ends up holding a trust record
  // for a desktop that no longer exists, alongside the one it just paired.
  const userData = process.argv.includes("--fresh-identity")
    ? mkdtempSync(path.join(os.tmpdir(), "agentparty-link-ud-"))
    : path.join(os.tmpdir(), "agentparty-link-ud-stable");
  mkdirSync(userData, { recursive: true });
  const workspace = path.join(os.tmpdir(), "agentparty-link-ws");
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

    console.log("signalling:");
    await post(desktop, "/api/mobile/settings", { enabled: true, ...(SIGNALING ? { signalingUrl: SIGNALING } : {}) });
    let status;
    for (let i = 0; i < 20; i += 1) {
      await delay(1500);
      status = unwrap(await get(desktop, "/api/mobile/status")).status;
      if (status?.signaling === "connected") break;
    }
    assert(status?.signaling === "connected",
      `connected (${status?.signaling}${status?.signalingError ? ` — ${status.signalingError}` : ""})`);
    // The server now rejects any field §3 does not define. If our client sends
    // one, this is where it shows up, and the field name is in the message.
    assert(!/protocol_error/i.test(String(status?.signalingError || "")),
      `no protocol_error from the strict server (${status?.signalingError || "none"})`);
    if (status?.signaling !== "connected") {
      throw new Error("cannot reach the signalling server — refusing to pair, since the phone would store this address permanently");
    }

    console.log("\npairing:");
    const opened = unwrap(await post(desktop, "/api/mobile/pair/open"));
    assert(opened?.ok && typeof opened.qr === "string", "the desktop issued a QR");
    const injected = await post(PHONE, "/pair", { qr: opened.qr });
    const phoneCode = unwrap(injected)?.confirmationCode;
    assert(injected.status === 200 && Boolean(phoneCode), `the phone took the QR and showed a code (${injected.status}, ${phoneCode})`);

    let pairing;
    for (let i = 0; i < 25; i += 1) {
      await delay(1000);
      pairing = unwrap(await get(desktop, "/api/mobile/status")).status?.pairing;
      if (pairing?.phase === "awaitingConfirm" || pairing?.phase === "failed") break;
    }
    assert(pairing?.phase === "awaitingConfirm", `the desktop saw the phone (${pairing?.phase}${pairing?.error ? ` — ${pairing.error}` : ""})`);
    // Presence is not the property under test — a code that exists but differs
    // is exactly the interception this step defends against.
    assert(phoneCode === pairing?.code, `the codes MATCH (phone=${phoneCode}, desktop=${pairing?.code})`);

    await post(desktop, "/api/mobile/pair/confirm");
    const paired = await post(PHONE, "/pair/await", {});
    const trust = unwrap(paired);
    assert(paired.status === 200 && Boolean(trust?.deviceId), `the phone stored the trust record (${trust?.deviceId || paired.status})`);

    console.log("\nsession:");
    const connected = await post(PHONE, "/connect", { deviceId: trust.deviceId });
    assert(connected.status === 200, `the phone opened a session (${connected.status} ${JSON.stringify(unwrap(connected)).slice(0, 140)})`);
    if (connected.status !== 200) {
      // `internal` wraps an exception that is not a LinkFailure, so the wrapped
      // detail is the only thing that names the real cause. Captured at the
      // moment of failure — a later read shows a recovered client and loses it.
      const diagnostics = await get(PHONE, "/diagnostics").catch((e) => ({ body: { error: String(e) } }));
      const state = await get(PHONE, "/status").catch((e) => ({ body: { error: String(e) } }));
      console.log("\n--- phone /diagnostics at failure ---");
      console.log(JSON.stringify(diagnostics.body, null, 1));
      console.log("\n--- phone /status at failure ---");
      console.log(JSON.stringify(state.body, null, 1));
    }

    // A party.list with nobody in it cannot prove anything about displayStatus —
    // that is exactly how the assertion below passed on an empty scratch
    // workspace for several runs.
    //
    // Creating a member also STARTS its session, so the status that comes back
    // is `idle`, off a live session, rather than `not-started`. No turn is sent,
    // so the harness costs a process and nothing else.
    console.log("\nfixture:");
    await post(desktop, "/api/parties", { name: "link-e2e" });
    const made = await post(desktop, "/api/party/members", { name: "probe", requirement: "displayStatus fixture" });
    assert(made.status === 200, `a member exists to read a status from (${made.status} ${JSON.stringify(unwrap(made)).slice(0, 120)})`);

    console.log("\nmethods over the link:");
    const spaces = await post(PHONE, "/rpc", { method: "workspace.list", params: {} });
    const listed = deepField(spaces.body, "workspaces") || [];
    assert(spaces.status === 200 && listed.length > 0, `workspace.list (${spaces.status}, ${listed.length} workspaces)`);
    const uri = listed[0]?.uri;
    assert(Boolean(uri), `an entry carries the round-trippable uri (${uri})`);

    const party = await post(PHONE, "/rpc", { method: "party.list", params: { workspacePath: uri } });
    const members = deepField(party.body, "members") || [];
    assert(party.status === 200, `party.list (${party.status})`);
    // `every` over an empty list is true, so this has to require members first
    // — otherwise a failed party.list reports the property as satisfied.
    assert(members.length > 0 && members.every((m) => typeof m.displayStatus === "string"),
      `members carry displayStatus rather than leaving the phone to derive it (${members.length} members: ${members.map((m) => `${m.name}=${m.displayStatus}`).join(", ")})`);

    const approvals = await post(PHONE, "/rpc", { method: "approval.list", params: {} });
    assert(approvals.status === 200, `approval.list is reachable over the link (${approvals.status})`);
    const pending = deepField(approvals.body, "approvals");
    assert(Array.isArray(pending), `…and returns a list (${JSON.stringify(pending)})`);
    assert(typeof deepField(approvals.body, "seq") === "number", `…carrying the baseline seq the phone filters events against (seq=${deepField(approvals.body, "seq")})`);

    // Over HTTP the `:id` path segment fills this field, so the alias cannot be
    // tested there — only a client coming over the link sends it by name, which
    // is how a phone reading approval.list and answering one got
    // "'id' is required" for a request that was entirely well-formed.
    // The id is deliberately unknown: what is under test is that the parameter
    // ARRIVES, not that some particular approval resolves.
    const aliased = await post(PHONE, "/rpc", { method: "approval.respond", params: { requestId: "no-such-approval", behavior: "deny" } });
    // Asserting the ABSENCE of "'id' is required" would pass on a dead link too
    // — `rpcTimeout` contains neither string. The echoed id can only come back
    // from a desktop that actually read the parameter.
    assert(deepField(aliased.body, "requestId") === "no-such-approval",
      `approval.respond takes requestId, the name every response gives it (${JSON.stringify(unwrap(aliased)).slice(0, 120)})`);

    const nameless = await post(PHONE, "/rpc", { method: "approval.respond", params: { behavior: "deny" } });
    assert(/'id' is required/.test(JSON.stringify(unwrap(nameless))), "…while omitting it entirely is still refused");

    const bogus = await post(PHONE, "/rpc", { method: "definitely.not.a.method", params: {} });
    const code = unwrap(bogus)?.code || unwrap(bogus)?.error?.code || JSON.stringify(unwrap(bogus));
    assert(/method_not_found|methodNotFound/.test(String(code)), `an unregistered method is refused, not silently ignored (${code})`);

    await post(desktop, "/api/window/close", {});
  } finally {
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
  }

  console.log(failures.length ? `\nLINK ROUND TRIP FAILED (${failures.length})` : "\nLINK ROUND TRIP PASSED");
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nLINK ROUND TRIP ERROR: ${error.message}`);
  process.exit(1);
});
