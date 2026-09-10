/**
 * Favourite parties — a USER setting, exactly like `favoriteModels`.
 *
 * A favourite does NOT move the party. The party keeps the group it was filed
 * in, and is ALSO listed in a virtual "즐겨찾기" group pinned above the real
 * ones. Moving it would make un-favouriting a destructive act (the app would
 * have to invent a group to return it to), and would hide the party from the
 * folder the user themselves filed it in.
 *
 * Stored ids are never auto-pruned, for the same reason favourite models are
 * not: an id with no matching party may mean the party was deleted, or merely
 * that this window is looking at another workspace right now. The list is
 * resolved against the parties on screen when it is RENDERED, so an unresolved
 * id draws no row and comes back on its own when that workspace is opened.
 */
import { DEFAULT_PARTY_GROUP_ID, groupParties, type PartyGroup, type PartyGroupView, type PartySummary } from "./partyGroups";

/** Party ids the user has starred, in the order they were starred. */
export type FavoriteParties = string[];

/** Built-in default: nothing starred. */
export const DEFAULT_FAVORITE_PARTIES: FavoriteParties = [];

/**
 * The virtual group's id. It is not a stored {@link PartyGroup}: nothing can be
 * filed into it, renamed, reordered or deleted, and a party in it is a mirror of
 * a row that also exists in its own group.
 */
export const FAVORITE_PARTY_GROUP_ID = "favorites";

export const FAVORITE_PARTY_GROUP_NAME = "즐겨찾기";

/** Coerces an arbitrary stored/HTTP value into a valid list (unknown → empty). */
export function normalizeFavoriteParties(value: unknown): FavoriteParties {
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

/** Whether `partyId` is starred. */
export function isFavoriteParty(favorites: readonly string[], partyId: string): boolean {
  return favorites.includes(partyId);
}

/** Stars/unstars `partyId`, returning a new list (order of the rest is preserved). */
export function toggleFavoriteParty(favorites: readonly string[], partyId: string): FavoriteParties {
  return isFavoriteParty(favorites, partyId)
    ? favorites.filter((entry) => entry !== partyId)
    : [...favorites, partyId];
}

/** Whether a group id names the virtual favourites group rather than a stored one. */
export function isFavoriteGroupId(groupId: string): boolean {
  return groupId === FAVORITE_PARTY_GROUP_ID;
}

/**
 * The sidebar's group list: the favourites group first (only when something is
 * starred AND resolvable here), then every stored group unchanged.
 *
 * An empty favourites group is not rendered at all — a permanently empty folder
 * at the top of the list is a worse default than no folder, and the group
 * appears the moment the first party is starred.
 */
export function groupPartiesWithFavorites(
  groups: PartyGroup[],
  parties: PartySummary[],
  favorites: readonly string[],
): PartyGroupView[] {
  const grouped = groupParties(groups, parties);
  const starred = favorites
    .map((partyId) => parties.find((party) => party.id === partyId))
    .filter((party): party is PartySummary => Boolean(party));
  if (starred.length === 0) {
    return grouped;
  }
  const now = new Date().toISOString();
  const favoriteGroup: PartyGroup = {
    id: FAVORITE_PARTY_GROUP_ID,
    name: FAVORITE_PARTY_GROUP_NAME,
    // Not "default" and not "user": the two kinds the STORE knows. A third kind
    // would have to be handled by every store path that reads a group; the list
    // screen tells the two apart by id instead (see isFavoriteGroupId).
    kind: "user",
    createdAt: now,
    updatedAt: now,
  };
  return [{ group: favoriteGroup, parties: starred }, ...grouped];
}

/** The group a party filed nowhere belongs to — never the virtual one. */
export function storableGroupId(groupId: string | undefined): string {
  return !groupId || isFavoriteGroupId(groupId) ? DEFAULT_PARTY_GROUP_ID : groupId;
}
