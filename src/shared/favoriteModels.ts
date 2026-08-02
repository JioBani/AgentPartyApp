/**
 * Favourite models — a USER setting, deliberately not part of the model catalog.
 *
 * `src/shared/modelCatalog.json` is a regenerated file: anything stored inside it
 * is lost the next time it is refreshed. Favourites are a user's own choice, so
 * they live in settings and are keyed by the catalog model **id** (a label can be
 * reworded without the favourite following it).
 *
 * ## Stored favourites are never auto-pruned
 *
 * An id in this list with no matching catalog model means one of two things, and
 * the stored value alone CANNOT tell them apart:
 *
 * 1. the model is permanently gone, or
 * 2. it is merely absent right now — a credential was removed, or a remotely
 *    fetched provider list (OpenRouter) failed to load.
 *
 * Dropping unknown ids on load would, in case 2, destroy the user's favourites
 * for good — and silently, since they never saw it happen and cannot undo it.
 * So nothing here prunes. Callers resolve the list against the live catalog when
 * they RENDER it ({@link resolveFavoriteModels}), which means an unknown id
 * simply draws no row (never a ghost) and comes back on its own once the model
 * is selectable again.
 *
 * Tidying the list is therefore an explicit user action, never a side effect of
 * opening a screen. The stored ids stay observable over the automation API
 * (`GET /api/state` → `settings.favoriteModels`), so "stored but unresolvable"
 * is diagnosable rather than invisible.
 */

/** Catalog model ids the user has starred, in the order they were stored. */
export type FavoriteModels = string[];

/** Built-in default: nothing starred. */
export const DEFAULT_FAVORITE_MODELS: FavoriteModels = [];

/** Coerces an arbitrary stored/HTTP value into a valid list (unknown → empty). */
export function normalizeFavoriteModels(value: unknown): FavoriteModels {
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

/** Whether `id` is starred. */
export function isFavoriteModel(favorites: readonly string[], id: string): boolean {
  return favorites.includes(id);
}

/** Adds or removes `id`, returning a new list (order of the rest is preserved). */
export function toggleFavoriteModel(favorites: readonly string[], id: string): FavoriteModels {
  return isFavoriteModel(favorites, id) ? favorites.filter((entry) => entry !== id) : [...favorites, id];
}

/**
 * Splits stored favourites against the ids the catalog can currently offer.
 *
 * `resolved` is what may be rendered; `unresolved` is kept in storage untouched
 * (see the note above) and is what makes a stored-vs-shown gap explainable.
 */
export function resolveFavoriteModels(
  favorites: readonly string[],
  availableIds: Iterable<string>,
): { resolved: string[]; unresolved: string[] } {
  const available = new Set(availableIds);
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const id of favorites) {
    (available.has(id) ? resolved : unresolved).push(id);
  }
  return { resolved, unresolved };
}
