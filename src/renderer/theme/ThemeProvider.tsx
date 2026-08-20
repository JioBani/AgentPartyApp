import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  normalizeThemePreference,
  type ThemePreference,
} from "../../shared/appTheme";
import { THEMES, buildThemeStylesheet } from "./themes";
import { applyDocumentTheme, initialRendererTheme } from "./firstPaint";

const STYLE_ELEMENT_ID = "agentparty-theme-vars";

function ensureThemeStylesheet(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = buildThemeStylesheet();
  document.head.appendChild(style);
}
ensureThemeStylesheet();

function persistTheme(theme: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Main-process settings are authoritative; cache failure must not block use.
  }
}

interface ThemeContextValue {
  preference: ThemePreference;
  themeId: ThemePreference;
  themes: typeof THEMES;
  setPreference: (preference: ThemePreference) => void;
  setTheme: (id: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialRendererTheme);

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
