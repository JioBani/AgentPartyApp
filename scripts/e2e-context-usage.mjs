/*
 * Full-process e2e for the per-harness context-capacity meter, with REAL model
 * calls, driven exactly as a user would through the party workbench. Launches
 * the real app (QA), creates a party with two live members —
 *   - claudey (Claude Code, sonnet) and
 *   - codexy  (Codex, gpt-5.4-mini)
 * — starts a real session for each, sends one real turn, and asserts each
 * member's session snapshot now carries `contextTokens > 0`: the adapter
 * captured live context-window occupancy from the harness's own usage report.
 * Both members are opened in the workbench and captured so the rendered meters
 * are visible for review.
 *
 * qa-render proves the pixels; this proves the number is real (not mocked) AND
 * that it reaches the rendered member panel end to end.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = "C:\\Project\\AgentPartyApp";
const ws = path.join(os.tmpdir(), "agentparty-ctx-usage-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-ctx-usage-e2e-user-data");
const port = Number(process.env.AGENTPARTY_CTX_E2E_PORT || "") || 48939;
const base = `http://127.0.0.1:${port}`;
const codexJs = process.env.AGENTPARTY_CODEX_JS || "C:\\Users\\Dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
const codexModel = process.env.AGENTPARTY_LIVE_CODEX_MODEL || "gpt-5.4-mini";

async function main() {
  await removePath(ws);
  await removePath(userData);
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
    },
    windowsHide: true,
  });
  child.stdout.on("data", (c) => process.stdout.write(c));
  child.stderr.on("data", (c) => process.stderr.write(c));

  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "health ok");
    const windows = await getJson("/api/windows");
    const windowId = windows.windows?.[0]?.id;
    assert(windowId, "test window discovered");
    await post(`/api/windows/${encodeURIComponent(windowId)}/workspace`, { workspacePath: ws });

    // A party is required before any member (no silent default party).
    await post("/api/parties", { name: "context-usage e2e" });

    // Two live members, one per harness.
    await post("/api/party/members", { name: "claudey", requirement: "context meter check", role: "claude", runtime: "claude-code", model: "sonnet" });
    const claudeStart = await post("/api/party/members/claudey/start", { model: "sonnet", permissionMode: "plan" });
    assert(claudeStart.session?.id, `claudey live session started (${claudeStart.session?.id})`);

    await post("/api/party/members", { name: "codexy", requirement: "context meter check", role: "codex", runtime: "codex", model: codexModel });
    const codexStart = await post("/api/party/members/codexy/start", { model: codexModel, permissionMode: "plan" });
    assert(codexStart.session?.id, `codexy live session started (${codexStart.session?.id})`);

    // Open both in the workbench so the panels (and their meters) render.
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["claudey"], ["codexy"]] });

    // One real turn each.
    await post("/api/party/members/claudey/message", { text: "Reply with exactly CTX_CLAUDE_PONG. Do not use tools." });
    await post("/api/party/members/codexy/message", { text: "Reply with exactly CTX_CODEX_PONG. Do not edit files." });

    const claudeCtx = await waitForContext("claudey");
    assert(claudeCtx > 0, `Claude member snapshot carries live contextTokens (${claudeCtx})`);
    const codexCtx = await waitForContext("codexy");
    assert(codexCtx > 0, `Codex member snapshot carries live contextTokens (${codexCtx})`);

    await delay(600);
    const shot = path.join(os.tmpdir(), "context-usage.png");
    const cap = await post("/api/capture", { path: shot });
    assert(cap.ok, `captured workbench with live context meters → ${cap.path}`);

    await post("/api/window/close", {});
    await waitForExit(child);
    console.log("CONTEXT USAGE E2E PASSED (live Claude + Codex members, real context tokens)");
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

/** Polls /api/state until the named member's live session reports contextTokens. */
async function waitForContext(memberName) {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const state = await getJson("/api/state");
    const member = (state.party?.members || []).find((m) => m.name === memberName);
    const session = member?.sessionId ? state.sessions.find((s) => s.id === member.sessionId) : undefined;
    const snap = session?.snapshot;
    if (snap?.status === "error") {
      throw new Error(`${memberName} session errored: ${snap.lastError || "unknown"}`);
    }
    if (typeof snap?.contextTokens === "number" && snap.contextTokens > 0) {
      return snap.contextTokens;
    }
    await delay(1000);
  }
  throw new Error(`${memberName} never reported contextTokens within 120s.`);
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try { if ((await getJson("/api/health")).ok) return; } catch {}
    await delay(500);
  }
  throw new Error("Automation API did not start.");
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

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("App did not exit after close API.")), 10000);
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
