import { useEffect, useSyncExternalStore } from "react";
import type { RouteLike } from "../workbench/routes";

/**
 * A one-value publish/subscribe channel carrying the model routes from `App`
 * down to the composer, which needs them for `!` model completion and gets
 * nothing else from the layers in between.
 *
 * Same shape and same reason as `app/partyMemberPrefs.ts`: not a second source
 * of truth — nothing writes here except {@link usePublishModelRoutes}, and the
 * composer never fetches routes on its own. That guarantees completion can
 * only ever complete a model the app actually has a route for; there is no
 * second catalog to drift.
 */
const EMPTY: RouteLike[] = [];
let current: RouteLike[] = EMPTY;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): RouteLike[] {
  return current;
}

/** Publishes the routes App holds. Call once, from the app-state owner. */
export function usePublishModelRoutes(routes: RouteLike[]): void {
  useEffect(() => {
    // Routes arrive as a whole new array on every app-state update, so identity
    // is useless as a change test and would notify on every keystroke elsewhere.
    if (routes === current) {
      return;
    }
    const changed =
      routes.length !== current.length ||
      routes.some((route, index) => {
        const previous = current[index];
        return !previous || previous.model !== route.model || previous.harnessId !== route.harnessId || previous.enabled !== route.enabled;
      });
    if (!changed) {
      return;
    }
    current = routes;
    for (const listener of listeners) {
      listener();
    }
  }, [routes]);
}

/** Subscribes a component to the published model routes. */
export function useModelRoutes(): RouteLike[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test seam: resets the channel between cases. */
export function __resetModelRoutes(): void {
  current = EMPTY;
  listeners.clear();
}
