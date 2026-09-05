/**
 * The persisted transcript scale arrives from the main process asynchronously.
 * Mirror it locally so the first frame has the user's real layout scale instead
 * of visibly jumping from 100% after mount.
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
  const root = document.documentElement;
  root.style.setProperty("--wb-font-scale", String(scale));
  // A non-default CSS zoom keeps glyphs sharp but makes descendant animations
  // paint on the main thread in Chromium. The attribute lets CSS pause those
  // purely decorative loops only while layout zoom is active.
  root.toggleAttribute("data-transcript-font-scaled", scale !== 1);
  try {
    localStorage.setItem(MIRROR_KEY, String(scale));
  } catch {
    // The style above is authoritative for this session; losing the mirror
    // only costs the pre-paint value on the NEXT boot.
  }
}
