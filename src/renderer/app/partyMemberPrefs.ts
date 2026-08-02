import { useEffect, useSyncExternalStore } from "react";
import type { MentionCandidate } from "../workbench/mentionModel";

/**
 * A one-value publish/subscribe channel carrying the CURRENT party's members
 * from `App` down to the composer, which needs them for `@` completion and gets
 * nothing else from the layers in between.
 *
 * Same shape and same reason as `app/composerPrefs.ts` and
 * `app/favoriteModelPrefs.ts`: not a second source of truth — nothing writes
 * here except {@link usePublishPartyMembers}, and the composer never fetches
 * members on its own. That is what guarantees `@` can only ever complete a
 * member the party actually has; there is no second list to drift.
 */
const EMPTY: MentionCandidate[] = [];
let current: MentionCandidate[] = EMPTY;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): MentionCandidate[] {
  return current;
}

/** Publishes the members App holds. Call once, from the party-state owner. */
export function usePublishPartyMembers(members: MentionCandidate[]): void {
  useEffect(() => {
    const changed =
      members.length !== current.length ||
      members.some((member, index) => {
        const previous = current[index];
        return !previous || previous.name !== member.name || previous.color !== member.color || previous.status !== member.status;
      });
    if (!changed) {
      return;
    }
    current = members;
    for (const listener of listeners) {
      listener();
    }
  }, [members]);
}

/** Subscribes a component to the published party members. */
export function usePartyMembers(): MentionCandidate[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test seam: resets the channel between cases. */
export function __resetPartyMembers(): void {
  current = EMPTY;
  listeners.clear();
}
