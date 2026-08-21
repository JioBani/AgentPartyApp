import { DEFAULT_THEME, DEFAULT_THEME_PREFERENCE, THEMES, registeredTheme } from "../../shared/themeCatalog";
import type { ThemeDefinition } from "../../shared/themeSchema";
import type { ThemePreference } from "../../shared/appTheme";

export type { ThemeColorToken, ThemeDefinition as Theme, ThemeShapeToken } from "../../shared/themeSchema";
export { THEMES } from "../../shared/themeCatalog";

export const DEFAULT_THEME_ID: ThemePreference = DEFAULT_THEME_PREFERENCE;
export function getTheme(id: string): ThemeDefinition { return registeredTheme(id) ?? DEFAULT_THEME; }

const SCALE: Readonly<Record<string, string>> = {
  "font-micro": "9.5px", "font-meta": "10px", "font-caption": "10.5px", "font-body-sm": "11px",
  "font-body": "11.5px", "font-ui": "12px", "font-ui-lg": "12.5px", "font-title": "13px",
  "font-heading": "14px", "font-display": "15px", "weight-regular": "400", "weight-medium": "500",
  "weight-semibold": "600", "weight-bold": "700", "motion-fast": "0.12s", "motion-base": "0.15s",
  "motion-slow": "0.3s", "motion-pulse": "1.6s", "motion-sweep": "1.2s", "control-height": "30px",
  "control-height-sm": "26px", "row-height": "38px", "tab-height": "37px", "bar-height": "40px",
  "dot-size": "7px", "touch-target-min": "44px",
};

function declarations(theme: ThemeDefinition): string {
  return [
    `color-scheme: ${theme.scheme};`,
    ...Object.entries(theme.color).map(([key, value]) => `--${key}: ${value};`),
    ...Object.entries(theme.shape).map(([key, value]) => `--${key}: ${value};`),
  ].join("\n  ");
}

export function buildThemeStylesheet(): string {
  const blocks = THEMES.map((theme) => `:root[data-theme="${theme.id}"] {\n  ${declarations(theme)}\n}`);
  blocks.unshift(`:root {\n  ${declarations(DEFAULT_THEME)}\n}`);
  blocks.unshift(`:root {\n  ${Object.entries(SCALE).map(([key, value]) => `--${key}: ${value};`).join("\n  ")}\n}`);
  return blocks.join("\n\n");
}
