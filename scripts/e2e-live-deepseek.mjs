/*
 * Billed, minimal proof that DeepSeek's OWN API serves both harnesses:
 *   1. Claude Code SDK process + DeepSeek V4 Pro   -> https://api.deepseek.com/anthropic
 *   2. Codex app-server process + DeepSeek V4 Flash -> https://api.deepseek.com/responses
 *
 * Also asserts the honest-unavailability contract: DeepSeek V4 Pro is VISIBLE on
 * the codex harness but disabled, because DeepSeek answers /responses for pro
 * with "available starting early August 2026" (verified live 2026-07-31). A
 * disabled route must never be silently rerouted to OpenRouter.
 *
 * Prompts and output caps are deliberately tiny — this proves routing, not model
 * quality. Needs DEEPSEEK_API_KEY (.env next to the app is picked up).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBaseUrls } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), `agentparty-deepseek-live-ws-${process.pid}`);
const userData = path.join(os.tmpdir(), `agentparty-deepseek-live-ud-${process.pid}`);
const claudeName = "claude-harness-deepseek";
const codexName = "codex-harness-deepseek";
let base = "";
let passed = false;

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
    const created = await post("/api/parties", { name: "live deepseek e2e" });
    const partyId = created.currentPartyId;
    assert(Boolean(partyId), "party created in the real Electron process");
    await post("/api/party/members/main/close", {}).catch(() => {});

    const auth = await getJson("/api/auth");
    const deepseek = (auth.providers || []).find((provider) => provider.id === "deepseek");
    assert(deepseek?.status === "configured", `DeepSeek key reached the app (${deepseek?.source || "no source"})`);

    // The catalog must offer both harnesses, and must say out loud which codex
    // combination DeepSeek does not serve yet.
    const routes = (await getJson("/api/models")).modelRoutes || [];
    const claudeRoute = routes.find((r) => r.harnessId === "claude-code" && r.model === "DeepSeek V4 Pro");
    const codexFlash = routes.find((r) => r.harnessId === "codex" && r.model === "deepseek-v4-flash" && r.modelProvider === "deepseek");
    const codexPro = routes.find((r) => r.harnessId === "codex" && r.model === "deepseek-v4-pro" && r.modelProvider === "deepseek");
    assert(claudeRoute?.enabled === true, "DeepSeek V4 Pro is selectable on the claude-code harness");
    assert(codexFlash?.enabled === true, "DeepSeek V4 Flash is selectable on the codex harness");
    assert(codexPro && codexPro.enabled === false && /Responses API/.test(codexPro.unavailableReason || ""),
      "DeepSeek V4 Pro stays visible on codex with the reason it cannot run there");

    await post("/api/party/members", {
      partyId,
      name: claudeName,
      requirement: "Prove DeepSeek runs inside the Claude Code harness.",
      runtime: "claude-code",
      model: "DeepSeek V4 Pro",
      effort: "high",
      permissionMode: "bypassPermissions",
    });
    const claudeStarted = await post(`/api/party/members/${claudeName}/start`, {
      model: "DeepSeek V4 Pro",
      effort: "high",
      permissionMode: "bypassPermissions",
    });
    assert(claudeStarted.member?.runtime === "claude-code", "DeepSeek member retains runtime=claude-code");

    await post("/api/party/members", {
      partyId,
      name: codexName,
      requirement: "Prove DeepSeek runs inside the Codex harness.",
      runtime: "codex",
      model: "deepseek-v4-flash",
      effort: "low",
      codexPolicy: { sandbox: "read-only", approval: "never", guardian: false },
    });
    const codexStarted = await post(`/api/party/members/${codexName}/start`, {
      model: "deepseek-v4-flash",
      effort: "low",
      codexPolicy: { sandbox: "read-only", approval: "never", guardian: false },
    });
    assert(codexStarted.member?.runtime === "codex", "DeepSeek member retains runtime=codex");

    // Sequential: one billed turn per harness, each attributable.
    await proveTurn(claudeName, "DEEPSEEK_CLAUDE_OK");
    await proveTurn(codexName, "DEEPSEEK_CODEX_OK");

    const state = await getJson("/api/state");
    const routerHealth = await getJsonFrom(state.router?.baseUrl, "/health");
    assert(routerHealth.protocol === "anthropic-messages" && routerHealth.lastRoute?.upstreamEndpoint === "messages",
      "Claude Code + DeepSeek kept Anthropic Messages end-to-end through the provider gateway");
    assert(routerHealth.lastRoute?.targetKind === "deepseek" && routerHealth.lastRoute?.targetModel === "deepseek-v4-pro",
      "the gateway selected DeepSeek's own API for the requested model, with no fallback");

    const codexRaw = readRequiredLog(sessionOf(state, codexName)?.snapshot?.logPath, codexName);
    assert(codexRaw.includes("thread/start") && codexRaw.includes("deepseek-v4-flash") && codexRaw.includes("deepseek"),
      "real DeepSeek turn was spawned by Codex app-server with modelProvider=deepseek");

    console.log("LIVE DEEPSEEK E2E PASSED (Claude Code+V4 Pro/Anthropic Messages, Codex+V4 Flash/Responses; DeepSeek API key billed)");
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
  const appLog = path.join(os.tmpdir(), `agentparty-deepseek-live-${process.pid}.log`);
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

async function proveTurn(name, expected) {
  await post(`/api/party/members/${encodeURIComponent(name)}/message`, {
    text: `Reply with exactly ${expected} and nothing else. Do not use tools.`,
  });
  await waitForAssistant(name, expected);
}

async function waitForAssistant(name, expected) {
  const started = Date.now();
  while (Date.now() - started < 240000) {
    const state = await getJson("/api/state");
    const session = sessionOf(state, name);
    if (session?.snapshot?.status === "error") throw new Error(`${name}: ${session.snapshot.lastError || "session error"}`);
    const transcript = await getJson(`/api/party/members/${encodeURIComponent(name)}/transcript`);
    const text = (transcript.blocks || []).filter((block) => block?.kind === "assistant").map((block) => String(block.text || "")).join("\n");
    if (text.includes(expected)) {
      console.log(`  ok: ${name} produced ${expected} from a real DeepSeek turn`);
      return;
    }
    await delay(750);
  }
  throw new Error(`${name} did not produce ${expected}`);
}

async function getJsonFrom(origin, url) {
  if (!origin) throw new Error(`Missing origin for ${url}`);
  const response = await fetch(origin + url);
  if (!response.ok) throw new Error(`${origin}${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
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
  throw new Error("Automation API did not start for DeepSeek E2E.");
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
