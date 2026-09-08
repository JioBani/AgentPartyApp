import type { PanelState } from "./types";
import type { WorkbenchLayout } from "../../shared/workbenchLayout";
import {
  insertPanelBeside,
  removePanelFromGrid,
  resizeGridSplit,
  rowGrid,
  type GridNode,
  type GridSide,
} from "../../shared/workbenchGrid";

/**
 * Pure layout engine for the multi-panel workbench. Every operation returns a
 * new `LayoutState` so React state updates stay predictable, and the same
 * helpers back both pointer interactions (drag/resize) and programmatic ones
 * (open member from the sidebar).
 *
 * Panels are the WHAT (which tabs, in which group); the grid in
 * `shared/workbenchGrid.ts` is the WHERE. Operations here only ever state the
 * panel change and, when a drop asks for a specific placement, that placement —
 * `composeLayout` repairs the tree around it.
 */

/**
 * The same shape the main process persists and broadcasts — an alias, not a
 * copy, so the two cannot drift into "almost the same layout" and need a
 * conversion nobody remembers to update.
 */
export type LayoutState = WorkbenchLayout;

export function emptyLayout(): LayoutState {
  return { panels: [], focusedPanelId: "" };
}

/** Builds a layout from an explicit panel→tabs spec (used by QA arrangement). */
export function layoutFromPanels(spec: string[][]): LayoutState {
  const panels: PanelState[] = spec
    .filter((tabs) => tabs.length > 0)
    .map((tabs) => ({ id: nextPanelId(), tabs: [...tabs], active: tabs[0], weight: 1 }));
  return composeLayout(panels, panels[0]?.id || "", rowGrid(panels));
}

/**
 * Re-exported from the shared module: opening a member is driven from BOTH a
 * sidebar click and `POST /api/party/members/:name/open`, so the two must run
 * the same code rather than two implementations that drift.
 */
export { openMemberTab as openMember, openMemberInNewPanel, openMemberInTabGroup } from "../../shared/workbenchLayout";
export { panelOf } from "../../shared/workbenchLayout";
import { composeLayout, nextPanelId, panelOf } from "../../shared/workbenchLayout";

export function focusPanel(state: LayoutState, panelId: string): LayoutState {
  return { ...state, focusedPanelId: panelId };
}

export function setActiveTab(state: LayoutState, panelId: string, memberName: string): LayoutState {
  return {
    ...state,
    panels: state.panels.map((panel) => (panel.id === panelId ? { ...panel, active: memberName } : panel)),
    focusedPanelId: panelId,
  };
}

/**
 * Brings a tab to the FRONT of its panel and activates it — how a member is
 * picked out of the overflow list.
 *
 * Moving it rather than only activating it is the point: the strip hides tabs
 * from the end, so a member chosen while hidden would be activated and then
 * folded straight back out of sight. Putting it first keeps it on screen, and
 * the order ends up reflecting what the user last reached for.
 */
export function promoteTab(state: LayoutState, panelId: string, memberName: string): LayoutState {
  return {
    ...state,
    panels: state.panels.map((panel) => (
      panel.id === panelId && panel.tabs.includes(memberName)
        ? { ...panel, tabs: [memberName, ...panel.tabs.filter((name) => name !== memberName)], active: memberName }
        : panel
    )),
    focusedPanelId: panelId,
  };
}

export function closeTab(state: LayoutState, panelId: string, memberName: string): LayoutState {
  const panels: PanelState[] = [];
  for (const panel of state.panels) {
    if (panel.id !== panelId) {
      panels.push(panel);
      continue;
    }
    const tabs = panel.tabs.filter((name) => name !== memberName);
    if (tabs.length === 0) {
      continue; // drop the now-empty panel
    }
    const active = panel.active === memberName ? tabs[Math.max(0, tabs.indexOf(memberName) - 0)] || tabs[tabs.length - 1] : panel.active;
    panels.push({ ...panel, tabs, active });
  }
  // The emptied panel's slot is removed explicitly rather than left to the
  // reconcile: dropping a leaf collapses its split and hands the freed space
  // back to the panels that shared it, which is what closing a split view in an
  // editor does. A bare reconcile would do the same, but only because it must
  // — saying it here keeps the intent in the operation.
  return composeLayout(panels, panelId, removePanelFromGrid(state.grid, panelId));
}

