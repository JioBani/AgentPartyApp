/*
 * Assembles the single-page mockup from the captured parts.
 *
 * Editing rules this file is designed around — the whole point of the rebuild:
 *
 *  - EVERY part appears exactly once. The workbench lives in one place, the
 *    window chrome in one place, each dialog in one place. Change it there and
 *    every state that shows it changes with it.
 *  - Each part sits between banner comments and carries a stable id
 *    (`#view-workbench`, `#overlay-compact`), so "edit the workbench" means
 *    "find that banner", not "search 8 files".
 *  - Behaviour is DATA-DRIVEN, never hand-wired: `data-goto` switches views,
 *    `data-open` / `data-close` raise and dismiss overlays, `data-tab` switches
 *    settings tabs, `data-theme-toggle` flips the theme. Adding a view means
 *    adding a section and a rail item — the script at the bottom needs no edit.
 *  - The script is ~40 lines of plain DOM toggling, so it can be read in one
 *    sitting by whoever inherits this file.
 *
 * Run after capture-mockup-parts.mjs:
 *   node scripts/build-mockup-page.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PARTS_DIR = path.join(root, "build", "mockup-parts");
const OUT_DIR = path.join(root, "build", "design-project");
const dsArg = process.argv.indexOf("--ds");
const DS_SLUG = dsArg > 0
  ? process.argv[dsArg + 1]
  : process.env.DESIGN_SYSTEM_SLUG
  || "agentparty-design-system-as-built-18fbdba3-0e2b-4008-9606-4c6b11063246";

/** Which app view each rail item goes to, keyed by the app's own `data-view`. */
const RAIL_VIEWS = ["workbench", "sessions", "usage", "auth", "runtime", "automation"];
/** Controls in the workbench that raise an overlay, and which one. */
const OPENERS = [
  [".wb-model-pill", "runtime-modal"],
  [".wb-ctx-donut", "compact"],
  [".wb-section-add", "wizard"],
];

const banner = (text) => `\n  <!-- ${"=".repeat(72)}\n       ${text}\n       ${"=".repeat(72)} -->\n`;

