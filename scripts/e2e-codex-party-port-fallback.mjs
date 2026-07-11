/*
 * Live GPT-mini e2e — root-cause proof for the Codex party MCP "-32603: fetch
 * failed" bug. A Codex member's agentparty-app tools fetch the app's automation
 * HTTP API by URL. Previously that URL was built from the CONFIGURED port, but
 * the API server falls back to an EPHEMERAL port when the configured one is taken
 * (a second instance / leftover process) — so the member fetched a dead port and
 * every send/list/member-create failed.
 *
 * This test forces exactly that mismatch: it OCCUPIES the configured automation
 * port before launch, so the app must bind a different (ephemeral) port. Then a
 * real Codex member is told to call `member-create`. The created member appears
 * in /api/state ONLY if the member's tool fetch reached the ACTUAL bound port —
 * a decisive, non-model-text signal that the fix (use the live base URL) works.
 * Under the old code, member-create would fetch the occupied/dead port and the
 * member would never be created.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBaseUrls } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Per-run dirs (pid-suffixed): a killed prior run can leave a dead instance file
// behind, and a stale entry must never shadow this run's live one.
const ws = path.join(os.tmpdir(), `agentparty-codex-port-fallback-ws-${process.pid}`);
const userData = path.join(os.tmpdir(), `agentparty-codex-port-fallback-ud-${process.pid}`);
const occupiedPort = Number(process.env.AGENTPARTY_FALLBACK_PORT || "") || 48971;
const codexJs = process.env.AGENTPARTY_CODEX_JS || "C:\\Users\\Dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
const model = process.env.AGENTPARTY_LIVE_CODEX_MODEL || "gpt-5.4-mini";
const memberName = "codexcaller";
const spawnedName = "codex-made-me";
let base = "";

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });

  // Squat the configured automation port so the app is FORCED onto a fallback
  // port. Run the squatter in a SEPARATE process: an in-process net server whose
  // socket handler churns starves THIS process's event loop (the app probes the
  // configured port during startup), which stalls our own poll loop.
  const squatter = spawn(process.execPath, ["-e", `require("net").createServer(()=>{}).listen(${occupiedPort},"127.0.0.1");setInterval(()=>{},1e9)`], { stdio: "ignore" });
  await delay(800);

  // Route the app's (very chatty) output straight to a log FILE via stdio fds —
  // NOT piped through this process. A piped child + process.stdout.write is a
  // SYNCHRONOUS write when our stdout is itself redirected to a file, and the
  // app's log volume then blocks THIS process's event loop, stalling waitForApi.
  const appLog = path.join(os.tmpdir(), `agentparty-codex-port-fallback-app-${process.pid}.log`);
  const logFd = fs.openSync(appLog, "w");
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws], {
    cwd: root,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_AUTOMATION_PORT: String(occupiedPort), // configured port — deliberately occupied
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      AGENTPARTY_CODEX_BIN: process.execPath,
      AGENTPARTY_CODEX_ARGS: JSON.stringify([codexJs]),
    },
    windowsHide: true,
  });
  console.log(`app output → ${appLog}`);

  try {
    await waitForApi();
    // The app could NOT bind the occupied port, so its real base URL must differ.
    const actualPort = Number(new URL(base).port);
    assert(actualPort > 0 && actualPort !== occupiedPort, `app fell back off the occupied port ${occupiedPort} → actual ${actualPort}`);
    assert((await getJson("/api/health")).ok, "health ok on the fallback port");

    await post("/api/parties", { name: "codex port fallback e2e" });
    await post("/api/party/members", { name: memberName, requirement: "Create a party member when told.", role: "port fallback caller", runtime: "codex", model });
    const started = await post(`/api/party/members/${memberName}/start`, { model, permissionMode: "plan", codexPolicy: { sandbox: "read-only", approval: "on-request", guardian: false } });
    const sessionId = await waitForMemberSession(started.session?.id);
    assert(sessionId, `live Codex member session started (${sessionId})`);

    await post(`/api/party/members/${memberName}/message`, {
      text: [
        "This is a live AgentParty tool test.",
        `Call the party tool mcp__agentparty-app__member-create exactly once with name="${spawnedName}" and role="spawned by e2e".`,
        "After the tool result arrives, reply with exactly PORT_FALLBACK_OK.",
        "Do not edit files and do not run shell commands.",
      ].join(" "),
    });

    // DECISIVE: the new member exists ONLY if the Codex member's tool fetch reached
    // the ACTUAL automation port. Under the old bug it would hit the occupied port
    // and fetch-fail, so the member would never be created.
    const created = await waitForMember(spawnedName, sessionId);
    assert(created, `Codex member-create reached the live API on the fallback port → '${spawnedName}' exists`);

    console.log(`CODEX PARTY PORT-FALLBACK E2E PASSED (${model}) — party tools use the actual bound port`);
    await post("/api/window/close", {}).catch(() => {});
    await waitForExitOrKill(child);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  } finally {
    try { squatter.kill(); } catch {}
  }
}

async function waitForMemberSession(initialSessionId) {
  const started = Date.now();
  let last = initialSessionId || "";
  while (Date.now() - started < 30000) {
    const state = await getJson("/api/state");
    const member = (state.party?.members || []).find((m) => m.name === memberName);
    if (member?.sessionId) {
      last = member.sessionId;
      const session = state.sessions.find((s) => s.id === last);
      if (session?.snapshot?.status && session.snapshot.status !== "created") {
        return last;
      }
    }
    await delay(500);
  }
  return last;
}

async function waitForMember(name, callerSessionId) {
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const state = await getJson("/api/state");
    const caller = state.sessions.find((s) => s.id === callerSessionId);
    if (caller?.snapshot?.status === "error") {
      throw new Error(caller.snapshot.lastError || "Codex caller session entered error state.");
    }
    if ((state.party?.members || []).some((m) => m.name === name)) {
      return true;
    }
    await delay(1500);
  }
  return false;
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    // Health-check EVERY advertised url, not just the first — a dead stale entry
    // must not shadow the live one.
    for (const url of discoverBaseUrls(ws)) {
      base = url;
      try { if ((await getJson("/api/health")).ok) return; } catch {}
    }
    await delay(500);
  }
  throw new Error("Automation API did not start (no live instance under the e2e workspace).");
}

async function getJson(u) {
  const r = await fetch(base + u);
  if (!r.ok) throw new Error(`${u} returned ${r.status}`);
  return r.json();
}

async function post(u, b) {
  const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
  if (!r.ok) throw new Error(`${u} returned ${r.status}: ${await r.text()}`);
  return r.json();
}

async function removePath(target) {
  for (let i = 0; i < 10; i += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (e) { if (e?.code !== "EBUSY" || i === 9) return; await delay(300); }
  }
}

function waitForExitOrKill(child) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { killProcessTree(child.pid); resolve(); }, 12000);
    child.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { try { process.kill(pid); } catch {} }
}

function assert(v, m) { if (!v) throw new Error(`Assertion failed: ${m}`); console.log(`  ok: ${m}`); }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
