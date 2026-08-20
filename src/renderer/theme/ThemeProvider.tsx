import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  THEME_SYNC_PAINT_ATTRIBUTE,
  THEME_SYNC_PAINT_VALUE,
  firstPaintFrom,
  isThemePreference,
  normalizeThemePreference,
  type ThemePreference,
} from "../../shared/appTheme";
import { THEMES, buildThemeStylesheet, getTheme } from "./themes";

const STYLE_ELEMENT_ID = "agentparty-theme-vars";

function ensureThemeStylesheet(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = buildThemeStylesheet();
  document.head.appendChild(style);
}
ensureThemeStylesheet();

function readLegacyTheme(): string | null {
  try {
    return window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY) || window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function bootTheme(): ThemePreference {
  const boot = typeof window === "undefined" ? null : window.agentPartyAppearanceBoot;
  return firstPaintFrom(boot && isThemePreference(boot.preference) ? boot : null, typeof window === "undefined" ? null : readLegacyTheme()).preference;
}

function persistTheme(theme: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Main-process settings are authoritative; cache failure must not block use.
  }
}

function applyDocumentTheme(theme: ThemePreference): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", getTheme(theme).id);
  document.documentElement.setAttribute("data-theme-preference", theme);
  document.documentElement.setAttribute(THEME_SYNC_PAINT_ATTRIBUTE, THEME_SYNC_PAINT_VALUE);
}

const initialTheme = bootTheme();
applyDocumentTheme(initialTheme);

interface ThemeContextValue {
  preference: ThemePreference;
  themeId: ThemePreference;
  themes: typeof THEMES;
  setPreference: (preference: ThemePreference) => void;
  setTheme: (id: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialTheme);

  useEffect(() => {
    applyDocumentTheme(preference);
    persistTheme(preference);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => setPreferenceState(normalizeThemePreference(next)), []);
  const setTheme = useCallback((id: string) => setPreferenceState(normalizeThemePreference(id)), []);
  const value = useMemo<ThemeContextValue>(() => ({ preference, themeId: preference, themes: THEMES, setPreference, setTheme }), [preference, setPreference, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider.");
  return context;
}