function loadPart(id) {
  const file = path.join(PARTS_DIR, `${id}.html`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

function main() {
  const parts = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, "_parts.json"), "utf8"));
  const byId = new Map(parts.map((part) => [part.id, part]));
  const missing = ["titlebar", "rail", "workbench", "runtime"].filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`missing required part(s): ${missing.join(", ")} — re-run the capture.`);

  const views = parts.filter((part) => part.kind === "view");
  const overlays = parts.filter((part) => part.kind === "overlay");
  const inlines = parts.filter((part) => part.kind === "inline");

  // --- chrome: rail items become view switches --------------------------------
  const railDom = new JSDOM(`<body>${loadPart("rail")}</body>`);
  for (const item of railDom.window.document.querySelectorAll(".nav-item[data-view]")) {
    const view = item.getAttribute("data-view");
    if (!RAIL_VIEWS.includes(view) || !byId.has(view)) continue;
    item.setAttribute("data-goto", view);
    item.classList.toggle("active", view === "workbench");
  }
  const rail = railDom.window.document.body.innerHTML;

  const titlebarDom = new JSDOM(`<body>${loadPart("titlebar")}</body>`);
  const themeButton = titlebarDom.window.document.querySelector(".titlebar-action");
  if (themeButton) themeButton.setAttribute("data-theme-toggle", "");
  const titlebar = titlebarDom.window.document.body.innerHTML;

  // --- views ------------------------------------------------------------------
  const viewSections = views.map((view) => {
    const dom = new JSDOM(`<body>${loadPart(view.id)}</body>`);
    const { document } = dom.window;

    if (view.id === "workbench") {
      // Controls that raise a dialog.
      for (const [selector, overlay] of OPENERS) {
        if (!byId.has(overlay)) continue;
        const control = document.querySelector(selector);
        if (control) control.setAttribute("data-open", overlay);
      }
      // In-flow panels the app renders in place, parked hidden where they belong.
      for (const inline of inlines) {
        const host = document.querySelector(inline.host);
        if (!host) continue;
        const holder = document.createElement("div");
        holder.setAttribute("data-inline", inline.id);
        holder.setAttribute("hidden", "");
        holder.innerHTML = loadPart(inline.id);
        host.appendChild(holder);
      }
      const palette = document.querySelector('[data-inline="palette"]');
      if (palette) palette.setAttribute("data-open-with", ".wb-composer-editor");
    }

    if (view.id === "runtime") {
      // The tab strip already carries every panel; give the tabs and panels
      // matching keys so switching is a lookup rather than a hand-kept list.
      const tabs = [...document.querySelectorAll(".set-tab")];
      const panels = [...document.querySelectorAll(".set-tab-panel")];
      tabs.forEach((tab, index) => {
        const key = `tab-${index}`;
        tab.setAttribute("data-tab", key);
        tab.classList.toggle("is-active", index === 0);
        if (panels[index]) {
          panels[index].setAttribute("data-tab-panel", key);
          if (index === 0) panels[index].removeAttribute("hidden");
          else panels[index].setAttribute("hidden", "");
        }
      });
    }

    return `${banner(`VIEW · ${view.label} — 이 화면을 고치려면 여기만`)}  <section class="mock-view" id="view-${view.id}" data-view-panel="${view.id}"${view.id === "workbench" ? "" : " hidden"}>
${dom.window.document.body.innerHTML}
  </section>`;
  });

  // --- overlays ---------------------------------------------------------------
  const overlaySections = overlays.map((overlay) => {
    const dom = new JSDOM(`<body>${loadPart(overlay.id)}</body>`);
    const close = dom.window.document.querySelector(".wb-modal-head .wb-icon-btn, .wb-modal-foot .wb-btn-ghost");
    if (close) close.setAttribute("data-close", "");
    return `${banner(`OVERLAY · ${overlay.label}`)}  <div class="mock-overlay" id="overlay-${overlay.id}" data-overlay="${overlay.id}" hidden>
${dom.window.document.body.innerHTML}
  </div>`;
  });

  const contents = [
    ...views.map((view) => `#view-${view.id} (${view.label})`),
    ...overlays.map((overlay) => `#overlay-${overlay.id} (${overlay.label})`),
    ...inlines.map((inline) => `[data-inline="${inline.id}"] (${inline.label}, ${inline.host} 안)`),
  ];

  const html = `<!DOCTYPE html>
<html lang="ko" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentParty Desktop</title>
<link rel="stylesheet" href="_ds/${DS_SLUG}/foundations/tokens.css">
<link rel="stylesheet" href="_ds/${DS_SLUG}/app/design-system.css">
<link rel="stylesheet" href="_ds/${DS_SLUG}/app/styles.css">
<style>
  /* The only rules this mockup adds. Everything else is the design system's. */
  html, body { margin: 0; height: 100%; background: var(--bg-1); }
  .app-shell { height: 100vh; }
  /* The view wrapper stands where the app has nothing, so it must be invisible
     to layout: without these the flex chain from .app-body to .program-main is
     broken and the panel grows past the window (the composer falls off the
     bottom instead of staying pinned). */
  .mock-view { display: flex; flex: 1; min-width: 0; min-height: 0; }
  .mock-view > .program-main { flex: 1; min-width: 0; min-height: 0; }
  /* Same reason for the in-flow panels: the holder must not become a width the
     app never gave them, or the wizard spills out of the sidebar. */
  [data-inline] { min-width: 0; }
  [data-inline] > * { max-width: 100%; }
  .mock-view[hidden], .mock-overlay[hidden], [data-inline][hidden] { display: none; }
  [data-goto], [data-open], [data-close], [data-tab], [data-theme-toggle] { cursor: pointer; }
</style>
</head>
<!--
  AgentParty Desktop — 단일 페이지 목업

  구조: 창 크롬 1벌 + 화면(view) N벌 + 대화상자(overlay) N벌. 각 조각은 한 번씩만
  존재하므로, 워크벤치를 고치면 그것을 보여주는 모든 상태가 함께 바뀐다.

  목차:
${contents.map((line) => `    - ${line}`).join("\n")}

  동작은 전부 data 속성이다(맨 아래 스크립트 40줄이 전부):
    data-goto="<view>"    화면 전환          data-open="<overlay>"  대화상자 열기
    data-close            대화상자 닫기      data-tab="<key>"       설정 탭 전환
    data-theme-toggle     라이트/다크 전환
  화면이나 대화상자를 추가할 때 스크립트는 건드리지 않아도 된다.
-->
<body>
<div class="app-shell">
${banner("CHROME · 타이틀바 (모든 화면 공용)")}${titlebar}
  <div class="app-body">
${banner("CHROME · 내비 레일 (모든 화면 공용)")}${rail}
${viewSections.join("\n")}
  </div>
</div>
${overlaySections.join("\n")}

<script>
  // View / overlay / tab switching. Data-driven on purpose: adding a section is
  // a markup edit, never a code edit.
  const show = (nodes, match) => nodes.forEach((node) => node.toggleAttribute("hidden", !match(node)));

  function goto(view) {
    show([...document.querySelectorAll("[data-view-panel]")], (n) => n.dataset.viewPanel === view);
    document.querySelectorAll("[data-goto]").forEach((n) => n.classList.toggle("active", n.dataset.goto === view));
    closeOverlay();
    location.hash = view;
  }
  function openOverlay(id) {
    const inline = document.querySelector('[data-inline="' + id + '"]');
    if (inline) { inline.hidden = false; return; }
    show([...document.querySelectorAll("[data-overlay]")], (n) => n.dataset.overlay === id);
  }
  function closeOverlay() {
    document.querySelectorAll("[data-overlay]").forEach((n) => { n.hidden = true; });
    document.querySelectorAll("[data-inline]").forEach((n) => { n.hidden = true; });
  }
  function selectTab(key) {
    show([...document.querySelectorAll("[data-tab-panel]")], (n) => n.dataset.tabPanel === key);
    document.querySelectorAll("[data-tab]").forEach((n) => n.classList.toggle("is-active", n.dataset.tab === key));
  }

  document.addEventListener("click", (event) => {
    const goto_ = event.target.closest("[data-goto]");
    const open = event.target.closest("[data-open]");
    const close = event.target.closest("[data-close]");
    const tab = event.target.closest("[data-tab]");
    const theme = event.target.closest("[data-theme-toggle]");
    if (goto_) { event.preventDefault(); goto(goto_.dataset.goto); }
    else if (open) { event.preventDefault(); openOverlay(open.dataset.open); }
    else if (close) { event.preventDefault(); closeOverlay(); }
    else if (tab) { event.preventDefault(); selectTab(tab.dataset.tab); }
    else if (theme) {
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    }
  });

  if (location.hash) goto(location.hash.slice(1));
</script>
</body>
</html>
`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), html);
  const kb = (html.length / 1024).toFixed(0);
  console.log(`index.html → ${kb} KB · ${views.length} views · ${overlays.length} overlays · ${inlines.length} inline panels`);
  console.log("각 조각은 한 벌씩만 존재합니다 (목차는 파일 상단 주석).");
}

main();
