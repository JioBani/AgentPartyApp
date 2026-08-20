import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  THEME_SYNC_PAINT_ATTRIBUTE,
  THEME_SYNC_PAINT_VALUE,
  cycleThemePreference,
  firstPaintFrom,
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

function readLegacyTheme(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function bootAppearance(): { preference: ThemePreference; applied: AppliedTheme } {
  const boot = typeof window === "undefined" ? undefined : window.agentPartyAppearanceBoot;
  return firstPaintFrom(boot && isThemePreference(boot.preference) ? boot : null, typeof window === "undefined" ? null : readLegacyTheme());
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
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.setAttribute("data-theme", getTheme(applied).id);
  document.documentElement.setAttribute("data-theme-preference", preference);
  document.documentElement.setAttribute(THEME_SYNC_PAINT_ATTRIBUTE, THEME_SYNC_PAINT_VALUE);
}

const bootPaint = bootAppearance();
const bootPreference = bootPaint.preference;
const bootOsDark = bootPaint.applied === "dark";
applyDocumentTheme(bootPaint.preference, bootPaint.applied);

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
  /** QA / host broadcast: the OS scheme the desktop just observed. */
  setOsDark: (dark: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(bootPreference);
  const [osDark, setOsDarkState] = useState<boolean>(bootOsDark);
  const themeId = resolveAppliedTheme(preference, osDark);

  useEffect(() => {
    applyDocumentTheme(preference, themeId);
    persistPreference(preference);
  }, [preference, themeId]);

  useEffect(() => {
    if (preference !== "system") {
      return;
    }
    setOsDarkState(osPrefersDark());
    return subscribeOsTheme(() => setOsDarkState(osPrefersDark()));
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(normalizeThemePreference(next));
  }, []);

  const setOsDark = useCallback((dark: boolean) => {
    setOsDarkState(dark);
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
    () => ({ preference, themeId, themes: THEMES, setPreference, setTheme, cycleTheme, setOsDark }),
    [preference, themeId, setPreference, setTheme, cycleTheme, setOsDark],
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
