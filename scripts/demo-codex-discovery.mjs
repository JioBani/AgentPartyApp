/*
 * Live demo for Codex `/` palette discovery (Item 4). Launches the real app on
 * the LEFT monitor with the fake app-server (returns sample skills/plugins) and a
 * remote-debugging port, creates a Codex member, sends a turn (so the thread
 * starts and discovery runs), then types "/" into the member's composer over CDP
 * to open the palette, and captures it. Leaves the app running.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeServer = path.join(root, "scripts", "fake-codex-appserver.mjs");
const ws = path.join(os.tmpdir(), "agentparty-discovery-demo");
const userData = path.join(os.tmpdir(), "agentparty-discovery-demo-user-data");
const port = 48936;
const cdpPort = 9223;
const base = `http://127.0.0.1:${port}`;

fs.mkdirSync(ws, { recursive: true });

const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start", "--", `--remote-debugging-port=${cdpPort}`], {
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

/** Minimal CDP: evaluate JS in the first page target. */
async function cdpEval(expression) {
  const targets = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json());
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no CDP page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const result = await new Promise((res, rej) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) res(d); };
    ws.onerror = rej;
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  ws.close();
  return result?.result?.result?.value;
}

async function main() {
  for (let i = 0; i < 30; i += 1) { try { if ((await getJson("/api/health")).ok) break; } catch {} await delay(500); }
  console.log("api up");
  await post("/api/windows/win-1/workspace", { workspacePath: ws });
  await post("/api/parties", { name: "discovery 시연" });
  await post("/api/party/members", { name: "codey", requirement: "discovery 시연", runtime: "codex", model: "gpt-5.4-mini", permissionMode: "default" });
  await post("/api/party/members/codey/open", {});
  await post("/api/party/members/codey/send", { content: "KIND=items 안녕" });
  // Wait for discovery to populate the snapshot.
  for (let i = 0; i < 30; i += 1) {
    const st = await getJson("/api/state");
    const s = st.sessions.find((x) => x.snapshot?.model === "gpt-5.4-mini");
    if ((s?.snapshot?.slashCommands || []).some((c) => c.name === "deep-dive")) { console.log("DISCOVERY_READY"); break; }
    await delay(400);
  }
  // Type "/" into codey's composer to open the palette (React-controlled input).
  await delay(500);
  const typed = await cdpEval(`(() => {
    const ta = document.querySelector('textarea[placeholder^="codey"]');
    if (!ta) return 'no-textarea';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '/');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    return 'typed';
  })()`);
  console.log("cdp:", typed);
  await delay(600);
  try {
    const shot = path.join(os.tmpdir(), "discovery-demo.png");
    const cap = await post("/api/capture", { path: shot });
    console.log("SHOT", cap.path);
  } catch (e) { console.log("capture failed", e.message); }
  console.log("DEMO_READY");
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
