/*
 * Full-process e2e for the REAL /compact path, both harnesses, with REAL model
 * calls. Launches the app (QA), creates a party with two live members —
 *   - claudey (Claude Code, sonnet, effort low) and
 *   - codexy  (Codex, gpt-5.4-mini, effort low)
 * — starts a real session for each, sends one tiny real turn (so there IS some
 * context), records contextTokens, then calls POST /api/sessions/:id/compact and
 * surfaces whatever the harness reports back (Claude sends `/compact`; Codex
 * sends `thread/compact/start`). This is INVESTIGATIVE: it does not hard-assert a
 * specific compaction outcome — it prints the post-compact status blocks + the
 * before/after context occupancy so we can see what the harness actually did on a
 * near-empty session (expected: little/nothing to compact).
 *
 * NOTE: this exercises MANUAL compaction (the dialog's "지금 압축 실행" / the
 * threshold-crossing auto-trigger both route through this same /compact path).
 * Per-member auto-compact-by-threshold IS implemented — its persistence + crossing
 * are covered offline by e2e-auto-compact.mjs / qa-auto-compact.mjs.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-compact-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-compact-e2e-user-data");
let base = "";
const codexJs = process.env.AGENTPARTY_CODEX_JS || "C:\\Users\\Dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
const claudeModel = process.env.AGENTPARTY_LIVE_CLAUDE_MODEL || "sonnet";
const codexModel = process.env.AGENTPARTY_LIVE_CODEX_MODEL || "gpt-5.4-mini";

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
    const winWs = windows.windows?.[0]?.workspacePath || windows.windows?.[0]?.workspace;
    assert(String(winWs).toLowerCase() === ws.toLowerCase(), `spawned app serves the e2e workspace (${winWs})`);

    await post("/api/parties", { name: "compact e2e" });

    await post("/api/party/members", { name: "claudey", requirement: "compact check", role: "claude", runtime: "claude-code", model: claudeModel });
    const claudeStart = await post("/api/party/members/claudey/start", { model: claudeModel, effort: "low", permissionMode: "plan" });
    assert(claudeStart.session?.id, `claudey live session started (${claudeStart.session?.id})`);

    await post("/api/party/members", { name: "codexy", requirement: "compact check", role: "codex", runtime: "codex", model: codexModel });
    const codexStart = await post("/api/party/members/codexy/start", { model: codexModel, effort: "low", permissionMode: "plan" });
    assert(codexStart.session?.id, `codexy live session started (${codexStart.session?.id})`);

    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["claudey"], ["codexy"]] });

    // One tiny real turn each so there is SOME context to (attempt to) compact.
    await post("/api/party/members/claudey/message", { text: "Reply with exactly PONG. Do not use tools." });
    await post("/api/party/members/codexy/message", { text: "Reply with exactly PONG. Do not edit files." });

    const claudeCtxBefore = await waitForContext("claudey");
    console.log(`  claudey contextTokens before compact: ${claudeCtxBefore}`);
    const codexCtxBefore = await waitForContext("codexy");
    console.log(`  codexy  contextTokens before compact: ${codexCtxBefore}`);

    // --- COMPACT both, via the exact same endpoint the toolbar button hits ---
    const claudeSid = await sessionIdOf("claudey");
    const codexSid = await sessionIdOf("codexy");
    console.log(`\n>>> POST /api/sessions/${claudeSid}/compact  (claudey / ${claudeModel})`);
    await post(`/api/sessions/${claudeSid}/compact`, {});
    console.log(`>>> POST /api/sessions/${codexSid}/compact  (codexy / ${codexModel})`);
    await post(`/api/sessions/${codexSid}/compact`, {});

    // Surface what each harness reported. Poll the transcript for any block that
    // mentions compaction, and read post-compact occupancy.
    const claudeOut = await waitForCompactSignal("claudey");
    const codexOut = await waitForCompactSignal("codexy");

    console.log("\n================ COMPACT RESULTS ================");
    report("claudey", claudeModel, claudeCtxBefore, claudeOut);
    report("codexy", codexModel, codexCtxBefore, codexOut);
    console.log("================================================\n");

    await delay(800);
    const shot = path.join(os.tmpdir(), "compact-e2e.png");
    const cap = await post("/api/capture", { path: shot });
    console.log(`  captured → ${cap.path}`);

    await post("/api/window/close", {});
    await waitForExit(child);
    console.log("COMPACT E2E DONE (investigative — see COMPACT RESULTS above)");
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

function report(name, model, before, out) {
  console.log(`\n[${name} · ${model}]`);
  console.log(`  contextTokens: ${before} → ${out.ctxAfter}`);
  if (out.blocks.length === 0) {
    console.log(`  compact status blocks: (none seen within timeout)`);
  } else {
    for (const b of out.blocks) console.log(`  compact block: "${b}"`);
  }
  console.log(`  last transcript blocks:`);
  for (const b of out.tail) console.log(`    - ${b}`);
}

/** Poll /api/state until member session reports contextTokens > 0 (turn landed). */
async function waitForContext(memberName) {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const snap = await snapshotOf(memberName);
    if (snap?.status === "error") throw new Error(`${memberName} session errored: ${snap.lastError || "unknown"}`);
    if (typeof snap?.contextTokens === "number" && snap.contextTokens > 0) return snap.contextTokens;
    await delay(1000);
  }
  throw new Error(`${memberName} never reported contextTokens within 120s.`);
}

/**
 * After compact, poll the member transcript for any status block mentioning
 * compaction and read post-compact occupancy. Returns after a compact block is
 * seen or a 60s timeout — whichever first (investigative, never throws).
 */
async function waitForCompactSignal(memberName) {
  const started = Date.now();
  let blocks = [];
  let tail = [];
  let ctxAfter = undefined;
  while (Date.now() - started < 60000) {
    const t = await getJson(`/api/party/members/${memberName}/transcript`).catch(() => ({ blocks: [] }));
    const all = (t.blocks || []).map(describeBlock).filter(Boolean);
    tail = all.slice(-6);
    blocks = all.filter((s) => /compact/i.test(s));
    const snap = await snapshotOf(memberName);
    ctxAfter = snap?.contextTokens;
    if (blocks.length > 0) break;
    await delay(1500);
  }
  return { blocks, tail, ctxAfter };
}

function describeBlock(b) {
  if (!b || typeof b !== "object") return "";
  const kind = b.kind || b.type || "?";
  const text = b.text || b.detail || b.status || (b.name ? `tool:${b.name}` : "");
  return `${kind}: ${String(text).replace(/\s+/g, " ").slice(0, 160)}`;
}

async function sessionIdOf(memberName) {
  const state = await getJson("/api/state");
  const m = (state.party?.members || []).find((x) => x.name === memberName);
  if (!m?.sessionId) throw new Error(`${memberName} has no live sessionId`);
  return m.sessionId;
}

async function snapshotOf(memberName) {
  const state = await getJson("/api/state");
  const m = (state.party?.members || []).find((x) => x.name === memberName);
  const s = m?.sessionId ? state.sessions.find((x) => x.id === m.sessionId) : undefined;
  return s?.snapshot;
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    base = firstBaseUrl(ws);
    if (base) { try { if ((await getJson("/api/health")).ok) return; } catch {} }
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
