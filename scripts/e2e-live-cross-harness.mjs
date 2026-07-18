/*
 * Billed, minimal proof of TRUE harness x model cross-routing:
 *   1. Claude Code SDK process + GPT-5.4 mini through Codex/ChatGPT OAuth
 *   2. Codex app-server process + Claude Sonnet through Claude OAuth
 *
 * Exactly one short low-effort turn per combination. The isolated app process
 * uses the local CLIProxyAPI and deletes its temporary userData/workspace afterward.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBaseUrls } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), `agentparty-cross-live-ws-${process.pid}`);
const userData = path.join(os.tmpdir(), `agentparty-cross-live-ud-${process.pid}`);
const gptName = "claude-harness-gpt";
const claudeName = "codex-harness-claude";
let base = "";
let passed = false;
const requestedSide = String(process.env.AGENTPARTY_CROSS_E2E_SIDE || "both").toLowerCase();
const runGpt = requestedSide === "both" || requestedSide === "gpt";
const runClaude = requestedSide === "both" || requestedSide === "claude";

async function main() {
  remove(ws);
  remove(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    workspacePath: ws,
    debugEnabled: true,
  }, null, 2));

  const child = launchApp();
  try {
    await waitForApi();
    const created = await post("/api/parties", { name: "live cross harness e2e" });
    const partyId = created.currentPartyId;
    assert(Boolean(partyId), "party created in the real Electron process");
    await post("/api/party/members/main/close", {}).catch(() => {});

    const auth = await getJson("/api/auth/subscriptions");
    if (runGpt) assert(auth.codex?.available, `Codex OAuth is available (${auth.codex?.loginCommand || "login command missing"})`);
    if (runClaude) assert(auth.claude?.available, `Claude OAuth is available (${auth.claude?.loginCommand || "login command missing"})`);

    if (runGpt) await post("/api/party/members", {
      partyId,
      name: gptName,
      requirement: "Prove GPT runs inside the Claude Code harness.",
      runtime: "claude-code",
      model: "GPT-5.4 mini",
      effort: "low",
      permissionMode: "plan",
    });
    const gptStarted = runGpt ? await post(`/api/party/members/${gptName}/start`, {
      model: "GPT-5.4 mini",
      effort: "low",
      permissionMode: "plan",
    }) : undefined;

    if (runClaude) await post("/api/party/members", {
      partyId,
      name: claudeName,
      requirement: "Prove Claude runs inside the Codex harness.",
      runtime: "codex",
      model: "Sonnet",
      effort: "low",
      codexPolicy: { sandbox: "read-only", approval: "never", guardian: false },
    });
    const claudeStarted = runClaude ? await post(`/api/party/members/${claudeName}/start`, {
      model: "Sonnet",
      effort: "low",
      codexPolicy: { sandbox: "read-only", approval: "never", guardian: false },
    }) : undefined;

    if (runGpt) {
      assert(gptStarted.member?.runtime === "claude-code", "GPT member retains runtime=claude-code");
      assert(gptStarted.session?.snapshot?.permissionMode === "plan" && !gptStarted.session?.snapshot?.codexPolicy, "GPT member exposes Claude permission semantics, not Codex policy");
    }
    if (runClaude) {
      assert(claudeStarted.member?.runtime === "codex", "Claude member retains runtime=codex");
      assert(claudeStarted.session?.snapshot?.model === "claude-sonnet-4-6" && Boolean(claudeStarted.session?.snapshot?.codexPolicy), "Claude subscription model is bound to a Codex adapter session");
    }

    if (runGpt) await post(`/api/party/members/${gptName}/message`, {
      text: "Reply exactly CROSS_GPT_OK. Do not use tools.",
    });
    if (runClaude) await post(`/api/party/members/${claudeName}/message`, {
      text: "Reply exactly CROSS_CLAUDE_OK. Do not use tools.",
    });
    await Promise.all([
      ...(runGpt ? [waitForAssistant(gptName, "CROSS_GPT_OK")] : []),
      ...(runClaude ? [waitForAssistant(claudeName, "CROSS_CLAUDE_OK")] : []),
    ]);

    const state = await getJson("/api/state");
    if (runGpt) {
      const gptSession = sessionOf(state, gptName);
      const gptRaw = readRequiredLog(gptSession?.snapshot?.logPath, gptName);
      assert(gptRaw.includes("spawn_sdk_query") && gptRaw.includes("claude-gpt-5.4-mini"), "real GPT turn was spawned by Claude Code with the subscription-router alias");
    }
    if (runClaude) {
      const claudeSession = sessionOf(state, claudeName);
      const claudeRaw = readRequiredLog(claudeSession?.snapshot?.logPath, claudeName);
      assert(claudeRaw.includes("thread/start") && claudeRaw.includes("claude-sonnet-4-6") && claudeRaw.includes("claude-subscription"), "real Claude turn was spawned by Codex app-server with modelProvider=claude-subscription");
    }

    console.log(`LIVE CROSS-HARNESS E2E PASSED (${runGpt ? "Claude Code+GPT mini" : ""}${runGpt && runClaude ? ", " : ""}${runClaude ? "Codex+Sonnet" : ""}; low effort, subscription OAuth)`);
    await closeApp(child);
    passed = true;
  } catch (error) {
    killTree(child?.pid);
    throw error;
  } finally {
    if (!passed && process.env.AGENTPARTY_KEEP_E2E_ARTIFACTS === "1") {
      console.error(`retained failed E2E workspace: ${ws}`);
      console.error(`retained failed E2E userData: ${userData}`);
    } else {
      remove(ws);
      remove(userData);
    }
  }
}

function launchApp() {
  const appLog = path.join(os.tmpdir(), `agentparty-cross-live-${process.pid}.log`);
  const fd = fs.openSync(appLog, "w");
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
  console.log(`app output -> ${appLog}`);
  return child;
}

async function waitForAssistant(name, expected) {
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const state = await getJson("/api/state");
    const session = sessionOf(state, name);
    if (session?.snapshot?.status === "error") throw new Error(`${name}: ${session.snapshot.lastError || "session error"}`);
    const transcript = await getJson(`/api/party/members/${encodeURIComponent(name)}/transcript`);
    const text = (transcript.blocks || []).filter((block) => block?.kind === "assistant").map((block) => String(block.text || "")).join("\n");
    if (text.includes(expected)) {
      console.log(`  ok: ${name} produced ${expected}`);
      return;
    }
    await delay(750);
  }
  throw new Error(`${name} did not produce ${expected}`);
}

function sessionOf(state, name) {
  const member = (state.party?.members || []).find((item) => item.name === name);
  return member?.sessionId ? state.sessions.find((item) => item.id === member.sessionId) : undefined;
}

function readRequiredLog(file, name) {
  if (!file || !fs.existsSync(file)) throw new Error(`${name} did not expose a debug harness log.`);
  return fs.readFileSync(file, "utf8");
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 90000) {
    for (const url of discoverBaseUrls(ws)) {
      base = url;
      try { if ((await getJson("/api/health")).ok) return; } catch {}
    }
    await delay(500);
  }
  throw new Error("Automation API did not start for cross-harness E2E.");
}

async function getJson(url) {
  const response = await fetch(base + url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(url, body) {
  const response = await fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function closeApp(child) {
  await post("/api/window/close", {}).catch(() => {});
  await new Promise((resolve) => {
    const timer = setTimeout(() => { killTree(child?.pid); resolve(); }, 15000);
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
