/*
 * Full-process e2e for the model catalog list (R-5 / R-6 / R-7).
 *
 * Launches the REAL app, opens the Runtime catalog through the real UI control,
 * and MEASURES the running renderer over the Chrome DevTools Protocol. Numbers,
 * not screenshots: this project has had capture-based checks pass silently while
 * the layout was wrong, so every geometric claim here is a computed value read
 * out of the live renderer and compared against the confirmed mockup, which was
 * rendered and measured the same way.
 *
 * It also proves the UI and the automation API share ONE path for favourites:
 * the star is driven from the UI and read back over HTTP, and a favourite
 * written over HTTP shows up in the UI without a reload.
 *
 * Offline — a mock member, no model turn, nothing billed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-catalog-list-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-catalog-list-e2e-user-data");
// Captures are regenerated evidence, not source — kept out of the repo.
const shots = path.join(os.tmpdir(), "agentparty-catalog-list-e2e-shots");

let base = "";
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };
const near = (actual, expected, tol, msg) => assert(Math.abs(actual - expected) <= tol, `${msg} — ${actual} vs ${expected} (±${tol})`);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* What the confirmed mockup measured, rendered and probed the same way.
   Source: `docs/디자인 핸드오프/design_handoff_model_catalog/Model Catalog.dc.html`
   (2026-08-10 handoff — the search box grew 30 → 32, the star shrank 24 → 22). */
const MOCKUP = {
  searchWrapHeight: 32,
  searchWrapRadius: 8,
  searchWrapGap: 7,
  searchFontSize: 12,
  starBox: 22,
  columnTiers: 3,
};

