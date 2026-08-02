import { useEffect, useSyncExternalStore } from "react";
import { DEFAULT_FAVORITE_MODELS, type FavoriteModels } from "../../shared/favoriteModels";

/**
 * A one-value publish/subscribe channel carrying the user's favourite models
 * from `App` (which owns settings state and its IPC updates) down to the model
 * catalog, which is opened from five different screens.
 *
 * Same shape and same reason as `app/composerPrefs.ts`: deliberately NOT a
 * second source of truth. Nothing writes the value here except
 * {@link usePublishFavoriteModels}, and a star click does not persist anything
 * itself — it calls back into App, so a change still flows
 * main → App → here and the catalog can never disagree with what is stored.
 *
 * Carrying it this way (rather than as props) keeps the catalog component's
 * public interface untouched, so every screen that opens the catalog gains
 * favourites without changing its call.
 */
let current: FavoriteModels = DEFAULT_FAVORITE_MODELS;
let writer: ((id: string) => Promise<void> | void) | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): FavoriteModels {
  return current;
}

/**
 * Publishes the favourites App holds, plus the callback that persists a toggle.
 * Call once, from the settings owner.
 */
export function usePublishFavoriteModels(favorites: FavoriteModels | undefined, toggle: (id: string) => Promise<void> | void): void {
  // The writer is refreshed without notifying: it is a fresh closure on every
  // App render, and waking every subscriber for that would be a render loop.
  writer = toggle;
  useEffect(() => {
    const next = favorites || DEFAULT_FAVORITE_MODELS;
    if (next === current) {
      return;
    }
    current = next;
    for (const listener of listeners) {
      listener();
    }
  }, [favorites]);
}

/** Subscribes a component to the published favourites. */
export function useFavoriteModels(): FavoriteModels {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Stars/unstars a model, persisting through App.
 *
 * Rejects rather than no-op'ing when nothing has registered a writer: that only
 * happens if the publisher was never mounted, and a star that silently fails to
 * save is exactly the kind of quiet loss the caller must be able to report.
 */
export async function toggleFavoriteModelId(id: string): Promise<void> {
  if (!writer) {
    throw new Error("favourite models: no writer registered (usePublishFavoriteModels was never mounted)");
  }
  await writer(id);
}

/** Test seam: resets the channel between jsdom cases. */
export function __resetFavoriteModelPrefs(): void {
  current = DEFAULT_FAVORITE_MODELS;
  writer = undefined;
  listeners.clear();
}
