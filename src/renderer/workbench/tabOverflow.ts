import type { MemberView, PanelDensity } from "./types";

/** Widest a tab can render (`.wb-tab` max-width plus its right border). */
const TAB_MAX = 178;

/** Space kept clear at the end of the strip for the `+N ⌄` chip itself. */
const OVERFLOW_CHIP = 52;

/** The strip's own horizontal border. */
const STRIP_CHROME = 2;

/**
 * Estimated rendered width of one tab, in pixels.
 *
 * Estimated rather than measured on purpose: measuring would require the tabs
 * to already be in the DOM, and the whole point is to decide which ones to put
 * there. The terms mirror what {@link TabStrip} actually draws — accent, dot,
 * name, and the badges that appear only in some states — so a tab carrying an
 * approval badge is correctly treated as wider than a bare one.
 *
 * The badge terms follow the RENDERING, not the data: the strip shows the
 * unread count only when there is no approval badge, so this counts one or the
 * other, never both.
 */
export function estimateTabWidth(view: MemberView, density: PanelDensity): number {
  const name = view.name || "";
  let width = 19 + 7 + 7 + Math.min(100, Math.max(34, name.length * 7)) + 7 + 17 + 1;
  if (density !== "narrow") {
    width += 25; // harness chip (18px) + gap — this app's tab has one, the design's does not
  }
  if (view.pendingApproval) {
    width += 37;
  } else if (view.unread > 0) {
    width += 29;
  }
  if ((view.member.queue?.items.length || 0) > 0) {
    width += 43;
  }
  return Math.min(TAB_MAX, width);
}

export interface TabSplit {
  /** Tabs drawn in the strip, in order. */
  visible: string[];
  /** Tabs folded into the `+N` overflow, in order. */
  hidden: string[];
}

/**
 * Splits a panel's tabs into the ones that fit and the ones that fold into the
 * overflow chip.
 *
 * Two rules make this safe rather than merely tidy:
 * - **The active tab is never hidden.** If the budget would push it out, it
 *   trades places with the last visible tab, so the panel always shows which
 *   member it is displaying.
 * - **At least one tab is always visible**, even in a panel too narrow for it —
 *   an empty strip above a populated panel reads as a broken panel.
 *
 * A width of 0 means the panel has not been measured yet; everything stays
 * visible for that first paint rather than briefly collapsing to one tab.
 */
export function splitTabs(
  tabs: string[],
  active: string,
  panelWidth: number,
  views: Map<string, MemberView>,
  density: PanelDensity,
): TabSplit {
  if (panelWidth <= 0 || tabs.length <= 1) {
    return { visible: tabs.slice(), hidden: [] };
  }
  const widthOf = (member: string) => {
    const view = views.get(member);
    return view ? estimateTabWidth(view, density) : 0;
  };
  const total = tabs.reduce((sum, member) => sum + widthOf(member), 0);
  if (total <= panelWidth - STRIP_CHROME) {
    return { visible: tabs.slice(), hidden: [] };
  }

  const budget = panelWidth - STRIP_CHROME - OVERFLOW_CHIP;
  const visible: string[] = [];
  const hidden: string[] = [];
  let used = 0;
  for (const member of tabs) {
    const width = widthOf(member);
    if (used + width <= budget || visible.length === 0) {
      used += width;
      visible.push(member);
    } else {
      hidden.push(member);
    }
  }

  const activeHidden = hidden.indexOf(active);
  if (activeHidden >= 0 && visible.length > 0) {
    const displaced = visible[visible.length - 1];
    visible[visible.length - 1] = active;
    hidden[activeHidden] = displaced;
  }
  return { visible, hidden };
}
