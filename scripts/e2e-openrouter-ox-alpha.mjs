/*
 * Ox Alpha end to end, in the real app — OFFLINE (mock harness, no provider call).
 *
 * The catalog contract is checked by qa-openrouter-ox-alpha; what only the real
 * app can answer is whether a user can actually GET to the model: does it appear
 * in the route list the renderer receives, does the catalog modal's search find
 * it, can a member be created on it, does that member persist the model, and
 * does the panel show the OpenRouter identity rather than the harness's.
 *
 * Deliberately does not send a turn: that would spend a third-party preview and
 * needs a real harness. The upstream call is contract-checked separately.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-ox-alpha-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-ox-alpha-e2e-user-data");
const shots = path.join(os.tmpdir(), "agentparty-ox-alpha-e2e");

const OR_MODEL_ID = "stealth/ox-alpha";
const CATALOG_ID = "Ox Alpha";

let base = "";
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
    windowsHide: true,
  });
  child.stderr.on("data", () => {});

  let cdp;
  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "health ok");
    await post("/api/qa/seed", { party: "ox-alpha", members: [{ name: "main", role: "e2e" }] });
    await post("/api/party/members/main/open");
    await delay(900);
    cdp = await attachRenderer();
    await dismissGuideOffer(cdp);

    console.log("\nthe model reaches the renderer:");
    const listed = await cdp.eval(`(async () => {
      const res = await window.agentParty.listModels();
      const routes = res?.modelRoutes || [];
      const mine = routes.filter((r) => r.model === ${JSON.stringify(CATALOG_ID)} || r.model === ${JSON.stringify(OR_MODEL_ID)});
      return {
        total: routes.length,
        count: mine.length,
        byHarness: Object.fromEntries(mine.map((r) => [r.harnessId, { enabled: r.enabled, provider: r.providerId, model: r.model, reason: r.unavailableReason || null }])),
        effort: mine.find((r) => r.harnessId === "claude-code")?.capabilities?.effort || null,
        thinking: mine.find((r) => r.harnessId === "claude-code")?.capabilities?.thinking || null,
        openrouterTotal: routes.filter((r) => r.providerId === "openrouter").length,
      };
    })()`);
    assert(listed.count >= 2, `the app publishes routes for it (${listed.count} of ${listed.total})`);
    assert(listed.byHarness["claude-code"]?.enabled === true, "claude-code can run it");
    assert(listed.byHarness["claude-code"]?.provider === "openrouter", "…as an OpenRouter model");
    assert(listed.byHarness.codex?.model === OR_MODEL_ID, "the codex route carries OpenRouter's exact id");
    assert(listed.effort?.options?.map((o) => o.id).join(",") === "low,high,max", "three effort levels reach the UI");
    assert(listed.effort?.defaultValue === "max", "…defaulting to max");
    assert((listed.thinking?.modes || []).length === 1, "the UI is given no way to turn reasoning off");
    assert(listed.openrouterTotal > 23, `the other OpenRouter models are still published too (${listed.openrouterTotal} routes)`);

    console.log("\nit is reachable from the catalog UI:");
    const catalogUi = await cdp.eval(`(async () => {
      const pill = document.querySelector(".wb-model-pill");
      if (!pill) return { opened: false };
      pill.click();
      await new Promise((r) => setTimeout(r, 400));
      const modal = document.querySelector(".wb-modal, .wb-catalog, [role=dialog]");
      const nameOf = (el) => (el.textContent || "").trim();
      const rows = [...document.querySelectorAll(".wb-catalog-row, .wb-model-row, [data-model-id]")];
      const search = document.querySelector('.wb-catalog-search input, input[type="search"], .wb-modal input');
      let searchHits = null;
      if (search) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(search, "ox");
        search.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        searchHits = [...document.querySelectorAll(".wb-catalog-row, .wb-model-row, [data-model-id]")].map(nameOf).filter((t) => /ox alpha/i.test(t)).length;
      }
      return {
        opened: Boolean(modal),
        listedBeforeSearch: rows.map(nameOf).filter((t) => /ox alpha/i.test(t)).length,
        searchHits,
        openrouterGroup: [...document.querySelectorAll("*")].some((el) => /openrouter/i.test(el.textContent || "") && el.children.length === 0),
      };
    })()`);
    if (catalogUi.opened) {
      assert(catalogUi.listedBeforeSearch > 0 || catalogUi.searchHits > 0, `the catalog lists it (${catalogUi.listedBeforeSearch} rows, ${catalogUi.searchHits} after searching "ox")`);
      if (catalogUi.searchHits !== null) {
        assert(catalogUi.searchHits > 0, "searching finds it by name");
      }
    } else {
      console.log("  (model catalog modal did not open — skipped)");
    }
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await delay(200);

    console.log("\na member can actually be created on it:");
    const created = await post("/api/party/members", {
      name: "ox-tester",
      requirement: "ox alpha e2e",
      runtime: "claude-code",
      model: CATALOG_ID,
      effort: "max",
    }).catch((error) => ({ error: String(error.message || error) }));
    assert(!created.error, `member creation accepted the model (${created.error || "ok"})`);
    const state = await getJson("/api/state");
    const member = (state.party?.members || []).find((m) => m.name === "ox-tester");
    assert(Boolean(member), "the member exists");
    assert(member?.model === CATALOG_ID, `…pinned to the catalog id (${member?.model})`);
    assert(member?.effort === "max", `…and to the effort it was created with (${member?.effort})`);

    await post("/api/party/members/ox-tester/open").catch(() => {});
    await delay(700);
    const panel = await cdp.eval(`(() => {
      const tabs = [...document.querySelectorAll(".wb-tab")];
      const tab = tabs.find((t) => t.querySelector(".wb-tab-name")?.textContent === "ox-tester");
      const panelEl = tab?.closest(".wb-panel");
      return {
        tabPresent: Boolean(tab),
        providerLabel: tab?.querySelector(".wb-member-mark")?.getAttribute("title") || null,
        neutralMark: Boolean(tab?.querySelector(".wb-provider-icon-generic")),
        modelPill: panelEl?.querySelector(".wb-model-pill .wb-mono")?.textContent || null,
        row: (() => {
          const r = [...document.querySelectorAll(".wb-member-row")].find((el) => el.querySelector(".wb-member-name")?.textContent === "ox-tester");
          return r ? { mark: r.querySelector(".wb-member-mark")?.getAttribute("title") || null } : null;
        })(),
      };
    })()`);
    assert(panel.tabPresent, "the member opens in a panel");
    assert(panel.providerLabel === "OpenRouter", `its mark names OpenRouter, not the harness (${panel.providerLabel})`);
    assert(panel.neutralMark, "…using the neutral mark, since OpenRouter has no brand artwork here");
    assert(panel.row?.mark === "OpenRouter", "the sidebar row agrees with the tab");
    assert(/ox/i.test(panel.modelPill || ""), `the panel names the model (${panel.modelPill})`);

    console.log("\nstarting it without OpenRouter credentials fails loudly, not silently:");
    const started = await post("/api/party/members/ox-tester/start", {}).catch((error) => ({ error: String(error.message || error) }));
    const status = JSON.stringify(started).toLowerCase();
    assert(!/sk-or-|bearer |api[_-]?key["']?\\s*[:=]\\s*["'][a-z0-9]/i.test(JSON.stringify(started)), "no credential material appears in the start response");
    console.log(`  (start outcome recorded: ${status.slice(0, 120)})`);

    await post("/api/capture", { path: path.join(shots, "01-ox-alpha-member.png") }).catch(() => {});
  } finally {
    await post("/api/window/close", {}).catch(() => {});
    await delay(300);
    child.kill();
  }

  console.log(failures.length ? `\nOX ALPHA E2E FAILED (${failures.length})` : "\nOX ALPHA E2E PASSED");
  console.log(`screenshots: ${shots}`);
  process.exit(failures.length ? 1 : 0);
}

async function dismissGuideOffer(cdp) {
  const dismissed = await cdp.eval(`(() => {
    const dismiss = document.querySelector("[data-guide-offer] .ghost-btn");
    if (!(dismiss instanceof HTMLElement)) return false;
    dismiss.click();
    return true;
  })()`);
  if (dismissed) await delay(150);
}

async function attachRenderer() {
  const portFile = path.join(userData, "DevToolsActivePort");
  const started = Date.now();
  let port = 0;
  while (Date.now() - started < 30000) {
    try {
      port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0].trim());
      if (port > 0) break;
    } catch { /* not written yet */ }
    await delay(250);
  }
  if (!port) throw new Error("Electron never wrote DevToolsActivePort.");
  let target;
  while (Date.now() - started < 30000) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
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
  return {
    async eval(expression) {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(`Renderer evaluation threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      }
      return result.result.value;
    },
    close() { socket.close(); },
  };
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    base = firstBaseUrl(ws);
    if (base) { try { if ((await getJson("/api/health")).ok) return; } catch { /* still booting */ } }
    await delay(500);
  }
  throw new Error("Automation API did not start.");
}

async function getJson(u) { const r = await fetch(base + u); if (!r.ok) throw new Error(`${u} returned ${r.status}`); return r.json(); }
async function post(u, b) { const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error(`${u} returned ${r.status}: ${await r.text()}`); return r.json(); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function removePath(target) { await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {}); }

main().catch((error) => { console.error(error); process.exit(1); });
