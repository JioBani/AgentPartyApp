/*
 * LIVE WSL Codex party-tool e2e (gpt-5.6-luna by default).
 *
 * Proves the actual fix: a real Codex member running INSIDE a WSL distro calls
 * an agentparty-app party tool and it reaches the app — the path that used to
 * fail with "-32603: fetch failed" because the in-distro MCP server had no
 * reachable automation API. Now the headless engine serves the automation API on
 * the distro's own loopback (see engineServerEntry.ts).
 *
 * Verification is two-signal:
 *   1. The in-distro MCP call log (forwarded via WSLENV) records a real `list`
 *      call from the member — the tool was invoked over the real WSL path.
 *   2. The member's transcript contains NO "fetch failed" / -32603 and the model
 *      produced the post-tool sentinel — the tool RESULT came back good.
 *
 * Requires: a running WSL distro with node + an authenticated `codex` CLI. Spends
 * real model tokens. Config via env:
 *   AGENTPARTY_WSL_DISTRO   (default Ubuntu-20.04)
 *   AGENTPARTY_LIVE_CODEX_MODEL (default gpt-5.6-luna)
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distro = process.env.AGENTPARTY_WSL_DISTRO || "Ubuntu-20.04";
const model = process.env.AGENTPARTY_LIVE_CODEX_MODEL || "gpt-5.6-luna";
const port = Number(process.env.AGENTPARTY_LIVE_WSL_PORT || "") || 48947;
const base = `http://127.0.0.1:${port}`;
const userData = path.join(os.tmpdir(), "agentparty-live-wsl-codex-user-data");
const memberName = "luna";
const nonce = `wsl${Date.now().toString(36)}`;
const sentinel = `WSL_CODEX_TOOL_OK_${nonce}`;
// Distro-side paths (posix). Unique per run.
const wsWorkspace = `/tmp/agentparty-wsl-live-${process.pid}`;
const wsMcpOut = `/tmp/agentparty-wsl-mcp-${process.pid}.jsonl`;
const wsWorkspaceUri = `wsl+${distro}:${wsWorkspace}`;

function wsl(args) {
  return execFileSync("wsl.exe", ["-d", distro, "-e", ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

async function main() {
  // Fresh distro workspace + clean call log.
  wsl(["bash", "-lc", `rm -rf "${wsWorkspace}" "${wsMcpOut}"; mkdir -p "${wsWorkspace}"`]);
  await removePath(userData);

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
      // Distro path; forwarded into the distro by wslEngine via WSLENV so the
      // in-distro MCP server writes its call log there. NOT a Windows path.
      AGENTPARTY_CODEX_MCP_OUT: wsMcpOut,
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

    // Point the window at the WSL workspace → the app spins up the WSL remote
    // engine (deploys the freshly built engine bundle + party MCP script).
    await post(`/api/windows/${encodeURIComponent(windowId)}/workspace`, { workspacePath: wsWorkspaceUri });
    await post("/api/navigation", { view: "workbench" });
    console.log(`  … WSL engine starting for ${wsWorkspaceUri} (first run provisions the SDK; allow time)`);

    await post("/api/parties", { name: "live wsl codex party tools e2e" });
    await post("/api/party/members", {
      name: memberName,
      requirement: "Call AgentParty app party tools when instructed.",
      role: "WSL Codex party tool live e2e member",
      runtime: "codex",
      model,
    });
    const started = await post(`/api/party/members/${memberName}/start`, {
      model,
      permissionMode: "plan",
      codexPolicy: { sandbox: "read-only", approval: "on-request", guardian: false },
    });
    const sessionId = await waitForMemberSession(started.session?.id);
    assert(sessionId, `live WSL Codex member session started (${sessionId})`);

    const mcp = await waitForPartyMcp(sessionId);
    const partyServer = mcp.servers?.find((s) => s.name === "agentparty-app");
    assert(partyServer, "in-distro Codex MCP snapshot exposes agentparty-app");
    assert(partyServer.tools?.some((t) => t.name === "list" || t.name === "mcp__agentparty-app__list"), "MCP snapshot exposes the list tool");

    await post(`/api/party/members/${memberName}/message`, {
      text: [
        "This is a live AgentParty tool test.",
        "Call the party tool `mcp__agentparty-app__list` exactly once.",
        `If it returns a members list, reply with exactly ${sentinel}.`,
        "If the tool errors, reply with exactly WSL_CODEX_TOOL_ERR followed by the error text.",
        "Do not edit files and do not run shell commands.",
      ].join(" "),
    });

    const { calls, idle } = await waitForToolAndIdle(sessionId);
    assert(calls.some((c) => c.member === memberName && c.name === "list"), "in-distro MCP call log records a real `list` call from the WSL Codex member");

    // Definitive success/failure: the tool RESULT as Codex saw it.
    const transcript = await getJson(`/api/party/members/${encodeURIComponent(memberName)}/transcript`).catch(() => ({}));
    const transcriptText = JSON.stringify(transcript);
    assert(!/fetch failed|-32603/i.test(transcriptText), "member transcript contains NO 'fetch failed' / -32603 (the bug is gone)");
    const sawSentinel = transcriptText.includes(sentinel);
    assert(sawSentinel, `member replied with the post-tool success sentinel (${sentinel}) — tool result came back good`);
    assert(idle, "session settled (idle) without error");

    await post(`/api/party/members/${memberName}/close`, {}).catch(() => undefined);
    console.log(`\nLIVE WSL CODEX PARTY TOOLS E2E PASSED (${model})`);
    await closeWindow();
    await waitForExitOrKill(child);
  } catch (error) {
    // Surface the last known session error + any call log for debugging.
    try { console.error("  last MCP call log:\n", readDistroCallLog().map((c) => JSON.stringify(c)).join("\n")); } catch { /* none */ }
    killProcessTree(child.pid);
    throw error;
  } finally {
    try { wsl(["bash", "-lc", `rm -rf "${wsWorkspace}" "${wsMcpOut}"`]); } catch { /* best effort */ }
  }
}

