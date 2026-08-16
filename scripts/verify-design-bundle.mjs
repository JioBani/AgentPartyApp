/*
 * Checks that every page in the design bundle renders on its OWN — before it is
 * uploaded, not after someone opens a blank card in the Design System pane.
 *
 * A captured page is only as good as the three things it links: the generated
 * tokens (without them every `var(--token)` is empty and the page is unstyled
 * black-on-white), the app stylesheet, and the bundled font (without it the type
 * silently falls back and the card misreports what the app looks like). Each is
 * asserted from the rendered result, not from the file being present.
 *
 * Run: node scripts/verify-design-bundle.mjs [--shots]
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = path.join(root, "build", "design-bundle");
const SHOT_DIR = path.join(root, "build", "design-shots");
const wantShots = process.argv.includes("--shots");

/** Every html page in the bundle, bundle-relative. */
function pages(dir = BUNDLE_DIR, prefix = "") {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...pages(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".html")) found.push(rel);
  }
  return found.sort();
}

const failures = [];
const ok = (condition, message) => {
  if (!condition) failures.push(message);
  return condition;
};

const PROBE = `(() => {
  const body = getComputedStyle(document.body);
  const root = getComputedStyle(document.documentElement);
  // The CAPTURED surface, which is the biggest child — not simply the first:
  // several pages lead with an explanatory note, and measuring that reported
  // every one of them as empty.
  const rect = [...document.body.children]
    .map((child) => child.getBoundingClientRect())
    .reduce((best, box) => (box.width * box.height > best.width * best.height ? box : best), { width: 0, height: 0 });
  const fontsLoaded = document.fonts ? document.fonts.check('12px Maplestory') : null;
  return {
    fontFamily: body.fontFamily,
    background: body.backgroundColor,
    bg0: root.getPropertyValue('--bg-0').trim(),
    radiusPanel: root.getPropertyValue('--radius-panel').trim(),
    firstWidth: Math.round(rect.width),
    firstHeight: Math.round(rect.height),
    fontsLoaded,
    dsCard: document.documentElement.dataset.theme || '',
  };
})()`;

async function main() {
  await app.whenReady();
  if (wantShots) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const list = pages();
  if (list.length === 0) throw new Error(`no pages in ${BUNDLE_DIR} — run the build + capture scripts first.`);

  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { offscreen: true } });
  console.log(`checking ${list.length} pages\n`);

  for (const relative of list) {
    const file = path.join(BUNDLE_DIR, relative);
    // The card marker is what puts the page in the Design System pane at all.
    const head = fs.readFileSync(file, "utf8").slice(0, 200);
    ok(head.startsWith("<!-- @dsCard "), `${relative}: missing the first-line @dsCard marker`);

    await window.loadFile(file);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const probe = await window.webContents.executeJavaScript(PROBE);

    const styled = ok(probe.bg0 !== "", `${relative}: --bg-0 is empty → tokens.css did not load, page is unstyled`);
    ok(probe.radiusPanel !== "", `${relative}: --radius-panel is empty → shape tokens missing`);
    ok(/Maplestory/i.test(probe.fontFamily), `${relative}: body font-family is '${probe.fontFamily}' — the app's font is not applied`);
    ok(probe.fontsLoaded !== false, `${relative}: the Maplestory woff2 did not load (fallback type would be shown)`);
    ok(probe.firstWidth > 200 && probe.firstHeight > 40, `${relative}: content renders at ${probe.firstWidth}×${probe.firstHeight} — effectively empty`);

    const mark = failures.some((f) => f.startsWith(relative)) ? "FAIL" : "ok  ";
    console.log(`  ${mark} ${relative.padEnd(38)} ${probe.firstWidth}×${probe.firstHeight}  ${styled ? probe.bg0 : "unstyled"}`);

    if (wantShots) {
      const image = await window.webContents.capturePage();
      const shot = path.join(SHOT_DIR, relative.replace(/[\\/]/g, "__").replace(/\.html$/, ".png"));
      fs.writeFileSync(shot, image.toPNG());
    }
  }

  console.log(failures.length ? `\nDESIGN BUNDLE FAILED (${failures.length})` : `\nDESIGN BUNDLE OK — ${list.length} pages render standalone`);
  for (const failure of failures) console.log(`  - ${failure}`);
  if (wantShots) console.log(`\nshots: ${SHOT_DIR}`);
  app.exit(failures.length ? 1 : 0);
}

main().catch((error) => { console.error(error); app.exit(1); });
