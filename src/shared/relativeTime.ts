/**
 * "방금 · 오늘 · 어제 · 3일 전" — the coarse recency wording the cwd lists use.
 *
 * `now` is a parameter rather than a `Date.now()` call so the same input always
 * renders the same string. The design preview page screenshots these rows; a
 * clock read inside the function would make every capture differ from the last
 * one and turn a real visual regression into noise.
 */
export function relativeDay(at: string | number | undefined, now: number): string {
  if (at === undefined) {
    return "";
  }
  const stamp = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(stamp)) {
    return "";
  }
  const minutes = Math.floor((now - stamp) / 60_000);
  if (minutes < 5) {
    return "방금";
  }
  const days = Math.floor((startOfDay(now) - startOfDay(stamp)) / 86_400_000);
  if (days <= 0) {
    return "오늘";
  }
  if (days === 1) {
    return "어제";
  }
  if (days < 7) {
    return `${days}일 전`;
  }
  if (days < 28) {
    return `${Math.floor(days / 7)}주 전`;
  }
  return `${Math.floor(days / 30)}개월 전`;
}

function startOfDay(stamp: number): number {
  const date = new Date(stamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
