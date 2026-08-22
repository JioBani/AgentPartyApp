/**
 * How the model catalog's left column is assembled: search filter, favourites
 * section, then provider groups.
 *
 * Pure — no React, no DOM — so the ordering rules below are unit-testable.
 *
 * ## The order is load-bearing
 *
 *   filter → split favourites → group by provider
 *
 * Grouping first and filtering after would leave a starred model inside its
 * provider group, so a search could hide a favourite behind a collapsed header.
 * Filtering first keeps the favourites section a view of the CURRENT matches.
 */
import { PROVIDER_LABELS, routeProvider, type ProviderId } from "./modelCatalog";
import type { RouteEntry } from "./modelMeters";
import { routeKey } from "./routes";

/** Provider order in the list; unlisted providers fall into `custom`. */
const PROVIDER_ORDER: ProviderId[] = ["anthropic", "openai", "cursor", "openrouter", "deepseek", "xai", "custom"];

export interface CatalogGroup {
  /** Stable key: the provider id, or `favorites` for the pinned section. */
  id: string;
  kind: "favorites" | "provider";
  /** Set for `kind: "provider"` — drives the dot colour. */
  provider?: ProviderId;
  label: string;
  entries: RouteEntry[];
  /** Whether the rows render. Favourites are always open. */
  open: boolean;
  /** Favourites cannot be collapsed; provider groups can. */
  collapsible: boolean;
  /** Whether the selected row is inside this group (badges a collapsed header). */
  hasSelected: boolean;
}

export interface CatalogView {
  groups: CatalogGroup[];
  /** Models in scope before filtering. */
  total: number;
  /** Models matching the query (equals `total` when not searching). */
  matched: number;
  /** Favourites actually shown — never counts an id the catalog cannot resolve. */
  favoriteCount: number;
  searching: boolean;
}

export interface CatalogViewInput {
  entries: RouteEntry[];
  /** Raw search box text; whitespace-only counts as no search. */
  query: string;
  /** Starred catalog model ids (stored order is irrelevant — see below). */
  favorites: readonly string[];
  /** Per-provider expanded flags; absent means collapsed. */
  provOpen: Record<string, boolean>;
  selectedKey: string;
}

/**
 * The axes a query is matched against: the model's display name and its
 * provider, named both the way the product labels it ("Claude") and by its
 * catalog id ("anthropic"), so either spelling finds it.
 *
 * The catalog has no capability-tier field today, so there is no tier axis. If
 * one is ever added it joins this list and both search and the row subtitle pick
 * it up — nothing else needs to change.
 */
function searchAxes(entry: RouteEntry): string[] {
  const provider = entry.meta.provider;
  return [entry.route.label || entry.meta.name, entry.meta.name, PROVIDER_LABELS[provider], provider];
}

function matches(entry: RouteEntry, needle: string): boolean {
  return searchAxes(entry).some((axis) => (axis || "").toLowerCase().includes(needle));
}

/**
 * Builds the rendered group list.
 *
 * Favourites keep **catalog order**, not the order they were starred, so
 * starring a model never reshuffles the rows around it.
 *
 * While a query is active every provider group renders expanded, but the user's
 * own collapse flags (`provOpen`) are read, never written — clearing the search
 * restores exactly the shape they left behind.
 */
export function buildCatalogView({ entries, query, favorites, provOpen, selectedKey }: CatalogViewInput): CatalogView {
  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;

  // 1. filter
  const visible = searching ? entries.filter((entry) => matches(entry, needle)) : entries;

  // 2. lift favourites to the top — WITHOUT removing them from their provider
  // group. A starred model is shown twice on purpose: the pinned section is a
  // shortcut, not a new home, so the provider list stays a complete inventory
  // of what that provider offers and a model does not appear to vanish from it
  // the moment it is starred.
  const starred = new Set(favorites);
  const isFavorite = (entry: RouteEntry) => starred.has(entry.route.model);
  const favoriteEntries = visible.filter(isFavorite);
  const rest = visible;

  const groups: CatalogGroup[] = [];
  const holdsSelection = (list: RouteEntry[]) => list.some((entry) => routeKey(entry.route) === selectedKey);

  if (favoriteEntries.length > 0) {
    groups.push({
      id: "favorites",
      kind: "favorites",
      label: "즐겨찾기",
      entries: favoriteEntries,
      open: true,
      collapsible: false,
      hasSelected: holdsSelection(favoriteEntries),
    });
  }

  // 3. group the remainder by provider, dropping providers with no match
  const buckets = new Map<ProviderId, RouteEntry[]>();
  for (const entry of rest) {
    const provider = routeProvider(entry.route);
    const bucket = buckets.get(provider);
    if (bucket) {
      bucket.push(entry);
    } else {
      buckets.set(provider, [entry]);
    }
  }

  for (const provider of PROVIDER_ORDER) {
    const bucket = buckets.get(provider);
    if (!bucket || bucket.length === 0) {
      continue;
    }
    groups.push({
      id: provider,
      kind: "provider",
      provider,
      label: PROVIDER_LABELS[provider],
      entries: bucket,
      open: searching ? true : Boolean(provOpen[provider]),
      collapsible: true,
      hasSelected: holdsSelection(bucket),
    });
  }

  return {
    groups,
    total: entries.length,
    matched: visible.length,
    favoriteCount: favoriteEntries.length,
    searching,
  };
}

/**
 * Which provider group to expand when the catalog opens: the one holding the
 * current model. A starred current model is already pinned at the top, so
 * nothing expands — matching the confirmed design.
 */
export function initialProvOpen(entries: RouteEntry[], selectedKey: string, favorites: readonly string[]): Record<string, boolean> {
  const selected = entries.find((entry) => routeKey(entry.route) === selectedKey);
  if (!selected || favorites.includes(selected.route.model)) {
    return {};
  }
  return { [routeProvider(selected.route)]: true };
}

/** Header count: `6 available · ★ 2` while browsing, `1 / 6 일치` while searching. */
export function catalogCountLabel(view: CatalogView): string {
  if (view.searching) {
    return `${view.matched} / ${view.total} 일치`;
  }
  return view.favoriteCount > 0 ? `${view.total} available · ★ ${view.favoriteCount}` : `${view.total} available`;
}
