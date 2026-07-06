/*
 * FULL-PROCESS e2e for the MCP status endpoint against the REAL harness adapters
 * (billed: it starts a live Claude + Codex member). Self-launching on an isolated
 * userData + temp workspace. It does NOT send a model turn — starting the session
 * is enough for the adapter's live MCP surface (Claude `mcpServerStatus()` /
 * Codex `mcpServerStatus/list`), so cost is just session init.
 *
 * For each harness: create a member → start (warm) its session → poll until it
 * has a sessionId and left "created" → GET /api/sessions/:id/mcp and assert the
 * neutral snapshot (supported + harness tag + well-formed servers array). This is
 * the only tier that proves the real SDK/app-server MCP path, not the mock.
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = String(process.pid);
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-mcp-ws-"));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-mcp-ud-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const env = { ...process.env, AGENTPARTY_ALLOW_MULTI_INSTANCE: "1", AGENTPARTY_USER_DATA: userData, AGENTPARTY_WINDOW_DISPLAY: "left" };
delete env.ELECTRON_RUN_AS_NODE;

console.log(`MCP status full-process e2e (real adapters, isolated userData=${path.basename(userData)}):`);
const child = spawn(process.execPath, [path.join(projectRoot, "scripts/launch-electron.mjs"), "--workspace", workspace], { stdio: "inherit", env });

async function stop() {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch {}
  await sleep(300);
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
}

let baseUrl = "";
const get = (p) => fetch(baseUrl + p).then((r) => r.json());
const post = (p, body) => fetch(baseUrl + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then((r) => r.json());

/** Warms a member's session and returns its live sessionId (or "" on timeout). */
async function warmSession(name) {
  await post(`/api/party/members/${encodeURIComponent(name)}/start`, {});
  for (let i = 0; i < 80; i++) {
    const party = await get("/api/party").catch(() => null);
    const member = (party?.members || []).find((m) => m.name === name);
    const status = member?.session?.snapshot?.status || member?.status || "";
    if (member?.sessionId && status && status !== "created" && status !== "spawned") {
      return member.sessionId;
    }
    await sleep(500);
  }
  return "";
}

async function checkHarness(label, harness, runtime, model) {
  const name = `${label}-${stamp}`;
  console.log(`\n[${label}] ${runtime}/${model}`);
  await post("/api/party/members", { name, requirement: "MCP status probe", runtime, model });
  const sessionId = await warmSession(name);
  assert(Boolean(sessionId), `${label}: session warmed (${sessionId || "TIMEOUT"})`);
  if (!sessionId) return;
  // Give the harness a moment to finish its MCP handshake after init.
  await sleep(3000);
  const snap = await get(`/api/sessions/${encodeURIComponent(sessionId)}/mcp`);
  console.log(`  servers: ${JSON.stringify((snap?.servers || []).map((s) => ({ name: s.name, state: s.state, tools: s.tools?.length })))}`);
  if (snap?.note) console.log(`  note: ${snap.note}`);
  if (snap?.error) console.log(`  error: ${snap.error}`);
  assert(snap?.supported === true, `${label}: snapshot.supported is true`);
  assert(snap?.harness === harness, `${label}: harness tag is '${harness}' (got '${snap?.harness}')`);
  assert(Array.isArray(snap?.servers), `${label}: servers is an array`);
  // Every listed server must carry the capability flags the UI gates on.
  const wellFormed = (snap?.servers || []).every((s) => typeof s.name === "string" && typeof s.state === "string" && typeof s.canReconnect === "boolean" && typeof s.canToggle === "boolean" && typeof s.canAuthenticate === "boolean");
  assert(wellFormed, `${label}: each server carries name/state + capability flags`);
}

try {
  for (let i = 0; i < 120 && !baseUrl; i++) {
    baseUrl = firstBaseUrl(workspace);
    if (!baseUrl) await sleep(500);
  }
  assert(Boolean(baseUrl), `app published per-workspace discovery (${baseUrl || "MISSING"})`);
  if (!baseUrl) throw new Error("no baseUrl");

  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    healthy = (await get("/api/health").catch(() => null))?.ok === true;
    if (!healthy) await sleep(500);
  }
  assert(healthy, "GET /api/health is ok");

  await post("/api/parties", { name: `MCP-${stamp}` });

  await checkHarness("claude", "claude-code", "claude-code", "sonnet");
  await checkHarness("codex", "codex", "codex", "gpt-5.4-mini");
} catch (error) {
  assert(false, `e2e threw: ${error?.message || error}`);
} finally {
  await stop();
}

console.log(failures.length ? `\nMCP e2e FAILED (${failures.length})` : "\nMCP e2e PASSED (real Claude + Codex adapters, HTTP API only)");
process.exit(failures.length ? 1 : 0);
