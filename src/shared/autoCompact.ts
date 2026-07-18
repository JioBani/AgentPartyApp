/**
 * Per-member auto-compaction: when a member's live context occupancy crosses a
 * threshold (expressed as a % of the model's context window), its session is
 * automatically compacted. Manual and automatic compaction coexist — this only
 * governs the *automatic* trigger.
 *
 * Single source of truth for the setting shape, bounds, inheritance (a member
 * without its own setting falls back to the global default), the token estimate
 * shown in the editor, and the crossing test the renderer fires on. Pure logic —
 * no I/O — so it is shared by main (persistence) and renderer (UI + trigger) and
 * unit-tested in isolation.
 */

export interface AutoCompactSetting {
  /** When true, the session auto-compacts once context crosses `at`% of the window. */
  on: boolean;
  /** Threshold as a percentage of the model's context window (AUTO_COMPACT_MIN..MAX). */
  at: number;
}

// Settable range. The threshold is shown on a full 0–100% gauge, but a value
// BELOW 10% or ABOVE 95% can't be SET (too eager / too late to be useful), so the
// slider + number input clamp to [10, 95] (10% 미만 · 95% 초과는 설정 불가).
export const AUTO_COMPACT_MIN = 10;
export const AUTO_COMPACT_MAX = 95;
export const AUTO_COMPACT_STEP = 1;
/** The blocked boundaries, surfaced in the editor hint ("10% 미만 · 95% 초과 불가"). */
export const AUTO_COMPACT_FLOOR = 10;
export const AUTO_COMPACT_CEIL = 95;
/** The visual gauge spans the full window occupancy, independent of the settable band. */
export const AUTO_COMPACT_GAUGE_MIN = 0;
export const AUTO_COMPACT_GAUGE_MAX = 100;

/**
 * Built-in global default when the user has never set one. OFF on purpose: a
 * fresh install must never silently compact a member's context behind the user's
 * back — they opt in per-member or flip the global default in Settings → Runtime.
 */
export const DEFAULT_AUTO_COMPACT: AutoCompactSetting = { on: false, at: 80 };

/** Snaps to the step grid and clamps to [MIN, MAX]; defaults on garbage input. */
export function clampAutoCompactAt(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return DEFAULT_AUTO_COMPACT.at;
  }
  const snapped = Math.round(raw / AUTO_COMPACT_STEP) * AUTO_COMPACT_STEP;
  return Math.min(AUTO_COMPACT_MAX, Math.max(AUTO_COMPACT_MIN, snapped));
}

/** Coerces an arbitrary stored/HTTP value into a valid setting, or undefined. */
export function normalizeAutoCompact(value: unknown): AutoCompactSetting | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const v = value as Partial<AutoCompactSetting>;
  if (typeof v.on !== "boolean" && v.at === undefined) {
    return undefined;
  }
  return { on: Boolean(v.on), at: clampAutoCompactAt(v.at) };
}

/**
 * The effective setting for a member: its own explicit setting, else the global
 * default, else the built-in default. A member without an explicit setting
 * INHERITS the global default live (so flipping the default moves every
 * unconfigured member) — the README's `compactDefault` fallback.
 */
export function resolveAutoCompact(
  memberSetting: AutoCompactSetting | undefined,
  globalDefault: AutoCompactSetting | undefined,
): AutoCompactSetting {
  return memberSetting || globalDefault || DEFAULT_AUTO_COMPACT;
}

/** Estimated token footprint at the threshold, given a known context window. */
export function thresholdTokens(at: number, contextWindow: number | undefined): number | undefined {
  if (!contextWindow || contextWindow <= 0) {
    return undefined;
  }
  return Math.round((contextWindow * at) / 100);
}

/**
 * Whether occupancy has crossed the threshold and auto-compaction should fire.
 * Requires the setting ON and a known ratio (`used`/`total`); an unknown window
 * never triggers (we don't guess against a fabricated window).
 */
export function shouldAutoCompact(
  setting: AutoCompactSetting,
  used: number | undefined,
  total: number | undefined,
): boolean {
  if (!setting.on || !used || !total || total <= 0) {
    return false;
  }
  return used / total >= setting.at / 100;
}
