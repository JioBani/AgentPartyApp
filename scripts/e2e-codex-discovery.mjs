/*
 * Full-process e2e for Codex `/` palette discovery (Item 4) AND live model
 * catalog discovery, driven by the fake codex app-server. Launches the REAL app
 * on the LEFT monitor, creates a Codex member, and asserts that:
 *   - the adapter queried skills/list + plugin/installed and merged the results
 *     (with source + disabled reason) into the session snapshot's slashCommands;
 *   - model/list discovery populated GET /api/models with every visible fake
 *     model as a codex route (default first, hidden dropped), alongside the
 *     bundled Codex routes;
 *   - the real command palette allows a newly discovered skill while keeping a
 *     harness-disabled skill blocked.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
      AGENTPARTY_QA: "1",
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

    // Model catalog discovery (kicked by state loads) settles against the fake
    // app-server; /api/models must then expose every visible model as a route.
    const catalog = await waitForModelCatalog();
    assert(catalog.codexModels.status === "ready", "codex model discovery reports ready");
    // Account-catalog routes (from model/list) are the openai-provider codex
    // routes; codex OpenRouter routes (Phase 2) carry providerId openrouter.
    const accountRoutes = catalog.modelRoutes.filter((route) => route.harnessId === "codex" && route.providerId === "openai");
    assert(accountRoutes.some((route) => route.model === "fake-5.5"), "default visible fake model is an account codex route");
    assert(accountRoutes.some((route) => route.model === "fake-5.4"), "second visible fake model is an account codex route");
    assert(!accountRoutes.some((route) => route.model === "hidden-model"), "hidden fake model is dropped");
    assert(accountRoutes[0].model === "fake-5.5", "the account-default model is first");
    assert(accountRoutes[0].capabilities?.effort?.options?.length === 4, "effort options come from the model's supportedReasoningEfforts");
    const orRoutes = catalog.modelRoutes.filter((route) => route.harnessId === "codex" && route.modelProvider === "openrouter");
    assert(orRoutes.length >= 10, "OpenRouter catalog models are also exposed as codex routes (Phase 2)");

    await post("/api/parties", { name: "skill blocklist e2e" });
    await post("/api/party/members", {
      name: "codey",
      requirement: "verify Codex skill discovery",
      runtime: "codex",
      model: "gpt-5.4-mini",
      codexPolicy: { sandbox: "workspace-write", approval: "on-request", guardian: false },
    });
    await post("/api/party/members/codey/open", {});

    // Thread start (which triggers skills/plugin discovery) happens on first turn.
    await post("/api/party/members/codey/message", { text: "KIND=items 안녕" });

    const { sessionId, commands } = await waitForDiscovery("codey");
    assert(sessionId, "codex member owns a live session");
    const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
    assert(byName.model?.source === "built-in", "built-in command reported with source");
    assert(byName["deep-dive"]?.source === "skill", "discovered skill merged into slashCommands with source=skill");
    assert(byName["legacy-skill"]?.disabledReason, "disabled skill carries a disabled reason");
    assert(byName.formatter?.source === "plugin", "installed plugin merged with source=plugin");
    assert(byName["blocked-plugin"]?.disabledReason, "admin-disabled plugin carries a disabled reason");

    // Drive the user-visible workflow through the same local automation API a
    // QA agent uses: open the real panel, type into the real composer, and read
    // the rendered palette rather than importing its model in isolation.
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["codey"]] });
    await delay(800);
    const editor = ".wb-composer-editor";
    await post("/api/qa/input", { selector: editor, text: "/deep" });
    await delay(300);
    const enabledRows = await post("/api/measure", {
      selector: ".wb-cmd-row",
      attributes: ["aria-disabled", "title"],
    });
    const deepDive = enabledRows.elements.find((row) => row.text.startsWith("/deep-dive"));
    assert(deepDive?.attributes?.["aria-disabled"] === "false", "newly discovered skill is selectable in the real palette");
    const selected = await post("/api/qa/input", { selector: editor, key: "Enter" });
    assert(selected.draft === "/deep-dive ", `selecting the skill inserts it into the real composer (${JSON.stringify(selected.draft)})`);

    await post("/api/qa/input", { selector: editor, text: "/legacy" });
    await delay(300);
    const blockedRows = await post("/api/measure", {
      selector: ".wb-cmd-row",
      attributes: ["aria-disabled", "title"],
    });
    const legacy = blockedRows.elements.find((row) => row.text.startsWith("/legacy-skill"));
    assert(legacy?.attributes?.["aria-disabled"] === "true", "harness-disabled skill remains blocked in the real palette");
    assert(legacy?.attributes?.title === "비활성화된 skill", "blocked skill shows the harness reason");

    await post("/api/party/members/codey/close", {});
    await post("/api/window/close", {});
    await waitForExit(child);
    console.log("CODEX DISCOVERY E2E PASSED");
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

/** Waits until codex model discovery settles (ready or error) in /api/models. */
async function waitForModelCatalog() {
  const started = Date.now();
  let last;
  while (Date.now() - started < 20000) {
    last = await getJson("/api/models");
    if (last.codexModels?.status === "ready") {
      return last;
    }
    if (last.codexModels?.status === "error") {
      throw new Error(`codex model discovery failed: ${last.codexModels.error}`);
    }
    await delay(400);
  }
  throw new Error(`codex model discovery did not settle within 20s (last: ${JSON.stringify(last?.codexModels)})`);
}

/** Waits until the session snapshot's slashCommands include the discovered skill. */
async function waitForDiscovery(memberName) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const st = await getJson("/api/state");
    const member = st.party?.members?.find((candidate) => candidate.name === memberName);
    const s = st.sessions.find((candidate) => candidate.id === member?.sessionId);
    const commands = s?.snapshot?.slashCommands || [];
    if (commands.some((c) => c.name === "deep-dive")) {
      return { sessionId: s.id, commands };
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
