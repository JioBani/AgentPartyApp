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
/** Set on `<html>` by the synchronous first-paint path, before React mounts. */
export const THEME_SYNC_PAINT_ATTRIBUTE = "data-theme-paint";
export const THEME_SYNC_PAINT_VALUE = "sync";

/**
 * The `bg-0` token for light and dark. `themes.ts` paints CSS from this;
 * `windowBackgroundFor` paints BrowserWindow chrome from the same values.
 */
export const APPLIED_THEME_BACKGROUNDS: Record<AppliedTheme, string> = {
  light: "#e7e8eb",
  dark: "#0a0b0e",
};

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
  if (!isThemePreference(pref) || !isAppliedTheme(applied) || (stored !== "0" && stored !== "1")) {
    return null;
  }
  return { preference: pref, applied, stored: stored === "1" };
}

/**
 * First paint. Settings+nativeTheme (boot.stored) always win over a stale
 * localStorage cache. localStorage `dark` is used only when settings.json has
 * no `theme` (true legacy).
 */
export function firstPaintFrom(boot: AppearanceBoot | null, legacyTheme: unknown): { preference: ThemePreference; applied: AppliedTheme } {
  if (boot?.stored) {
    return { preference: boot.preference, applied: boot.applied };
  }
  if (legacyTheme === "dark") {
    return { preference: "dark", applied: "dark" };
  }
  if (boot) {
    return { preference: boot.preference, applied: boot.applied };
  }
  return { preference: DEFAULT_THEME_PREFERENCE, applied: "light" };
}

/**
 * Thrown when a headless/WSL engine would otherwise write its own settings.json
 * (a different file from the desktop's) or invent an applied theme. The caller
 * must either forward over HostChannel or surface this error.
 */
export const APPEARANCE_DESKTOP_ONLY_ERROR =
  "모양 설정은 데스크톱 앱이 소유합니다. 이 엔진은 호스트 채널이 없어 전달할 수 없습니다.";

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

export function appearanceAccess(input: { appearance?: unknown; appearanceRemote?: unknown }): AppearanceAccess {
  if (input.appearanceRemote) return "remote";
  if (input.appearance) return "local";
  return "unavailable";
}

export function appearanceOwnerError(): AppearanceOwnerError {
  return new AppearanceOwnerError();
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

export interface AppearanceState {
  preference: ThemePreference;
  applied: AppliedTheme;
  options: readonly ThemePreference[];
  /** True when settings.json itself contains `theme`, not just the in-memory default. */
  stored: boolean;
  /** Colour the native window chrome should paint while the renderer loads. */
  background: string;
}

export interface AppearanceRemote {
  getAppearance(): Promise<AppearanceState>;
  setTheme(theme: unknown): Promise<AppearanceState>;
}

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
    throw new InvalidThemeError(value);
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

export function windowBackgroundFor(preference: ThemePreference, osDark?: boolean): string {
  return APPLIED_THEME_BACKGROUNDS[resolveAppliedTheme(preference, osDark)];
}

export function appearanceStateOf(preference: ThemePreference, osDark: boolean | undefined, stored: boolean): AppearanceState {
  const applied = resolveAppliedTheme(preference, osDark);
  return {
    preference,
    applied,
    options: THEME_PREFERENCES,
    stored,
    background: APPLIED_THEME_BACKGROUNDS[applied],
  };
}

/** Subscribe to OS scheme updates; the disposer must run on shutdown. */
export function bindAppearanceUpdates(host: AppearanceHost | undefined, onUpdated: () => void): () => void {
  if (!host) {
    return () => undefined;
  }
  return host.onUpdated(onUpdated);
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
