/**
 * Display names for the execution harness a member runs on.
 *
 * A member showed only its MODEL, but the same model can run on a different
 * harness with different tools, permissions and behaviour — so the model alone
 * does not say what a member is. These names were duplicated in three places
 * (the Runtime settings view, the member wizard, the model catalog modal); this
 * is the shared source for surfaces that need them.
 *
 * An unrecognized id is returned as-is rather than mapped to a guess: a new
 * harness should show up as its own raw id, not silently as an existing one.
 */
const HARNESS_NAMES: Record<string, { label: string; short: string }> = {
  "claude-code": { label: "Claude Code", short: "CC" },
  codex: { label: "Codex", short: "CDX" },
  cursor: { label: "Cursor CLI", short: "CUR" },
  grok: { label: "Grok Build", short: "GRK" },
};

/** Full display name, e.g. "Claude Code". */
export function harnessLabel(harness: string | undefined): string {
  const id = String(harness || "");
  return HARNESS_NAMES[id]?.label || id;
}

/**
 * Compact badge text for dense surfaces (a sidebar row, a tab) where the full
 * name would crowd out the member's name. Always pair it with
 * {@link harnessLabel} as the tooltip — the short form alone is not readable.
 */
export function harnessShort(harness: string | undefined): string {
  const id = String(harness || "");
  return HARNESS_NAMES[id]?.short || id.slice(0, 3).toUpperCase();
}