function readDistroCallLog() {
  try {
    return wsl(["bash", "-lc", `cat "${wsMcpOut}" 2>/dev/null || true`])
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitForToolAndIdle(sessionId) {
  const start = Date.now();
  let calls = [];
  let idle = false;
  while (Date.now() - start < 240000) {
    const state = await getJson("/api/state").catch(() => ({}));
    const session = (state.sessions || []).find((s) => s.id === sessionId);
    if (session?.snapshot?.status === "error") {
      throw new Error(session.snapshot.lastError || "WSL Codex session entered error state.");
    }
    idle = session?.snapshot?.status === "idle";
    calls = readDistroCallLog();
    const hasList = calls.some((c) => c.member === memberName && c.name === "list");
    if (hasList && idle) {
      return { calls, idle };
    }
    await delay(1500);
  }
  return { calls, idle };
}

async function waitForMemberSession(initialSessionId) {
  const start = Date.now();
  let last = initialSessionId || "";
  while (Date.now() - start < 120000) {
    const state = await getJson("/api/state").catch(() => ({}));
    const member = (state.party?.members || []).find((m) => m.name === memberName);
    if (member?.sessionId) {
      last = member.sessionId;
      const session = (state.sessions || []).find((s) => s.id === last);
      if (session?.snapshot?.status && session.snapshot.status !== "created") {
        return last;
      }
    }
    await delay(1000);
  }
  return last;
}

async function waitForPartyMcp(sessionId) {
  const start = Date.now();
  let last;
  while (Date.now() - start < 120000) {
    last = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/mcp`).catch(() => ({}));
    const partyServer = last.servers?.find((s) => s.name === "agentparty-app");
    if (partyServer?.tools?.some((t) => t.name === "list" || t.name === "mcp__agentparty-app__list")) {
      return last;
    }
    await delay(1500);
  }
  throw new Error(`agentparty-app MCP tools did not become ready: ${JSON.stringify(last)}`);
}

async function waitForApi() {
  const start = Date.now();
  while (Date.now() - start < 60000) {
    try { if ((await getJson("/api/health")).ok) return; } catch { /* keep polling */ }
    await delay(500);
  }
  throw new Error("Automation API did not start.");
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

async function removePath(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; }
    catch (error) { if (error?.code !== "EBUSY" || attempt === 9) return; await delay(300); }
  }
}

async function closeWindow() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(base + "/api/window/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: controller.signal });
  } catch { /* closing the last window can cut the response short */ }
  finally { clearTimeout(timer); }
}

function waitForExitOrKill(child) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { killProcessTree(child.pid); resolve(); }, 10000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
  catch { try { process.kill(pid); } catch { /* already exited */ } }
}

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((error) => { console.error(error); process.exit(1); });
