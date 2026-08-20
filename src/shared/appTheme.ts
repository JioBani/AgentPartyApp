export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** Matches the current first-paint default (`THEMES[0]` is light). */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "light";

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** Heals a missing or stale value read from settings.json. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE;
}

/** Validates an explicit user/API choice instead of silently changing it. */
export function requireThemePreference(value: unknown): ThemePreference {
  if (!isThemePreference(value)) {
    throw new Error(`지원하지 않는 테마입니다: ${String(value ?? "")}`);
  }
  return value;
}
