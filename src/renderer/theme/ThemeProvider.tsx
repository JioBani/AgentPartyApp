import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_THEME_ID, THEMES, buildThemeStylesheet, getTheme } from "./themes";

const STORAGE_KEY = "agentparty.theme";
const STYLE_ELEMENT_ID = "agentparty-theme-vars";

/**
 * Injects the generated theme stylesheet exactly once. Runs at module import
 * time (before React renders) so the first paint is already themed.
 */
function ensureThemeStylesheet(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ELEMENT_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = buildThemeStylesheet();
  document.head.appendChild(style);
}

ensureThemeStylesheet();

function readStoredTheme(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && THEMES.some((theme) => theme.id === stored)) {
      return stored;
    }
  } catch {
    // localStorage may be unavailable; fall back to the default theme.
  }
  return DEFAULT_THEME_ID;
}

interface ThemeContextValue {
  themeId: string;
  themes: typeof THEMES;
  setTheme: (id: string) => void;
  /** Advances to the next registered theme (used by the title-bar toggle). */
  cycleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeId] = useState<string>(readStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", getTheme(themeId).id);
    try {
      window.localStorage.setItem(STORAGE_KEY, themeId);
    } catch {
      // Persistence is best-effort.
    }
  }, [themeId]);

  const setTheme = useCallback((id: string) => {
    setThemeId(THEMES.some((theme) => theme.id === id) ? id : DEFAULT_THEME_ID);
  }, []);

  const cycleTheme = useCallback(() => {
    setThemeId((current) => {
      const index = THEMES.findIndex((theme) => theme.id === current);
      return THEMES[(index + 1) % THEMES.length].id;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ themeId, themes: THEMES, setTheme, cycleTheme }),
    [themeId, setTheme, cycleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider.");
  }
  return context;
}
