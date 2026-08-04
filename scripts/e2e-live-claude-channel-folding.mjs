/*
 * Billed product E2E for Claude's party-send event lifecycle.
 *
 * Starts the real Electron app and real Claude Code harness, asks Opus 5 for one
 * party send, then verifies the renderer-persisted transcript contains one
 * complete channel card and no transport-level tool_result/empty card. Finally
 * it restarts the app and verifies the same cleaned transcript is restored.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBaseUrls } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), `agentparty-claude-channel-ws-${process.pid}`);
const userData = path.join(os.tmpdir(), `agentparty-claude-channel-ud-${process.pid}`);
const sender = "sender";
const receiver = "sink";
const marker = "CHANNEL_FOLD_E2E";
let base = "";

async function main() {
  remove(ws);
  remove(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws, debugEnabled: true }, null, 2));

  let child = launchApp();
  try {
    await waitForApi();
    const windows = await getJson("/api/windows");
    assert(String(windows.windows?.[0]?.workspacePath || "").toLowerCase() === ws.toLowerCase(), "real app serves the isolated QA workspace");

    const auth = await getJson("/api/auth/subscriptions");
    assert(auth.claude?.available, "Claude subscription authentication is available");

    const created = await post("/api/parties", { name: "Claude channel folding E2E" });
    const partyId = created.currentPartyId;
    assert(Boolean(partyId), "QA party created through the automation API");

    await post("/api/party/members", {
      partyId,
      name: receiver,
      requirement: "Receive one E2E message.",
      runtime: "claude-code",
      model: "claude-sonnet-4-6",
      permissionMode: "plan",
    });
    await post(`/api/party/members/${receiver}/start`, { model: "claude-sonnet-4-6", permissionMode: "plan" });

    await post("/api/party/members", {
      partyId,
      name: sender,
      requirement: "Send exactly the requested party message, then stop.",
      runtime: "claude-code",
      model: "claude-opus-5[1m]",
      permissionMode: "bypassPermissions",
    });
    await post(`/api/party/members/${sender}/start`, { model: "claude-opus-5[1m]", permissionMode: "bypassPermissions" });
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [[sender], [receiver]] });

    await post(`/api/party/members/${sender}/message`, {
      text: `Use the party send tool exactly once: send to ${receiver} with content exactly ${marker}. Then reply exactly DONE.`,
    });
    const first = await waitForCleanTranscript();
    assertClean(first, "live Claude turn");

    const shot = path.join(os.tmpdir(), `agentparty-claude-channel-${process.pid}.png`);
    const capture = await post("/api/capture", { path: shot });
    assert(capture.ok && fs.existsSync(shot), `workbench captured after the real send (${shot})`);

    await closeApp(child);
    child = launchApp();
    base = "";
    await waitForApi();
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [[sender], [receiver]] });
    const restored = await waitForCleanTranscript();
    assertClean(restored, "app restart restore");

    await closeApp(child);
    child = undefined;
    console.log("LIVE CLAUDE CHANNEL FOLDING E2E PASSED (real Electron + Opus 5 send + restart restore)");
  } finally {
    killTree(child?.pid);
    remove(ws);
    remove(userData);
  }
}

function launchApp() {
  const logPath = path.join(os.tmpdir(), `agentparty-claude-channel-${process.pid}-${Date.now()}.log`);
  const fd = fs.openSync(logPath, "w");
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws], {
    cwd: root,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
    windowsHide: true,
  });
  console.log(`app output -> ${logPath}`);
  return child;
}

async function waitForCleanTranscript() {
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    const response = await getJson(`/api/party/members/${sender}/transcript`);
    const blocks = response.blocks || [];
    const channels = blocks.filter((block) => block?.kind === "channel" && block.direction === "out" && block.text === marker);
    const assistantDone = blocks.some((block) => block?.kind === "assistant" && String(block.text || "").includes("DONE"));
    if (channels.length === 1 && channels[0].state === "ok" && assistantDone) {
      return blocks;
    }
    await delay(750);
  }
  throw new Error("Sender transcript never reached one successful channel card plus DONE.");
}

function assertClean(blocks, phase) {
  const channels = blocks.filter((block) => block?.kind === "channel" && block.direction === "out");
  assert(channels.filter((block) => block.text === marker && block.to === receiver).length === 1, `${phase}: one complete sender -> sink card`);
  assert(!channels.some((block) => !block.to || !block.text), `${phase}: no empty member -> ? card`);
  assert(!blocks.some((block) => block?.kind === "tool" && block.name === "tool_result"), `${phase}: no raw tool_result card`);
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    for (const url of discoverBaseUrls(ws)) {
      base = url;
      try {
        if ((await getJson("/api/health")).ok) return;
      } catch {}
    }
    await delay(500);
  }
  throw new Error("Automation API did not start for Claude channel E2E.");
}

async function getJson(url) {
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

async function closeApp(child) {
  await post("/api/window/close", {}).catch(() => {});
  await new Promise((resolve) => {
    const timer = setTimeout(() => { killTree(child?.pid); resolve(); }, 15_000);
    child?.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function killTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}

function remove(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((error) => { console.error(error); process.exit(1); });
