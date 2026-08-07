/**
 * The workbench tab layout for one party — which members are open, in which
 * panels, in what order, and which tab is active in each.
 *
 * Party state, not window state. It used to live in each renderer's
 * localStorage under a per-party key, which every window on that party wrote to
 * and none of them read again: closing a tab in one window left it open in the
 * other, and the other window's next change rewrote the key and resurrected the
 * closed tab on relaunch. Same process + same party must show the same thing, so
 * the main process owns this and broadcasts it, the way it already does for
 * party state and transcripts.
 *
 * Shared because the main process persists it and must not write nonsense a
 * renderer would then have to defend against — hence {@link sanitizeLayout}.
 */

export interface WorkbenchPanel {
  id: string;
  /** Member names, left → right. */
  tabs: string[];
  /** The member name whose tab is frontmost in this panel. */
  active: string;
  /** Flex weight relative to sibling panels. */
  weight: number;
}

export interface WorkbenchLayout {
  panels: WorkbenchPanel[];
  focusedPanelId: string;
}

export const EMPTY_LAYOUT: WorkbenchLayout = { panels: [], focusedPanelId: "" };

/**
 * Coerces stored or IPC-delivered JSON into a usable layout, or undefined when
 * there is nothing usable in it.
 *
 * Undefined rather than an empty layout on purpose: "no layout stored" and "a
 * layout with no panels" are different facts. The first means seed from the
 * member list; the second means the user closed every tab, and reseeding it
 * would reopen tabs they just closed.
 */
export function sanitizeLayout(value: unknown): WorkbenchLayout | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Partial<WorkbenchLayout>;
  if (!Array.isArray(raw.panels)) {
    return undefined;
  }
  const panels: WorkbenchPanel[] = [];
  for (const candidate of raw.panels) {
    const panel = sanitizePanel(candidate);
    if (panel) {
      panels.push(panel);
    }
  }
  const focused = typeof raw.focusedPanelId === "string" ? raw.focusedPanelId : "";
  return {
    panels,
    // A focus pointing at a panel that did not survive sanitising would leave
    // the workbench with no focused panel and every "open here" landing nowhere.
    focusedPanelId: panels.some((panel) => panel.id === focused) ? focused : panels[0]?.id || "",
  };
}

function sanitizePanel(value: unknown): WorkbenchPanel | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Partial<WorkbenchPanel>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const tabs = Array.isArray(raw.tabs) ? raw.tabs.filter((tab): tab is string => typeof tab === "string" && tab.length > 0) : [];
  if (!id || tabs.length === 0) {
    return undefined;
  }
  const weight = Number(raw.weight);
  return {
    id,
    tabs,
    active: typeof raw.active === "string" && tabs.includes(raw.active) ? raw.active : tabs[0],
    weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
  };
}

/** Whether two layouts are the same, for suppressing echo saves and no-op broadcasts. */
export function layoutsEqual(a: WorkbenchLayout | undefined, b: WorkbenchLayout | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The panel currently holding a member's tab, if any. */
export function panelOf(layout: WorkbenchLayout, memberName: string): WorkbenchPanel | undefined {
  return layout.panels.find((panel) => panel.tabs.includes(memberName));
}

let panelCounter = 0;

/**
 * A fresh panel id. Exported so there is ONE counter: while the renderer kept
 * its own, two panels created in the same millisecond — one by a split, one by
 * an open — could be minted the same id, and every lookup that resolves a panel
 * by id (move a tab, drag a divider) then hit both.
 */
export function nextPanelId(): string {
  panelCounter += 1;
  return `panel-${Date.now().toString(36)}-${panelCounter}`;
}

/**
 * Opens a member: focuses its existing tab, or adds one to the focused panel.
 *
 * Shared because "open this member" has two callers that must agree — a click in
 * the sidebar and `POST /api/party/members/:name/open`. The HTTP one used to
 * only set a status flag and answer "Member 'X' opened." while no tab appeared
 * anywhere, so an agent asking for a member could not get one.
 */
export function openMemberTab(layout: WorkbenchLayout, memberName: string): WorkbenchLayout {
  const existing = panelOf(layout, memberName);
  if (existing) {
    return {
      panels: layout.panels.map((panel) => (panel.id === existing.id ? { ...panel, active: memberName } : panel)),
      focusedPanelId: existing.id,
    };
  }
  const target = layout.panels.find((panel) => panel.id === layout.focusedPanelId) || layout.panels[0];
  if (!target) {
    const panel: WorkbenchPanel = { id: nextPanelId(), tabs: [memberName], active: memberName, weight: 1 };
    return { panels: [panel], focusedPanelId: panel.id };
  }
  return {
    panels: layout.panels.map((panel) => (
      panel.id === target.id ? { ...panel, tabs: [...panel.tabs, memberName], active: memberName } : panel
    )),
    focusedPanelId: target.id,
  };
}
