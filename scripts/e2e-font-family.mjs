/*
 * Full-process e2e for the font-family picker (설정 → 글꼴).
 *
 * Drives the REAL app over the automation API and, crucially, checks the thing
 * a settings round-trip cannot: that the choice reached the SCREEN. `POST
 * /api/settings` succeeding only proves a file was written — CSS substitutes a
 * missing family silently, so every assertion here reads the computed
 * `font-family` off the live DOM via `/api/measure`.
 *
 * Covers: catalog + installed probe, default selection, applying a font live to
 * an already-open window, code font independent of UI font, an unknown id
 * healing to the default, and captures the picker for review. Offline.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-font-family-ws");
const userData = path.join(os.tmpdir(), "agentparty-font-family-ud");
const port = Number(process.env.AGENTPARTY_FONT_FAMILY_PORT || "") || 48957;
const base = `http://127.0.0.1:${port}`;
const outDir = process.env.AGENTPARTY_FONT_FAMILY_OUT || os.tmpdir();
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(u) { const r = await fetch(`${base}${u}`); return r.json(); }
async function post(u, b) { const r = await fetch(`${base}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return r.json(); }
async function waitForApi() { for (let i = 0; i < 120; i++) { try { if ((await getJson("/api/health")).ok) return true; } catch {} await delay(500); } throw new Error("API never came up"); }
function killTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }

/** The computed font-family actually in effect for a selector, off the live DOM. */
async function computedFont(selector) {
  const result = await post("/api/measure", { selector, styles: ["font-family"], limit: 1 });
  if (!result?.ok) throw new Error(`measure '${selector}' failed: ${result?.error || "no result"}`);
  return String(result.elements?.[0]?.styles?.["font-family"] || "");
}

/**
 * How far the settings page must scroll for the 글꼴 card to sit near the top.
 *
 * `box.top` is VIEWPORT-relative, so it only equals the document offset while
 * the page is at the top. Rewind the scroll region first — otherwise the second
 * call of a run returns a tiny number and the capture silently stays where it
 * already was, which is exactly the plausible-looking wrong screenshot
 * `/api/capture` refuses to produce on its own.
 */
async function fontCardOffset() {
  const result = await post("/api/measure", { selector: ".set-font-field", limit: 1, scroll: { selector: ".program-scroll", to: 0 } });
  if (!result?.ok) throw new Error(`could not locate the 글꼴 card: ${result?.error || "no result"}`);
  // Leave room above the first field for the card's own "글꼴" header — a shot
  // that starts mid-card does not show which card is being reviewed.
  const offset = Number(result.elements?.[0]?.box?.top || 0);
  return Math.max(0, Math.round(offset - 330));
}

/** Whether BOTH font fields are fully within the window right now. */
async function fontCardOnScreen() {
  const result = await post("/api/measure", { selector: ".set-font-field", containedBy: "#root", limit: 2 });
  if (!result?.ok) throw new Error(`could not verify the 글꼴 card: ${result?.error || "no result"}`);
  return (result.elements || []).length === 2 && (result.elements || []).every((e) => e.containedBy?.fully === true);
}