/**
 * Splits a panel: a new slot on the given side, seeded with the active member.
 *
 * `side` is what makes the layout a grid rather than a row — "bottom" stacks
 * the new slot under the source instead of beside it.
 */
export function splitPanel(state: LayoutState, panelId: string, side: GridSide = "right"): LayoutState {
  const source = state.panels.find((panel) => panel.id === panelId);
  if (!source) {
    return state;
  }
  const panel: PanelState = { id: nextPanelId(), tabs: [source.active], active: source.active, weight: source.weight };
  return placeNewPanel(state, panel, panelId, side);
}

/**
 * Moves a tab into a panel — another one (cross-panel drag) or its own
 * (reorder).
 *
 * `atMember` is the tab the cursor was over and `after` which half of it, so a
 * drop lands on the side the user aimed at. Insertion was once always BEFORE the
 * hovered tab, which made every rightward reorder land one slot short: dragging
 * `A` in `[A,B,C]` onto `B` removed `A`, then re-inserted it before `B` — back
 * where it started, so short drags looked like reordering did not work at all.
 */
export function moveTab(state: LayoutState, memberName: string, toPanelId: string, atMember?: string, after = false): LayoutState {
  const from = panelOf(state, memberName);
  if (!from) {
    return state;
  }
  if (from.id === toPanelId && !atMember) {
    return setActiveTab(state, toPanelId, memberName);
  }
  let panels = state.panels.map((panel) => (
    panel.id === from.id
      ? { ...panel, tabs: panel.tabs.filter((name) => name !== memberName), active: panel.active === memberName ? panel.tabs.filter((n) => n !== memberName)[0] || "" : panel.active }
      : panel
  ));
  panels = panels.map((panel) => {
    if (panel.id !== toPanelId) {
      return panel;
    }
    const tabs = panel.tabs.filter((name) => name !== memberName);
    const at = atMember ? tabs.indexOf(atMember) : -1;
    if (at >= 0) {
      tabs.splice(after ? at + 1 : at, 0, memberName);
    } else {
      tabs.push(memberName);
    }
    return { ...panel, tabs, active: memberName };
  });
  panels = panels.filter((panel) => panel.tabs.length > 0);
  return composeLayout(panels, toPanelId, gridWithout(state.grid, state.panels, panels));
}

/**
 * Drops a tab onto an edge of a panel: it leaves its group and takes a new slot
 * on that side — the interaction that builds the grid.
 *
 * `targetPanelId` is the panel that was dropped on; with none (a drop in the
 * empty area past the last panel) the slot is appended to the outermost row.
 */
export function moveTabToNewPanel(
  state: LayoutState,
  memberName: string,
  targetPanelId?: string,
  side: GridSide = "right",
): LayoutState {
  const from = panelOf(state, memberName);
  if (!from) {
    return state;
  }
  if (from.tabs.length === 1 && (from.id === targetPanelId || !targetPanelId)) {
    // Already alone in the slot the drop would create — moving it would be
    // churn that also loses the panel's size.
    return setActiveTab(state, from.id, memberName);
  }
  const stripped = state.panels
    .map((panel) => (
      panel.id === from.id
        ? { ...panel, tabs: panel.tabs.filter((name) => name !== memberName), active: panel.tabs.filter((n) => n !== memberName)[0] || "" }
        : panel
    ))
    .filter((panel) => panel.tabs.length > 0);
  const panel: PanelState = { id: nextPanelId(), tabs: [memberName], active: memberName, weight: 1 };
  const anchor = targetPanelId && stripped.some((item) => item.id === targetPanelId) ? targetPanelId : undefined;
  const base = { ...state, panels: stripped, grid: gridWithout(state.grid, state.panels, stripped) };
  return placeNewPanel(base, panel, anchor, side);
}

