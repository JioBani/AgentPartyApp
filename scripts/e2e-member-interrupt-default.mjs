/*
 * Full-process E2E for member-message interrupt inheritance. Runs the real
 * Electron app and drives the same HTTP controller paths used by the UI.
 * Run after `npm run build`.
 */
import { spawn } from "node:child_process";
import http from "node:http";
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
    const seeded = await post("/api/qa/seed", {
      party: "member interrupt e2e",
      members: [{ name: "sender" }, { name: "그록" }, { name: "한글-수신자" }, { name: "target-split" }, { name: "target-runtime" }, { name: "target-member" }, { name: "target-explicit" }, { name: "target-idle" }, { name: "target-sleeping" }],
    });

    const unicodeSend = await callPartyMcpAs("그록", seeded.currentPartyId, "한글-수신자", "한글 발신자와 수신자");
    assert(unicodeSend.ok === true, "standalone party MCP sends between Korean member names without a ByteString header failure");
    const splitMessage = "청크 경계에서도 한글과 🚀가 보존됩니다";
    const split = await postUtf8Split("/api/party/messages", {
      from: "그록", to: "target-split", content: splitMessage,
    }, seeded.currentPartyId);
    assert(split.contentType === "application/json; charset=utf-8", "automation JSON responses declare UTF-8 explicitly");
    assert(split.body?.partyMessage?.from === "그록" && split.body?.partyMessage?.content === splitMessage, "automation JSON preserves Unicode split inside a multibyte code point");

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

function callPartyMcpAs(member, party, to, content) {
  return new Promise((resolve, reject) => {
    const relay = spawn(process.execPath, [path.join(root, "scripts", "agentparty-codex-mcp-server.mjs")], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        AGENTPARTY_AUTOMATION_BASE_URL: base,
        AGENTPARTY_MEMBER: member,
        AGENTPARTY_PARTY: party,
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => finish(new Error(`party MCP timed out: ${stderr}`)), 10_000);
    const finish = (error, value) => {
      clearTimeout(timer);
      relay.kill();
      if (error) reject(error); else resolve(value);
    };
    relay.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    relay.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lineEnd = stdout.indexOf("\n");
      if (lineEnd < 0) return;
      try {
        const response = JSON.parse(stdout.slice(0, lineEnd));
        if (response.error) return finish(new Error(response.error.message));
        const text = response.result?.content?.find((item) => item.type === "text")?.text;
        finish(undefined, JSON.parse(text || "{}"));
      } catch (error) {
        finish(error);
      }
    });
    relay.once("exit", (code) => {
      if (code && code !== 0) finish(new Error(`party MCP exited ${code}: ${stderr}`));
    });
    relay.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send", arguments: { to, content } } })}\n`);
  });
}

function postUtf8Split(pathname, value, party) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  const marker = Buffer.from("그", "utf8");
  const markerAt = bytes.indexOf(marker);
  const splitAt = markerAt + 1;
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(bytes.length),
        "x-agentparty-party": party,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            contentType: response.headers["content-type"],
          });
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.write(bytes.subarray(0, splitAt));
    setTimeout(() => request.end(bytes.subarray(splitAt)), 5);
  });
}

await main();
