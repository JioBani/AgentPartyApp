/*
 * Live demo launcher for the Codex approval card (Item 2). Launches the real app
 * on the LEFT monitor with the fake codex app-server, creates a Codex member,
 * sends a turn that pauses on a command approval, captures a screenshot, and
 * LEAVES the app running so the card can be clicked. Not a test — a demo aid.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeServer = path.join(root, "scripts", "fake-codex-appserver.mjs");
const ws = path.join(os.tmpdir(), "agentparty-approval-demo");
const userData = path.join(os.tmpdir(), "agentparty-approval-demo-user-data");
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
    AGENTPARTY_FAKE_CODEX_OUT: path.join(os.tmpdir(), "demo-decision.json"),
  },
  windowsHide: true,
  detached: false,
});
child.stdout.on("data", (c) => process.stdout.write(c));
child.stderr.on("data", (c) => process.stderr.write(c));
child.unref();

const post = (u, b) => fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => { if (!r.ok) throw new Error(u + " " + r.status + " " + (await r.text())); return r.json(); });
const getJson = (u) => fetch(base + u).then((r) => r.json());
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (let i = 0; i < 30; i += 1) {
    try { if ((await getJson("/api/health")).ok) break; } catch {}
    await delay(500);
  }
  console.log("api up");
  await post("/api/windows/win-1/workspace", { workspacePath: ws });
  const s = await post("/api/sessions", { workspacePath: ws, selectedHarnessId: "codex", selectedProviderId: "openai", model: "gpt-5.4-mini", permissionMode: "default", codexPolicy: { sandbox: "read-only", approval: "on-request", guardian: false } });
  console.log("codex session", s.id);
  await post(`/api/sessions/${s.id}/send`, { text: "프로젝트 상태를 확인해줘" });
  for (let i = 0; i < 40; i += 1) {
    const st = await getJson("/api/state");
    const sess = st.sessions.find((x) => x.id === s.id);
    if (sess?.snapshot?.status === "error") { console.log("ERROR:", sess.snapshot.lastError); break; }
    if (Number(sess?.snapshot?.pendingApprovalCount || 0) >= 1) { console.log("APPROVAL_PENDING", s.id); break; }
    await delay(400);
  }
  // capture
  try {
    const shot = path.join(os.tmpdir(), "approval-demo.png");
    const cap = await post("/api/capture", { path: shot });
    console.log("CAPTURE", JSON.stringify(cap).slice(0, 200));
    console.log("SHOT", shot);
  } catch (e) { console.log("capture failed", e.message); }
  console.log("DEMO_READY (app left running)");
}

main().catch((e) => { console.error(e); process.exit(1); });
