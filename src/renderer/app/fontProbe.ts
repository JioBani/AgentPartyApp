/**
 * What fonts does this machine actually have, and what is each one good for?
 *
 * Two jobs, both of which only Chromium can do:
 *
 * 1. **Enumerate** the installed families (`queryLocalFonts`), so the picker
 *    offers what the user really has instead of a list we guessed at.
 * 2. **Classify** them, because the raw list is ~300 families in which the
 *    handful usable for a Korean UI or for code are indistinguishable by name.
 *    Both answers are MEASURED, never inferred from the name: a family called
 *    "…Mono" is not necessarily fixed-width and says nothing about Hangul.
 *
 * Availability is measured too, for the recommended families that enumeration
 * may not cover (and for when enumeration is unavailable entirely). CSS answers
 * "is this font installed" silently — pick a missing family and the browser
 * quietly renders the next one in the stack — so the picker must ask something
 * that cannot shrug.
 */

import type { LocalFontFamily, LocalFontListing } from "../../shared/appFonts";

/** Hangul + Latin + digits — a UI font must cover the app's real alphabet. */
const PROBE_TEXT = "가나다라ABCXYZabcxyz0123";
const PROBE_SIZE = "72px";
const BASELINES = ["monospace", "serif", "sans-serif"] as const;

let context: CanvasRenderingContext2D | null | undefined;

function probeContext(): CanvasRenderingContext2D | null {
  if (context === undefined) {
    context = document.createElement("canvas").getContext("2d");
  }
  return context;
}

/** CSS-safe quoted family for a canvas `font` shorthand. */
function quoted(family: string): string {
  return `"${family.replace(/["\\]/g, "")}"`;
}

function widthOf(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  ctx.font = `${PROBE_SIZE} ${font}`;
  return ctx.measureText(text).width;
}

/**
 * Whether `family` is installed (or already loaded as a bundled `@font-face`).
 *
 * `document.fonts.check()` cannot answer this — Chromium returns true for any
 * name because a fallback always exists. So measure: render the probe text in
 * the candidate layered over each generic baseline and call it installed when
 * it changes the width against EVERY baseline. Against every one, not any: a
 * family whose metrics happen to match `serif` exactly would otherwise read as
 * missing.
 *
 * Returns `null` — never a bare `false` — when the measurement could not run.
 * "We could not tell" and "it is missing" must not look the same.
 */
export function isFontAvailable(family: string): boolean | null {
  if (!family.trim()) {
    return true; // the platform stack names no family — always renderable
  }
  const ctx = probeContext();
  if (!ctx) {
    return null;
  }
  return BASELINES.every((baseline) => widthOf(ctx, `${quoted(family)}, ${baseline}`, PROBE_TEXT) !== widthOf(ctx, baseline, PROBE_TEXT));
}

/** Availability for many families at once, keyed by family name. */
export function probeFonts(families: string[]): Record<string, boolean | null> {
  const result: Record<string, boolean | null> = {};
  for (const family of families) {
    result[family] = isFontAvailable(family);
  }
  return result;
}

/**
 * Fixed-width test: in a monospace family every glyph advances the same, so the
 * narrowest and widest Latin letters measure identically. Both measurements use
 * the SAME font string, so this compares a family against itself — no
 * cross-font comparison, and therefore none of the collisions that make glyph-
 * coverage undecidable below. Layered over `serif` (a proportional baseline) so
 * an absent family fails the test rather than inheriting another font's answer.
 */
function isMonospace(ctx: CanvasRenderingContext2D, family: string): boolean {
  const font = `${quoted(family)}, serif`;
  return widthOf(ctx, font, "iiiiiiiiii") === widthOf(ctx, font, "WWWWWWWWWW");
}

/*
 * Why there is no `hasHangul` here.
 *
 * The obvious test — render 한글 in the family, compare against a baseline, call
 * a difference "the family has the glyph" — cannot work, and measurement proved
 * it: 맑은 고딕 and 굴림체 both came back as "no Hangul".
 *
 * The reason is that a family MISSING the glyph falls back to the system's
 * Hangul font, so its rendering becomes identical to the baseline's. That is
 * indistinguishable from a family that HAS the glyph and happens to be that
 * same system font — which is exactly what 맑은 고딕 is on Windows. Pixel
 * comparison instead of width does not help; the two cases are identical at
 * every level the DOM exposes. Deciding it properly would mean parsing each
 * font's cmap table out of `FontData.blob()`, which is megabytes per family.
 *
 * So the picker shows a Hangul sample line drawn IN EACH FAMILY instead. The
 * user sees the fallback mismatch directly, which is both truthful and easier
 * to act on than a flag that is wrong for the most common Korean font on the
 * platform.
 */

/**
 * Every installed family, deduplicated and classified.
 *
 * `queryLocalFonts()` returns one entry per FACE (Arial, Arial Bold, Arial
 * Italic…), which would show the same family a dozen times; the picker chooses
 * a family and lets CSS pick the face, so they are collapsed here.
 *
 * Requires the Local Font Access permission. A refusal is reported, never
 * swallowed into an empty list — "you have no fonts" and "we were not allowed
 * to look" lead to completely different fixes.
 */
export async function enumerateLocalFonts(): Promise<LocalFontListing> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
  if (typeof query !== "function") {
    return { families: [], error: "이 런타임은 설치 글꼴 열거(queryLocalFonts)를 지원하지 않습니다." };
  }
  let faces: Array<{ family: string }>;
  try {
    faces = await query.call(window);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { families: [], error: `설치 글꼴을 열거하지 못했습니다: ${reason}` };
  }
  const ctx = probeContext();
  if (!ctx) {
    return { families: [], error: "글꼴 분류에 필요한 캔버스를 만들지 못했습니다." };
  }
  const seen = new Set<string>();
  const families: LocalFontFamily[] = [];
  for (const face of faces) {
    const family = (face?.family || "").trim();
    if (!family || seen.has(family)) {
      continue;
    }
    seen.add(family);
    families.push({ family, monospace: isMonospace(ctx, family) });
  }
  families.sort((a, b) => a.family.localeCompare(b.family, "ko"));
  return { families };
}

/**
 * Publishes the probes for the main process to call through
 * `webContents.executeJavaScript`, which is how `GET /api/appearance/fonts`
 * answers.
 *
 * An intentional automation hook, not a leak: these are questions only
 * Chromium can answer, and routing them through ONE object keeps a single
 * implementation instead of a copy pasted into a main-process script string
 * that could then drift from what the picker shows.
 */
export function publishFontProbe(): void {
  (window as unknown as Record<string, unknown>).agentPartyFonts = { probe: probeFonts, list: enumerateLocalFonts };
}
