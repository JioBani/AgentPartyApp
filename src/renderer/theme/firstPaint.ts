import {
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  THEME_SYNC_PAINT_ATTRIBUTE,
  THEME_SYNC_PAINT_VALUE,
  firstPaintFrom,
  isThemePreference,
  themeFromRendererStorage,
  type ThemePreference,
} from "../../shared/appTheme";

export function cachedRendererTheme(): ThemePreference | null {
  try {
    return themeFromRendererStorage(
      window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY),
      window.localStorage.getItem(THEME_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

export function bootRendererTheme(): ThemePreference {
  const boot = typeof window === "undefined" ? null : window.agentPartyAppearanceBoot;
  return firstPaintFrom(boot && isThemePreference(boot.preference) ? boot : null, typeof window === "undefined" ? null : cachedRendererTheme()).preference;
}

export function applyDocumentTheme(theme: ThemePreference): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-theme-preference", theme);
  document.documentElement.setAttribute(THEME_SYNC_PAINT_ATTRIBUTE, THEME_SYNC_PAINT_VALUE);
}

export const initialRendererTheme = bootRendererTheme();
applyDocumentTheme(initialRendererTheme);
