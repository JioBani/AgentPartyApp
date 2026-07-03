/*
 * Live demo for Codex diagnostics (Item 5). Launches the real app on the LEFT
 * monitor with the fake app-server, creates a Codex member, sends a turn whose
 * fake response emits model/rerouted + a sandbox warning + a near-exhausted
 * rate-limit, captures a screenshot, and LEAVES the app running. Not a test.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = "C:\\Project\\AgentPartyApp";
const fakeServer = path.join(root, "scripts", "fake-codex-appserver.mjs");
const ws = path.join(os.tmpdir(), "agentparty-diag-demo");
const userData = path.join(os.tmpdir(), "agentparty-diag-demo-user-data");
const port = 48936;
const base = `http://127.0.0.1:${port}`;

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
child.unref();

const post = (u, b) => fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }).then(async (r) => { const t = await r.text(); if (!r.ok) throw new Error(u + " " + r.status + " " + t); try { return JSON.parse(t); } catch { return t; } });
const getJson = (u) => fetch(base + u).then((r) => r.json());
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (let i = 0; i < 30; i += 1) { try { if ((await getJson("/api/health")).ok) break; } catch {} await delay(500); }
  console.log("api up");
  await post("/api/windows/win-1/workspace", { workspacePath: ws });
  await post("/api/parties", { name: "diagnostics 시연" });
  await post("/api/party/members", { name: "codey", requirement: "diagnostics 시연", runtime: "codex", model: "gpt-5.4-mini", permissionMode: "default" });
  await post("/api/party/members/codey/open", {});
  await post("/api/party/members/codey/send", { content: "KIND=diagnostics 진단을 보여줘" });
  for (let i = 0; i < 30; i += 1) {
    const st = await getJson("/api/state");
    const s = st.sessions.find((x) => x.snapshot?.model === "gpt-5.4-mini");
    if (s?.snapshot?.status === "error") { console.log("ERROR:", s.snapshot.lastError); break; }
    if (s && Number(s.snapshot?.turnCount || 0) >= 1) { console.log("TURN_COMPLETE"); break; }
    await delay(400);
  }
  try {
    const shot = path.join(os.tmpdir(), "diag-demo.png");
    const cap = await post("/api/capture", { path: shot });
    console.log("SHOT", cap.path);
  } catch (e) { console.log("capture failed", e.message); }
  console.log("DEMO_READY");
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
