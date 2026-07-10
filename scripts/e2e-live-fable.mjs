/*
 * Full-process e2e for the Fable 5 catalog entry, with a REAL model call.
 * Launches the real app (QA), asserts GET /api/models exposes the new
 * claude-fable-5[1m] route (native anthropic, adaptive-only thinking, effort
 * up to max, image vision), then creates a live member on that model, sends
 * one real turn, and asserts the reply comes back from a session whose
 * snapshot reports the Fable model and live contextTokens — proving the id
 * routes NATIVELY through the claude-code harness (isNativeClaudeModel), not
 * into the router/custom fallback. Captures the workbench for review.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-fable-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-fable-e2e-user-data");
const MODEL = "claude-fable-5[1m]";
// Discovered from the spawned app's per-workspace instance file — NEVER a fixed
// port. A fixed port once attached this driver to the USER'S installed app
// (which had that port persisted in settings) and rewired its workspace.
let base = "";

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
    windowsHide: true,
  });
  child.stdout.on("data", (c) => process.stdout.write(c));
  child.stderr.on("data", (c) => process.stderr.write(c));

  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "health ok");
    const windows = await getJson("/api/windows");
    const winWs = windows.windows?.[0]?.workspacePath || windows.windows?.[0]?.workspace;
    assert(String(winWs).toLowerCase() === ws.toLowerCase(), `spawned app serves the e2e workspace (${winWs}) — not someone else's instance`);

    // The catalog route is exposed with the right shape.
    const models = await getJson("/api/models");
    const routes = models.modelRoutes || [];
    const fable = routes.find((r) => (r.harnessId || "claude-code") === "claude-code" && r.model === MODEL);
    assert(fable, `GET /api/models exposes ${MODEL} on the claude-code harness`);
    assert(fable.providerId === "anthropic" && fable.label === "Fable", "Fable route is native anthropic, labeled 'Fable'");
    assert(fable.capabilities?.effort?.options?.some((o) => o.id === "max"), "Fable effort options reach max");
    const modes = (fable.capabilities?.thinking?.modes || []).map((o) => o.id);
    assert(modes.join() === "adaptive", `Fable thinking is adaptive-only (got: ${modes.join()})`);
    assert(fable.capabilities?.vision?.image === true, "Fable route reports image vision");
    assert(!routes.some((r) => r.model === "fable" || r.model === "fable[1m]"), "no unsupported 'fable' short-alias route");

    // A live member on Fable — the real proof the id routes natively.
    await post("/api/parties", { name: "fable e2e" });
    await post("/api/party/members", { name: "fabley", requirement: "fable catalog check", role: "claude", runtime: "claude-code", model: MODEL });
    const start = await post("/api/party/members/fabley/start", { model: MODEL, permissionMode: "plan" });
    assert(start.session?.id, `fabley live session started (${start.session?.id})`);

    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["fabley"]] });

    await post("/api/party/members/fabley/message", { text: "Reply with exactly FABLE_PONG. Do not use tools." });
    const replySnap = await waitForReply("fabley", "FABLE_PONG");
    const effective = String(replySnap.model || "").toLowerCase();
    assert(effective.includes("fable"), `session snapshot reports a fable model (${replySnap.model})`);
    // The usage report can land moments after the reply text — poll separately.
    const ctxSnap = await waitForSnapshot("fabley", (s) => typeof s.contextTokens === "number" && s.contextTokens > 0, "contextTokens > 0");
    assert(ctxSnap.contextTokens > 0, `Fable session carries live contextTokens (${ctxSnap.contextTokens})`);

    // Usage-limit regressions (the "사용량 정보를 읽을 수 없습니다" spam + N/A-over-
    // real-data bugs): the failed proactive usage read may post its info block at
    // most ONCE (never once per poll tick), and whenever live windows exist the
    // provider must not read unavailable.
    const transcript = await getJson("/api/party/members/fabley/transcript");
    const usageNotices = (transcript.blocks || []).filter((b) => b.kind === "diagnostic" && b.category === "rate-limit" && b.title === "사용량 정보를 읽을 수 없습니다");
    assert(usageNotices.length <= 1, `usage-read notice appears at most once (got ${usageNotices.length})`);
    const usage = (await getJson("/api/usage")).usage || {};
    if (usage.claude?.windows?.length) {
      assert(usage.claude.available !== false, "claude usage with real windows is never reported unavailable (N/A bug)");
    }

    await delay(600);
    const shot = path.join(os.tmpdir(), "fable-e2e.png");
    const cap = await post("/api/capture", { path: shot });
    assert(cap.ok, `captured workbench with the Fable member → ${cap.path}`);

    await post("/api/window/close", {});
    await waitForExit(child);
    console.log("FABLE LIVE E2E PASSED (native claude-fable-5[1m] member, real turn)");
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

/**
 * Polls the member transcript until the expected reply text appears, then
 * returns the member's live session snapshot (for model/contextTokens checks).
 */
async function waitForReply(memberName, marker) {
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const state = await getJson("/api/state");
    const member = (state.party?.members || []).find((m) => m.name === memberName);
    const session = member?.sessionId ? state.sessions.find((s) => s.id === member.sessionId) : undefined;
    const snap = session?.snapshot;
    if (snap?.status === "error") {
      throw new Error(`${memberName} session errored: ${snap.lastError || "unknown"}`);
    }
    const transcript = await getJson(`/api/party/members/${encodeURIComponent(memberName)}/transcript`);
    if (JSON.stringify(transcript.blocks || []).includes(marker)) {
      return snap;
    }
    await delay(1500);
  }
  throw new Error(`${memberName} never replied with ${marker} within 180s.`);
}

/** Polls the member's live session snapshot until `predicate` holds. */
async function waitForSnapshot(memberName, predicate, what) {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const state = await getJson("/api/state");
    const member = (state.party?.members || []).find((m) => m.name === memberName);
    const session = member?.sessionId ? state.sessions.find((s) => s.id === member.sessionId) : undefined;
    if (session?.snapshot && predicate(session.snapshot)) {
      return session.snapshot;
    }
    await delay(1000);
  }
  throw new Error(`${memberName} snapshot never satisfied: ${what}`);
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    base = firstBaseUrl(ws);
    if (base) {
      try { if ((await getJson("/api/health")).ok) return; } catch {}
    }
    await delay(500);
  }
  throw new Error("Automation API did not start (no live instance file under the e2e workspace).");
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
