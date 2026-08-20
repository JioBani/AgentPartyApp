import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  cycleThemePreference,
  isThemePreference,
  normalizeThemePreference,
  resolveAppliedTheme,
  type AppliedTheme,
  type ThemePreference,
} from "../../shared/appTheme";
import { DEFAULT_THEME_ID, THEMES, buildThemeStylesheet, getTheme } from "./themes";

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

function osPrefersDark(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
}

/** Subscribe to OS scheme changes; always unsubscribe on the returned disposer. */
function subscribeOsTheme(onChange: () => void): () => void {
  const media = typeof window === "undefined" ? undefined : window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!media) {
    return () => undefined;
  }
  const handler = () => onChange();
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }
  media.addListener(handler);
  return () => media.removeListener(handler);
}

function readStoredPreference(): ThemePreference {
  try {
    const marked = window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY);
    if (isThemePreference(marked)) {
      return marked;
    }
    const legacy = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (legacy === "light" || legacy === "dark") {
      return legacy;
    }
  } catch {
    // localStorage may be unavailable; fall back to the default preference.
  }
  return DEFAULT_THEME_PREFERENCE;
}

function persistPreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, preference);
    if (preference === "light" || preference === "dark") {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // Persistence is best-effort.
  }
}

function applyDocumentTheme(preference: ThemePreference, applied: AppliedTheme): void {
  document.documentElement.setAttribute("data-theme", getTheme(applied).id);
  document.documentElement.setAttribute("data-theme-preference", preference);
}

interface ThemeContextValue {
  /** User choice: system / light / dark. */
  preference: ThemePreference;
  /** Applied visual theme (`data-theme`). */
  themeId: AppliedTheme;
  themes: typeof THEMES;
  setPreference: (preference: ThemePreference) => void;
  /** Forces a visual theme id (guide stage). Light/dark become an explicit preference. */
  setTheme: (id: string) => void;
  /** Advances system → light → dark → system (title-bar shortcut). */
  cycleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [osDark, setOsDark] = useState<boolean>(osPrefersDark);
  const themeId = resolveAppliedTheme(preference, osDark);

  useEffect(() => {
    applyDocumentTheme(preference, themeId);
    persistPreference(preference);
  }, [preference, themeId]);

  useEffect(() => {
    if (preference !== "system") {
      return;
    }
    setOsDark(osPrefersDark());
    return subscribeOsTheme(() => setOsDark(osPrefersDark()));
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(normalizeThemePreference(next));
  }, []);

  const setTheme = useCallback((id: string) => {
    if (id === "system" || id === "light" || id === "dark") {
      setPreferenceState(id);
      return;
    }
    setPreferenceState(DEFAULT_THEME_ID === "dark" ? "dark" : "light");
  }, []);

  const cycleTheme = useCallback(() => {
    setPreferenceState((current) => cycleThemePreference(current));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, themeId, themes: THEMES, setPreference, setTheme, cycleTheme }),
    [preference, themeId, setPreference, setTheme, cycleTheme],
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
