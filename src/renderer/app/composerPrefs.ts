import { useEffect, useSyncExternalStore } from "react";
import { DEFAULT_COMPOSER_SETTINGS, type ComposerSettings } from "../../shared/composerSettings";

/**
 * A one-value publish/subscribe channel carrying the global composer settings
 * from `App` (which owns the settings state and its IPC updates) down to the
 * `Composer`, which sits behind Workbench → Panel and needs nothing else from
 * those layers.
 *
 * Deliberately NOT a second source of truth: nothing writes here except
 * {@link usePublishComposerPrefs}, and nothing fetches settings on its own — a
 * change still flows main → App → here, so the input can never disagree with
 * Settings → Runtime. It exists only so the preference does not have to be
 * threaded as a prop through two layers that have no use for it.
 */
let current: ComposerSettings = { ...DEFAULT_COMPOSER_SETTINGS };
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ComposerSettings {
  return current;
}

/** Publishes the settings App holds. Call once, from the settings owner. */
export function usePublishComposerPrefs(settings: ComposerSettings | undefined): void {
  useEffect(() => {
    const next = settings || DEFAULT_COMPOSER_SETTINGS;
    if (next === current) {
      return;
    }
    current = next;
    for (const listener of listeners) {
      listener();
    }
  }, [settings]);
}

/** Subscribes a component to the published composer settings. */
export function useComposerPrefs(): ComposerSettings {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
