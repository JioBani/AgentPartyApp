/*
 * Full-process E2E for member-message interrupt inheritance. Runs the real
 * Electron app and drives the same HTTP controller paths used by the UI.
 * Run after `npm run build`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForLiveBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-member-interrupt-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-member-interrupt-e2e-user-data");
const failures = [];
let base = "";
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

async function main() {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));

  const launchedAt = Date.now();
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_USER_DATA: userData, AGENTPARTY_AUTOMATION_PORT: "" },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    base = await waitForLiveBaseUrl(ws, { since: launchedAt, timeoutMs: 20_000 });
    if (!base) throw new Error("real app did not advertise a live automation endpoint");
    assert((await get("/api/health")).ok, `real app is up at ${base}`);
    await post("/api/qa/seed", {
      party: "member interrupt e2e",
      members: [{ name: "sender" }, { name: "target-runtime" }, { name: "target-member" }, { name: "target-explicit" }, { name: "target-idle" }, { name: "target-sleeping" }],
    });

    const runtime = await post("/api/settings", { memberMessaging: { interruptOnSend: true } });
    assert(runtime.memberMessaging?.interruptOnSend === true, "Runtime default persists as interrupt");
    await workingTarget("target-runtime");
    let sent = await post("/api/party/messages", { from: "sender", to: "target-runtime", content: "runtime-default" });
    assert(sent.queued === true && sent.queue?.items?.find((item) => item.text === "runtime-default")?.cutIn === true, "omitted value inherits Runtime and cuts in");

    const override = await post("/api/party/members/sender/outbound-interrupt", { outboundInterrupt: false });
    assert(override.member?.outboundInterrupt === false, "member queue override persists");
    await workingTarget("target-member");
    sent = await post("/api/party/messages", { from: "sender", to: "target-member", content: "member-queue" });
    assert(sent.queue?.items?.find((item) => item.text === "member-queue")?.cutIn !== true, "member false override beats Runtime true");

    await workingTarget("target-explicit");
    sent = await post("/api/party/messages", { from: "sender", to: "target-explicit", content: "explicit", interrupt: true });
    assert(sent.queue?.items?.find((item) => item.text === "explicit")?.cutIn === true, "explicit true beats member false override");

    // An interrupt preference is a conditional policy, not an instruction to
    // stop the turn this message itself creates. Idle, sleeping and unstarted
    // targets have no arrival-time turn and must never be interrupted.
    sent = await post("/api/party/messages", { from: "sender", to: "target-idle", content: "idle-direct", interrupt: true });
    assert(sent.partyMessage?.delivered === true && sent.queued !== true, "explicit interrupt sends normally when the target is idle");

    const slept = await post("/api/party/members/target-sleeping/sleep", {});
    assert(slept.member?.status === "sleeping", "idle target enters sleeping state for the wake-up check");
    sent = await post("/api/party/messages", { from: "sender", to: "target-sleeping", content: "wake-without-stop", interrupt: true });
    assert(sent.queued === true && sent.queue?.items?.find((item) => item.text === "wake-without-stop")?.cutIn !== true, "sleeping target wakes with a normal queued message, never an interrupt");

    await post("/api/party/members", { name: "target-unstarted", requirement: "unstarted e2e target" });
    sent = await post("/api/party/messages", { from: "sender", to: "target-unstarted", content: "start-without-stop", interrupt: true });
    assert(sent.partyMessage?.delivered === true && sent.queued !== true, "unstarted target starts and receives without being interrupted");

    const inherited = await post("/api/party/members/sender/outbound-interrupt", { outboundInterrupt: null });
    assert(inherited.member && !("outboundInterrupt" in inherited.member), "null clears the override back to inherit");

    await post("/api/window/close", {}).catch(() => undefined);
    await waitForExit(child);
  } catch (error) {
    killTree(child.pid);
    throw error;
  }

  console.log(failures.length ? `\nMEMBER INTERRUPT E2E FAILED (${failures.length})` : "\nMEMBER INTERRUPT E2E PASSED");
  process.exitCode = failures.length ? 1 : 0;
}

async function workingTarget(name) {
  await post(`/api/qa/members/${name}/emit`, { status: "working" });
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function request(method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${method} ${pathname}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}
const get = (pathname) => request("GET", pathname);
const post = (pathname, body = {}) => request("POST", pathname, body);

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function killTree(pid) {
  if (!pid) return;
  spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
}

await main();
