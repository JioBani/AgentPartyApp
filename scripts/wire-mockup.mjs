/*
 * Turns the captured windows into a walkable mockup.
 *
 * The capture gives one page per view, each the whole app window — but every
 * control in it is a dead `<button>`. This pass rewrites the ones that NAVIGATE
 * into links to the page for their destination, using the app's own hooks:
 * `data-view` on the nav rail, the settings tab strip, the model pill and the
 * context donut. Nothing is positioned or invented; a control that has no page
 * to go to is simply left inert, which is honest — the mockup then shows exactly
 * how far it goes.
 *
 * Run after capture-app-mockup.mjs:
 *   node scripts/wire-mockup.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(root, "build", "design-project");
const dsArg = process.argv.indexOf("--ds");
const DS_SLUG = dsArg > 0
  ? process.argv[dsArg + 1]
  : process.env.DESIGN_SYSTEM_SLUG
  || "agentparty-design-system-as-built-18fbdba3-0e2b-4008-9606-4c6b11063246";

/** Where each app view lives in the mockup. */
const VIEW_PAGE = {
  workbench: "index.html",
  sessions: "sessions.html",
  usage: "usage.html",
  auth: "auth.html",
  runtime: "runtime-general.html",
  automation: "automation.html",
};
/** Where each settings tab lives. */
const TAB_PAGE = {
  일반: "runtime-general.html",
  "하네스 기본값": "runtime-harness.html",
  환경: "runtime-environment.html",
  "Message Gate": "runtime-gate.html",
  Discord: "runtime-discord.html",
  버전: "runtime-versions.html",
  진단: "runtime-diagnostics.html",
};
/** Controls that open something, and the page that something lives on. */
const OPENS = [
  [".wb-model-pill", "modal-runtime.html"],
  [".wb-ctx-donut", "modal-compact.html"],
  [".wb-section-add", "modal-wizard.html"],
];

/** Replaces a `<button>` with an `<a href>` carrying the same classes/content. */
function linkify(document, element, href) {
  const link = document.createElement("a");
  link.setAttribute("href", href);
  for (const attribute of element.attributes) {
    if (attribute.name !== "type" && attribute.name !== "disabled") link.setAttribute(attribute.name, attribute.value);
  }
  link.innerHTML = element.innerHTML;
  element.replaceWith(link);
  return link;
}

function wire(file, spec, pages) {
  const raw = fs.readFileSync(path.join(OUT_DIR, `${file}.raw`), "utf8");
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${raw}</body></html>`);
  const { document } = dom.window;
  let wired = 0;

  // Nav rail: every view that HAS a page becomes a link; the current one keeps
  // its active state and does not link to itself.
  for (const item of document.querySelectorAll(".nav-item[data-view]")) {
    const view = item.getAttribute("data-view");
    const target = VIEW_PAGE[view];
    if (!target || view === spec.view) continue;
    linkify(document, item, target);
    wired += 1;
  }

  // Settings tabs, matched by their visible label so a renamed tab fails loudly
  // (an unmatched tab stays inert) rather than linking to the wrong page.
  for (const tab of document.querySelectorAll(".set-tab")) {
    const label = tab.textContent.replace(/\s+/g, " ").trim().replace(/\s\d+$/, "");
    const target = Object.entries(TAB_PAGE).find(([name]) => label.startsWith(name))?.[1];
    if (!target || target === file) continue;
    linkify(document, tab, target);
    wired += 1;
  }

  // Controls that open a dialog, only on pages where that dialog is not already
  // standing (a modal page must not re-open itself).
  if (!spec.back) {
    for (const [selector, target] of OPENS) {
      const control = document.querySelector(selector);
      if (control && pages.has(target)) {
        linkify(document, control, target);
        wired += 1;
      }
    }
  }

  // On a modal page, the explicit close returns where it came from — the same
  // way out the app gives, since these dialogs ignore the scrim and Escape.
  if (spec.back) {
    const close = document.querySelector(".wb-modal-head .wb-icon-btn, .wb-modal-foot .wb-btn-ghost, .wb-section-add.is-open");
    if (close) {
      linkify(document, close, spec.back);
      wired += 1;
    }
  }

  const body = document.body.innerHTML;
  const page = `<!DOCTYPE html>
<html lang="ko" data-theme="${spec.theme || "light"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentParty — ${spec.title}</title>
<link rel="stylesheet" href="_ds/${DS_SLUG}/foundations/tokens.css">
<link rel="stylesheet" href="_ds/${DS_SLUG}/app/design-system.css">
<link rel="stylesheet" href="_ds/${DS_SLUG}/app/styles.css">
<style>
  /* The page IS the app window. Only two rules are added: fill the viewport,
     and make the linkified controls behave like the buttons they replaced. */
  html, body { margin: 0; height: 100%; background: var(--bg-1); }
  a.nav-item, a.set-tab, a.wb-pill, a.wb-icon-btn, a.wb-ctx-donut { text-decoration: none; cursor: pointer; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
  fs.writeFileSync(path.join(OUT_DIR, file), page);
  fs.rmSync(path.join(OUT_DIR, `${file}.raw`));
  return wired;
}

function main() {
  const specs = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "_pages.json"), "utf8"));
  const pages = new Set(specs.map((spec) => spec.file));
  let total = 0;
  for (const spec of specs) {
    const wired = wire(spec.file, spec, pages);
    total += wired;
    console.log(`  ${spec.file.padEnd(26)} ${wired} link(s)`);
  }
  console.log(`\n${specs.length} pages wired with ${total} links → ${OUT_DIR}`);
}

main();
