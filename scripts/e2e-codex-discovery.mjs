/*
 * Full-process e2e for Codex `/` palette discovery (Item 4), driven by the fake
 * codex app-server. Launches the REAL app on the LEFT monitor, creates a Codex
 * session, and asserts that the real adapter queried skills/list + plugin/installed
 * and merged the discovered skills/plugins (with source + disabled reason) into the
 * session snapshot's slashCommands — the inventory the composer palette renders.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = "C:\\Project\\AgentPartyApp";
const fakeServer = path.join(root, "scripts", "fake-codex-appserver.mjs");
const ws = path.join(os.tmpdir(), "agentparty-codex-discovery-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-codex-discovery-e2e-user-data");
const port = Number(process.env.AGENTPARTY_DISCOVERY_E2E_PORT || "") || 48937;
const base = `http://127.0.0.1:${port}`;

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_AUTOMATION_PORT: String(port),
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      AGENTPARTY_CODEX_BIN: process.execPath,
      AGENTPARTY_CODEX_ARGS: JSON.stringify([fakeServer]),
    },
    windowsHide: true,
  });
  child.stdout.on("data", (c) => process.stdout.write(c));
  child.stderr.on("data", (c) => process.stderr.write(c));

  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "health ok");
    await post("/api/windows/win-1/workspace", { workspacePath: ws });

    const session = await post("/api/sessions", {
      workspacePath: ws,
      selectedHarnessId: "codex",
      selectedProviderId: "openai",
      model: "gpt-5.4-mini",
      permissionMode: "default",
    });
    assert(session.id, "codex session created");

    // Thread start (which triggers skills/plugin discovery) happens on first turn.
    await post(`/api/sessions/${session.id}/send`, { text: "KIND=items 안녕" });

    const commands = await waitForDiscovery(session.id);
    const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
    assert(byName.model?.source === "built-in", "built-in command reported with source");
    assert(byName["deep-dive"]?.source === "skill", "discovered skill merged into slashCommands with source=skill");
    assert(byName["legacy-skill"]?.disabledReason, "disabled skill carries a disabled reason");
    assert(byName.formatter?.source === "plugin", "installed plugin merged with source=plugin");
    assert(byName["blocked-plugin"]?.disabledReason, "admin-disabled plugin carries a disabled reason");

    await post(`/api/sessions/${session.id}/close`, {});
    await post("/api/window/close", {});
    await waitForExit(child);
    console.log("CODEX DISCOVERY E2E PASSED");
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

/** Waits until the session snapshot's slashCommands include the discovered skill. */
async function waitForDiscovery(sessionId) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const st = await getJson("/api/state");
    const s = st.sessions.find((x) => x.id === sessionId);
    const commands = s?.snapshot?.slashCommands || [];
    if (commands.some((c) => c.name === "deep-dive")) {
      return commands;
    }
    if (s?.snapshot?.status === "error") {
      throw new Error(s.snapshot.lastError || "session errored");
    }
    await delay(400);
  }
  throw new Error("discovery did not populate slashCommands within 20s");
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try { if ((await getJson("/api/health")).ok) return; } catch {}
    await delay(500);
  }
  throw new Error("Automation API did not start.");
}

async function getJson(u) { const r = await fetch(base + u); if (!r.ok) throw new Error(`${u} returned ${r.status}`); return r.json(); }
async function post(u, b) { const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); if (!r.ok) throw new Error(`${u} returned ${r.status}: ${await r.text()}`); return r.json(); }

async function removePath(target) {
  for (let i = 0; i < 10; i += 1) { try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (e) { if (e?.code !== "EBUSY" || i === 9) return; await delay(300); } }
}
function waitForExit(child) { return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("App did not exit after close API.")), 10000); child.once("exit", () => { clearTimeout(t); resolve(); }); }); }
function killProcessTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { try { process.kill(pid); } catch {} } }
function assert(v, m) { if (!v) throw new Error(`Assertion failed: ${m}`); console.log(`  ok: ${m}`); }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
