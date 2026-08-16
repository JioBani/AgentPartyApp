/*
 * Drives the single-page mockup and checks the two claims it makes.
 *
 *  1. EVERY PART EXISTS ONCE. This is the whole reason for the rebuild — if the
 *     workbench were still duplicated, editing it would still mean editing
 *     several places, and nobody would find out until they had done it twice.
 *  2. THE WIRING WORKS. Rail, tabs, dialogs and the theme toggle are clicked for
 *     real and the resulting DOM is asserted, so "it looks navigable" is not
 *     mistaken for "it navigates".
 *
 * Run: node scripts/verify-mockup.mjs   (through electron — see the npm script)
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = path.join(root, "build", "design-project", "index.html");
const SHOT_DIR = path.join(root, "build", "design-shots");

const failures = [];
const ok = (condition, message) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}: ${message}`);
  if (!condition) failures.push(message);
};

async function main() {
  await app.whenReady();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { offscreen: true } });
  await window.loadFile(PAGE);
  await new Promise((r) => setTimeout(r, 600));
  const evaluate = (expression) => window.webContents.executeJavaScript(expression);

  console.log("\n(1) 조각은 한 벌씩만:");
  const counts = await evaluate(`({
    titlebar: document.querySelectorAll(".app-titlebar").length,
    rail: document.querySelectorAll(".nav-rail").length,
    workbench: document.querySelectorAll(".wb-root").length,
    sidebar: document.querySelectorAll(".wb-sidebar").length,
    settingsTabs: document.querySelectorAll(".set-tabs").length,
    views: document.querySelectorAll("[data-view-panel]").length,
    overlays: document.querySelectorAll("[data-overlay]").length,
  })`);
  ok(counts.titlebar === 1, `타이틀바 ${counts.titlebar}벌`);
  ok(counts.rail === 1, `내비 레일 ${counts.rail}벌`);
  ok(counts.workbench === 1, `워크벤치 ${counts.workbench}벌 (예전 구조에서는 8벌이었다)`);
  ok(counts.sidebar === 1, `사이드바 ${counts.sidebar}벌`);
  ok(counts.settingsTabs === 1, `설정 탭 줄 ${counts.settingsTabs}벌 (예전 7벌)`);
  console.log(`     views ${counts.views} · overlays ${counts.overlays}`);

  console.log("\n(2) 배선이 실제로 동작:");
  const visible = () => evaluate(`[...document.querySelectorAll("[data-view-panel]")].filter((n) => !n.hidden).map((n) => n.dataset.viewPanel)`);
  ok((await visible()).join() === "workbench", "첫 화면은 workbench");

  for (const view of ["runtime", "usage", "sessions", "auth", "automation", "workbench"]) {
    const clicked = await evaluate(`(() => { const el = document.querySelector('[data-goto="${view}"]'); if (!el) return false; el.click(); return true; })()`);
    const shown = await visible();
    ok(clicked && shown.length === 1 && shown[0] === view, `레일 → ${view} (보이는 화면: ${shown.join(",") || "없음"})`);
  }

  await evaluate(`document.querySelector('[data-goto="runtime"]').click()`);
  const tabResult = await evaluate(`(() => {
    const tabs = [...document.querySelectorAll("[data-tab]")];
    if (tabs.length < 3) return { tabs: tabs.length };
    tabs[2].click();
    const open = [...document.querySelectorAll("[data-tab-panel]")].filter((n) => !n.hidden).map((n) => n.dataset.tabPanel);
    return { tabs: tabs.length, open, active: tabs[2].classList.contains("is-active"), key: tabs[2].dataset.tab };
  })()`);
  ok(tabResult.tabs === 7, `설정 탭 ${tabResult.tabs}개`);
  ok(tabResult.open?.length === 1 && tabResult.open[0] === tabResult.key, `탭 클릭 → 그 패널만 열림 (${tabResult.open?.join(",")})`);
  ok(tabResult.active === true, "클릭한 탭이 활성 표시");

  await evaluate(`document.querySelector('[data-goto="workbench"]').click()`);
  for (const [selector, overlay] of [[".wb-model-pill", "runtime-modal"], [".wb-ctx-donut", "compact"]]) {
    const opened = await evaluate(`(() => { const el = document.querySelector('${selector}[data-open]'); if (!el) return null; el.click(); return [...document.querySelectorAll("[data-overlay]")].filter((n) => !n.hidden).map((n) => n.dataset.overlay); })()`);
    ok(opened?.length === 1 && opened[0] === overlay, `${selector} → ${overlay} 열림 (${opened?.join(",") ?? "컨트롤 없음"})`);
    const closed = await evaluate(`(() => { const el = document.querySelector("[data-close]:not([hidden])") || document.querySelector('[data-overlay]:not([hidden]) [data-close]'); if (!el) return null; el.click(); return [...document.querySelectorAll("[data-overlay]")].filter((n) => !n.hidden).length; })()`);
    ok(closed === 0, `${overlay} 닫힘`);
  }

  const layout = await evaluate(`(() => {
    const composer = document.querySelector(".wb-composer");
    const box = composer ? composer.getBoundingClientRect() : null;
    return box ? { bottom: Math.round(box.bottom), viewport: window.innerHeight } : null;
  })()`);
  ok(layout && layout.bottom <= layout.viewport + 2, `컴포저가 창 안에 있음 (bottom ${layout?.bottom} / ${layout?.viewport})`);

  const wizard = await evaluate(`(() => { const el = document.querySelector('[data-open="wizard"]'); if (!el) return null; el.click(); return document.querySelector('[data-inline="wizard"]')?.hidden === false; })()`);
  ok(wizard === true, "멤버 추가(+) → 사이드바 안 마법사 열림");

  const theme = await evaluate(`(() => { document.querySelector("[data-theme-toggle]").click(); return document.documentElement.dataset.theme; })()`);
  ok(theme === "dark", `테마 토글 → ${theme}`);
  // The paint has to land before the shot; without this the "dark" capture came
  // back light and would have been filed as proof of the opposite.
  await new Promise((r) => setTimeout(r, 400));
  const painted = await evaluate(`getComputedStyle(document.body).backgroundColor`);
  ok(!/247|243|231/.test(painted), `dark 테마가 실제로 칠해짐 (body ${painted})`);
  fs.writeFileSync(path.join(SHOT_DIR, "mockup-dark.png"), (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector("[data-theme-toggle]").click()`);
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(path.join(SHOT_DIR, "mockup-light.png"), (await window.webContents.capturePage()).toPNG());

  console.log(failures.length ? `\nMOCKUP FAILED (${failures.length})` : "\nMOCKUP OK — 조각 한 벌씩, 배선 동작");
  app.exit(failures.length ? 1 : 0);
}

main().catch((error) => { console.error(error); app.exit(1); });
