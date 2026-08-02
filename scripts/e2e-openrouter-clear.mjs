/*
 * Full-process e2e for R-25 — clear a stored OpenRouter key from Authentication.
 * Offline (no provider network). Layout/state measured over CDP.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "ap-or-clear-e2e-ws");
const userData = path.join(os.tmpdir(), "ap-or-clear-e2e-ud");
const shotDir = path.join(os.tmpdir(), "ap-or-clear-shots");
const FAKE_KEY = "sk-or-e2e-clear-key-not-real-0001";

let base = "";
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function main() {
  await removePath(ws);
  await removePath(userData);
  await removePath(shotDir);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    workspacePath: ws,
    openRouterApiKey: FAKE_KEY,
  }, null, 2));

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
      // Empty string is defined, so loadDotEnv will not refill from the repo .env
      // (values already present in the environment win). Without this, clearing
      // settings.json still looks configured via OPENROUTER_API_KEY.
      OPENROUTER_API_KEY: "",
    },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let cdp;
  try {
    base = await discover();
    assert((await get("/api/health")).ok, `app is up at ${base}`);
    const appRoot = (await get("/api/state")).runtime?.appRoot || "";
    const within = (appRoot + path.sep).toLowerCase().startsWith((root + path.sep).toLowerCase());
    assert(Boolean(appRoot) && within, `runtime.appRoot is this worktree (${appRoot})`);

    const authBefore = await get("/api/auth");
    const openrouterBefore = (authBefore.providers || []).find((p) => p.id === "openrouter");
    assert(openrouterBefore?.status === "configured" && Boolean(openrouterBefore?.maskedValue), "OpenRouter key is present before clear");

    await post("/api/navigation", { view: "auth" });
    await delay(500);
    cdp = await attachRenderer();
    assert((await post("/api/capture", { path: path.join(shotDir, "auth-before.png") })).bytes > 0, "auth screen rendered");

    const uiBefore = await cdp.eval(`(() => ({
      hasClear: Boolean(document.querySelector('[data-auth-clear="openrouter"]')),
      clearLabel: (document.querySelector('[data-auth-clear="openrouter"]')?.textContent || "").trim(),
      hasMaskedRow: [...document.querySelectorAll(".set-key-current code")].some((el) => (el.textContent || "").length > 0),
    }))()`);
    assert(uiBefore.hasClear, `Auth UI shows OpenRouter clear button (label=${JSON.stringify(uiBefore.clearLabel)})`);
    assert(uiBefore.hasMaskedRow, "Auth UI shows the masked current key");

    // 1) HTTP clear uses the same AppController method as the Auth button.
    const deleted = await fetch(base + "/api/auth/openrouter", { method: "DELETE" }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, body };
    });
    assert(deleted.ok, `DELETE /api/auth/openrouter succeeded (${deleted.status})`);
    await delay(300);

    const settingsOnDisk = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    assert(!settingsOnDisk.openRouterApiKey, `settings.json key cleared (got ${JSON.stringify(settingsOnDisk.openRouterApiKey)})`);

    let stateAfter = await get("/api/auth");
    let openrouterAfter = (stateAfter.providers || []).find((p) => p.id === "openrouter");
    assert(
      openrouterAfter?.status === "missing" && !openrouterAfter?.maskedValue,
      `auth API reports key missing after DELETE (status=${openrouterAfter?.status}, source=${openrouterAfter?.source})`,
    );

    // 2) Re-seed and clear through the Auth UI button (product path).
    await post("/api/auth/openrouter", { key: FAKE_KEY });
    await delay(300);
    stateAfter = await get("/api/auth");
    openrouterAfter = (stateAfter.providers || []).find((p) => p.id === "openrouter");
    assert(openrouterAfter?.status === "configured", "re-seeded OpenRouter key before UI clear");
    await post("/api/navigation", { view: "auth" });
    await delay(400);
    const uiReady = await cdp.eval(`Boolean(document.querySelector('[data-auth-clear="openrouter"]'))`);
    assert(uiReady, "clear button present after re-seed");
    await post("/api/capture", {
      click: '[data-auth-clear="openrouter"]',
      path: path.join(shotDir, "auth-clear-click.png"),
    });
    await delay(600);
    stateAfter = await get("/api/auth");
    openrouterAfter = (stateAfter.providers || []).find((p) => p.id === "openrouter");
    assert(
      openrouterAfter?.status === "missing" && !openrouterAfter?.maskedValue,
      `stored OpenRouter key is gone after UI clear (status=${openrouterAfter?.status})`,
    );

    const uiAfter = await cdp.eval(`(() => ({
      hasClear: Boolean(document.querySelector('[data-auth-clear="openrouter"]')),
    }))()`);
    assert(!uiAfter.hasClear, "clear button disappears once the key is gone");

    assert((await post("/api/capture", { path: path.join(shotDir, "auth-after.png") })).bytes > 0, "auth after clear captured");

    // Survive restart.
    cdp.close();
    cdp = null;
    await post("/api/window/close", {});
    await waitForExit(child);

    const child2 = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
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
    child2.stderr.on("data", (chunk) => process.stderr.write(chunk));
    try {
      base = await discover();
      const restarted = await get("/api/auth");
      const providers = restarted.providers || (Array.isArray(restarted) ? restarted : []);
      const or = providers.find((p) => p.id === "openrouter");
      assert(!or?.maskedValue && or?.status !== "configured", "cleared OpenRouter key stays cleared across restart");
      await post("/api/window/close", {});
      await waitForExit(child2);
    } catch (error) {
      killProcessTree(child2.pid);
      throw error;
    }

    console.log("");
    if (failures.length) {
      console.log(`OPENROUTER CLEAR E2E FAILED: ${failures.length}`);
      for (const f of failures) console.log(` - ${f}`);
      process.exit(1);
    }
    console.log("OPENROUTER CLEAR E2E PASSED");
  } catch (error) {
    try { cdp?.close(); } catch {}
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
  throw new Error("App did not advertise an automation endpoint for the e2e workspace.");
}

async function attachRenderer() {
  const portFile = path.join(userData, "DevToolsActivePort");
  const started = Date.now();
  let port = 0;
  while (Date.now() - started < 30_000) {
    try {
      port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0].trim());
      if (port > 0) break;
    } catch {}
    await delay(250);
  }
  if (!port) throw new Error(`Electron never wrote ${portFile}`);
  let target;
  while (Date.now() - started < 30_000) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (target) break;
    await delay(250);
  }
  if (!target) throw new Error("No debuggable renderer page target found.");
  const { default: WebSocket } = await import("ws");
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
  return {
    async eval(expression) {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(`Renderer evaluation threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      }
      return result.result.value;
    },
    close() { try { socket.close(); } catch {} },
  };
}

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}
async function post(route, body) {
  const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}
async function removePath(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; }
    catch (error) { if (error?.code !== "EBUSY" || attempt === 9) return; await delay(300); }
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

main().catch((error) => { console.error(error); process.exit(1); });
