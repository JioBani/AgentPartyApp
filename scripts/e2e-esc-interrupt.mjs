/*
 * Full-process e2e for Esc turn interrupt (R-12) + popup-first (R-13).
 * Offline mock member. Asserts runtime.appRoot is THIS worktree.
 * Never kills foreign electron processes.
 *
 * Run: npm run test:e2e:esc-interrupt
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-esc-interrupt-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-esc-interrupt-e2e-user-data");

let base = "";
const failures = [];
const assert = (cond, msg) => { console.log("  " + (cond ? "PASS" : "FAIL") + " " + msg); if (!cond) failures.push(msg); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function removePath(target) {
  await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
}

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
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      AGENTPARTY_AUTOMATION_PORT: "",
    },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let cdp;
  try {
    base = await discover();
    assert((await get("/api/health")).ok, "app is up at " + base);

    const appRoot = (await get("/api/state")).runtime?.appRoot || "";
    const within = (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep);
    assert(Boolean(appRoot) && within, "running build is THIS worktree (appRoot=" + (appRoot || "<missing>") + ")");

    await post("/api/qa/seed", {
      party: "esc interrupt e2e",
      members: [{ name: "worker", model: "claude-sonnet-4.5", role: "esc", status: "working" }],
    });
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["worker"]] });
    await delay(800);

    const before = await get("/api/party/status");
    const workerBefore = (before.members || []).find((m) => m.name === "worker");
    assert(workerBefore?.turnActive === true, "seeded member is mid-turn");

    cdp = await attachRenderer();
    // Focus the panel so R-12 applies to this member.
    await cdp.eval('document.querySelector(".wb-panel")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))');
    await delay(100);

    // R-13: open model catalog (Escape-owning popup), Esc closes it without stopping the turn.
    await cdp.eval('document.querySelector(".wb-model-pill")?.click()');
    await delay(300);
    const modalOpen = await cdp.eval('!!document.querySelector(".wb-modal")');
    assert(modalOpen, "model catalog popup opened");

    await cdp.eval('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await delay(250);
    const modalClosed = await cdp.eval('!document.querySelector(".wb-modal")');
    assert(modalClosed, "Esc closes the popup first (R-13)");
    const stillBusy = await get("/api/party/status");
    assert((stillBusy.members || []).find((m) => m.name === "worker")?.turnActive === true, "popup Esc did not interrupt the turn");

    // R-12: Esc with no popup stops the focused member.
    await cdp.eval('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await delay(500);
    const after = await get("/api/party/status");
    assert((after.members || []).find((m) => m.name === "worker")?.turnActive === false, "Esc interrupts the focused busy member (R-12)");

    console.log(failures.length ? ("\nE2E ESC INTERRUPT FAILED (" + failures.length + ")") : "\nE2E ESC INTERRUPT PASSED");
  } finally {
    killProcessTree(child.pid);
    await waitForExit(child);
    if (cdp) try { cdp.close(); } catch {}
  }
  process.exit(failures.length ? 1 : 0);
}

async function discover() {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const url = firstBaseUrl(ws);
    if (url) {
      try {
        const response = await fetch(url + "/api/health");
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
  if (!port) throw new Error("Electron never wrote " + portFile + " — was --remote-debugging-port passed?");

  let target;
  while (Date.now() - started < 30_000) {
    const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
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
    pending.set(id, (msg) => (msg.error ? reject(new Error(method + ": " + msg.error.message)) : resolve(msg.result)));
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
  if (!r.ok) throw new Error("GET " + p + " -> " + r.status + ": " + (await r.text()));
  return r.json();
}
async function post(p, body) {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("POST " + p + " -> " + r.status + ": " + JSON.stringify(json));
  return json;
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  } catch { /* already gone */ }
}
function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.on("exit", resolve);
    setTimeout(resolve, 5000);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
