/*
 * Release-gate E2E: launch the real Electron product with a fresh profile and
 * prove the mobile link performs no startup work until it is enabled.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForLiveBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), `agentparty-mobile-off-workspace-${process.pid}`);
const userData = path.join(os.tmpdir(), `agentparty-mobile-off-user-data-${process.pid}`);
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));

  let socketAttempts = 0;
  const signalingProbe = net.createServer((socket) => {
    socketAttempts += 1;
    socket.destroy();
  });
  await new Promise((resolve, reject) => signalingProbe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = signalingProbe.address().port;

  const env = { ...process.env };
  delete env.AGENTPARTY_MOBILE_PIPE;
  Object.assign(env, {
    AGENTPARTY_USER_DATA: userData,
    AGENTPARTY_AUTOMATION_PORT: "",
    AGENTPARTY_MOBILE_SIGNALING_URL: `ws://127.0.0.1:${port}/v1/ws`,
  });
  const launchedAt = Date.now();
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env,
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    const base = await waitForLiveBaseUrl(ws, { since: launchedAt, timeoutMs: 60_000 });
    assert((await get(base, "/api/mobile/settings")).settings.enabled === false, "fresh settings keep mobile disabled");

    const status = await fetch(base + "/api/mobile/status");
    const statusBody = await status.text();
    assert(!status.ok && statusBody.includes("모바일 연결이 비활성화"), "mobile status fails explicitly while disabled");

    await post(base, "/api/navigation", { view: "runtime", tab: "general" });
    await delay(400);
    const tabs = (await post(base, "/api/measure", { selector: ".set-tab", limit: 20 })).elements || [];
    assert(!tabs.some((entry) => entry.text === "모바일 연결"), "the disabled feature has no settings tab");

    await delay(500);
    assert(socketAttempts === 0, "the real gateway opened no signaling socket");
    assert(!fs.existsSync(path.join(userData, "mobile-identity.json")), "the gateway did not initialize its identity store");
    assert(!fs.existsSync(path.join(userData, "mobile-connection-lock.json")), "the gateway did not initialize lock storage");

    const spec = await get(base, "/api/spec");
    assert(spec.endpoints.includes("GET /api/mobile/settings") && spec.endpoints.includes("POST /api/mobile/settings"),
      "automation keeps the explicit opt-in settings surface");

    await post(base, "/api/window/close", {}).catch(() => undefined);
    await waitForExit(child);
  } finally {
    if (child.exitCode === null) killProcessTree(child.pid);
    await new Promise((resolve) => signalingProbe.close(resolve));
    await removePath(ws);
    await removePath(userData);
  }

  console.log(failures.length ? `\nMOBILE DEFAULT-OFF E2E FAILED (${failures.length})` : "\nMOBILE DEFAULT-OFF E2E PASSED");
  process.exit(failures.length ? 1 : 0);
}

async function get(base, route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(base, route, body) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function removePath(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) throw error;
      await delay(300);
    }
  }
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { killProcessTree(child.pid); resolve(); }, 10_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function killProcessTree(pid) {
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}

await main();
