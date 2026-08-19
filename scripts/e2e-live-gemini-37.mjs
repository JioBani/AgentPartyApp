/*
 * Billed product E2E for Gemini 3.7 Flash through OpenRouter on both executable
 * harness routes. Launches the real Electron app and drives only its automation
 * API; OPENROUTER_API_KEY must be present in the environment.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = `${process.pid}-${Date.now()}`;
const workspace = path.join(os.tmpdir(), `agentparty-gemini-37-${runId}-workspace`);
const userData = path.join(os.tmpdir(), `agentparty-gemini-37-${runId}-user-data`);
const expected = "GEMINI_37_OPENROUTER_OK";
let base = "";
let child;

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is required for the billed Gemini 3.7 Flash E2E.");
}

try {
  fs.mkdirSync(workspace, { recursive: true });
  child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
    },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  await waitForApi();
  const models = await get("/api/models");
  assert(models.modelRoutes.some((route) => route.harnessId === "claude-code" && route.model === "Gemini 3.7 Flash" && route.runtimeModel === "claude-gemini-3-7-flash"), "Claude Code route is exposed");
  assert(models.modelRoutes.some((route) => route.harnessId === "codex" && route.model === "google/gemini-3.7-flash" && route.modelProvider === "openrouter"), "Codex route is exposed");

  const party = await post("/api/parties", { name: "Gemini 3.7 live E2E" });
  await post("/api/party/members/main/close", {}).catch(() => {});
  await proveTurn(party.currentPartyId, "gemini37-claude", "claude-code", "Gemini 3.7 Flash");
  await proveTurn(party.currentPartyId, "gemini37-codex", "codex", "google/gemini-3.7-flash");

  const state = await get("/api/state");
  const health = await getFrom(state.router?.baseUrl, "/health");
  assert(health.lastRoute?.targetKind === "openrouter" && health.lastRoute?.targetModel === "google/gemini-3.7-flash", "embedded router selected only Gemini 3.7 Flash on OpenRouter");
  console.log("LIVE GEMINI 3.7 E2E PASSED (Claude Code + Codex; OpenRouter, low effort)");
  await post("/api/window/close", {}).catch(() => {});
  await waitForExit(child).catch(() => killTree(child.pid));
} catch (error) {
  if (child?.pid) killTree(child.pid);
  throw error;
} finally {
  removePath(workspace);
  removePath(userData);
}

async function proveTurn(partyId, name, runtime, model) {
  const policy = runtime === "codex"
    ? { codexPolicy: { sandbox: "read-only", approval: "never", guardian: false } }
    : { permissionMode: "bypassPermissions" };
  await post("/api/party/members", { partyId, name, requirement: "Minimal live model verification", runtime, model, effort: "low", ...policy });
  await post(`/api/party/members/${name}/start`, { model, effort: "low", ...policy });
  await post(`/api/party/members/${name}/message`, { text: `Reply exactly ${expected}. Do not use tools.` });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const transcript = await get(`/api/party/members/${name}/transcript`);
    const text = (transcript.blocks || []).filter((block) => block.kind === "assistant").map((block) => String(block.text || "")).join("\n");
    if (text.includes(expected)) {
      console.log(`  ok: ${runtime} produced ${expected}`);
      return;
    }
    const status = await post(`/api/party/members/${name}/status`, {});
    const member = (status.members || []).find((item) => item.name === name);
    if (member?.status === "error") throw new Error(`${name}: ${member.lastError || "session error"}`);
    await delay(750);
  }
  throw new Error(`${name} did not produce ${expected}.`);
}

async function waitForApi() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    base = firstBaseUrl(workspace);
    if (base) {
      try { if ((await get("/api/health")).ok) return; } catch {}
    }
    await delay(500);
  }
  throw new Error("AgentParty automation API did not start.");
}

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function getFrom(origin, route) {
  const response = await fetch(origin + route);
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(route, body) {
  const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

function waitForExit(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("AgentParty did not exit.")), 10_000);
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function killTree(pid) {
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}

function removePath(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(value, message) { if (!value) throw new Error(`Assertion failed: ${message}`); console.log(`  ok: ${message}`); }
