/*
 * Writes `_ds_manifest.json` — the index the Design System pane actually reads.
 *
 * The `@dsCard` comment on each page is the SOURCE of a card, but the pane lists
 * what the manifest says; a project uploaded without one shows an empty pane
 * even though every file is there (measured against a working project of the
 * user's, which carries the same fields as below). So the manifest is built here
 * from the markers, and only from them — no second list to keep in step.
 *
 * Card viewports come from `_sizes.json`, which the verify pass MEASURES by
 * rendering each page. Guessing them would crop half the cards.
 *
 * Run after build + capture + verify:
 *   node scripts/build-design-manifest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = path.join(root, "build", "design-bundle");
const PROJECT_ID = process.env.DESIGN_PROJECT_ID || "18fbdba3-0e2b-4008-9606-4c6b11063246";

/** Order the pane shows groups in: foundations first, then the app outward. */
const GROUP_ORDER = ["Foundations", "Primitives", "Navigation", "Surfaces", "Blocks", "Composites"];

function pages(dir = BUNDLE_DIR, prefix = "") {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...pages(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".html")) found.push(rel);
  }
  return found;
}

/** Reads the `@dsCard` marker off a page; a page without one is not a card. */
function cardOf(relative) {
  const head = fs.readFileSync(path.join(BUNDLE_DIR, relative), "utf8").slice(0, 400);
  const marker = head.match(/^<!--\s*@dsCard\s+([^>]*?)-->/);
  if (!marker) {
    return null;
  }
  const attributes = {};
  for (const [, key, value] of marker[1].matchAll(/(\w+)="([^"]*)"/g)) {
    attributes[key] = value;
  }
  return attributes;
}

function main() {
  const sizesPath = path.join(BUNDLE_DIR, "_sizes.json");
  if (!fs.existsSync(sizesPath)) {
    throw new Error("no _sizes.json — run scripts/verify-design-bundle.mjs first, it measures the card viewports.");
  }
  const sizes = JSON.parse(fs.readFileSync(sizesPath, "utf8"));

  const cards = [];
  for (const relative of pages().sort()) {
    const attributes = cardOf(relative);
    if (!attributes) {
      console.log(`  (no @dsCard marker, skipped) ${relative}`);
      continue;
    }
    cards.push({
      path: relative,
      group: attributes.group || "Components",
      viewport: attributes.viewport || sizes[relative] || "1200x700",
      subtitle: attributes.subtitle || "",
      name: attributes.name || relative,
    });
  }
  cards.sort((a, b) => {
    const byGroup = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    return byGroup !== 0 ? byGroup : a.path.localeCompare(b.path);
  });

  const source = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, "foundations", "_source.json"), "utf8"));
  const manifest = {
    namespace: `AgentPartyAsBuilt_${PROJECT_ID.slice(0, 6)}`,
    components: [],
    // Where someone should start reading: the tab is the unit the whole
    // workbench is built out of, and the panel is the unit a screen is.
    startingPoints: [
      { name: "Member tab", path: "components/navigation/tab.card.html", previewPath: "components/navigation/tab.card.html", kind: "component", section: "Navigation", subtitle: "활성 · 작업 중 · 표시", viewport: sizes["components/navigation/tab.card.html"] || "900x260" },
      { name: "Panel", path: "components/composites/panel.card.html", previewPath: "components/composites/panel.card.html", kind: "component", section: "Composites", subtitle: "탭 + 툴바 + 대화 + 입력", viewport: sizes["components/composites/panel.card.html"] || "1200x700" },
    ],
    cards,
    templates: [],
    hasThumbnailHtml: false,
    // Load order matters: tokens first (everything else reads them), then the
    // app's own two stylesheets exactly as the app loads them.
    globalCssPaths: ["foundations/tokens.css", "app/design-system.css", "app/styles.css", "foundations/stage.css"],
    tokens: [],
    themes: source.themes.map((theme) => ({ selector: `:root[data-theme="${theme.id}"]`, label: theme.label })),
    fonts: [{
      family: "Maplestory",
      weight: "400 700",
      style: "normal",
      cssPath: "app/design-system.css",
      files: ["app/assets/fonts/Maplestory-Light.woff2", "app/assets/fonts/Maplestory-Bold.woff2"],
      remoteSrc: false,
    }],
    brandFonts: [{ family: "Maplestory", status: "ok", tokens: ["--font-sans"], path: "app/design-system.css" }],
    source: "app-capture",
    sourceInventory: {
      source: "agentparty-app",
      generatedFrom: source.generatedFrom,
      colorTokens: source.colorTokens,
      shapeTokens: source.shapeTokens,
      cards: cards.length,
    },
  };

  fs.writeFileSync(path.join(BUNDLE_DIR, "_ds_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const byGroup = cards.reduce((counts, card) => ({ ...counts, [card.group]: (counts[card.group] || 0) + 1 }), {});
  console.log(`_ds_manifest.json → ${cards.length} cards`);
  for (const [group, count] of Object.entries(byGroup)) console.log(`  ${group}: ${count}`);
}

main();