/**
 * Adjusts the weights of two adjacent panels by a normalized delta.
 *
 * Kept panel-addressed for callers that only know the two panels either side of
 * a divider; it resolves them to their shared split, so it works on any axis and
 * refuses (rather than guessing) when the two are not actually siblings.
 */
export function resizeAt(state: LayoutState, leftPanelId: string, rightPanelId: string, deltaRatio: number): LayoutState {
  const divider = findDivider(state.grid, leftPanelId, rightPanelId);
  if (!divider) {
    return state;
  }
  return resizeSplit(state, divider.splitId, divider.index, deltaRatio);
}

/** Adjusts one split's divider: the pair around `index` moves, nothing else. */
export function resizeSplit(state: LayoutState, splitId: string, index: number, deltaRatio: number): LayoutState {
  const grid = resizeGridSplit(state.grid, splitId, index, deltaRatio);
  return composeLayout(state.panels, state.focusedPanelId, grid);
}

/** Drops tabs for members that no longer exist and prunes empty panels. */
export function pruneLayout(state: LayoutState, validMembers: Set<string>): LayoutState {
  const panels = state.panels
    .map((panel) => {
      const tabs = panel.tabs.filter((name) => validMembers.has(name));
      const active = tabs.includes(panel.active) ? panel.active : tabs[0] || "";
      return { ...panel, tabs, active };
    })
    .filter((panel) => panel.tabs.length > 0);
  return composeLayout(panels, state.focusedPanelId, gridWithout(state.grid, state.panels, panels));
}

/** Adds a panel to the layout, in a slot beside `anchor` or at the end. */
function placeNewPanel(state: LayoutState, panel: PanelState, anchor: string | undefined, side: GridSide): LayoutState {
  const panels = [...state.panels, panel];
  // With no anchor the reconcile appends the leaf to the outermost row, which
  // is exactly where a drop into empty space belongs.
  const grid = anchor ? insertPanelBeside(state.grid, panel.id, anchor, side) : state.grid;
  return composeLayout(panels, panel.id, grid);
}

/** Drops the slots of panels that did not survive an operation. */
function gridWithout(grid: GridNode | undefined, before: PanelState[], after: PanelState[]): GridNode | undefined {
  const survivors = new Set(after.map((panel) => panel.id));
  let next = grid;
  for (const panel of before) {
    if (!survivors.has(panel.id)) {
      next = removePanelFromGrid(next, panel.id);
    }
  }
  return next;
}

/** The split, and index within it, whose divider sits between two panels. */
function findDivider(grid: GridNode | undefined, leftPanelId: string, rightPanelId: string): { splitId: string; index: number } | undefined {
  if (!grid || grid.type === "leaf") {
    return undefined;
  }
  for (let index = 0; index < grid.children.length - 1; index += 1) {
    const first = grid.children[index];
    const second = grid.children[index + 1];
    if (first.type === "leaf" && second.type === "leaf" && first.panelId === leftPanelId && second.panelId === rightPanelId) {
      return { splitId: grid.id, index };
    }
  }
  for (const child of grid.children) {
    const found = findDivider(child, leftPanelId, rightPanelId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

// --- Persistence ----------------------------------------------------------
//
// There is none here any more. The layout used to live in each renderer's
// localStorage under `agentparty.layout.<partyId>`, which every window on that
// party wrote and none of them read again: a tab closed in one window stayed
// open in the other, and that window's next change rewrote the shared key and
// brought the closed tab back on relaunch.
//
// It is party state, so the main process owns it and broadcasts it — see
// shared/workbenchLayout.ts and PartyApplicationService.setPartyLayout.
