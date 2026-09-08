/**
 * Where the workbench's panels SIT — the split tree behind the grid layout.
 *
 * `WorkbenchLayout.panels` says which panels exist and what tabs they hold;
 * this module says how they are arranged. Two structures rather than one tree
 * of tabs on purpose: every other consumer of a layout (the sidebar's tab-group
 * list, MCP `member-create`'s `tabGroup` anchor, session prewarm, prune) cares
 * only about the flat panel set, and folding tabs into the tree would have made
 * all of them walk it for nothing.
 *
 * The grid is OPTIONAL, and that is the compatibility story: a layout stored
 * before grids existed — or written by an older window on this party — has no
 * grid and is rendered as one left-to-right row, exactly as it was.
 *
 * Leaf weights are mirrored back onto `WorkbenchPanel.weight` (see
 * {@link syncPanelWeights}) so a panel always carries its share OF ITS OWN
 * parent split. That is what the renderer's flex box needs, and it is what an
 * older client reads as a share of the single row.
 */

import type { WorkbenchPanel } from "./workbenchLayout";

/** A panel's slot in the grid. `weight` is its share of its parent split. */
export interface GridLeaf {
  type: "leaf";
  panelId: string;
  weight: number;
}

/** A row (side by side) or a column (stacked) of nodes. */
export interface GridSplit {
  type: "split";
  id: string;
  dir: "row" | "column";
  children: GridNode[];
  weight: number;
}

export type GridNode = GridLeaf | GridSplit;

/** Which edge of a panel a dragged tab was dropped on. */
export type GridSide = "left" | "right" | "top" | "bottom";

/** Smallest share a node may be dragged down to, relative to an average of 1. */
export const GRID_MIN_WEIGHT = 0.18;

let splitCounter = 0;

/** A fresh split id. Prefixed, so it can never be mistaken for a panel id. */
export function nextSplitId(): string {
  splitCounter += 1;
  return `split-${Date.now().toString(36)}-${splitCounter}`;
}

const AXIS_OF: Record<GridSide, "row" | "column"> = {
  left: "row",
  right: "row",
  top: "column",
  bottom: "column",
};

/** The axis a drop on this side splits along. */
export function axisOfSide(side: GridSide): "row" | "column" {
  return AXIS_OF[side];
}

/** Panel ids the grid places, in visual order. */
export function gridPanelIds(node: GridNode | undefined): string[] {
  if (!node) {
    return [];
  }
  return node.type === "leaf" ? [node.panelId] : node.children.flatMap(gridPanelIds);
}

/**
 * A stable id for a grid this module INVENTS — the fallback row for a layout
 * that carries no grid, or the wrapper that takes in panels a stored grid never
 * heard of.
 *
 * Derived from the panels rather than minted, because these are produced while
 * READING a layout: with a fresh id each time, sanitising the same stored
 * layout twice gave two different results. Everything that compares layouts by
 * value then broke — the window's echo guard never recognised its own layout
 * coming back, so it stopped pushing the user's changes to the main process at
 * all, and the main process saw every identical POST as a change to broadcast.
 */
function stableSplitId(kind: string, panels: WorkbenchPanel[]): string {
  let hash = 2166136261;
  for (const character of panels.map((panel) => panel.id).join("|")) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return `split-${kind}-${(hash >>> 0).toString(36)}`;
}

/** The default geometry: every panel side by side, in panel order. */
export function rowGrid(panels: WorkbenchPanel[]): GridNode | undefined {
  const children: GridNode[] = panels.map((panel) => ({ type: "leaf", panelId: panel.id, weight: panel.weight }));
  return normalizeNode({ type: "split", id: stableSplitId("row", panels), dir: "row", children, weight: 1 });
}

/**
 * Coerces a grid out of stored or IPC-delivered JSON. Structure only — whether
 * it matches the panel set is {@link reconcileGrid}'s job.
 */
export function sanitizeGrid(value: unknown): GridNode | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Partial<GridSplit> & Partial<GridLeaf>;
  const rawWeight = Number(raw.weight);
  const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 1;
  if (raw.type === "leaf") {
    return typeof raw.panelId === "string" && raw.panelId ? { type: "leaf", panelId: raw.panelId, weight } : undefined;
  }
  if (raw.type !== "split" || !Array.isArray(raw.children)) {
    return undefined;
  }
  const children = raw.children.map(sanitizeGrid).filter((child): child is GridNode => Boolean(child));
  const id = typeof raw.id === "string" && raw.id ? raw.id : nextSplitId();
  const dir = raw.dir === "column" ? "column" : "row";
  return collapse({ type: "split", id, dir, children, weight });
}

