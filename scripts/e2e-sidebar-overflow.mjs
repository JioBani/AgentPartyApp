/*
 * Full-process e2e for list/menu OVERFLOW SAFETY — OFFLINE (mock members, no
 * model). Regression guard for [#11]: with more parties/members than fit the
 * window, the sidebar lists must SCROLL, not clip. `.wb-member-list` already
 * had this bug once and was fixed; `.wb-party-list` regressed the same way, so
 * the invariant is worth locking down instead of eyeballing a screenshot.
 *
 * Assertions are measured in the REAL renderer, not read off a picture: the app
 * is launched with `--remote-debugging-port=0` and driven over CDP, so real
 * layout (flex pressure, computed max-height, hit-testing) is what answers. The
 * decisive check is `document.elementFromPoint()` over the LAST row after
 * scrolling to the bottom — that is exactly the user complaint ("항목이 화면 밖으로
 * 밀리면 아예 클릭할 방법이 없음"), and it fails if the row is clipped or covered.
 *
 * A capture is saved too, but only as a record; nothing here depends on a human
 * looking at it. Not billed; safe to run anytime after `npm run build`.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-sidebar-overflow-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-sidebar-overflow-e2e-user-data");
const PARTIES = 16;
const MEMBERS = 26;

let base = "";
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  // Chromium writes DevToolsActivePort before Electron creates userData itself.
  fs.mkdirSync(userData, { recursive: true });

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
    windowsHide: true,
  });
  child.stdout.on("data", (c) => process.stdout.write(c));
  child.stderr.on("data", (c) => process.stderr.write(c));

  let cdp;
  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "health ok");

    await post("/api/qa/seed", { party: "lane-01", members: [{ name: "main", role: "overflow e2e" }] });
    await post("/api/party/members/main/open");
    await delay(800);
    cdp = await attachRenderer();

    // Overflowing POPUPS are the other half of #11: a menu must be bounded and
    // fully on-window, otherwise its tail is unreachable the same way. Checked
    // first, while one member owns a full-width panel — the panel's dropdowns
    // are hidden at narrow widths, which is what many open panels produce.
    const menu = await cdp.eval(`(async () => {
      const trigger = document.querySelector(".wb-dd-trigger");
      if (!trigger) return { found: false };
      trigger.click();
      // React renders the menu on the next tick — measuring synchronously here
      // would report "no menu" for a perfectly working dropdown.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const el = document.querySelector(".wb-dd-menu");
      if (!el) return { found: true, opened: false };
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        found: true,
        opened: true,
        bounded: style.maxHeight !== "none",
        maxHeight: style.maxHeight,
        overflowY: style.overflowY,
        verticallyOnScreen: rect.top >= 0 && rect.bottom <= window.innerHeight,
        rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) },
        viewport: { w: window.innerWidth, h: window.innerHeight },
        label: (trigger.getAttribute("title") || trigger.textContent || "").trim().slice(0, 40),
        uncut: el.scrollHeight <= el.clientHeight + 1,
      };
    })()`);
    assert(menu.found && menu.opened, `a dropdown menu opens in the workbench`);
    assert(menu.bounded, `the dropdown menu is height-bounded (max-height ${menu.maxHeight}) so a long one scrolls instead of running off-window`);
    assert(menu.overflowY === "auto" || menu.overflowY === "scroll", `the bounded menu scrolls its overflow (overflow-y "${menu.overflowY}")`);
    // Vertical only, deliberately. HORIZONTAL containment is NOT asserted because
    // it does not hold today: <Dropdown> defaults to align="left" (`left: 0`), so
    // a trigger near the right edge puts its 180px-min-width menu partly past the
    // window. That is a placement bug in src/renderer/workbench/Dropdown.tsx —
    // no CSS rule can flip the anchor — and is reported separately rather than
    // quietly dropped here. Extend this to `rect.right <= viewport.w` when the
    // dropdown learns to flip its alignment.
    assert(menu.verticallyOnScreen, `the open "${menu.label}" menu is vertically inside the window (rect ${JSON.stringify(menu.rect)} in ${JSON.stringify(menu.viewport)})`);
    assert(menu.uncut, "today's tallest menu still renders whole (the cap is not clipping normal menus)");
    await cdp.eval(`document.querySelector(".wb-dd-trigger")?.click()`);

    // Now far more parties and members than any window height can show at once.
    for (let i = 2; i <= PARTIES; i += 1) {
      await post("/api/parties", { name: `lane-${String(i).padStart(2, "0")}-a-deliberately-long-party-name` });
    }
    const first = (await getJson("/api/state")).party?.parties?.find((p) => p.name === "lane-01");
    if (!first) throw new Error("seeded party lane-01 is missing from /api/state");
    await post(`/api/parties/${first.id}/select`);
    for (let i = 1; i <= MEMBERS; i += 1) {
      await post("/api/qa/members", { name: `member-${String(i).padStart(2, "0")}`, role: "overflow e2e" });
    }
    await delay(800);

    const counts = await cdp.eval(`({
      parties: document.querySelectorAll(".wb-party-list .wb-party-row").length,
      members: document.querySelectorAll(".wb-member-list .wb-member-row").length,
      innerHeight: window.innerHeight,
    })`);
    assert(counts.parties === PARTIES, `sidebar renders all ${PARTIES} parties (got ${counts.parties})`);
    assert(counts.members === MEMBERS + 1, `sidebar renders all ${MEMBERS + 1} members (got ${counts.members})`);

    for (const [label, list, row] of [
      ["party", ".wb-party-list", ".wb-party-row"],
      ["member", ".wb-member-list", ".wb-member-row"],
    ]) {
      const m = await cdp.eval(measureList(list, row));
      assert(m.found, `${label} list is present`);
      assert(m.overflows, `${label} list overflows its box (scrollHeight ${m.scrollHeight} > clientHeight ${m.clientHeight})`);
      assert(m.scrollable, `${label} list scrolls it (computed overflow-y "${m.overflowY}", scrollTop reached ${m.scrolledTo})`);
      assert(m.withinViewport, `${label} list stays inside the window (bottom ${Math.round(m.bottom)} ≤ ${m.innerHeight})`);
      // The complaint itself: the last row must be hit-testable after scrolling.
      assert(m.lastRowReachable, `last ${label} row is reachable by click after scrolling to the bottom (hit "${m.hitText}")`);
    }

    // The parties section must not eat the whole sidebar: Members has to stay
    // visible and usable next to it (this is what `flex:none` + the cap buy).
    const sections = await cdp.eval(`(() => {
      const label = [...document.querySelectorAll(".wb-section-label")].find((el) => el.textContent.includes("Members"));
      const list = document.querySelector(".wb-member-list");
      const r = label?.getBoundingClientRect();
      return {
        labelVisible: !!r && r.top >= 0 && r.bottom <= window.innerHeight,
        memberListHeight: list ? list.clientHeight : 0,
      };
    })()`);
    assert(sections.labelVisible, "the Members section label is still on screen with 16 parties listed");
    assert(sections.memberListHeight > 100, `the Members list keeps usable height (${sections.memberListHeight}px)`);

    const shot = path.join(os.tmpdir(), "sidebar-overflow-e2e.png");
    const cap = await post("/api/capture", { path: shot, scrollSelector: ".wb-party-list", scrollY: "bottom" });
    assert(cap.ok && cap.bytes > 0, `captured the scrolled sidebar → ${cap.path} (${cap.bytes} bytes)`);

    cdp.close();
    await post("/api/window/close", {});
    await waitForExit(child);
    console.log(failures.length ? `\nSIDEBAR OVERFLOW E2E FAILED (${failures.length})` : "\nSIDEBAR OVERFLOW E2E PASSED");
    process.exit(failures.length ? 1 : 0);
  } catch (error) {
    try { cdp?.close(); } catch { /* already gone */ }
    killProcessTree(child.pid);
    throw error;
  }
}