async function main() {
  await rm(ws); await rm(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });
  // The app reads its launch workspace ONLY from here (there is no workspace env
  // var). The port is left ephemeral and found through the instance file.
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_ALLOW_MULTI_INSTANCE: "1", AGENTPARTY_USER_DATA: userData, AGENTPARTY_WINDOW_DISPLAY: "left" },
    windowsHide: true,
  });
  child.stderr.on("data", (c) => process.stderr.write(c));

  let cdp;
  try {
    await waitForApi();

    // --- step 0: is the build we are driving THIS worktree? ----------------
    console.log("\nStep 0 — the running build is this worktree:");
    const state = await getJson("/api/state");
    const appRoot = state.runtime?.appRoot || "";
    // Boundary compare: "…/AgentPartyApp" is a string PREFIX of
    // "…/AgentPartyApp-b1", so a bare startsWith would accept the main build as
    // ours — reproducing the exact false pass this check exists to prevent.
    const within = (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep);
    assert(within, `runtime.appRoot is under this script's root (${appRoot})`);
    const servedWs = ((await getJson("/api/windows")).windows || [])[0]?.workspacePath || "";
    assert(path.resolve(servedWs).toLowerCase() === path.resolve(ws).toLowerCase(), "the served workspace is the isolated e2e one");
    if (!within) { throw new Error("Refusing to continue: driving a different checkout."); }

    await post("/api/qa/seed", { party: "catalog-e2e", members: [{ name: "main", role: "catalog list e2e" }] });
    await post("/api/party/members/main/open");
    await delay(900);
    cdp = await attachRenderer();

    // --- open the catalog through the REAL control -------------------------
    console.log("\nOpening the catalog from the panel's model control:");
    const opened = await cdp.eval(`(() => {
      const pill = document.querySelector(".wb-model-pill");
      if (!pill) return { ok: false };
      pill.click();
      return { ok: true };
    })()`);
    assert(opened.ok === true, "the panel's model control exists and was clicked");
    await delay(600);
    assert(await cdp.eval(`!!document.querySelector(".wb-model-list")`), "the catalog opened");

    const theme = await cdp.eval(`document.documentElement.getAttribute("data-theme") || "(default)"`);
    console.log(`  · measured in theme: ${theme}`);

    // --- the three-tier column --------------------------------------------
    console.log("\nColumn structure (fixed head / fixed search row / scrolling list):");
    const col = await cdp.eval(`(() => {
      const list = document.querySelector(".wb-model-list");
      const cs = getComputedStyle(list);
      const scroll = list.querySelector(".wb-model-scroll");
      const row = list.querySelector(".wb-model-search-row");
      const head = list.querySelector(".wb-model-list-head");
      const r = (el) => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
      return {
        listOverflow: cs.overflow, listDisplay: cs.display, listDir: cs.flexDirection, listMinH: cs.minHeight,
        scrollFlex: getComputedStyle(scroll).flex, scrollOverflowY: getComputedStyle(scroll).overflowY,
        scrollMinH: getComputedStyle(scroll).minHeight,
        rowFlex: getComputedStyle(row).flex, headFlex: getComputedStyle(head).flex,
        searchInsideScroll: !!scroll.querySelector(".wb-model-search-row"),
        rects: { list: r(list), row: r(row), scroll: r(scroll), head: r(head) },
      };
    })()`);
    assert(col.listDisplay === "flex" && col.listDir === "column", "the column is a flex column");
    assert(col.listMinH === "0px", "the column can shrink (min-height 0) so the list scrolls instead of pushing");
    assert(col.scrollOverflowY === "auto", "only the list scrolls");
    assert(col.scrollFlex.startsWith("1 1"), "the list takes the remaining height");
    assert(col.headFlex.startsWith("0 0") && col.rowFlex.startsWith("0 0"), "the header and the search row are fixed");
    assert(col.searchInsideScroll === false, "the search row is OUTSIDE the scrolling area");
    assert(col.rects.row.y < col.rects.scroll.y, "the search row sits above the list");
    console.log(`  · tiers: head h=${col.rects.head.h}, searchRow h=${col.rects.row.h}, list h=${col.rects.scroll.h}`);

    // --- the search field, against the mockup ------------------------------
    console.log("\nSearch field vs the confirmed mockup:");
    const field = await cdp.eval(`(() => {
      const wrap = document.querySelector(".wb-model-search");
      const input = wrap.querySelector(".wb-model-search-input");
      const cs = getComputedStyle(wrap);
      const ics = getComputedStyle(input);
      return {
        h: +wrap.getBoundingClientRect().height.toFixed(1),
        radius: parseFloat(cs.borderTopLeftRadius),
        gap: parseFloat(cs.gap),
        borderWidth: parseFloat(cs.borderTopWidth),
        fontSize: parseFloat(ics.fontSize),
        placeholder: input.placeholder,
        ariaLabel: input.getAttribute("aria-label"),
      };
    })()`);
    near(field.h, MOCKUP.searchWrapHeight, 1, "search box height matches the mockup");
    near(field.radius, MOCKUP.searchWrapRadius, 0.5, "search box corner radius matches");
    near(field.gap, MOCKUP.searchWrapGap, 1.5, "icon/input gap matches");
    near(field.fontSize, MOCKUP.searchFontSize, 0.5, "input font size matches");
    assert(field.borderWidth >= 1, "the box has a border");
    assert(field.ariaLabel === "모델 검색", "the input is labelled for screen readers");
    console.log(`  · placeholder: "${field.placeholder}"`);

    // --- R-5: collapsed by default ----------------------------------------
    console.log("\nR-5 — provider groups:");
    const collapsed = await cdp.eval(`(() => {
      const heads = [...document.querySelectorAll(".wb-model-provider-btn")];
      return {
        count: heads.length,
        expanded: heads.map(h => h.getAttribute("aria-expanded")),
        previews: heads.map(h => (h.querySelector(".wb-model-preview")||{}).textContent || ""),
        rows: document.querySelectorAll(".wb-model-scroll .wb-model-row").length,
        inUse: heads.filter(h => h.querySelector(".wb-model-inuse")).length,
      };
    })()`);
    assert(collapsed.count > 0, `provider groups render (${collapsed.count})`);
    assert(collapsed.expanded.filter((v) => v === "true").length <= 1, "at most one group is expanded on open (the current model's)");
    assert(collapsed.previews.some((p) => p.length > 0), "a collapsed header previews the names it hides");
    console.log(`  · groups=${collapsed.count} expanded=${collapsed.expanded.join(",")} rows=${collapsed.rows} 사용중배지=${collapsed.inUse}`);

    // --- R-6: favourites, both directions ---------------------------------
    console.log("\nR-6 — favourites travel the SAME path as the UI:");
    const modelRoutes = (await getJson("/api/models")).modelRoutes || [];
    // /api/models serves EVERY harness's routes; this catalog is scoped to the
    // member's harness. Starring a route outside that scope would correctly show
    // nothing, so pick from what this list actually offers.
    await cdp.eval(`[...document.querySelectorAll(".wb-model-provider-btn")].forEach(h => { if (h.getAttribute("aria-expanded") === "false") h.click(); })`);
    await delay(500);
    // Read the id off the rendered row rather than guessing it from the label:
    // a model cross-routed to another harness shares its label but not its id,
    // so label matching silently picks a route this list never shows.
    const visible = await cdp.eval(`[...document.querySelectorAll(".wb-model-scroll .wb-model-row")].map(r => r.dataset.model)`);
    const selectedId = await cdp.eval(`document.querySelector(".wb-model-row.is-selected")?.dataset.model || ""`);
    const firstId = visible.find((id) => id && id !== selectedId);
    assert(!!firstId, `the catalog offers models in scope (${visible.length} of ${modelRoutes.length} routes; starring ${firstId})`);

    // Direction 1 — starred in the UI, persisted through the settings path and
    // readable over HTTP. This is what makes the star and the API one route.
    const before = (await getJson("/api/state")).settings?.favoriteModels || [];
    const toggled = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll(".wb-model-scroll .wb-model-row")];
      const target = rows.find(r => !r.querySelector(".wb-model-star.is-on"));
      if (!target) return { ok: false };
      return {
        ok: true,
        selected: document.querySelector(".wb-model-row.is-selected .wb-model-name .wb-mono")?.textContent || "",
        name: target.querySelector(".wb-model-name .wb-mono").textContent,
        clicked: (target.querySelector(".wb-model-star").click(), true),
      };
    })()`);
    assert(toggled.ok, "found an unstarred row to star");
    await delay(900);
    const stored = (await getJson("/api/state")).settings?.favoriteModels || [];
    assert(stored.length === before.length + 1, `starring in the UI persisted over HTTP (${before.length} → ${stored.length})`);
    const afterStar = await cdp.eval(`(() => ({
      selected: document.querySelector(".wb-model-row.is-selected .wb-model-name .wb-mono")?.textContent || "",
      pinned: [...document.querySelectorAll(".wb-model-group.is-favorites .wb-model-row .wb-model-name .wb-mono")].map(n => n.textContent),
      head: (document.querySelector(".wb-model-list-head .wb-mono")||{}).textContent,
    }))()`);
    assert(afterStar.selected === toggled.selected, "the star click did NOT change the selected model");
    assert(afterStar.pinned.includes(toggled.name), `the starred model moved to the pinned section (${afterStar.pinned.join(", ")})`);
    assert(/★\s*1/.test(afterStar.head || ""), `the header counts it (${afterStar.head})`);
    assert(afterStar.pinned.length === 1, "it is listed once — lifted OUT of its provider group, not duplicated");

    // Direction 2 — written over HTTP. Settings reach a window on its next load
    // (documented for this endpoint), so reload before reading the UI back
    // rather than asserting a live push this endpoint does not promise.
    await post("/api/settings", { favoriteModels: [firstId, "no-such-model-xyz"] });
    await reopenCatalog(cdp);
    const ghost = await cdp.eval(`(() => ({
      favRows: [...document.querySelectorAll(".wb-model-group.is-favorites .wb-model-row")].map(r => r.dataset.model),
      head: (document.querySelector(".wb-model-list-head .wb-mono")||{}).textContent,
    }))()`);
    assert(ghost.favRows.join() === firstId, `a favourite written over HTTP shows up, and the unresolvable one draws NO ghost row (${ghost.favRows.join(", ") || "none"})`);
    assert(/★\s*1/.test(ghost.head || ""), `the header counts what is SHOWN, not what is stored (${ghost.head})`);
    const keptStored = (await getJson("/api/state")).settings?.favoriteModels || [];
    assert(keptStored.includes("no-such-model-xyz"), "…yet the unknown id is KEPT in storage, never silently pruned");

    // --- R-7: search -------------------------------------------------------
    console.log("\nR-7 — search:");
    await post("/api/settings", { favoriteModels: [] });
    await delay(500);
    const search = async (text) => {
      await cdp.eval(`(() => {
        const input = document.querySelector(".wb-model-search-input");
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await delay(400);
      return cdp.eval(`(() => ({
        head: (document.querySelector(".wb-model-list-head .wb-mono")||{}).textContent,
        rows: [...document.querySelectorAll(".wb-model-scroll .wb-model-row .wb-model-name .wb-mono")].map(n => n.textContent),
        groups: document.querySelectorAll(".wb-model-scroll .wb-model-group").length,
        expanded: [...document.querySelectorAll(".wb-model-provider-btn")].map(h => h.getAttribute("aria-expanded")),
        empty: !!document.querySelector(".wb-model-empty"),
        emptyText: (document.querySelector(".wb-model-empty p")||{}).textContent || "",
        clear: !!document.querySelector(".wb-model-search-clear"),
      }))()`);
    };

    const hit = await search("claude");
    assert(/일치/.test(hit.head || ""), `the header switches to a match count (${hit.head})`);
    assert(hit.rows.length > 0, "matches are listed");
    // "Claude" is the PROVIDER's product name, so this query is expected to
    // match Anthropic models whose own names ("Fable", "Opus 5") never contain
    // it — that is the provider axis working, not a leak.
    const anthropicNames = modelRoutes.filter((r) => r.providerId === "anthropic").map((r) => r.label || r.model);
    assert(hit.rows.every((n) => /claude/i.test(n) || anthropicNames.includes(n)), "every listed row matches by model name or by provider");
    assert(hit.rows.some((n) => !/claude/i.test(n)), "the provider axis really pulls in models whose own name lacks the query");
    assert(hit.expanded.every((v) => v === "true"), "every surviving group renders expanded while searching");
    assert(hit.clear === true, "the clear control appears once there is a query");

    const miss = await search("Llama");
    assert(miss.empty === true, "no match draws the empty state");
    assert(miss.emptyText.includes('"Llama"'), "the empty state echoes the query in the user's original casing");
    assert(miss.groups === 0, "no provider group is left behind at zero matches");

    // Escape must not take the modal with it.
    await cdp.eval(`document.querySelector(".wb-model-search-input").focus()`);
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await delay(400);
    const afterEsc = await cdp.eval(`(() => ({
      open: !!document.querySelector(".wb-model-list"),
      query: (document.querySelector(".wb-model-search-input")||{}).value,
    }))()`);
    assert(afterEsc.open === true, "Escape with a query does NOT close the catalog");
    assert(afterEsc.query === "", "…it clears the query instead");

    // --- overflow safety ---------------------------------------------------
    console.log("\nOverflow safety (many models, narrow window):");
    const overflow = await cdp.eval(`(() => {
      const heads = [...document.querySelectorAll(".wb-model-provider-btn")];
      heads.forEach(h => { if (h.getAttribute("aria-expanded") === "false") h.click(); });
      return true;
    })()`);
    assert(overflow === true, "expanded every provider group to fill the list");
    await delay(600);
    const bounds = await cdp.eval(`(() => {
      const scroll = document.querySelector(".wb-model-scroll");
      const modal = document.querySelector(".wb-modal");
      scroll.scrollTop = scroll.scrollHeight;
      const rows = [...scroll.querySelectorAll(".wb-model-row")];
      const last = rows[rows.length - 1];
      const lb = last.getBoundingClientRect();
      const sb = scroll.getBoundingClientRect();
      const mb = modal.getBoundingClientRect();
      const hitEl = document.elementFromPoint(lb.x + lb.width / 2, lb.y + lb.height / 2);
      return {
        rows: rows.length,
        scrolls: scroll.scrollHeight > scroll.clientHeight + 1,
        insideViewport: mb.right <= window.innerWidth + 1 && mb.bottom <= window.innerHeight + 1,
        lastInsideList: lb.bottom <= sb.bottom + 1,
        lastClickable: !!hitEl && (hitEl === last || last.contains(hitEl)),
        overflowX: getComputedStyle(scroll).overflowX,
      };
    })()`);
    console.log(`  · ${bounds.rows} rows, scrollable=${bounds.scrolls}`);
    assert(bounds.insideViewport, "the catalog stays inside the window");
    if (bounds.scrolls) {
      assert(bounds.lastInsideList, "after scrolling to the bottom the last row is inside the list box");
      assert(bounds.lastClickable, "…and it is actually clickable (nothing covers it)");
    } else {
      console.log("  · (list fits without scrolling at this size — clip check not applicable)");
    }

    // Narrow window: the preview text must give way, not push the header out.
    // Deliberately NOT wrapped in a catch — a resize that silently fails would
    // turn this into a check that always passes at the default width.
    // 1100 is the app's enforced minimum window width, so it is the narrowest a
    // user can actually get — asking for less just clamps. Assert the app really
    // moved to its floor rather than pretending we tested a width it forbids.
    const resized = await post("/api/qa/window/bounds", { width: 900, height: 760 });
    assert(resized?.bounds?.width === 1100, `the window is at its narrowest allowed width (${resized?.bounds?.width})`);
    await delay(700);
    const narrow = await cdp.eval(`(() => {
      const heads = [...document.querySelectorAll(".wb-model-provider-btn")];
      const list = document.querySelector(".wb-model-list");
      const lb = list.getBoundingClientRect();
      return {
        headsInside: heads.every(h => { const b = h.getBoundingClientRect(); return b.right <= lb.right + 1; }),
        namesVisible: heads.every(h => (h.querySelector(".wb-model-provider-name")||{}).getBoundingClientRect?.().width > 0),
      };
    })()`);
    assert(narrow.headsInside, "provider headers stay inside the column when the window narrows");
    assert(narrow.namesVisible, "the provider name survives narrowing (the preview is what shrinks)");

    // --- side-by-side captures --------------------------------------------
    // Reproduce the confirmed screenshot's state: two favourites pinned on top,
    // every provider group collapsed. Comparing against a mid-test scroll
    // position would be comparing two different screens.
    console.log("\nCaptures for the side-by-side:");
    await post("/api/qa/window/bounds", { width: 1400, height: 900 });
    const twoFavs = visible.filter((id) => id).slice(0, 2);
    await post("/api/settings", { favoriteModels: twoFavs });
    await reopenCatalog(cdp);
    const shotState = await cdp.eval(`(() => {
      document.querySelector(".wb-model-scroll").scrollTop = 0;
      return {
        pinned: document.querySelectorAll(".wb-model-group.is-favorites .wb-model-row").length,
        collapsed: [...document.querySelectorAll(".wb-model-provider-btn")].filter(h => h.getAttribute("aria-expanded") === "false").length,
        groups: document.querySelectorAll(".wb-model-provider-btn").length,
        head: (document.querySelector(".wb-model-list-head .wb-mono")||{}).textContent,
      };
    })()`);
    assert(shotState.pinned === 2, `two favourites pinned for the shot (${shotState.pinned})`);
    console.log(`  · ${shotState.collapsed}/${shotState.groups} groups collapsed · header "${shotState.head}"`);

    // The confirmed screenshots are light-theme; dark is shot too because the
    // colours are tokens and one that only resolves in one theme is a bug.
    await capture("catalog-app-default-light.png", "light");
    await capture("catalog-app-default-dark.png", "dark");
    await search("claude");
    await capture("catalog-app-search-light.png", "light");
    await search("Llama");
    await capture("catalog-app-empty-light.png", "light");

    console.log(`\ncaptures → ${shots}`);
  } finally {
    try { cdp?.close(); } catch { /* already gone */ }
    await post("/api/window/close", {}).catch(() => {});
    await delay(1200);
    try { child.kill(); } catch { /* already stopped */ }
  }

  console.log(failures.length ? `\n${failures.length} failure(s)` : "\nall good");
  process.exit(failures.length ? 1 : 0);
}