/**
 * Repairs a grid against the panels that actually exist: drops leaves whose
 * panel is gone, appends leaves for panels the grid never heard of, removes
 * duplicates, collapses splits left with a single child, and renormalizes.
 *
 * Every layout operation goes through this instead of maintaining the tree by
 * hand, so closing a tab, dragging a member away, pruning a removed member and
 * adopting a grid from another window all converge on the same repair. The
 * silence is deliberate ONLY here: a mismatch is not a failure to surface, it is
 * the normal consequence of the panel set changing.
 */
export function reconcileGrid(node: GridNode | undefined, panels: WorkbenchPanel[]): GridNode | undefined {
  if (panels.length === 0) {
    return undefined;
  }
  const known = new Set(panels.map((panel) => panel.id));
  const seen = new Set<string>();
  const kept = node ? keepKnownLeaves(node, known, seen) : undefined;
  if (!kept) {
    return rowGrid(panels);
  }
  const missing = panels.filter((panel) => !seen.has(panel.id));
  if (missing.length === 0) {
    return normalizeNode(kept);
  }
  const extra: GridNode[] = missing.map((panel) => ({ type: "leaf", panelId: panel.id, weight: panel.weight }));
  const root: GridSplit = kept.type === "split" && kept.dir === "row"
    ? { ...kept, children: [...kept.children, ...extra] }
    : { type: "split", id: stableSplitId("add", panels), dir: "row", children: [kept, ...extra], weight: 1 };
  return normalizeNode(root);
}

/** Mirrors each leaf's weight onto its panel, so a panel carries its own share. */
export function syncPanelWeights(panels: WorkbenchPanel[], node: GridNode | undefined): WorkbenchPanel[] {
  if (!node) {
    return panels;
  }
  const weights = new Map<string, number>();
  collectWeights(node, weights);
  return panels.map((panel) => {
    const weight = weights.get(panel.id);
    return weight !== undefined && weight !== panel.weight ? { ...panel, weight } : panel;
  });
}

/**
 * Places a panel next to another one, on the given side — the drop that turns a
 * single row into a grid.
 *
 * When the target's parent split already runs along the needed axis, the panel
 * becomes its sibling (a row of two becomes a row of three, not a row holding a
 * row); otherwise the target leaf is replaced by a fresh split along that axis.
 * That is the rule VS Code uses, and it is what stops a grid from growing a
 * tower of redundant one-way splits.
 */
export function insertPanelBeside(
  node: GridNode | undefined,
  panelId: string,
  targetPanelId: string,
  side: GridSide,
): GridNode | undefined {
  if (!node) {
    return undefined;
  }
  const axis = AXIS_OF[side];
  const before = side === "left" || side === "top";
  if (node.type === "leaf") {
    return node.panelId === targetPanelId ? wrapLeaf(node, panelId, axis, before) : node;
  }
  const children: GridNode[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.type === "leaf" && child.panelId === targetPanelId) {
      changed = true;
      if (node.dir === axis) {
        // Same axis: become a sibling and take half of the target's share, so
        // the other panels in this split keep the sizes the user gave them.
        const half = child.weight / 2;
        const inserted: GridLeaf = { type: "leaf", panelId, weight: half };
        const shrunk: GridLeaf = { ...child, weight: half };
        children.push(...(before ? [inserted, shrunk] : [shrunk, inserted]));
      } else {
        children.push(wrapLeaf(child, panelId, axis, before));
      }
      continue;
    }
    const next = insertPanelBeside(child, panelId, targetPanelId, side);
    if (next && next !== child) {
      changed = true;
    }
    children.push(next || child);
  }
  return changed ? normalizeNode({ ...node, children }) : node;
}

/**
 * Places a panel against an OUTER edge of the whole grid: a full-width row
 * underneath everything, or a full-height column beside it.
 *
 * The per-panel drop in {@link insertPanelBeside} can only ever divide the panel
 * it lands on, so an arrangement like "two side by side, one wide underneath
 * both" was unreachable by dragging — the new slot always ended up inside one of
 * the two. This is that missing shape: the split happens at the root.
 */
