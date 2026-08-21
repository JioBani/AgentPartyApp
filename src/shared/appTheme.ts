import {
  DEFAULT_THEME_PREFERENCE,
  THEME_BACKGROUNDS,
  THEME_METADATA,
  THEME_PREFERENCES,
  isRegisteredThemeId,
  requireRegisteredThemeId,
  type ThemePreference,
} from "./themeCatalog";

export { DEFAULT_THEME_PREFERENCE, THEME_BACKGROUNDS, THEME_METADATA, THEME_PREFERENCES } from "./themeCatalog";
export type { ThemePreference } from "./themeCatalog";
export type AppliedTheme = ThemePreference;

export const THEME_STORAGE_KEY = "agentparty.theme";
export const THEME_PREFERENCE_STORAGE_KEY = "agentparty.themePreference";
export const THEME_SYNC_PAINT_ATTRIBUTE = "data-theme-paint";
export const THEME_SYNC_PAINT_VALUE = "sync";

const LEGACY_LIGHT_THEME = requireRegisteredThemeId("agentparty-light", "theme migration.light");
const LEGACY_DARK_THEME = requireRegisteredThemeId("agentparty-dark", "theme migration.dark");

export interface AppearanceBoot {
  preference: ThemePreference;
  applied: AppliedTheme;
  stored: boolean;
}

const BOOT_PREF_FLAG = "--ap-pref=";
const BOOT_APPLIED_FLAG = "--ap-applied=";
const BOOT_STORED_FLAG = "--ap-stored=";

export function appearanceBootArgs(boot: AppearanceBoot): string[] {
  return [
    `${BOOT_PREF_FLAG}${boot.preference}`,
    `${BOOT_APPLIED_FLAG}${boot.applied}`,
    `${BOOT_STORED_FLAG}${boot.stored ? "1" : "0"}`,
  ];
}

export function parseAppearanceBootArgs(argv: readonly string[]): AppearanceBoot | null {
  const pref = argv.find((arg) => arg.startsWith(BOOT_PREF_FLAG))?.slice(BOOT_PREF_FLAG.length);
  const applied = argv.find((arg) => arg.startsWith(BOOT_APPLIED_FLAG))?.slice(BOOT_APPLIED_FLAG.length);
  const stored = argv.find((arg) => arg.startsWith(BOOT_STORED_FLAG))?.slice(BOOT_STORED_FLAG.length);
  if (!isThemePreference(pref) || !isThemePreference(applied) || pref !== applied || (stored !== "0" && stored !== "1")) {
    return null;
  }
  return { preference: pref, applied, stored: stored === "1" };
}

/** Settings boot is authoritative; renderer storage is only an upgrade source. */
export function firstPaintFrom(boot: AppearanceBoot | null, cachedTheme: unknown): { preference: ThemePreference; applied: AppliedTheme } {
  if (boot?.stored) return { preference: boot.preference, applied: boot.applied };
  const migrated = migrateLegacyThemeId(cachedTheme);
  if (migrated) return { preference: migrated, applied: migrated };
  if (boot) return { preference: boot.preference, applied: boot.applied };
  return { preference: DEFAULT_THEME_PREFERENCE, applied: DEFAULT_THEME_PREFERENCE };
}

export function retainAppearanceOnInitialState<T extends { theme?: unknown }>(current: T, incoming: T, committedTheme?: unknown): T {
  if (!isThemePreference(committedTheme)) return incoming;
  return { ...incoming, theme: committedTheme };
}

export const APPEARANCE_DESKTOP_ONLY_ERROR =
  "모양 설정은 데스크톱 앱이 소유합니다. 이 엔진은 호스트 채널 없이 테마를 변경할 수 없습니다.";

export class AppearanceOwnerError extends Error {
  readonly code = "appearance_desktop_only" as const;
  readonly status = 403;
  constructor() {
    super(APPEARANCE_DESKTOP_ONLY_ERROR);
    this.name = "AppearanceOwnerError";
  }
}

export class InvalidThemeError extends Error {
  readonly code = "invalid_theme" as const;
  readonly status = 400;
  constructor(value: unknown) {
    super(`지원하지 않는 테마입니다: ${String(value ?? "")}`);
    this.name = "InvalidThemeError";
  }
}

export type AppearanceAccess = "local" | "remote" | "unavailable";

/** Marker injected only by the desktop process; headless engines use `appearanceRemote`. */
export interface AppearanceHost { readonly desktop: true }

export interface AppearanceState {
  preference: ThemePreference;
  applied: AppliedTheme;
  options: readonly ThemePreference[];
  stored: boolean;
  background: string;
}

export interface AppearanceRemote {
  getAppearance(): Promise<AppearanceState>;
  setTheme(theme: unknown): Promise<AppearanceState>;
}

export function appearanceAccess(input: { appearance?: unknown; appearanceRemote?: unknown }): AppearanceAccess {
  if (input.appearanceRemote) return "remote";
  if (input.appearance) return "local";
  return "unavailable";
}

export function appearanceOwnerError(): AppearanceOwnerError { return new AppearanceOwnerError(); }

export function isThemePreference(value: unknown): value is ThemePreference {
  return isRegisteredThemeId(value);
}

/** Converts persisted values from the original System/Light/Dark themes safely. */
export function migrateLegacyThemeId(value: unknown): ThemePreference | null {
  if (isThemePreference(value)) return value;
  if (value === "dark") return LEGACY_DARK_THEME;
  if (value === "light" || value === "system") return LEGACY_LIGHT_THEME;
  return null;
}

/**
 * Resolves the two renderer cache keys. A current preset preference wins; when
 * it is a removed `system` value, the old applied-theme key preserves whether
 * that OS-following choice last painted light or dark.
 */
export function themeFromRendererStorage(themePreference: unknown, appliedTheme: unknown): ThemePreference | null {
  if (isThemePreference(themePreference)) return themePreference;
  const migratedApplied = migrateLegacyThemeId(appliedTheme);
  if (migratedApplied) return migratedApplied;
  return migrateLegacyThemeId(themePreference);
}

export function normalizeThemePreference(value: unknown): ThemePreference {
  return migrateLegacyThemeId(value) ?? DEFAULT_THEME_PREFERENCE;
}

export function requireThemePreference(value: unknown): ThemePreference {
  if (!isThemePreference(value)) throw new InvalidThemeError(value);
  return value;
}

export function resolveAppliedTheme(preference: ThemePreference): AppliedTheme { return preference; }
export function windowBackgroundFor(preference: ThemePreference): string { return THEME_BACKGROUNDS[preference]; }

export function appearanceStateOf(preference: ThemePreference, stored: boolean): AppearanceState {
  return { preference, applied: preference, options: THEME_PREFERENCES, stored, background: THEME_BACKGROUNDS[preference] };
}

/** Existing settings win; otherwise migrate either legacy renderer cache key. */
export function migrateLegacyThemeValue(storedTheme: unknown, legacyValue: unknown): ThemePreference | null {
  if (storedTheme !== undefined && storedTheme !== null) return null;
  return migrateLegacyThemeId(legacyValue);
}
