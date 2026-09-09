/*
 * Full-process e2e: a dropdown menu must not be clipped by its container.
 *
 * The composer's permission menu is ~250px tall; the composer is ~110px and
 * `overflow: hidden`, and `.wb-panel` carries `container-type: inline-size`,
 * which makes it a containing block for fixed descendants too. So the menu was
 * cut to the composer's box: four of its six options were invisible and
 * unclickable, and the CSS `max-height: 60vh` guard never applied because the
 * limit was the container, not the viewport.
 *
 * Geometry alone cannot catch this: the layout box was always correct, only the
 * painted result was cut. What proves the fix is STRUCTURAL — the menu is no
 * longer a descendant of the clipping container, and it is placed against the
 * viewport rather than that container.
 *
 * The click below is NOT that proof: /api/capture dispatches the click on the
 * element itself rather than hit-testing a coordinate, so it succeeds against a
 * clipped menu too. It is here for the regression portalling itself introduces —
 * the menu leaves `.wb-dd`, so an outside-click test that only knows about
 * `.wb-dd` would unmount the option on mousedown and the click would do
 * nothing. It guards that, and nothing more.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-dd-clip-ws");
const userData = path.join(os.tmpdir(), "agentparty-dd-clip-ud");
const port = Number(process.env.AGENTPARTY_DD_CLIP_PORT || "") || 48997;
const base = `http://127.0.0.1:${port}`;
const outDir = process.env.AGENTPARTY_DD_CLIP_OUT || os.tmpdir();
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(u) { const r = await fetch(`${base}${u}`); return r.json(); }
async function post(u, b) {
  const r = await fetch(`${base}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
  return r.json();
}
async function waitForApi() {
  for (let i = 0; i < 120; i++) { try { if ((await getJson("/api/health")).ok) return true; } catch {} await delay(500); }
  throw new Error("API never came up");
}
function killTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }

async function measure(selector, extra = {}) {
  const res = await post("/api/measure", { selector, limit: 10, ...extra });
  return Array.isArray(res.elements) ? res.elements : [];
}
async function permissionOf(name) {
  const party = await getJson("/api/party");
  return party.members?.find((m) => m.name === name)?.permissionMode;
}

async function main() {
  for (const p of [ws, userData]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  fs.mkdirSync(ws, { recursive: true });

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root, stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
    env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_AUTOMATION_PORT: String(port), AGENTPARTY_USER_DATA: userData, AGENTPARTY_WINDOW_DISPLAY: "left" },
  });

  try {
    await waitForApi();
    const windowId = (await getJson("/api/windows")).windows?.[0]?.id;
    assert(Boolean(windowId), "test window discovered");
    await post(`/api/windows/${encodeURIComponent(windowId)}/workspace`, { workspacePath: ws });

    await post("/api/qa/seed", {
      party: "ddclip",
      members: [{ name: "slop", role: "r", model: "sonnet", status: "working",
        blocks: [{ type: "assistant_text_delta", text: "작업 시작" }] }],
    });
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["slop"]] });
    await delay(1200);

    const composer = (await measure(".wb-composer", { styles: ["overflow"] }))[0];
    assert(composer?.styles?.overflow === "hidden", "the composer still clips its own content (the condition under test)");

    const opened = await post("/api/capture", { path: path.join(outDir, "dd-open.png"), click: ".wb-composer .wb-dd-trigger" });
    assert(opened.ok, "opened the permission dropdown from the composer");
    await delay(400);

    const items = await measure(".wb-dd-menu .wb-dd-item");
    assert(items.length === 6, `all six permission options are rendered (got ${items.length})`);

    const menu = (await measure(".wb-dd-menu", { styles: ["position", "z-index"] }))[0];
    assert(Boolean(menu), "the menu is on screen");
    // The heart of it: the menu must no longer live inside the box that clips it.
    assert((await measure(".wb-composer .wb-dd-menu")).length === 0,
      "REGRESSION TARGET: the menu is not a descendant of the clipping composer");
    assert((await measure(".wb-panel .wb-dd-menu")).length === 0,
      "...nor of the panel, which clips fixed descendants too");
    assert(menu?.styles?.position === "fixed", "the menu is positioned against the viewport, not its container");
    assert(Number(menu?.styles?.["z-index"]) >= 1500, `the menu clears every overlay's stacking context (z-index ${menu?.styles?.["z-index"]})`);

    const body = (await measure("body"))[0];
    const within = menu && body
      && menu.box.top >= 0 && menu.box.left >= 0
      && menu.box.bottom <= body.box.height + 1 && menu.box.right <= body.box.width + 1;
    assert(within, "the whole menu sits inside the window");

    // The menu opens upward from the composer, so its FIRST item is the one
    // furthest from the trigger — exactly the part the container used to cut.
    const before = await permissionOf("slop");
    const clicked = await post("/api/capture", {
      path: path.join(outDir, "dd-click.png"),
      // 2nd, not 1st: the 1st is "Default", already the current value, so a click
      // on it would prove nothing. This one was equally cut off AND changes state.
      click: ".wb-dd-menu .wb-dd-item:nth-child(2)",
    });
    assert(clicked.ok, "clicked an option from the region that used to be cut off");
    await delay(600);
    const after = await permissionOf("slop");
    assert(after !== undefined && after !== before,
      `choosing an option still applies after portalling (${before} -> ${after})`);

    assert((await measure(".wb-dd-menu")).length === 0, "choosing an option closes the menu");

    // --- the risk this fix introduces --------------------------------------
    // Inside a modal the menu used to inherit the dialog's stacking context and
    // painted above it for free. Out at <body> it does not. Both the portalled
    // menu and the scrim are children of <body>, so they share one stacking
    // context and their z-indexes are directly comparable — which makes this a
    // real check on paint order, not an interaction test.
    const wizard = await post("/api/capture", { path: path.join(outDir, "dd-wizard.png"), click: ".wb-member-add" });
    assert(wizard.ok, "opened a modal (the member wizard)");
    await delay(500);
    const scrim = (await measure(".wb-modal-scrim", { styles: ["z-index"] }))[0];
    assert(Boolean(scrim), "the wizard is a real modal with a scrim");
    assert(1500 > Number(scrim?.styles?.["z-index"]),
      `a portalled menu still paints above a dialog's scrim (1500 > ${scrim?.styles?.["z-index"]})`);

    await post("/api/window/close", {});
  } catch (error) {
    console.error(error);
    failures.push(String(error?.message || error));
  } finally {
    killTree(child.pid);
    await delay(500);
    for (const p of [ws, userData]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  }

  console.log("");
  if (failures.length) { console.log(`DROPDOWN CLIPPING E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("DROPDOWN CLIPPING E2E PASSED");
  process.exit(0);
}

main();