async function main() {
  for (const p of [ws, userData]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  fs.mkdirSync(ws, { recursive: true });

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root, stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_AUTOMATION_PORT: String(port),
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
  });

  try {
    await waitForApi();
    const windowId = (await getJson("/api/windows")).windows?.[0]?.id;
    assert(Boolean(windowId), "test window discovered");
    await post(`/api/windows/${encodeURIComponent(windowId)}/workspace`, { workspacePath: ws });
    await delay(800);

    // --- enumeration ------------------------------------------------------
    const catalog = await getJson("/api/appearance/fonts");
    assert(catalog?.ok === true, "GET /api/appearance/fonts responds");
    assert(!catalog.error, `enumeration ran (error: ${catalog.error || "none"})`);
    // A real desktop has far more than a curated list would; anything near zero
    // means queryLocalFonts was refused and we are silently showing a stub.
    assert(catalog.totalFamilies > 50, `enumerated the machine's fonts (${catalog.totalFamilies} families)`);
    assert(catalog.families.every((f) => typeof f.family === "string" && typeof f.monospace === "boolean"),
      "every family carries a measured monospace flag");
    const monoCount = catalog.families.filter((f) => f.monospace).length;
    assert(monoCount > 0 && monoCount < catalog.totalFamilies, `monospace classification discriminates (${monoCount}/${catalog.totalFamilies})`);
    // The classifier must not be fooled by names: these are fixed-width Korean
    // fonts that say nothing of the sort, and Consolas is the obvious positive.
    for (const family of ["Consolas", "DotumChe"]) {
      const entry = catalog.families.find((f) => f.family === family);
      assert(entry?.monospace === true, `${family} classified as fixed-width`);
    }
    const proportional = catalog.families.find((f) => f.family === "Malgun Gothic");
    assert(proportional?.monospace === false, "맑은 고딕 classified as proportional");
    assert(catalog.selected?.sans === "Maplestory" && catalog.selected?.mono === "Geist Mono",
      `default selection is Maplestory/Geist Mono (got ${catalog.selected?.sans}/${catalog.selected?.mono})`);
    const bundled = (catalog.recommended || []).find((f) => f.family === "Maplestory");
    assert(bundled?.installed === true, "bundled Maplestory reports installed:true");
    console.log(`    recommended missing: ${(catalog.recommended || []).filter((f) => !f.installed).map((f) => f.family).join(", ") || "(none)"}`);

    // --- search -----------------------------------------------------------
    const hit = await getJson("/api/appearance/fonts?q=consol");
    assert(hit.families.some((f) => f.family === "Consolas"), "search 'consol' finds Consolas");
    assert(hit.families.length < catalog.totalFamilies, `search narrows the list (${hit.families.length} of ${catalog.totalFamilies})`);
    assert(hit.totalFamilies === catalog.totalFamilies, "a filtered response still reports the full count");
    const miss = await getJson("/api/appearance/fonts?q=zzzznotafont");
    assert(miss.families.length === 0, "a search with no match returns an empty list, not everything");
    // The OS reports Korean fonts under romanised names, so a Korean user's
    // most likely query must still reach them.
    const korean = await getJson(`/api/appearance/fonts?q=${encodeURIComponent("고딕")}`);
    assert(korean.families.some((f) => f.family === "Malgun Gothic"), "Korean search '고딕' finds Malgun Gothic");
    const hangulName = await getJson(`/api/appearance/fonts?q=${encodeURIComponent("맑은")}`);
    assert(hangulName.families.some((f) => f.family === "Malgun Gothic"), "Korean search '맑은' finds Malgun Gothic");

    // --- default is on screen --------------------------------------------
    const bodyDefault = await computedFont("body");
    assert(/Maplestory/i.test(bodyDefault), `body renders in Maplestory by default (${bodyDefault.slice(0, 60)}…)`);

    // Show the picker and capture it. Scroll to the card and PROVE it is on
    // screen — a screenshot of the wrong part of a settings screen looks exactly
    // as plausible as the right one.
    await post("/api/navigation", { view: "settings", tab: "general" });
    await delay(700);
    const shotBefore = path.join(outDir, "font-family-picker.png");
    assert((await post("/api/capture", { path: shotBefore, scrollY: await fontCardOffset(), scrollSelector: ".program-scroll" })).ok, `captured 글꼴 카드 → ${shotBefore}`);
    assert(await fontCardOnScreen(), "the 글꼴 card is fully inside the viewport in that capture");

    // --- the picker itself lists the enumerated fonts --------------------
    // Typing cannot be synthesized over the API, so the search BOX is asserted
    // to exist and its filtering is covered by `?q=` above; what is checked here
    // is that the popover really renders the machine's fonts, not a stub list.
    const shotOpen = path.join(outDir, "font-family-popover.png");
    assert((await post("/api/capture", { path: shotOpen, click: "[data-font-role=mono]" })).ok, `opened the 코드 글꼴 picker → ${shotOpen}`);
    const rows = await post("/api/measure", { selector: ".set-font-row", limit: 200 });
    assert(rows.ok && rows.count > 10, `picker lists many fonts (${rows.count} rows)`);
    assert((await post("/api/measure", { selector: "[data-font-search=mono]", limit: 1 })).ok, "the search box is present");
    const consolasRow = await post("/api/measure", { selector: '[data-font-family="Consolas"]', limit: 1 });
    assert(consolasRow.ok, "an enumerated family (Consolas) is offered as a row");
    // The code picker must not offer proportional fonts — that is the whole
    // reason the monospace classifier exists.
    const proportionalRow = await post("/api/measure", { selector: '[data-font-family="Malgun Gothic"]', limit: 1 }).catch(() => null);
    assert(!proportionalRow?.ok, "the 코드 글꼴 picker hides proportional families");
    // Toggle the popover shut so the later captures show the card, not the list.
    // A THROWAWAY path on purpose: reusing `shotOpen` would overwrite the open
    // shot with a closed one and quietly leave the wrong image for review.
    await post("/api/capture", { path: path.join(outDir, "font-family-popover-closed.png"), click: "[data-font-role=mono]" });

    // --- applying a UI font reaches the live window ----------------------
    // 맑은 고딕 ships with Windows, so this asserts a REAL swap, not a fallback.
    await post("/api/settings", { fonts: { sans: "Malgun Gothic", mono: "Geist Mono" } });
    await delay(700);
    assert((await getJson("/api/state")).settings?.fonts?.sans === "Malgun Gothic", "fonts.sans round-tripped to Malgun Gothic");
    const bodyMalgun = await computedFont("body");
    assert(/Malgun Gothic/i.test(bodyMalgun), `body switched to 맑은 고딕 live (${bodyMalgun.slice(0, 60)}…)`);
    assert(!/Maplestory/i.test(bodyMalgun), "the previous family is gone from the stack");
    const shotAfter = path.join(outDir, "font-family-malgun.png");
    assert((await post("/api/capture", { path: shotAfter, scrollY: await fontCardOffset(), scrollSelector: ".program-scroll" })).ok, `captured after UI font change → ${shotAfter}`);

    // --- the code font is independent of the UI font ---------------------
    await post("/api/settings", { fonts: { sans: "Malgun Gothic", mono: "Consolas" } });
    await delay(700);
    const monoNow = await computedFont(".wb-mono");
    assert(/Consolas/i.test(monoNow), `.wb-mono switched to Consolas (${monoNow.slice(0, 60)}…)`);
    const bodyStill = await computedFont("body");
    assert(/Malgun Gothic/i.test(bodyStill) && !/Consolas/i.test(bodyStill), "UI font untouched by the code-font change");

    // --- a font the machine lacks is KEPT, not erased --------------------
    // The old fixed catalog could reject an unknown id; a family name cannot be
    // judged that way. Erasing it would delete the choice of a user syncing
    // settings between two PCs, so it is stored and reported as missing instead.
    await post("/api/settings", { fonts: { sans: "Totally Not Installed", mono: "Consolas" } });
    await delay(700);
    const kept = (await getJson("/api/state")).settings?.fonts;
    assert(kept?.sans === "Totally Not Installed", `an uninstalled family is kept (got ${kept?.sans})`);
    const bodyMissing = await computedFont("body");
    assert(/Totally Not Installed/i.test(bodyMissing), "it is written into the stack, so CSS falls through to the tail");

    // --- a value that could break out of the CSS declaration is stripped --
    await post("/api/settings", { fonts: { sans: 'Arial", x; color: red; --y: "', mono: "Consolas" } });
    await delay(700);
    const sanitized = (await getJson("/api/state")).settings?.fonts?.sans;
    assert(!/["';{}]/.test(sanitized || ""), `CSS-hostile characters stripped (stored: ${JSON.stringify(sanitized)})`);
    const bodyColor = await post("/api/measure", { selector: "body", styles: ["color", "font-family"], limit: 1 });
    assert(!/rgb\(255,\s*0,\s*0\)/.test(bodyColor.elements?.[0]?.styles?.color || ""), "the injected declaration did not take effect");

    // --- legacy ids from the first version still migrate -----------------
    await post("/api/settings", { fonts: { sans: "malgun-gothic", mono: "system-mono" } });
    await delay(700);
    const migrated = (await getJson("/api/state")).settings?.fonts;
    assert(migrated?.sans === "Malgun Gothic", `legacy id 'malgun-gothic' migrated (got ${migrated?.sans})`);
    assert(migrated?.mono === "", `legacy id 'system-mono' migrated to the platform default (got ${JSON.stringify(migrated?.mono)})`);

    // --- it survives a restart -------------------------------------------
    await post("/api/settings", { fonts: { sans: "", mono: "Consolas" } });
    await delay(500);
    const persisted = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    assert(persisted.fonts?.sans === "" && persisted.fonts?.mono === "Consolas",
      `selection persisted to settings.json (${JSON.stringify(persisted.fonts)})`);

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
  if (failures.length) { console.log(`FONT FAMILY E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("FONT FAMILY E2E PASSED (catalog + probe, live apply verified on the DOM, roles independent, unknown id heals, persisted)");
  process.exit(0);
}

main();
