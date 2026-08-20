export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** The resolved `data-theme` value. Visual themes are only light and dark. */
export type AppliedTheme = "light" | "dark";

/** Matches the current first-paint default (`THEMES[0]` is light). */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "light";

/**
 * Legacy renderer key: used to store the applied `light`/`dark` id.
 * Still read on upgrade; never written with a System-resolved applied id.
 */
export const THEME_STORAGE_KEY = "agentparty.theme";
/** Explicit preference (`system` | `light` | `dark`) cached for first paint. */
export const THEME_PREFERENCE_STORAGE_KEY = "agentparty.themePreference";

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function isAppliedTheme(value: unknown): value is AppliedTheme {
  return value === "light" || value === "dark";
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

/**
 * Preference → the `data-theme` the UI actually paints.
 * `osDark` is only consulted when the preference is `system`; omitted/false → light.
 */
export function resolveAppliedTheme(preference: ThemePreference, osDark?: boolean): AppliedTheme {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return osDark ? "dark" : "light";
}

/** Title-bar / shortcut order: system → light → dark → system. */
export function cycleThemePreference(current: ThemePreference): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(normalizeThemePreference(current));
  return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length];
}

/**
 * Upgrade path from renderer-only `localStorage`.
 *
 * The old ThemeProvider always wrote `light` on first paint, so a leftover
 * `light` is not evidence the user chose Light. Only a leftover `dark` is
 * migrated. If settings.json already has a `theme` value, that explicit
 * setting wins. Returns the preference to persist, or `null` when nothing
 * should be written.
 */
export function migrateLegacyThemeValue(storedTheme: unknown, legacyValue: unknown): ThemePreference | null {
  if (isThemePreference(storedTheme)) return null;
  return legacyValue === "dark" ? "dark" : null;
}

export interface AppearanceState {
  preference: ThemePreference;
  applied: AppliedTheme;
  options: readonly ThemePreference[];
  /** True when settings.json itself contains `theme`, not just the in-memory default. */
  stored: boolean;
}

/**
 * Desktop-only native chrome (Electron `nativeTheme`). Absent in a headless
 * engine, which has no window chrome to colour.
 */
export interface AppearanceHost {
  setSource(source: ThemePreference): void;
  isDark(): boolean;
  onUpdated(listener: () => void): () => void;
}
