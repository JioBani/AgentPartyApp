/*
 * Live GPT-mini e2e for #9: a real Codex party member must see and call the
 * app-hosted agentparty-app tool surface. This launches the real app, creates a
 * Codex member, asserts /api/sessions/:id/mcp exposes agentparty-app, then sends
 * one real mini-model turn requiring member-permission. This proves a member can
 * change another member's persisted permission through the actual MCP/API path.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = "C:\\Project\\AgentPartyApp";
const ws = path.join(os.tmpdir(), "agentparty-live-codex-party-tools-workspace");
const userData = path.join(os.tmpdir(), "agentparty-live-codex-party-tools-user-data");
const port = Number(process.env.AGENTPARTY_LIVE_PARTY_TOOLS_PORT || "") || 48943;
const base = `http://127.0.0.1:${port}`;
const codexJs = process.env.AGENTPARTY_CODEX_JS || "C:\\Users\\Dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
const model = process.env.AGENTPARTY_LIVE_CODEX_MODEL || "gpt-5.4-mini";
const memberName = "codexparty";
const targetName = "permission-target";
const createdName = "agent-created-codex";
const createdPolicy = { sandbox: "read-only", approval: "never", guardian: true };
const mcpCallLog = path.join(os.tmpdir(), `agentparty-live-codex-party-tools-${process.pid}.jsonl`);

async function main() {
  await removePath(ws);
  await removePath(userData);
  await removePath(mcpCallLog);
  fs.mkdirSync(ws, { recursive: true });

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_AUTOMATION_PORT: String(port),
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      AGENTPARTY_CODEX_BIN: process.execPath,
      AGENTPARTY_CODEX_ARGS: JSON.stringify([codexJs]),
      AGENTPARTY_CODEX_MCP_OUT: mcpCallLog,
    },
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "health ok");
    const windows = await getJson("/api/windows");
    const windowId = windows.windows?.[0]?.id;
    assert(windowId, "test window discovered");
    await post(`/api/windows/${encodeURIComponent(windowId)}/workspace`, { workspacePath: ws });
    await post("/api/navigation", { view: "workbench" });

    await post("/api/parties", { name: "live codex party tools e2e" });
    await post("/api/party/members", {
      name: targetName,
      requirement: "Permission mutation target.",
      runtime: "claude-code",
      model: "sonnet",
      permissionMode: "default",
    });
    await post("/api/party/members", {
      name: memberName,
      requirement: "Call AgentParty app party tools when instructed.",
      role: "Codex party tool live e2e member",
      runtime: "codex",
      model,
    });
    const started = await post(`/api/party/members/${memberName}/start`, {
      model,
      permissionMode: "plan",
      codexPolicy: { sandbox: "read-only", approval: "on-request", guardian: false },
    });
    const sessionId = await waitForMemberSession(started.session?.id);
    assert(sessionId, `live Codex party member session started (${sessionId})`);

    const mcp = await waitForPartyMcp(sessionId);
    const partyServer = mcp.servers?.find((server) => server.name === "agentparty-app");
    assert(partyServer, "Codex MCP snapshot exposes agentparty-app");
    assert(partyServer.tools?.some((tool) => tool.name === "member-permission" || tool.name === "mcp__agentparty-app__member-permission"), "Codex MCP snapshot exposes member-permission");
    assert(partyServer.tools?.some((tool) => tool.name === "member-create" || tool.name === "mcp__agentparty-app__member-create"), "Codex MCP snapshot exposes member-create");
    assert(partyServer.tools?.some((tool) => tool.name === "list-models" || tool.name === "mcp__agentparty-app__list-models"), "Codex MCP snapshot exposes list-models");

    await post(`/api/party/members/${memberName}/message`, {
      text: [
        "This is a live AgentParty tool test.",
        "Perform these three party-tool calls in order, exactly once each:",
        "(1) call `mcp__agentparty-app__list-models` with {}.",
        `(2) call \`mcp__agentparty-app__member-create\` with name=${createdName}, role='AI-created initial permission QA', harness=codex, model=${model}, effort=low, and codexPolicy=${JSON.stringify(createdPolicy)}.`,
        `(3) call \`mcp__agentparty-app__member-permission\` with name=${targetName} and permissionMode=plan.`,
        "After the tool result arrives, reply with exactly LIVE_CODEX_PARTY_TOOL_OK.",
        "Do not edit files and do not run shell commands.",
      ].join(" "),
    });

    const calls = await waitForPartyTools(sessionId);
    assert(calls.some((call) => call.member === memberName && call.name === "list-models"), "MCP call log contains a real list-models call from the Codex member");
    assert(calls.some((call) => call.member === memberName && call.name === "member-create"), "MCP call log contains a real member-create call from the Codex member");
    assert(calls.some((call) => call.member === memberName && call.name === "member-permission"), "MCP call log contains a real member-permission call from the Codex member");
    const changed = await getJson("/api/party");
    const agentCreated = changed.members?.find((item) => item.name === createdName);
    assert(agentCreated?.runtime === "codex" && agentCreated?.model === model && agentCreated?.effort === "low", "real model created the requested Codex member through the product tool path");
    assert(JSON.stringify(agentCreated?.codexPolicy) === JSON.stringify(createdPolicy), "AI-created member keeps its explicit initial Codex permission policy");
    assert(changed.members?.find((item) => item.name === targetName)?.permissionMode === "plan", "real model tool call persisted the other member's permission");

    await post(`/api/party/members/${memberName}/close`, {});
    console.log(`LIVE CODEX PARTY TOOLS E2E PASSED (${model})`);
    await closeWindow();
    await waitForExitOrKill(child);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

async function waitForMemberSession(initialSessionId) {
  const started = Date.now();
  let last = initialSessionId || "";
  while (Date.now() - started < 30000) {
    const state = await getJson("/api/state");
    const member = (state.party?.members || []).find((item) => item.name === memberName);
    if (member?.sessionId) {
      last = member.sessionId;
      const session = state.sessions.find((item) => item.id === last);
      if (session?.snapshot?.status && session.snapshot.status !== "created") {
        return last;
      }
    }
    await delay(500);
  }
  return last;
}

async function waitForPartyMcp(sessionId) {
  const started = Date.now();
  let last;
  while (Date.now() - started < 30000) {
    last = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/mcp`);
    const partyServer = last.servers?.find((server) => server.name === "agentparty-app");
    if (partyServer?.tools?.some((tool) => tool.name === "member-permission" || tool.name === "mcp__agentparty-app__member-permission")) {
      return last;
    }
    await delay(1000);
  }
  throw new Error(`agentparty-app MCP tools did not become ready: ${JSON.stringify(last)}`);
}

async function waitForPartyTools(sessionId) {
  const started = Date.now();
  let lastCalls = [];
  while (Date.now() - started < 180000) {
    const state = await getJson("/api/state");
    const session = state.sessions.find((item) => item.id === sessionId);
    if (session?.snapshot?.status === "error") {
      throw new Error(session.snapshot.lastError || "Live Codex party tool session entered error state.");
    }
    lastCalls = readCallLog();
    const memberCalls = lastCalls.filter((call) => call.member === memberName);
    if (["list-models", "member-create", "member-permission"].every((name) => memberCalls.some((call) => call.name === name)) && session?.snapshot?.status === "idle") {
      return lastCalls;
    }
    await delay(1000);
  }
  throw new Error(`Live Codex did not complete the party tool call within 180s. Last MCP calls: ${JSON.stringify(lastCalls).slice(0, 2000)}`);
}

function readCallLog() {
  try {
    return fs.readFileSync(mcpCallLog, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      if ((await getJson("/api/health")).ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await delay(500);
  }
  throw new Error("Automation API did not start.");
}

async function getJson(url) {
  const response = await fetch(base + url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function post(url, body) {
  const response = await fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function removePath(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) {
        return;
      }
      await delay(300);
    }
  }
}

async function closeWindow() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(base + "/api/window/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
  } catch {
    // Closing the only window can cut the HTTP response short; cleanup below
    // observes the process exit and kills if needed.
  } finally {
    clearTimeout(timer);
  }
}

function waitForExitOrKill(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      killProcessTree(child.pid);
      resolve();
    }, 10000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function killProcessTree(pid) {
  if (!pid) {
    return;
  }
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    try {
      process.kill(pid);
    } catch {
      // already exited
    }
  }
}

function assert(value, message) {
  if (!value) {
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ok: ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
