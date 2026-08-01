import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaWorkspace = path.join(os.tmpdir(), "agentparty-live-codex-e2e-workspace");
const qaUserData = path.join(os.tmpdir(), "agentparty-live-codex-e2e-user-data");
const automationPort = Number(process.env.AGENTPARTY_LIVE_E2E_PORT || "") || 48932;
const codexJs = process.env.AGENTPARTY_CODEX_JS || "C:\\Users\\Dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
const model = process.env.AGENTPARTY_LIVE_CODEX_MODEL || "gpt-5.4-mini";

async function main() {
  await removeQaWorkspace();
  await removePath(qaUserData);
  fs.mkdirSync(qaWorkspace, { recursive: true });
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_AUTOMATION_PORT: String(automationPort),
      AGENTPARTY_USER_DATA: qaUserData,
      AGENTPARTY_CODEX_BIN: process.execPath,
      AGENTPARTY_CODEX_ARGS: JSON.stringify([codexJs]),
    },
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    const baseUrl = await waitForApi();
    const health = await getJson(`${baseUrl}/api/health`);
    assert(health.ok, "health ok");

    const windows = await getJson(`${baseUrl}/api/windows`);
    const windowId = windows.windows?.[0]?.id;
    assert(windowId, "test window discovered");
    await postJson(`${baseUrl}/api/windows/${encodeURIComponent(windowId)}/workspace`, {
      workspacePath: qaWorkspace,
    });
    assert(true, "test window switched to QA workspace");

    const session = await postJson(`${baseUrl}/api/sessions`, {
      workspacePath: qaWorkspace,
      selectedHarnessId: "codex",
      selectedProviderId: "openai",
      model,
      permissionMode: "plan",
    });
    assert(session.id, "live codex session created");
    assert(session.snapshot?.model === model, `live codex model is ${model}`);
    assert(session.snapshot?.slashCommands?.some((command) => command.name === "approvals"), "codex slash commands exposed");

    await postJson(`${baseUrl}/api/sessions/${session.id}/send`, {
      text: "Reply with exactly LIVE_CODEX_MINI_PONG. Do not edit files.",
    });
    const firstTurn = await waitForLiveTurn(baseUrl, session.id, 1);
    assert(firstTurn.snapshot?.turnCount >= 1, "live codex first turn completed");
    assert(firstTurn.snapshot?.lastAssistantMessageAt, "live codex first assistant response observed");

    await postJson(`${baseUrl}/api/sessions/${session.id}/send`, {
      text: "Reply with exactly LIVE_CODEX_RESUME_PONG. Do not edit files.",
    });
    const secondTurn = await waitForLiveTurn(baseUrl, session.id, 2);
    assert(secondTurn.snapshot?.turnCount >= 2, "live codex second turn completed on same app-server thread");
    assert(secondTurn.snapshot?.lastAssistantMessageAt, "live codex second assistant response observed");

    await postJson(`${baseUrl}/api/sessions/${session.id}/close`, {});
    await postJson(`${baseUrl}/api/window/close`, {});
    await waitForExit(child);
    console.log(`LIVE CODEX E2E PASSED (${model})`);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

async function waitForLiveTurn(baseUrl, sessionId, expectedTurnCount) {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const state = await getJson(`${baseUrl}/api/state`);
    const session = state.sessions.find((item) => item.id === sessionId);
    if (session?.snapshot?.turnCount >= expectedTurnCount && session.snapshot.status === "idle") {
      return session;
    }
    if (session?.snapshot?.status === "error") {
      throw new Error(session.snapshot.lastError || "Live Codex session entered error state.");
    }
    await delay(1000);
  }
  throw new Error("Live Codex turn did not complete within 120s.");
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const baseUrl = `http://127.0.0.1:${automationPort}`;
    try {
      const health = await getJson(`${baseUrl}/api/health`);
      if (health?.ok) {
        return baseUrl;
      }
    } catch {
      // keep polling
    }
    await delay(500);
  }
  throw new Error("Automation API did not start.");
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function removeQaWorkspace() {
  return removePath(qaWorkspace);
}

async function removePath(targetPath) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) {
        throw error;
      }
      await delay(300);
    }
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("App did not exit after close API.")), 10000);
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
      // Process already exited.
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
