/*
 * Targeted full-process regression for native Claude Code Opus routing.
 * Starts the real Electron app and Claude process, deliberately sends the
 * stale/cross-harness OpenRouter runtime slug through the public model setter,
 * then proves the live turn runs as native opus[1m] without router fallback.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.join(os.tmpdir(), "agentparty-opus-routing-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-opus-routing-e2e-user-data");
let base = "";

async function main() {
  remove(workspace);
  remove(userData);
  fs.mkdirSync(workspace, { recursive: true });

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
    },
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForApi();
    const created = await post("/api/sessions", {
      workspacePath: workspace,
      selectedHarnessId: "claude-code",
      selectedProviderId: "anthropic",
      model: "sonnet",
      permissionMode: "plan",
    });
    assert(created.id, `real Claude Code session created (${created.id})`);

    // Reproduce the exact bad boundary input from the reported failure. Before
    // the fix this restarts into router mode and throws the mapping error.
    await post(`/api/sessions/${created.id}/model`, {
      model: "opus[1m]",
      providerId: "anthropic",
      runtimeModel: "anthropic/claude-opus-4.8",
    });
    await post(`/api/sessions/${created.id}/send`, {
      text: "Reply with exactly OPUS_NATIVE_PONG. Do not use tools.",
    });

    const session = await waitForTurn(created.id);
    assert(String(session.snapshot.model).toLowerCase() === "opus", `snapshot reports Opus (${session.snapshot.model})`);
    assert(!/router mapping|refusing to fall back/i.test(session.snapshot.lastError || ""), "no AgentParty router-mapping error");
    console.log("CLAUDE OPUS ROUTING LIVE E2E PASSED (real process, real turn)");
  } finally {
    killTree(child.pid);
  }
}

async function waitForTurn(sessionId) {
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const state = await get("/api/state");
    const session = state.sessions?.find((item) => item.id === sessionId);
    if (session?.snapshot?.status === "error") {
      throw new Error(session.snapshot.lastError || "Claude session entered error state");
    }
    if (session?.snapshot?.turnCount >= 1 && session.snapshot.status === "idle") {
      const events = JSON.stringify(session.events || []);
      assert(events.includes("OPUS_NATIVE_PONG") || session.snapshot.lastAssistantMessageAt, "real Opus assistant response observed");
      return session;
    }
    await delay(1000);
  }
  throw new Error("Live Opus turn did not complete within 180 seconds");
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    base = firstBaseUrl(workspace);
    if (base) {
      try { if ((await get("/api/health")).ok) return; } catch {}
    }
    await delay(500);
  }
  throw new Error("Automation API did not start");
}

async function get(url) {
  const response = await fetch(base + url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function post(url, body) {
  const response = await fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

function remove(target) { try { fs.rmSync(target, { recursive: true, force: true }); } catch {} }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(value, message) { if (!value) throw new Error(`Assertion failed: ${message}`); console.log(`  ok: ${message}`); }
function killTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}

main().catch((error) => { console.error(error); process.exit(1); });
