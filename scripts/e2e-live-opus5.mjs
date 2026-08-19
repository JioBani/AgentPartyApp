/*
 * Full-process e2e for the Opus 5 catalog entry, with a REAL model call.
 * Launches the real app (QA), asserts GET /api/models exposes the new
 * claude-opus-5[1m] route (native anthropic, adaptive-default thinking, effort
 * up to max, image vision) and that the retired short alias "opus[1m]" is gone,
 * then creates a live member on that model, sends one minimal real turn, and
 * asserts the reply comes from a session whose snapshot reports an Opus 5 model
 * with live contextTokens — proving the id routes NATIVELY through the
 * claude-code harness (backendFor → claude-native) instead of falling into the
 * router/custom path. Captures the workbench for review.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-opus5-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-opus5-e2e-user-data");
const MODEL = "claude-opus-5[1m]";
// Discovered from the spawned app's per-workspace instance file — NEVER a fixed
// port, which once attached a driver to the USER'S installed app.
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
    const opus5 = routes.find((r) => (r.harnessId || "claude-code") === "claude-code" && r.model === MODEL);
    assert(opus5, `GET /api/models exposes ${MODEL} on the claude-code harness`);
    assert(opus5.providerId === "anthropic" && opus5.label === "Opus 5", "Opus 5 route is native anthropic, labeled 'Opus 5'");
    assert(opus5.meta?.context === "1M", `Opus 5 route reports the 1M context window (${opus5.meta?.context})`);
    assert(opus5.capabilities?.effort?.options?.some((o) => o.id === "max"), "Opus 5 effort options reach max");
    assert(opus5.capabilities?.effort?.defaultValue === "high", `Opus 5 effort defaults to high (${opus5.capabilities?.effort?.defaultValue})`);
    assert(opus5.capabilities?.thinking?.defaultValue === "adaptive", `Opus 5 thinking defaults to adaptive (${opus5.capabilities?.thinking?.defaultValue})`);
    assert(opus5.capabilities?.vision?.image === true, "Opus 5 route reports image vision");
    // The CLI's short aliases track the LATEST model of a family, so an
    // "opus[1m]" route would silently change model on a CLI update.
    assert(!routes.some((r) => r.model === "opus" || r.model === "opus[1m]"), "no drifting 'opus' short-alias route");
    const opus48 = routes.find((r) => (r.harnessId || "claude-code") === "claude-code" && r.model === "claude-opus-4-8[1m]");
    assert(opus48?.label === "Opus 4.8", "Opus 4.8 stays selectable under its own full id");

    // A live member on Opus 5 — the real proof the id routes natively.
    await post("/api/parties", { name: "opus5 e2e" });
    await post("/api/party/members", { name: "opie", requirement: "opus 5 catalog check", role: "claude", runtime: "claude-code", model: MODEL, effort: "high" });
    const start = await post("/api/party/members/opie/start", { model: MODEL, effort: "high", permissionMode: "plan" });
    assert(start.session?.id, `opie live session started (${start.session?.id})`);

    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["opie"]] });

    await post("/api/party/members/opie/message", { text: "Reply with exactly OPUS5_PONG. Do not use tools." });
    const replySnap = await waitForReply("opie", "OPUS5_PONG");
    const effective = String(replySnap.model || "").toLowerCase();
    assert(/opus[-\s]?5/.test(effective), `session snapshot reports an Opus 5 model (${replySnap.model})`);
    assert(!effective.includes("4-8") && !effective.includes("4.8"), `the turn did NOT silently run Opus 4.8 (${replySnap.model})`);
    // The usage report can land moments after the reply text — poll separately.
    const ctxSnap = await waitForSnapshot("opie", (s) => typeof s.contextTokens === "number" && s.contextTokens > 0, "contextTokens > 0");
    assert(ctxSnap.contextTokens > 0, `Opus 5 session carries live contextTokens (${ctxSnap.contextTokens})`);

    await delay(600);
    const shot = path.join(os.tmpdir(), "opus5-e2e.png");
    const cap = await post("/api/capture", { path: shot });
    assert(cap.ok, `captured workbench with the Opus 5 member → ${cap.path}`);

    await post("/api/window/close", {});
    await waitForExit(child);
    console.log("OPUS 5 LIVE E2E PASSED (native claude-opus-5[1m] member, real turn)");
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
