export const THEME_PREFERENCES = [
  "agentparty-light",
  "agentparty-dark",
  "github-light",
  "github-dark",
  "dracula",
  "nord",
  "solarized-dark",
] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type AppliedTheme = ThemePreference;

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "agentparty-light";
export const THEME_STORAGE_KEY = "agentparty.theme";
export const THEME_PREFERENCE_STORAGE_KEY = "agentparty.themePreference";
export const THEME_SYNC_PAINT_ATTRIBUTE = "data-theme-paint";
export const THEME_SYNC_PAINT_VALUE = "sync";

export interface ThemeMetadata {
  id: ThemePreference;
  label: string;
  scheme: "light" | "dark";
  background: string;
}

/** Shared preset metadata used by BrowserWindow chrome and renderer themes. */
export const THEME_METADATA: readonly ThemeMetadata[] = [
  { id: "agentparty-light", label: "AgentParty Light", scheme: "light", background: "#e7e8eb" },
  { id: "agentparty-dark", label: "AgentParty Dark", scheme: "dark", background: "#0a0b0e" },
  { id: "github-light", label: "GitHub Light", scheme: "light", background: "#f6f8fa" },
  { id: "github-dark", label: "GitHub Dark", scheme: "dark", background: "#0d1117" },
  { id: "dracula", label: "Dracula", scheme: "dark", background: "#282a36" },
  { id: "nord", label: "Nord", scheme: "dark", background: "#2e3440" },
  { id: "solarized-dark", label: "Solarized Dark", scheme: "dark", background: "#002b36" },
];

export const THEME_BACKGROUNDS = Object.fromEntries(
  THEME_METADATA.map(({ id, background }) => [id, background]),
) as Record<ThemePreference, string>;

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
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** Converts persisted values from the original System/Light/Dark themes safely. */
export function migrateLegacyThemeId(value: unknown): ThemePreference | null {
  if (isThemePreference(value)) return value;
  if (value === "dark") return "agentparty-dark";
  if (value === "light" || value === "system") return "agentparty-light";
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
