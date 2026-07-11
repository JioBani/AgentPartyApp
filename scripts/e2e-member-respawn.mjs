/*
 * Full-process e2e for member RESPAWN (the tab toolbar's reset button) and the
 * `POST /api/party/members/:name/respawn` endpoint. Respawn RELOADS the session
 * while CONTINUING the conversation (resume the harness thread) — the button you
 * press after adding an MCP server so it takes effect without losing the chat.
 *
 * Launches the real app (QA), creates a live Claude member, starts it (session
 * A, id "session-…"), sends one real turn so the harness thread is committed,
 * then respawns and asserts the WHOLE chain end to end:
 *   - respawn returns a session whose id is a RESUME session ("resume-…"),
 *     proving the fresh session was created WITH the old thread as its resume
 *     target (conversation continues) — not a fresh "session-…",
 *   - it is a NEW app session (B ≠ A) and the member is running bound to B,
 *   - the member's harness thread id is unchanged (same conversation),
 *   - the OLD app session A is gone from /api/state (closed, not dangling),
 *   - the member keeps its persisted config (model) across the respawn.
 *
 * qa-party-bridge proves the service composition against a fake SessionManager;
 * this proves it through the real main process + HTTP + real session lifecycle.
 *
 * App output goes to a log FILE via stdio fds (NOT piped through this process):
 * a piped child + our stdout being file-redirected is a synchronous write that
 * can stall this process's event loop and freeze the poll loop.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBaseUrls } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), `agentparty-respawn-e2e-ws-${process.pid}`);
const userData = path.join(os.tmpdir(), `agentparty-respawn-e2e-ud-${process.pid}`);
const model = process.env.AGENTPARTY_LIVE_CLAUDE_MODEL || "sonnet";
const memberName = "respawnee";
let base = "";

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });

  const appLog = path.join(os.tmpdir(), `agentparty-respawn-e2e-app-${process.pid}.log`);
  const logFd = fs.openSync(appLog, "w");
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws], {
    cwd: root,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
    windowsHide: true,
  });
  console.log(`app output → ${appLog}`);

  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "health ok");

    await post("/api/parties", { name: "respawn e2e" });
    await post("/api/party/members", { name: memberName, requirement: "respawn check", role: "claude", runtime: "claude-code", model });
    const started = await post(`/api/party/members/${memberName}/start`, { model, permissionMode: "plan" });
    const sessionA = await waitForMemberSession(started.session?.id);
    assert(sessionA, `member live session A started (${sessionA})`);
    assert(sessionA.startsWith("session-"), `A is a fresh session, not a resume (${sessionA})`);

    // One real turn commits the harness thread so it is genuinely resumable, and
    // opening the panel lets the renderer persist the member's harness thread id.
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [[memberName]] });
    await post(`/api/party/members/${memberName}/message`, { text: "Reply with exactly RESPAWN_PING. Do not use tools." });
    const thread = await waitForHarnessThread();
    assert(thread, `member's harness thread id captured (${thread})`);

    // Respawn: reload the session RESUMING the same thread (conversation continues).
    const respawned = await post(`/api/party/members/${memberName}/respawn`, {});
    const sessionB = respawned.session?.id;
    assert(sessionB && sessionB !== sessionA, `respawn minted a NEW app session B (${sessionB}) ≠ A (${sessionA})`);
    assert(sessionB.startsWith("resume-"), `B is a RESUME session (${sessionB}) — the conversation continues, not a fresh chat`);
    assert(respawned.member?.status === "running", "respawned member is running again");
    assert(respawned.member?.sessionId === sessionB, "member is bound to the new session B");
    assert(respawned.member?.harnessSessionId === thread, `member keeps the same harness thread across respawn (${respawned.member?.harnessSessionId})`);
    assert(respawned.member?.model === model, `respawn preserved the member's model (${respawned.member?.model})`);

    // The OLD app session A must be gone from live state (closed, not dangling).
    const state = await getJson("/api/state");
    assert(!state.sessions.some((s) => s.id === sessionA), "old app session A was closed (absent from /api/state)");
    assert(state.sessions.some((s) => s.id === sessionB), "new resume session B is live in /api/state");
    const member = (state.party?.members || []).find((m) => m.name === memberName);
    assert(member?.sessionId === sessionB, "member state reflects the new session B");

    console.log("MEMBER RESPAWN E2E PASSED — respawn reloads the session and RESUMES the conversation");
    await post("/api/window/close", {}).catch(() => {});
    await waitForExitOrKill(child);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

async function waitForMemberSession(initialSessionId) {
  const started = Date.now();
  let last = initialSessionId || "";
  while (Date.now() - started < 45000) {
    const state = await getJson("/api/state");
    const member = (state.party?.members || []).find((m) => m.name === memberName);
    if (member?.sessionId) {
      last = member.sessionId;
      const session = state.sessions.find((s) => s.id === last);
      if (session?.snapshot?.status === "error") {
        throw new Error(session.snapshot.lastError || "member session entered error state.");
      }
      if (session?.snapshot?.status && session.snapshot.status !== "created") {
        return last;
      }
    }
    await delay(500);
  }
  return last;
}

/** Polls /api/state until the member's harness thread id is persisted (turn committed). */
async function waitForHarnessThread() {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const state = await getJson("/api/state");
    const member = (state.party?.members || []).find((m) => m.name === memberName);
    const session = member?.sessionId ? state.sessions.find((s) => s.id === member.sessionId) : undefined;
    if (session?.snapshot?.status === "error") {
      throw new Error(session.snapshot.lastError || "member session entered error state.");
    }
    if (member?.harnessSessionId) {
      return member.harnessSessionId;
    }
    await delay(1000);
  }
  throw new Error(`${memberName} never persisted a harness thread id within 120s.`);
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
