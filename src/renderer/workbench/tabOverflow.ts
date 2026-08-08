/**
 * The narrowest a tab is allowed to get before one is folded away instead.
 * Below this the name has no room left to say which member it is.
 */
const MIN_TAB = 116;

/** Width the `+N ⌄` chip occupies once it appears. */
const OVERFLOW_CHIP = 46;

/** The split button that always sits at the end of the strip. */
const STRIP_ACTIONS = 30;

/** The strip's own horizontal border. */
const STRIP_CHROME = 2;

export interface TabSplit {
  /** Tabs drawn in the strip, in order. */
  visible: string[];
  /** Tabs folded into the `+N` overflow, in order. */
  hidden: string[];
}

/**
 * Splits a panel's tabs into the ones that are drawn and the ones that fold
 * into the overflow chip.
 *
 * This counts how many tabs fit at {@link MIN_TAB} rather than adding up each
 * tab's own width. Estimating individual widths was wrong twice over: the
 * estimate ran 5–12px high per tab, and even a perfect one leaves the row
 * ending in a gap the width of whatever tab did not fit — so the strip showed
 * empty space next to a `+6`, which reads as "there is room, why is it hiding
 * things". Tabs instead SHRINK to share the row (see `.wb-tab` flex rules), so
 * the count is the only decision left here and an overflowing strip is always
 * visually full — which is what makes "no more room" self-evident.
 *
 * Two rules make this safe rather than merely tidy:
 * - **The active tab is never hidden.** If the count would push it out, it
 *   trades places with the last visible tab, so the panel always shows which
 *   member it is displaying.
 * - **At least one tab is always visible**, even in a panel too narrow for it —
 *   an empty strip above a populated panel reads as a broken panel.
 *
 * A width of 0 means the panel has not been measured yet; everything stays
 * visible for that first paint rather than briefly collapsing to one tab.
 */
export function splitTabs(tabs: string[], active: string, panelWidth: number): TabSplit {
  if (panelWidth <= 0 || tabs.length <= 1) {
    return { visible: tabs.slice(), hidden: [] };
  }

  const fitsIn = (reserved: number) => Math.max(1, Math.floor((panelWidth - STRIP_CHROME - STRIP_ACTIONS - reserved) / MIN_TAB));
  if (fitsIn(0) >= tabs.length) {
    return { visible: tabs.slice(), hidden: [] };
  }
  // Something has to fold, so the chip is on screen and takes room of its own.
  const count = Math.min(tabs.length - 1, fitsIn(OVERFLOW_CHIP));

  const visible = tabs.slice(0, count);
  const hidden = tabs.slice(count);
  const activeHidden = hidden.indexOf(active);
  if (activeHidden >= 0 && visible.length > 0) {
    const displaced = visible[visible.length - 1];
    visible[visible.length - 1] = active;
    hidden[activeHidden] = displaced;
  }
  return { visible, hidden };
}
