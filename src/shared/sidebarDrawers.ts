/**
 * The sidebar's two drawers — the party list and the member list — as settings.
 *
 * In settings rather than the renderer's `localStorage` so the SAME
 * `AppController.updateSettings` serves the user's click and an agent's
 * `POST /api/settings`, which is what makes collapsing a drawer something a QA
 * agent can actually drive (see `docs/API.md`).
 *
 * Per drawer, not one shared number: the party list wants room for a group name
 * plus a count, the member list wants room for a name plus a status, and one
 * width forces the wider need on both.
 */

export type SidebarDrawerId = "party" | "member";

export interface SidebarDrawerState {
  /** Expanded. Collapsed leaves a rail that opens it again in one click. */
  open: boolean;
  /** Width in px while expanded. */
  width: number;
}

export type SidebarDrawerSettings = Record<SidebarDrawerId, SidebarDrawerState>;

export const SIDEBAR_DRAWER_IDS: SidebarDrawerId[] = ["party", "member"];
export const SIDEBAR_DRAWER_MIN_WIDTH = 150;
export const SIDEBAR_DRAWER_MAX_WIDTH = 460;

export const DEFAULT_SIDEBAR_DRAWERS: SidebarDrawerSettings = {
  party: { open: true, width: 256 },
  member: { open: true, width: 256 },
};

/**
 * Fills in a stored value, clamping widths into the range the drag allows.
 *
 * A width outside the range is CLAMPED, not rejected: it is still the user's
 * intent, and dropping it back to the default would silently undo a resize.
 */
export function normalizeSidebarDrawers(value: unknown): SidebarDrawerSettings {
  const source = (value || {}) as Partial<Record<SidebarDrawerId, Partial<SidebarDrawerState>>>;
  const result = {} as SidebarDrawerSettings;
  for (const id of SIDEBAR_DRAWER_IDS) {
    const stored = source[id] || {};
    const width = Number(stored.width);
    result[id] = {
      open: typeof stored.open === "boolean" ? stored.open : DEFAULT_SIDEBAR_DRAWERS[id].open,
      width: Number.isFinite(width)
        ? Math.min(SIDEBAR_DRAWER_MAX_WIDTH, Math.max(SIDEBAR_DRAWER_MIN_WIDTH, Math.round(width)))
        : DEFAULT_SIDEBAR_DRAWERS[id].width,
    };
  }
  return result;
}
