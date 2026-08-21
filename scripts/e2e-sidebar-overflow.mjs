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
const PARTIES = 24;
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
    const dismissedGuideOffer = await cdp.eval(`(() => {
      const dismiss = document.querySelector("[data-guide-offer] .ghost-btn");
      if (!(dismiss instanceof HTMLElement)) return false;
      dismiss.click();
      return true;
    })()`);
    if (dismissedGuideOffer) await delay(150);

    // Creation entry points stay visible without relying on context menus.
    const emptyGroupName = "empty-group-with-a-deliberately-long-name";
    const existingEmptyGroup = (await getJson("/api/party-groups")).groups.find((group) => group.name === emptyGroupName);
    const emptyGroup = existingEmptyGroup
      ? { group: existingEmptyGroup }
      : await post("/api/party-groups", { name: emptyGroupName });
    await delay(300);
    const creationEntries = await cdp.eval(`(() => {
      const member = document.querySelector(".wb-member-add");
      const groupButtons = [...document.querySelectorAll(".wb-party-add")];
      const empty = groupButtons.find((button) => button.getAttribute("aria-label")?.includes("empty-group-with-a-deliberately-long-name"));
      const memberRect = member?.getBoundingClientRect();
      const emptyRect = empty?.getBoundingClientRect();
      return {
        memberFound: member instanceof HTMLButtonElement,
        memberText: member?.textContent?.trim(),
        oldHintFound: Boolean(document.querySelector(".wb-members-section .wb-section-label .wb-hint")),
        groupButtonCount: groupButtons.length,
        groupCount: document.querySelectorAll(".wb-party-group.is-open").length,
        emptyFound: empty instanceof HTMLButtonElement,
        memberInsideDrawer: Boolean(memberRect && memberRect.left >= 0 && memberRect.right <= document.querySelector(".wb-member-drawer")?.getBoundingClientRect().right),
        emptyInsideDrawer: Boolean(emptyRect && emptyRect.left >= 0 && emptyRect.right <= document.querySelector(".wb-party-drawer")?.getBoundingClientRect().right),
      };
    })()`);
    assert(creationEntries.memberFound && creationEntries.memberText === "\uBA64\uBC84 \uB9CC\uB4E4\uAE30", "the member drawer exposes the labeled create button");
    assert(!creationEntries.oldHintFound, "the former member-selection hint is removed");
    assert(creationEntries.groupButtonCount === creationEntries.groupCount, "every expanded group exposes one party-create button");
    assert(creationEntries.emptyFound, "an empty group exposes its party-create button");
    assert(creationEntries.memberInsideDrawer && creationEntries.emptyInsideDrawer, "creation buttons fit inside narrow drawer geometry");

    const memberFlow = await cdp.eval(`(async () => {
      const button = document.querySelector(".wb-member-add");
      button?.focus();
      const keyboardFocusable = document.activeElement === button;
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        keyboardFocusable,
        expanded: button?.getAttribute("aria-expanded"),
        wizard: Boolean(document.querySelector(".wb-members-section .wb-wizard")),
      };
    })()`);
    assert(memberFlow.keyboardFocusable && memberFlow.expanded === "true" && memberFlow.wizard, "the keyboard-focusable member button opens the existing member wizard");
    await cdp.eval(`document.querySelector(".wb-member-add")?.click()`);

    const partyFlow = await cdp.eval(`(async () => {
      const button = [...document.querySelectorAll(".wb-party-add")].find((item) => item.getAttribute("aria-label")?.includes("empty-group-with-a-deliberately-long-name"));
      button?.focus();
      const keyboardFocusable = document.activeElement === button;
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const modal = document.querySelector(".wb-new-party-modal");
      return {
        keyboardFocusable,
        opened: Boolean(modal),
        groupId: modal?.querySelector(".wb-group-select")?.value,
      };
    })()`);
    assert(partyFlow.keyboardFocusable && partyFlow.opened && partyFlow.groupId === emptyGroup.group.id, "a keyboard-focusable group button opens party creation with that group selected");
    await cdp.eval(`document.querySelector(".wb-new-party-modal .wb-modal-head .wb-icon-btn")?.click()`);

    await post("/api/appearance/theme", { theme: "agentparty-dark" });
    await delay(200);
    const darkGeometry = await cdp.eval(`(() => {
      const member = document.querySelector(".wb-member-add")?.getBoundingClientRect();
      const party = document.querySelector(".wb-party-add")?.getBoundingClientRect();
      return {
        theme: document.documentElement.getAttribute("data-theme"),
        memberVisible: Boolean(member && member.width > 0 && member.height > 0),
        partyVisible: Boolean(party && party.width > 0 && party.height > 0),
      };
    })()`);
    assert(darkGeometry.theme === "agentparty-dark" && darkGeometry.memberVisible && darkGeometry.partyVisible, "creation entries remain visible in the dark theme");
    await post("/api/appearance/theme", { theme: "agentparty-light" });
    await delay(150);
    const creationShot = await post("/api/capture", { path: path.join(os.tmpdir(), "create-actions-e2e.png") });
    assert(creationShot.ok && creationShot.bytes > 0, "saved the creation-entry layout screenshot");

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
      const el = trigger.closest(".wb-dd")?.querySelector(".wb-dd-menu");
      if (!el) return { found: true, opened: false };
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        found: true,
        opened: true,
        bounded: style.maxHeight !== "none",
        maxHeight: style.maxHeight,
        overflowY: style.overflowY,
        onScreen: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth,
        rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) },
        viewport: { w: window.innerWidth, h: window.innerHeight },
        label: (trigger.getAttribute("title") || trigger.textContent || "").trim().slice(0, 40),
        uncut: el.scrollHeight <= el.clientHeight + 1,
      };
    })()`);
    assert(menu.found && menu.opened, `a dropdown menu opens in the workbench`);
    assert(menu.bounded, `the dropdown menu is height-bounded (max-height ${menu.maxHeight}) so a long one scrolls instead of running off-window`);
    assert(menu.overflowY === "auto" || menu.overflowY === "scroll", `the bounded menu scrolls its overflow (overflow-y "${menu.overflowY}")`);
    // Both axes. The horizontal one is [#18]: the panel-header trigger sits near
    // the right edge, so with the old fixed align="left" its menu ran ~30px past
    // the window. <Dropdown> now flips its anchor, and this is what proves it.
    assert(menu.onScreen, `the open "${menu.label}" menu lies entirely inside the window (rect ${JSON.stringify(menu.rect)} in ${JSON.stringify(menu.viewport)})`);
    assert(menu.uncut, "today's tallest menu still renders whole (the cap is not clipping normal menus)");
    await cdp.eval(`document.querySelector(".wb-dd-trigger")?.click()`);

    // Every dropdown in the workbench, not just the first: the fix flips the
    // anchor per trigger, so a right-anchored one (the composer's) must stay
    // correct too, not merely the left-anchored one that was broken.
    const all = await cdp.eval(`(async () => {
      const out = [];
      const triggers = [...document.querySelectorAll(".wb-dd-trigger")];
      let strays = 0;
      for (const trigger of triggers) {
        trigger.click();
        await new Promise((resolve) => setTimeout(resolve, 150));
        // Scoped to THIS trigger's own .wb-dd. A document-wide query would
        // silently measure a previous menu that failed to close, and the
        // count-match below would still pass.
        const el = trigger.closest(".wb-dd")?.querySelector(".wb-dd-menu");
        if (document.querySelectorAll(".wb-dd-menu").length > 1) strays += 1;
        if (el) {
          const r = el.getBoundingClientRect();
          out.push({
            label: (trigger.getAttribute("title") || trigger.textContent || "?").trim().slice(0, 30),
            onScreen: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
            right: Math.round(r.right),
          });
        }
        trigger.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { count: triggers.length, menus: out, strays, leftOpen: document.querySelectorAll(".wb-dd-menu").length };
    })()`);
    // Count-matched on purpose: "no menu opened" would make the containment
    // check below vacuously true, since nothing cannot overflow anything.
    assert(all.count > 0 && all.menus.length === all.count, `every dropdown trigger opened a menu (${all.menus.length}/${all.count})`);
    assert(all.strays === 0 && all.leftOpen === 0, `each menu closed before the next opened, so every measurement belongs to its own trigger (strays ${all.strays}, left open ${all.leftOpen})`);
    const offScreen = all.menus.filter((m) => !m.onScreen);
    assert(offScreen.length === 0, `all ${all.menus.length} open menus stay inside the window${offScreen.length ? ` — off-window: ${JSON.stringify(offScreen)}` : ""}`);

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

    const moreBefore = await cdp.eval(`(() => {
      const button = document.querySelector(".wb-party-more");
      const list = document.querySelector(".wb-party-scroll");
      return { visible: Boolean(button), top: list?.scrollTop || 0, label: button?.getAttribute("aria-label") || "" };
    })()`);
    assert(moreBefore.visible && moreBefore.label.length > 0, "party overflow affordance is visible and keyboard-labelled while content remains below");
    await cdp.eval(`document.querySelector(".wb-party-more")?.click()`);
    await delay(700);
    const moreAfter = await cdp.eval(`document.querySelector(".wb-party-scroll")?.scrollTop || 0`);
    assert(moreAfter > moreBefore.top, `party overflow button advances to the next hidden area (scrollTop ${moreBefore.top} → ${moreAfter})`);

    for (const [label, list, row] of [
      ["party", ".wb-party-scroll", ".wb-party-row"],
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
    await delay(250);
    const moreAtBottom = await cdp.eval(`Boolean(document.querySelector(".wb-party-more"))`);
    assert(!moreAtBottom, "party overflow affordance disappears at the actual bottom");

    // Reproduce the exact lower-row context-menu bug with native pointer input.
    // The previous measurement left the member list at its bottom; the last row
    // is therefore the lowest reachable member in the real viewport.
    const lastMember = await cdp.eval(`(() => {
      const rows = document.querySelectorAll(".wb-member-list .wb-member-row");
      const row = rows[rows.length - 1];
      if (!row) return undefined;
      const rect = row.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, top: rect.top, bottom: rect.bottom };
    })()`);
    assert(Boolean(lastMember), "the bottom member row has a native pointer target");
    if (lastMember) {
      await cdp.rightClick(lastMember.x, lastMember.y);
      await delay(250);
    }
    const contextMenu = await cdp.eval(`(() => {
      const el = document.querySelector(".wb-ctx-menu");
      if (!el) return { found: false };
      const rect = el.getBoundingClientRect();
      return {
        found: true,
        visible: getComputedStyle(el).visibility !== "hidden",
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    })()`);
    assert(contextMenu.found && contextMenu.visible, "right-click opens the bottom member's context menu");
    assert(
      contextMenu.found
        && contextMenu.top >= 0
        && contextMenu.left >= 0
        && contextMenu.bottom <= contextMenu.viewport.height
        && contextMenu.right <= contextMenu.viewport.width,
      "the bottom member context menu stays fully inside the viewport",
    );
    assert(contextMenu.found && lastMember && contextMenu.bottom < lastMember.y, "when it would be clipped below, the context menu opens upward");
    await cdp.eval(`document.dispatchEvent(new MouseEvent("click", { bubbles: true }))`);

    // The parties section must not eat the whole sidebar: Members has to stay
    // visible and usable next to it (this is what `flex:none` + the cap buy).
    const sections = await cdp.eval(`(() => {
      const label = document.querySelector(".wb-member-drawer .wb-drawer-head");
      const list = document.querySelector(".wb-member-list");
      const r = label?.getBoundingClientRect();
      return {
        labelVisible: !!r && r.top >= 0 && r.bottom <= window.innerHeight,
        memberListHeight: list ? list.clientHeight : 0,
      };
    })()`);
    assert(sections.labelVisible, `the Members drawer header is still on screen with ${PARTIES} parties listed`);
    assert(sections.memberListHeight > 100, `the Members list keeps usable height (${sections.memberListHeight}px)`);

    const shot = path.join(os.tmpdir(), "sidebar-overflow-e2e.png");
    // A record only. Whether the list really scrolled is asserted above from CDP
    // measurements; this call proves nothing about it and the message must not
    // imply otherwise (the endpoint reports no scroll outcome today).
    const cap = await post("/api/capture", { path: shot, scrollSelector: ".wb-party-list", scrollY: "bottom" });
    assert(cap.ok && cap.bytes > 0, `saved a screenshot for the record → ${cap.path} (${cap.bytes} bytes)`);

    await del(`/api/party-groups/${encodeURIComponent(emptyGroup.group.id)}`);

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
    async rightClick(x, y) {
      const point = { x: Math.round(x), y: Math.round(y), button: "right", clickCount: 1 };
      await send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 2, ...point });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...point });
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
async function del(u) { const r = await fetch(base + u, { method: "DELETE" }); if (!r.ok) throw new Error(`${u} returned ${r.status}: ${await r.text()}`); return r.json(); }
async function removePath(target) { for (let i = 0; i < 10; i += 1) { try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (e) { if (e?.code !== "EBUSY" || i === 9) return; await delay(300); } } }
function waitForExit(child) { return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("App did not exit after close API.")), 30000); child.once("exit", () => { clearTimeout(t); resolve(); }); }); }
function killProcessTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { try { process.kill(pid); } catch { /* gone */ } } }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