/**
 * Measures one list the way a user experiences it: does it overflow, does it
 * scroll, and — after scrolling to the bottom — is the LAST row the element the
 * mouse would actually hit at its own centre?
 */
function measureList(listSelector, rowSelector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(listSelector)});
    if (!el) return { found: false };
    const style = getComputedStyle(el);
    el.scrollTop = el.scrollHeight;
    const rows = el.querySelectorAll(${JSON.stringify(rowSelector)});
    const last = rows[rows.length - 1];
    const box = el.getBoundingClientRect();
    const r = last ? last.getBoundingClientRect() : null;
    const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    return {
      found: true,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflows: el.scrollHeight > el.clientHeight + 1,
      overflowY: style.overflowY,
      scrolledTo: el.scrollTop,
      scrollable: (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollTop > 0,
      bottom: box.bottom,
      innerHeight: window.innerHeight,
      withinViewport: box.bottom <= window.innerHeight + 1 && box.top >= -1,
      lastRowReachable: !!(hit && last && (last === hit || last.contains(hit))),
      hitText: (hit?.textContent || "").trim().slice(0, 40),
    };
  })()`;
}

/**
 * Attaches to the renderer over the Chrome DevTools Protocol. The port is
 * ephemeral (`--remote-debugging-port=0`); Chromium writes the real one to
 * `<userData>/DevToolsActivePort`, so nothing is hardcoded here either.
 */
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
  if (!port) throw new Error(`Electron never wrote ${portFile} — was --remote-debugging-port passed?`);

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
  throw new Error("Automation API did not start (no live instance file under the e2e workspace).");
}

async function getJson(u) { const r = await fetch(base + u); if (!r.ok) throw new Error(`${u} returned ${r.status}`); return r.json(); }
async function post(u, b) { const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error(`${u} returned ${r.status}: ${await r.text()}`); return r.json(); }
async function removePath(target) { for (let i = 0; i < 10; i += 1) { try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (e) { if (e?.code !== "EBUSY" || i === 9) return; await delay(300); } } }
function waitForExit(child) { return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("App did not exit after close API.")), 10000); child.once("exit", () => { clearTimeout(t); resolve(); }); }); }
function killProcessTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { try { process.kill(pid); } catch { /* gone */ } } }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
