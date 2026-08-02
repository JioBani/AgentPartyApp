/*
 * Full-process e2e for R-8 / R-9 / F-83 — reasoning options unified into the
 * model catalog, including the previously-dead harness-default fields
 * (thinking budget + Cursor speed grade).
 *
 * Offline (mock members, no model calls). Layout/state assertions are measured
 * in the running renderer over CDP (`--remote-debugging-port=0`), never by
 * eyeing a capture. Captures are saved only as a handoff record.
 *
 * Step 0 asserts runtime.appRoot is THIS worktree on a path boundary (not a
 * bare prefix of the main checkout).
 *
 * Run: npm run test:e2e:reasoning-unify   (builds, then runs this)
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "ap-reasoning-unify-e2e-ws");
const userData = path.join(os.tmpdir(), "ap-reasoning-unify-e2e-ud");
const shotDir = path.join(os.tmpdir(), "ap-reasoning-unify-shots");

let base = "";
const failures = [];
const assert = (cond, msg) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures.push(msg);
};

async function main() {
  await removePath(ws);
  await removePath(userData);
  await removePath(shotDir);
  fs.mkdirSync(ws, { recursive: true });
  // Chromium writes DevToolsActivePort before Electron creates userData itself.
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  // Workspace comes from the isolated settings file — no workspace env var.
  // Leave automationApiPort unset so the port stays ephemeral and is discovered
  // from the workspace instance file (never attach to a fixed/user port).
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

    // Step 0 — running build must be THIS worktree (boundary, not bare prefix).
    const appRoot = (await get("/api/state")).runtime?.appRoot || "";
    const within = (appRoot + path.sep).toLowerCase().startsWith((root + path.sep).toLowerCase());
    assert(Boolean(appRoot), `runtime.appRoot is reported (got ${JSON.stringify(appRoot)})`);
    assert(within, `runtime.appRoot is this worktree (${appRoot} within ${root})`);
    const mainRoot = path.resolve(root, "..", "AgentPartyApp");
    const mistakenMain = (appRoot + path.sep).toLowerCase().startsWith((mainRoot + path.sep).toLowerCase())
      && !(appRoot + path.sep).toLowerCase().startsWith((root + path.sep).toLowerCase());
    assert(!mistakenMain, "running build is NOT the main AgentPartyApp checkout");

    await post("/api/qa/reset").catch(() => {});
    await post("/api/qa/seed", { party: "reasoning", members: [{ name: "worker", role: "r" }] });
    let party = await get("/api/party");
    const partyId = party.currentPartyId || party.members[0]?.partyId;

    // Haiku (not Sonnet): catalog only shows the thinking-budget slider when
    // the selected model advertises a budget — Sonnet has thinking modes but
    // no budget axis, so a Sonnet default would green-wash F-83's dead field.
    const claudeDefaults = {
      model: "haiku",
      effort: "high",
      reasoning: "enabled",
      reasoningBudget: 4096,
      permissionMode: "default",
    };
    const cursorDefaults = {
      model: "Grok 4.5",
      effort: "high",
      serviceTier: "fast",
      cursorPolicy: { mode: "agent", approval: "allowlist" },
    };
    await post("/api/settings", {
      harnessDefaults: {
        "claude-code": claudeDefaults,
        cursor: cursorDefaults,
      },
    });
    const saved = await get("/api/state");
    assert(saved.settings?.harnessDefaults?.["claude-code"]?.reasoningBudget === 4096, "settings API stores thinking budget");
    assert(saved.settings?.harnessDefaults?.cursor?.serviceTier === "fast", "settings API stores Cursor speed grade");

    await post("/api/party/members", {
      partyId,
      name: "budgeted",
      requirement: "inherits thinking budget",
      runtime: "claude-code",
    });
    await post("/api/party/members", {
      partyId,
      name: "speedy",
      requirement: "inherits Cursor speed",
      runtime: "cursor",
    });
    party = await get("/api/party");
    const budgeted = party.members.find((m) => m.name === "budgeted");
    const speedy = party.members.find((m) => m.name === "speedy");
    assert(budgeted?.reasoningBudget === 4096 && budgeted?.reasoning === "enabled", "new Claude member inherits thinking budget + mode");
    assert(speedy?.serviceTier === "fast", "new Cursor member inherits speed grade");

    await post("/api/navigation", { view: "runtime" });
    await delay(500);
    cdp = await attachRenderer();

    assert((await post("/api/capture", { path: path.join(shotDir, "runtime-defaults.png") })).bytes > 0, "runtime settings screen rendered");

    await post("/api/capture", {
      click: ".set-harness-card .wb-model-picker-trigger",
      path: path.join(shotDir, "catalog-open.png"),
    });
    await delay(300);

    // Haiku: thinking + budget (F-83 dead field). No effort on this model.
    const haikuCatalog = await cdp.eval(`(() => {
      const heads = [...document.querySelectorAll(".wb-detail-section-head")].map((el) => (el.textContent || "").trim());
      return {
        heads,
        hasThinking: heads.some((t) => /Thinking/i.test(t)),
        hasBudget: Boolean(document.querySelector("input[type=range]")),
        outerEffort: [...document.querySelectorAll(".set-field-label")].some((el) => el.textContent === "추론 강도"),
        outerMode: [...document.querySelectorAll(".set-field-label")].some((el) => el.textContent === "추론 모드"),
      };
    })()`);
    assert(haikuCatalog.hasThinking, `haiku catalog shows thinking (${haikuCatalog.heads.join(" | ")})`);
    assert(haikuCatalog.hasBudget, "haiku catalog shows thinking budget slider");
    assert(!haikuCatalog.outerEffort && !haikuCatalog.outerMode, "duplicate outer effort/mode segments are gone");

    // Sonnet: effort axis (no budget). Click, wait for React to restage caps, then measure.
    const sonnetClick = await cdp.eval(`(() => {
      const row = [...document.querySelectorAll(".wb-model-row")].find((el) => /Sonnet/i.test(el.textContent || ""));
      if (!row) return { clicked: false, label: "" };
      row.click();
      return { clicked: true, label: (row.textContent || "").trim() };
    })()`);
    assert(sonnetClick.clicked, "selected Sonnet in the catalog list");
    await delay(250);
    const sonnetCatalog = await cdp.eval(`(() => {
      const selected = document.querySelector(".wb-model-row.is-selected");
      const heads = [...document.querySelectorAll(".wb-detail-section-head")].map((el) => (el.textContent || "").trim());
      return {
        selectedLabel: (selected?.textContent || "").trim(),
        heads,
        hasEffort: heads.some((t) => /Effort/i.test(t)),
        hasThinking: heads.some((t) => /Thinking/i.test(t)),
        hasBudget: Boolean(document.querySelector("input[type=range]")),
      };
    })()`);
    assert(/Sonnet/i.test(sonnetCatalog.selectedLabel), `Sonnet row is selected (got ${JSON.stringify(sonnetCatalog.selectedLabel)})`);
    assert(sonnetCatalog.hasEffort, `sonnet catalog shows effort (${sonnetCatalog.heads.join(" | ")})`);
    assert(sonnetCatalog.hasThinking, `sonnet catalog shows thinking (${sonnetCatalog.heads.join(" | ")})`);
    assert(!sonnetCatalog.hasBudget, "sonnet catalog hides budget (model has no budget axis)");

    await cdp.eval(`(() => { document.querySelector(".wb-icon-btn[title='Close']")?.click(); })()`);
    await post("/api/navigation", { view: "workbench" });
    await delay(400);
    const header = await cdp.eval(`(() => ({
      hasEffortTitle: [...document.querySelectorAll("[title]")].some((el) => el.getAttribute("title") === "Effort"),
      hasUnifiedPill: [...document.querySelectorAll("[title]")].some((el) => (el.getAttribute("title") || "").includes("추론")),
    }))()`);
    assert(!header.hasEffortTitle, "workbench header has no separate Effort dropdown");
    assert(header.hasUnifiedPill, "workbench header model pill is the reasoning entry");
    assert((await post("/api/capture", { path: path.join(shotDir, "workbench-header.png") })).bytes > 0, "workbench captured");

    cdp.close();
    cdp = null;
    await post("/api/window/close", {});
    await waitForExit(child);

    // Survive restart — relaunch same userData/workspace.
    const child2 = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
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
    child2.stderr.on("data", (chunk) => process.stderr.write(chunk));
    try {
      base = await discover();
      const restarted = await get("/api/state");
      assert(restarted.settings?.harnessDefaults?.["claude-code"]?.reasoningBudget === 4096, "thinking budget survives app restart");
      assert(restarted.settings?.harnessDefaults?.cursor?.serviceTier === "fast", "Cursor speed survives app restart");
      const restartedParty = await get("/api/party");
      assert(restartedParty.members.find((m) => m.name === "budgeted")?.reasoningBudget === 4096, "inherited budget survives restart on the member");
      assert(restartedParty.members.find((m) => m.name === "speedy")?.serviceTier === "fast", "inherited speed survives restart on the member");
      await post("/api/window/close", {});
      await waitForExit(child2);
    } catch (error) {
      killProcessTree(child2.pid);
      throw error;
    }

    console.log("");
    if (failures.length) {
      console.log(`REASONING UNIFY E2E FAILED: ${failures.length}`);
      for (const f of failures) console.log(` - ${f}`);
      process.exit(1);
    }
    console.log("REASONING UNIFY E2E PASSED");
  } catch (error) {
    try { cdp?.close(); } catch { /* already gone */ }
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
      } catch { /* still starting */ }
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
    } catch { /* not written yet */ }
    await delay(250);
  }
  if (!port) throw new Error(`Electron never wrote ${portFile} — was --remote-debugging-port passed?`);

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
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
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
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) return;
      await delay(300);
    }
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
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    try { process.kill(pid); } catch { /* gone */ }
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
