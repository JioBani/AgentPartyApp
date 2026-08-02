/*
 * Full-process e2e for R-63 — a party message to an open tab with no live
 * session auto-starts and delivers. A closed tab still refuses.
 * Offline (mock sessions). Step 0 asserts runtime.appRoot boundary.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "ap-r63-e2e-ws");
const userData = path.join(os.tmpdir(), "ap-r63-e2e-ud");

let base = "";
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_E2E: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      AGENTPARTY_AUTOMATION_PORT: "",
      OPENROUTER_API_KEY: "",
    },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    base = await discover();
    assert((await get("/api/health")).ok, "app is up");
    const appRoot = (await get("/api/state")).runtime?.appRoot || "";
    const within = (appRoot + path.sep).toLowerCase().startsWith((root + path.sep).toLowerCase());
    assert(Boolean(appRoot) && within, `runtime.appRoot is this worktree (${appRoot})`);

    await post("/api/qa/reset").catch(() => {});
    await post("/api/qa/seed", { party: "r63", members: [{ name: "sender", role: "s" }] });
    let party = await get("/api/party");
    const partyId = party.currentPartyId || party.members[0]?.partyId;

    // HTTP create may auto-start. Close then open to get an open tab with no session.
    await post("/api/party/members", {
      partyId,
      name: "open-idle",
      requirement: "open tab before start",
      runtime: "claude-code",
    });
    await post("/api/party/members/open-idle/close", {});
    await post("/api/party/members/open-idle/open", {});
    party = await get("/api/party");
    const before = party.members.find((m) => m.name === "open-idle");
    assert(before?.status === "opened" && !before?.sessionId, `open-idle has no session (status=${before?.status}, session=${before?.sessionId || "none"})`);

    const sent = await post("/api/party/messages", {
      to: "open-idle",
      content: "hello before your session exists",
      from: "sender",
    });
    assert(sent.partyMessage?.delivered === true, `message delivered (error=${sent.partyMessage?.error || "none"})`);
    assert(!sent.partyMessage?.error, "no delivery error on an open tab");

    party = await get("/api/party");
    const after = party.members.find((m) => m.name === "open-idle");
    assert(Boolean(after?.sessionId), "recipient has a live session after the party message");
    assert(after?.status === "running", `recipient is running (status=${after?.status})`);

    // Closed tab refuses wake-up.
    await post("/api/party/members", {
      partyId,
      name: "shut",
      requirement: "closed",
      runtime: "claude-code",
    });
    await post("/api/party/members/shut/close", {});
    const refused = await post("/api/party/messages", {
      to: "shut",
      content: "should not wake a closed tab",
      from: "sender",
    });
    assert(refused.partyMessage?.delivered !== true, "closed tab is not delivered to");
    assert(refused.partyMessage?.error === "target_member_is_closed", `closed error is explicit (got ${refused.partyMessage?.error})`);

    await post("/api/window/close", {});
    await waitForExit(child);

    console.log("");
    if (failures.length) {
      console.log(`OPEN TAB DELIVER E2E FAILED: ${failures.length}`);
      for (const f of failures) console.log(` - ${f}`);
      process.exit(1);
    }
    console.log("OPEN TAB DELIVER E2E PASSED");
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

async function discover() {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const url = firstBaseUrl(ws);
    if (url) {
      try {
        const response = await fetch(`${url}/api/health`);
        if (response.ok && (await response.json()).ok) return url;
      } catch {}
    }
    await delay(500);
  }
  throw new Error("App did not advertise an automation endpoint.");
}
async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}
async function post(route, body) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}
async function removePath(target) {
  for (let i = 0; i < 10; i += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; }
    catch (e) { if (e?.code !== "EBUSY" || i === 9) return; await delay(300); }
  }
}
function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("App did not exit after close API.")), 15_000);
    child.once("exit", () => { clearTimeout(t); resolve(); });
  });
}
function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
  catch { try { process.kill(pid); } catch {} }
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
