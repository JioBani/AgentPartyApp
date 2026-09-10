/**
 * Which sidebar groups are folded shut, remembered across launches.
 *
 * Stored as what is CLOSED, never as what is open. A group the user has never
 * touched — one created after this setting was written, or by another window —
 * must appear OPEN, and only "closed wins" gives that: an unknown id is simply
 * absent from the list. Storing the open ids would hide every new group behind a
 * fold nobody chose.
 *
 * It lives in settings rather than renderer-local storage for the same reason
 * `sidebarDrawers` does: an agent can fold a group over the automation API
 * exactly as the user does, and the state is observable in `GET /api/state`.
 */

export interface SidebarGroupFolds {
  /** Closed party groups, by group id (the virtual 즐겨찾기 group included). */
  party: string[];
  /** Closed member groups in the member tree, by that tree's group key. */
  member: string[];
}

export const DEFAULT_SIDEBAR_GROUP_FOLDS: SidebarGroupFolds = { party: [], member: [] };

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      seen.add(item.trim());
    }
  }
  return [...seen];
}

/** Coerces an arbitrary stored/HTTP value into a valid fold set. */
export function normalizeSidebarGroupFolds(value: unknown): SidebarGroupFolds {
  const raw = (value || {}) as Partial<SidebarGroupFolds>;
  return { party: normalizeIds(raw.party), member: normalizeIds(raw.member) };
}

/** Folds or unfolds one group, returning a new set. */
export function toggleSidebarGroupFold(
  folds: SidebarGroupFolds,
  which: keyof SidebarGroupFolds,
  groupId: string,
  closed: boolean,
): SidebarGroupFolds {
  const current = folds[which];
  const next = closed
    ? (current.includes(groupId) ? current : [...current, groupId])
    : current.filter((id) => id !== groupId);
  return { ...folds, [which]: next };
}