/** Reloads the window and reopens the catalog from the real control. */
async function reopenCatalog(cdp) {
  await cdp.eval(`location.reload()`).catch(() => {});
  await delay(2500);
  const fresh = await attachRenderer();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ready = await fresh.eval(`!!document.querySelector(".wb-model-pill")`);
    if (ready) { break; }
    await delay(500);
  }
  await fresh.eval(`document.querySelector(".wb-model-pill")?.click()`);
  await delay(800);
  const open = await fresh.eval(`!!document.querySelector(".wb-model-list")`);
  assert(open, "the catalog reopened after the reload");
  // Hand the caller the live session; the old socket points at a dead frame.
  Object.assign(cdp, fresh);
  return fresh;
}

async function capture(name, theme) {
  const body = { path: path.join(shots, name) };
  if (theme) { body.theme = theme; }
  const res = await post("/api/capture", body);
  // A capture that quietly fails leaves the reviewer comparing a stale file.
  assert(res?.ok !== false && fs.existsSync(body.path), `captured ${name}`);
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
  if (!port) throw new Error(`Electron never wrote ${portFile}.`);
  let target;
  while (Date.now() - started < 30000) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (target) break;
    await delay(250);
  }
  if (!target) throw new Error("No debuggable renderer page target found.");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("CDP websocket failed to open.")); });
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
  while (Date.now() - started < 90000) {
    base = firstBaseUrl(ws);
    if (base) { try { if ((await getJson("/api/health")).ok) return; } catch { /* still booting */ } }
    await delay(500);
  }
  throw new Error("The app's automation API never came up.");
}

async function getJson(route) {
  const res = await fetch(base + route);
  if (!res.ok) throw new Error(`${route} ${res.status}`);
  return res.json();
}

async function post(route, body) {
  const res = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!res.ok) throw new Error(`${route} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function rm(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; } catch { await delay(300); }
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
