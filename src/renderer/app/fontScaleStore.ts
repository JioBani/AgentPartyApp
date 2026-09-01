/**
 * SEL-6958 follow-up: the transcript font scale must be on the page BEFORE the
 * first paint. The persisted setting lives in the main process and arrives
 * asynchronously; applying it after mount mutates the scale wrapper's transform
 * at runtime, and Chromium keeps the raster translation it chose for the
 * original transform (crbug.com/40431598) — already-painted panes then show
 * text rastered for the old scale, i.e. visibly blurred, until their paint is
 * rebuilt. The renderer therefore mirrors the value into localStorage and reads
 * the mirror synchronously at boot, so the very first frame already renders at
 * the real scale and no boot-time transform change happens at all.
 */
const MIRROR_KEY = "agentparty.transcriptFontScale";
const MIN_SCALE = 0.6;
const MAX_SCALE = 2.0;

export function readMirroredFontScale(): number {
  try {
    const value = Number(localStorage.getItem(MIRROR_KEY));
    return value >= MIN_SCALE && value <= MAX_SCALE ? value : 1;
  } catch {
    return 1;
  }
}

/** Applies the scale to the document and keeps the boot mirror current. */
export function applyFontScale(scale: number): void {
  document.documentElement.style.setProperty("--wb-font-scale", String(scale));
  try {
    localStorage.setItem(MIRROR_KEY, String(scale));
  } catch {
    // The style above is authoritative for this session; losing the mirror
    // only costs the pre-paint value on the NEXT boot.
  }
}
