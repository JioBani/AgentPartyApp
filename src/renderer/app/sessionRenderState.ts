import type { ClaudeSessionSnapshot } from "../../core/events";
import type { SessionView } from "../../shared/types";

const fingerprints = new WeakMap<object, string>();

/**
 * `lastEventAt` advances for every streamed token, but no renderer surface reads
 * it. Treating that timestamp as UI state made each token rebuild the whole app
 * even though transcript deltas are already delivered on their own channel.
 * Every other snapshot field stays in the comparison so a future UI field is
 * not accidentally hidden by this optimization.
 */
export function sessionSnapshotRenderFingerprint(snapshot: ClaudeSessionSnapshot): string {
  const cached = fingerprints.get(snapshot);
  if (cached !== undefined) {
    return cached;
  }
  const { lastEventAt: _volatileActivityClock, ...renderState } = snapshot;
  const fingerprint = JSON.stringify(renderState);
  fingerprints.set(snapshot, fingerprint);
  return fingerprint;
}

export function sameSessionForRenderer(previous: SessionView, next: SessionView): boolean {
  return previous.id === next.id
    && previous.title === next.title
    && previous.workspace === next.workspace
    && sessionSnapshotRenderFingerprint(previous.snapshot) === sessionSnapshotRenderFingerprint(next.snapshot);
}

/** Reuses the current array and session objects when a list push changes no UI fact. */
export function mergeRendererSessions(current: SessionView[], incoming: SessionView[]): SessionView[] {
  if (current.length !== incoming.length) {
    return incoming;
  }
  const currentById = new Map(current.map((session) => [session.id, session]));
  const merged = incoming.map((session) => {
    const previous = currentById.get(session.id);
    return previous && sameSessionForRenderer(previous, session) ? previous : session;
  });
  return merged.every((session, index) => session === current[index]) ? current : merged;
}

/** Applies one snapshot push only when it changes a renderer-visible fact. */
export function updateRendererSessionSnapshot(current: SessionView[], sessionId: string, snapshot: ClaudeSessionSnapshot): SessionView[] {
  const index = current.findIndex((session) => session.id === sessionId);
  if (index < 0) {
    return current;
  }
  const candidate = { ...current[index], snapshot };
  if (sameSessionForRenderer(current[index], candidate)) {
    return current;
  }
  const next = current.slice();
  next[index] = candidate;
  return next;
}
