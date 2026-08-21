import agentpartyLightJson from "./themes/agentparty-light.json";
import agentpartyDarkJson from "./themes/agentparty-dark.json";
import githubLightJson from "./themes/github-light.json";
import githubDarkJson from "./themes/github-dark.json";
import draculaJson from "./themes/dracula.json";
import nordJson from "./themes/nord.json";
import solarizedDarkJson from "./themes/solarized-dark.json";
import themeJsonSchema from "./theme.schema.json";
import { parseThemeCatalog, requireThemeInCatalog, type ThemeDefinition } from "./themeSchema";

const BUILTIN_THEME_JSON: readonly unknown[] = [
  agentpartyLightJson,
  agentpartyDarkJson,
  githubLightJson,
  githubDarkJson,
  draculaJson,
  nordJson,
  solarizedDarkJson,
];

const BUILTIN_THEME_SOURCES = [
  "themes/agentparty-light.json",
  "themes/agentparty-dark.json",
  "themes/github-light.json",
  "themes/github-dark.json",
  "themes/dracula.json",
  "themes/nord.json",
  "themes/solarized-dark.json",
] as const;

/** Static imports keep startup and first paint synchronous; no directory scan occurs. */
export const THEMES = parseThemeCatalog(BUILTIN_THEME_JSON, BUILTIN_THEME_SOURCES);
/** Bundled for editor/tooling consumers; runtime validation remains in themeSchema.ts. */
export const THEME_JSON_SCHEMA: unknown = themeJsonSchema;
export type ThemePreference = string;

export const THEME_PREFERENCES: readonly ThemePreference[] = Object.freeze(THEMES.map(({ id }) => id));
const themeById: ReadonlyMap<ThemePreference, ThemeDefinition> = new Map(THEMES.map((theme) => [theme.id, theme]));
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "agentparty-light";
export const DEFAULT_THEME = requireThemeInCatalog(THEMES, DEFAULT_THEME_PREFERENCE);
export const THEME_METADATA = Object.freeze(THEMES.map(({ id, label, scheme, color }) => ({ id, label, scheme, background: color["bg-0"] })));
export const THEME_BACKGROUNDS: Readonly<Record<ThemePreference, string>> = Object.freeze(
  Object.fromEntries(THEMES.map(({ id, color }) => [id, color["bg-0"]])),
);

export function isRegisteredThemeId(value: unknown): value is ThemePreference {
  return typeof value === "string" && themeById.has(value);
}

export function registeredTheme(id: string): ThemeDefinition | undefined { return themeById.get(id); }
