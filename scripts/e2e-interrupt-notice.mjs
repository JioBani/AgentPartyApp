/*
 * Full-process e2e for interrupt notice vs real failure (R-90 / R-91).
 * Offline: injects the event shapes Claude emits, asserts the LIVE UI.
 *
 * Step 0 asserts runtime.appRoot is THIS worktree. Never kills foreign electrons.
 *
 * Run: npm run test:e2e:interrupt-notice
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-interrupt-notice-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-interrupt-notice-e2e-user-data");
const shotDir = path.join(os.tmpdir(), "agentparty-interrupt-notice-shots");

let base = "";
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function removePath(target) {
  await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
}

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      AGENTPARTY_AUTOMATION_PORT: "",
    },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let cdp;
  try {
    base = await discover();
    assert((await get("/api/health")).ok, `app is up at ${base}`);

    const appRoot = (await get("/api/state")).runtime?.appRoot || "";
    const within = (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep);
    assert(Boolean(appRoot) && within, `running build is THIS worktree (appRoot=${appRoot || "<missing>"})`);

    await post("/api/qa/seed", {
      party: "interrupt notice e2e",
      members: [{ name: "worker", role: "r", status: "working" }],
    });
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["worker"]] });
    await delay(700);

    cdp = await attachRenderer();

    // R-90: intentional interrupt events (what ClaudeAdapter now emits).
    await post("/api/qa/members/worker/emit", {
      events: [{
        type: "diagnostic",
        severity: "info",
        category: "interrupt",
        title: "턴이 중단되었습니다",
        detail: "사용자 또는 다른 멤버의 요청으로 진행 중이던 작업이 멈췄습니다. 실패가 아닙니다.",
        recovery: "이어서 도착하는 메시지가 있으면 그것을 먼저 처리하세요.",
        at: new Date().toISOString(),
      }],
      status: "idle",
    });
    await delay(400);

    let ui = await cdp.eval(`(() => ({
      errors: [...document.querySelectorAll(".wb-error")].map((el) => el.textContent.trim()),
      diags: [...document.querySelectorAll(".wb-diagnostic")].map((el) => ({
        text: el.textContent.trim(),
        severity: [...el.classList].find((c) => c.startsWith("is-")) || "",
      })),
    }))()`);
    assert(ui.errors.length === 0, `R-90: no red error block after intentional stop (${JSON.stringify(ui.errors)})`);
    assert(ui.diags.some((d) => d.severity === "is-info" && /중단/.test(d.text) && /실패가 아닙니다/.test(d.text)),
      `R-90: info diagnostic explains the stop (${JSON.stringify(ui.diags)})`);

    // R-91: a real failure must still look like an error — distinguishable from R-90.
    await post("/api/qa/members/worker/emit", {
      events: [{ type: "error", message: "API rate limit exceeded", at: new Date().toISOString() }],
    });
    await delay(400);

    ui = await cdp.eval(`(() => ({
      errors: [...document.querySelectorAll(".wb-error")].map((el) => el.textContent.trim()),
      diags: [...document.querySelectorAll(".wb-diagnostic.is-info")].map((el) => el.textContent.trim()),
    }))()`);
    assert(ui.errors.some((t) => /rate limit/i.test(t)), `R-91: real failure still shows as .wb-error (${JSON.stringify(ui.errors)})`);
    assert(ui.diags.some((t) => /중단/.test(t)), "R-91: prior interrupt guidance remains visible alongside the real error");

    const shot = path.join(shotDir, "interrupt-notice.png");
    const cap = await post("/api/capture", { path: shot });
    assert(cap.ok && cap.bytes > 0, `capture → ${shot} (${cap.bytes}B)`);

    console.log(failures.length ? `\nE2E INTERRUPT NOTICE FAILED (${failures.length})` : "\nE2E INTERRUPT NOTICE PASSED");
  } finally {
    killProcessTree(child.pid);
    await waitForExit(child);
    if (cdp) try { cdp.close(); } catch { /* ignore */ }
  }
  process.exit(failures.length ? 1 : 0);
}

async function discover() {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const url = firstBaseUrl(ws);
    if (url) {
      try {
        const response = await fetch(`${url}/api/health`);
        if (response.ok && (await response.json()).ok) return url;
      } catch { /* still starting */ }
    }
    await delay(500);
  }
  throw new Error("App did not advertise an automation endpoint for the e2e workspace.");
}

async function attachRenderer() {
  const { WebSocket } = await import("ws");
  const portFile = path.join(userData, "DevToolsActivePort");
  const started = Date.now();
  let port = 0;
  while (Date.now() - started < 30_000) {
    try {
      port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0].trim());
      if (port > 0) break;
    } catch { /* not written yet */ }
    await delay(250);
  }
  if (!port) throw new Error(`Electron never wrote ${portFile}`);

  let target;
  while (Date.now() - started < 30_000) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    if (target) break;
    await delay(250);
  }
  if (!target) throw new Error("No debuggable renderer page target found.");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("CDP websocket failed to open."));
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (entry) { pending.delete(msg.id); entry(msg); }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable");
  return {
    eval: async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    },
    close: () => socket.close(),
  };
}

async function get(p) {
  const r = await fetch(base + p);
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}: ${await r.text()}`);
  return r.json();
}
async function post(p, body) {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status}: ${JSON.stringify(json)}`);
  return json;
}
function killProcessTree(pid) {
  if (!pid) return;
  try { spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }); } catch { /* already gone */ }
}
function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.on("exit", resolve);
    setTimeout(resolve, 5000);
  });
}

main().catch((error) => { console.error(error); process.exit(1); });
