/**
 * Orders transcript restoration by what the user can currently see.
 *
 * Returning one deterministic queue is deliberately separate from React and
 * IPC. App consumes only the first unresolved entry per event-loop yield, which
 * prevents several large transcript responses from being batched into one
 * multi-panel render. Members not present in `visibleNames` keep their persisted
 * order and preload after the foreground panels.
 */
export function transcriptRestoreOrder<T extends { name: string }>(
  members: T[],
  visibleNames: string[],
): T[] {
  const byName = new Map(members.map((member) => [member.name, member]));
  const visible = new Set<string>();
  const foreground: T[] = [];
  for (const name of visibleNames) {
    const member = byName.get(name);
    if (member && !visible.has(name)) {
      visible.add(name);
      foreground.push(member);
    }
  }
  const background = members.filter((member) => !visible.has(member.name));
  return [...foreground, ...background];
}

/** Returns one restore only when no earlier restore is still in flight. */
export function nextTranscriptRestore<T extends { name: string }>(
  members: T[],
  visibleNames: string[],
  isSettled: (member: T) => boolean,
  isRequested: (member: T) => boolean,
): T | undefined {
  const ordered = transcriptRestoreOrder(members, visibleNames);
  if (ordered.some((member) => !isSettled(member) && isRequested(member))) {
    return undefined;
  }
  return ordered.find((member) => !isSettled(member));
}

/** A cached transcript stays readable while an explicit disk refresh is pending. */
export function isTranscriptRestoreSettled(
  hasRestoredTranscript: boolean,
  needsRefresh: boolean,
): boolean {
  return hasRestoredTranscript && !needsRefresh;
}

/** Chooses exactly one panel whose already-loaded transcript may mount next. */
export function nextTranscriptReveal(
  visibleNames: string[],
  revealedNames: ReadonlySet<string>,
  availableNames: ReadonlySet<string>,
): string | undefined {
  return visibleNames.find((name) => !revealedNames.has(name) && availableNames.has(name));
}
