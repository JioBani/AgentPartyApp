import type { PanelState } from "./types";
import type { WorkbenchLayout } from "../../shared/workbenchLayout";

/**
 * Pure layout engine for the multi-panel workbench. Every operation returns a
 * new `LayoutState` so React state updates stay predictable, and the same
 * helpers back both pointer interactions (drag/resize) and programmatic ones
 * (open member from the sidebar).
 */

/**
 * The same shape the main process persists and broadcasts — an alias, not a
 * copy, so the two cannot drift into "almost the same layout" and need a
 * conversion nobody remembers to update.
 */
export type LayoutState = WorkbenchLayout;

const MIN_WEIGHT = 0.18;

export function emptyLayout(): LayoutState {
  return { panels: [], focusedPanelId: "" };
}

/** Builds a layout from an explicit panel→tabs spec (used by QA arrangement). */
export function layoutFromPanels(spec: string[][]): LayoutState {
  const panels: PanelState[] = spec
    .filter((tabs) => tabs.length > 0)
    .map((tabs) => ({ id: nextPanelId(), tabs: [...tabs], active: tabs[0], weight: 1 }));
  return { panels, focusedPanelId: panels[0]?.id || "" };
}

/**
 * Re-exported from the shared module: opening a member is driven from BOTH a
 * sidebar click and `POST /api/party/members/:name/open`, so the two must run
 * the same code rather than two implementations that drift.
 */
export { openMemberTab as openMember } from "../../shared/workbenchLayout";
export { panelOf } from "../../shared/workbenchLayout";
import { nextPanelId, panelOf } from "../../shared/workbenchLayout";

function focusFallback(panels: PanelState[], preferred: string): string {
  if (panels.some((panel) => panel.id === preferred)) {
    return preferred;
  }
  return panels[0]?.id || "";
}

/**
 * Opens a member in its OWN new panel appended on the right (a new region),
 * instead of merging it into an existing panel's tab strip. Used when a member
 * is created (by the wizard or by an agent via member-create) so it goes live in
 * a fresh slot rather than into the background of the focused panel.
 */
export function openMemberInNewPanel(state: LayoutState, memberName: string): LayoutState {
  const existing = panelOf(state, memberName);
  if (existing) {
    return {
      panels: state.panels.map((panel) => (panel.id === existing.id ? { ...panel, active: memberName } : panel)),
      focusedPanelId: existing.id,
    };
  }
  const panel: PanelState = { id: nextPanelId(), tabs: [memberName], active: memberName, weight: 1 };
  const panels = [...state.panels, panel];
  return { panels: normalizeWeights(panels), focusedPanelId: panel.id };
}

export function focusPanel(state: LayoutState, panelId: string): LayoutState {
  return { ...state, focusedPanelId: panelId };
}

export function setActiveTab(state: LayoutState, panelId: string, memberName: string): LayoutState {
  return {
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
  return { panels: normalizeWeights(panels), focusedPanelId: focusFallback(panels, panelId) };
}

/** Splits a panel: a new watch-slot to the right seeded with the active member. */
export function splitPanel(state: LayoutState, panelId: string): LayoutState {
  const index = state.panels.findIndex((panel) => panel.id === panelId);
  if (index < 0) {
    return state;
  }
  const source = state.panels[index];
  const panel: PanelState = { id: nextPanelId(), tabs: [source.active], active: source.active, weight: source.weight };
  const panels = [...state.panels.slice(0, index + 1), panel, ...state.panels.slice(index + 1)];
  return { panels: normalizeWeights(panels), focusedPanelId: panel.id };
}

/** Moves a tab to another existing panel (cross-panel drag). */
export function moveTab(state: LayoutState, memberName: string, toPanelId: string, beforeMember?: string): LayoutState {
  const from = panelOf(state, memberName);
  if (!from) {
    return state;
  }
  if (from.id === toPanelId && !beforeMember) {
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
    const at = beforeMember ? tabs.indexOf(beforeMember) : -1;
    if (at >= 0) {
      tabs.splice(at, 0, memberName);
    } else {
      tabs.push(memberName);
    }
    return { ...panel, tabs, active: memberName };
  });
  panels = panels.filter((panel) => panel.tabs.length > 0);
  return { panels: normalizeWeights(panels), focusedPanelId: focusFallback(panels, toPanelId) };
}

/** Drops a tab into empty space to create a new panel (drop-to-split). */
export function moveTabToNewPanel(state: LayoutState, memberName: string, afterPanelId?: string): LayoutState {
  const from = panelOf(state, memberName);
  if (!from) {
    return state;
  }
  if (from.tabs.length === 1) {
    // Already alone — moving to a new panel would be a no-op churn.
    return setActiveTab(state, from.id, memberName);
  }
  const stripped = state.panels.map((panel) => (
    panel.id === from.id
      ? { ...panel, tabs: panel.tabs.filter((name) => name !== memberName), active: panel.tabs.filter((n) => n !== memberName)[0] || "" }
      : panel
  ));
  const panel: PanelState = { id: nextPanelId(), tabs: [memberName], active: memberName, weight: 1 };
  const anchor = afterPanelId ? stripped.findIndex((item) => item.id === afterPanelId) : stripped.length - 1;
  const panels = [...stripped.slice(0, anchor + 1), panel, ...stripped.slice(anchor + 1)].filter((item) => item.tabs.length > 0);
  return { panels: normalizeWeights(panels), focusedPanelId: panel.id };
}

/** Adjusts the weights of two adjacent panels by a normalized delta. */
export function resizeAt(state: LayoutState, leftPanelId: string, rightPanelId: string, deltaRatio: number): LayoutState {
  const panels = state.panels.map((panel) => ({ ...panel }));
  const left = panels.find((panel) => panel.id === leftPanelId);
  const right = panels.find((panel) => panel.id === rightPanelId);
  if (!left || !right) {
    return state;
  }
  const pair = left.weight + right.weight;
  let leftWeight = left.weight + deltaRatio * pair;
  leftWeight = Math.min(pair - MIN_WEIGHT, Math.max(MIN_WEIGHT, leftWeight));
  left.weight = leftWeight;
  right.weight = pair - leftWeight;
  return { ...state, panels };
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
  return { panels: normalizeWeights(panels), focusedPanelId: focusFallback(panels, state.focusedPanelId) };
}

function normalizeWeights(panels: PanelState[]): PanelState[] {
  if (panels.length === 0) {
    return panels;
  }
  const total = panels.reduce((sum, panel) => sum + (panel.weight > 0 ? panel.weight : 1), 0);
  const target = panels.length; // keep the average weight near 1
  return panels.map((panel) => ({ ...panel, weight: ((panel.weight > 0 ? panel.weight : 1) / total) * target }));
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
