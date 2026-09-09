/*
 * Full-process e2e for two user-visible defects, driven through the real UI:
 *
 *   1. Escape closes the topmost dialog. Most modals never listened for it, and
 *      because they all match `.wb-modal` in POPUP_SELECTORS they also stopped
 *      Panel's Escape-interrupt (R-12) from running — so Escape did nothing at
 *      all while one was open. Every dialog now registers with `useModalEscape`.
 *   2. The "작업 중" dots keep moving at a custom transcript font scale. The
 *      layout-zoom performance guard paused every animation under
 *      `.wb-transcript-scale`, freezing the one indicator whose whole job is to
 *      say a turn is alive — at any scale but 1.0, which is most users.
 *
 * The per-card tool spinner must STAY paused: that is the perf guard working,
 * and e2e-font-zoom asserts it. This test pins both sides of that line.
 *
 * Offline throughout (mock members, no provider calls).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-esc-motion-ws");
const userData = path.join(os.tmpdir(), "agentparty-esc-motion-ud");
const port = Number(process.env.AGENTPARTY_ESC_MOTION_PORT || "") || 48973;
const base = `http://127.0.0.1:${port}`;
const outDir = process.env.AGENTPARTY_ESC_MOTION_OUT || os.tmpdir();
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

/** How many elements match, off the live screen. */
async function count(selector) {
  const res = await post("/api/measure", { selector, limit: 5 });
  return Array.isArray(res.elements) ? res.elements.length : 0;
}
async function styleOf(selector, prop) {
  const res = await post("/api/measure", { selector, styles: [prop], limit: 1 });
  return res.elements?.[0]?.styles?.[prop];
}
const pressEscape = () => post("/api/qa/input", { key: "Escape" });

/**
 * Open a dialog by clicking its real trigger, prove it is up, press Escape,
 * prove it is gone. Anything less would pass on a dialog that never opened.
 */
async function escapeCloses(label, trigger, present = ".wb-modal-scrim") {
  const shot = path.join(outDir, `esc-${label.replace(/[^a-z0-9]+/gi, "-")}.png`);
  const opened = await post("/api/capture", { path: shot, click: trigger });
  if (!opened.ok) { assert(false, `${label}: trigger ${trigger} did not click`); return; }
  await delay(350);
  if (await count(present) === 0) { assert(false, `${label}: did not open (no ${present})`); return; }
  await pressEscape();
  await delay(350);
  assert(await count(present) === 0, `Escape closes ${label}`);
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
      party: "esc",
      members: [{
        name: "worker", role: "works", model: "sonnet", status: "working",
        blocks: [
          { type: "assistant_text_delta", text: "작업을 시작합니다." },
          { type: "tool_call", id: "running-tool", name: "Shell", status: "started", input: { command: "echo hi" } },
        ],
      }],
    });
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["worker"]] });
    await delay(900);

    // ---- 2. The turn indicator keeps moving at a custom scale ----------------
    console.log("\n[작업 중 motion under layout zoom]");
    assert((await getJson("/api/state")).settings?.transcriptFontScale === 1, "starts at 100%");
    assert(await count(".wb-typing-dots") > 0, "busy member shows the 작업 중 indicator");
    assert(await styleOf(".wb-typing-dots i", "animation-play-state") === "running", "at 100% the dots run");

    await post("/api/settings", { transcriptFontScale: 1.1 });
    await delay(700);
    const guard = await post("/api/measure", { selector: "html", attributes: ["data-transcript-font-scaled"], limit: 1 });
    assert(guard.elements?.[0]?.attributes?.["data-transcript-font-scaled"] === "", "layout-zoom guard is active at 110%");
    assert(await styleOf(".wb-typing-dots i", "animation-play-state") === "running",
      "REGRESSION TARGET: 작업 중 dots still run at 110%");
    assert(await styleOf(".wb-tool-check.is-running svg", "animation-play-state") === "paused",
      "per-card tool spinner stays paused (perf guard intact)");
    const shot = path.join(outDir, "busy-motion-110.png");
    assert((await post("/api/capture", { path: shot })).ok, `captured busy transcript @110% → ${shot}`);
    await post("/api/settings", { transcriptFontScale: 1 });
    await delay(500);

    // ---- 1. Escape closes the topmost dialog --------------------------------
    console.log("\n[Escape closes dialogs]");
    // Previously had no Escape handler at all.
    await escapeCloses("the new-party modal", ".wb-new-party .wb-icon-btn.is-accent");
    await escapeCloses("the panel overflow menu", ".wb-header-more", ".wb-header-menu");

    // The overflow menu's 2nd item opens the message-gate modal — also deaf before.
    const menu = await post("/api/capture", { path: path.join(outDir, "esc-menu.png"), click: ".wb-header-more" });
    if (menu.ok) {
      await delay(250);
      await escapeCloses("the message-gate modal", ".wb-header-menu .wb-menu-item:nth-child(2)");
    } else {
      assert(false, "could not reopen the overflow menu");
    }

    // These already had Escape; they were migrated onto the shared owner, so
    // they have to still work — a refactor that silently drops one is the risk.
    await escapeCloses("the runtime/model catalog", ".wb-model-pill");

    // ---- Escape is handed back once every dialog is closed -----------------
    // A mock member has no interrupt to observe, so the turn-interrupt handoff
    // itself is covered by qa-esc-interrupt. What this proves is the half that
    // only the real app can show: after all that opening and closing, nothing
    // is left mounted that would keep claiming the key. A dialog that failed to
    // unmount — or a menu left behind — is exactly how Escape became a no-op in
    // the first place, and it is invisible to a unit test.
    console.log("\n[Escape is free again once dialogs are closed]");
    for (const selector of [".wb-modal-scrim", ".wb-tool-modal", ".wb-cmd-palette", ".mcp-modal", ".wb-dd-menu", ".wb-header-menu", ".usage-pop"]) {
      assert(await count(selector) === 0, `no ${selector} left claiming Escape`);
    }

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
  if (failures.length) { console.log(`MODAL ESCAPE + BUSY MOTION E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("MODAL ESCAPE + BUSY MOTION E2E PASSED");
  process.exit(0);
}

main();