export function insertPanelAtRoot(node: GridNode | undefined, panelId: string, side: GridSide): GridNode | undefined {
  if (!node) {
    return undefined;
  }
  const axis = AXIS_OF[side];
  const before = side === "left" || side === "top";
  const leaf: GridLeaf = { type: "leaf", panelId, weight: 1 };
  if (node.type === "split" && node.dir === axis) {
    // The root already runs along this axis, so the panel joins it rather than
    // burying the whole existing grid one level deeper.
    const children = before ? [leaf, ...node.children] : [...node.children, leaf];
    return normalizeNode({ ...node, children });
  }
  return normalizeNode({
    type: "split",
    id: nextSplitId(),
    dir: axis,
    children: before ? [leaf, { ...node, weight: 1 }] : [{ ...node, weight: 1 }, leaf],
    weight: node.weight,
  });
}

/** Removes a panel's slot, collapsing any split left with a single child. */
export function removePanelFromGrid(node: GridNode | undefined, panelId: string): GridNode | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "leaf") {
    return node.panelId === panelId ? undefined : node;
  }
  const children = node.children
    .map((child) => removePanelFromGrid(child, panelId))
    .filter((child): child is GridNode => Boolean(child));
  return normalizeNode(collapse({ ...node, children }));
}

/**
 * Drags the divider between `children[index]` and `children[index + 1]` of one
 * split. Only that pair moves, so resizing one column never disturbs the rest
 * of the grid.
 */
export function resizeGridSplit(
  node: GridNode | undefined,
  splitId: string,
  index: number,
  deltaRatio: number,
): GridNode | undefined {
  if (!node || node.type === "leaf") {
    return node;
  }
  if (node.id === splitId) {
    const first = node.children[index];
    const second = node.children[index + 1];
    if (!first || !second) {
      return node;
    }
    const pair = first.weight + second.weight;
    const firstWeight = Math.min(pair - GRID_MIN_WEIGHT, Math.max(GRID_MIN_WEIGHT, first.weight + deltaRatio * pair));
    return {
      ...node,
      children: node.children.map((child, at) => {
        if (at === index) {
          return { ...child, weight: firstWeight };
        }
        return at === index + 1 ? { ...child, weight: pair - firstWeight } : child;
      }),
    };
  }
  return {
    ...node,
    children: node.children.map((child) => resizeGridSplit(child, splitId, index, deltaRatio) || child),
  };
}

function wrapLeaf(leaf: GridLeaf, panelId: string, axis: "row" | "column", before: boolean): GridSplit {
  const moved: GridLeaf = { ...leaf, weight: 1 };
  const inserted: GridLeaf = { type: "leaf", panelId, weight: 1 };
  return {
    type: "split",
    id: nextSplitId(),
    dir: axis,
    children: before ? [inserted, moved] : [moved, inserted],
    weight: leaf.weight,
  };
}

function keepKnownLeaves(node: GridNode, known: Set<string>, seen: Set<string>): GridNode | undefined {
  if (node.type === "leaf") {
    if (!known.has(node.panelId) || seen.has(node.panelId)) {
      return undefined;
    }
    seen.add(node.panelId);
    return node;
  }
  const children = node.children
    .map((child) => keepKnownLeaves(child, known, seen))
    .filter((child): child is GridNode => Boolean(child));
  return collapse({ ...node, children });
}

/** A split with one child IS that child; with none it is nothing. */
function collapse(node: GridSplit): GridNode | undefined {
  if (node.children.length === 0) {
    return undefined;
  }
  if (node.children.length === 1) {
    return { ...node.children[0], weight: node.weight };
  }
  return node;
}

function normalizeNode(node: GridNode | undefined): GridNode | undefined {
  if (!node || node.type === "leaf") {
    return node;
  }
  const children = node.children
    .map((child) => normalizeNode(child))
    .filter((child): child is GridNode => Boolean(child));
  const collapsed = collapse({ ...node, children });
  if (!collapsed || collapsed.type === "leaf") {
    return collapsed;
  }
  // Keep the average weight at 1 per level, the same convention the flat panel
  // weights use, so a nested split's numbers stay readable in stored layouts.
  const total = collapsed.children.reduce((sum, child) => sum + (child.weight > 0 ? child.weight : 1), 0);
  const scale = collapsed.children.length / (total || 1);
  return {
    ...collapsed,
    children: collapsed.children.map((child) => ({ ...child, weight: (child.weight > 0 ? child.weight : 1) * scale })),
  };
}

function collectWeights(node: GridNode, into: Map<string, number>): void {
  if (node.type === "leaf") {
    into.set(node.panelId, node.weight);
    return;
  }
  for (const child of node.children) {
    collectWeights(child, into);
  }
}
