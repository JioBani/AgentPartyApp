/*
 * Full-process live verification for Cursor CLI through the real AgentParty app.
 * Pass --auto for Cursor-managed selection or --grok for the named Grok route.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.join(os.tmpdir(), "agentparty-live-cursor-grok-workspace");
const userData = path.join(os.tmpdir(), "agentparty-live-cursor-grok-user-data");
const useAuto = process.argv.includes("--auto");
const requestedModel = useAuto ? "Auto" : "Grok 4.5";
const expectedReply = useAuto ? "LIVE_CURSOR_AUTO_OK" : "LIVE_CURSOR_GROK_45_OK";
let base = "";

async function main() {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForApi();
    const diagnostics = await get("/api/harnesses/cursor/status");
    assert(diagnostics.installed, "real Cursor CLI is installed");
    if (!useAuto) {
      assert(diagnostics.grok45Models.includes("cursor-grok-4.5-high"), "real CLI lists Cursor Grok 4.5 High");
    }
    const party = await post("/api/parties", { name: `Live Cursor ${requestedModel}` });
    assert(party.ok && party.currentPartyId, "real app party created");
    const created = await post("/api/party/members", {
      name: "cursor-live",
      runtime: "cursor",
      model: requestedModel,
      effort: "high",
      permissionMode: "plan",
      requirement: `Verify a real Cursor ${requestedModel} response through AgentParty.`,
    });
    assert(created.member?.runtime === "cursor", "real Cursor party member created");
    const started = await post("/api/party/members/cursor-live/start", {});
    assert(started.session?.id, "real Cursor member session started");
    await post("/api/party/members/cursor-live/message", {
      text: `Reply with exactly ${expectedReply}. Do not use tools.`,
    });
    await waitForTranscript("cursor-live");
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["cursor-live"]] });
    const screenshot = path.join(os.tmpdir(), `agentparty-live-cursor-${useAuto ? "auto" : "grok"}.png`);
    const capture = await post("/api/capture", { path: screenshot });
    assert(capture.ok && fs.existsSync(screenshot), "captured the real Cursor response in the app UI");
    await post("/api/window/close", {});
    await waitForExit(child);
    console.log(`LIVE CURSOR ${requestedModel.toUpperCase()} APP E2E PASSED`);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

async function waitForTranscript(member) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const transcript = await get(`/api/party/members/${encodeURIComponent(member)}/transcript`);
    const exactAssistantReply = (transcript.blocks || []).some(
      (block) => block.kind === "assistant" && String(block.text || "").trim() === expectedReply,
    );
    if (exactAssistantReply) {
      assert(true, `app transcript contains the exact ${expectedReply} response`);
      return;
    }
    const state = await get("/api/state");
    const session = state.sessions.find((item) => item.snapshot?.model === requestedModel);
    if (session?.snapshot?.status === "error") {
      throw new Error(`Real Cursor ${requestedModel} call failed: ${session.snapshot.lastError || "unknown error"}`);
    }
    await delay(500);
  }
  throw new Error(`Real Cursor ${requestedModel} transcript did not contain ${expectedReply} within 120 seconds.`);
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    base = firstBaseUrl(workspace);
    if (base) {
      try { if ((await get("/api/health")).ok) return; } catch {}
    }
    await delay(300);
  }
  throw new Error("Live Cursor E2E app API did not start.");
}

async function get(url) {
  const response = await fetch(base + url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(url, body) {
  const response = await fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error("App did not exit after close API.")), 10_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    try { process.kill(pid); } catch {}
  }
}

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
