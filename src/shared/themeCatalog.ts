import agentpartyLightJson from "./themes/agentparty-light.json";
import agentpartyDarkJson from "./themes/agentparty-dark.json";
import githubLightJson from "./themes/github-light.json";
import githubDarkJson from "./themes/github-dark.json";
import draculaJson from "./themes/dracula.json";
import nordJson from "./themes/nord.json";
import solarizedDarkJson from "./themes/solarized-dark.json";
import oneDarkProJson from "./themes/one-dark-pro.json";
import atomOneDarkJson from "./themes/atom-one-dark.json";
import ayuMirageJson from "./themes/ayu-mirage.json";
import winterIsComingJson from "./themes/winter-is-coming.json";
import nightOwlJson from "./themes/night-owl.json";
import oneMonokaiJson from "./themes/one-monokai.json";
import tokyoNightJson from "./themes/tokyo-night.json";
import palenightJson from "./themes/palenight.json";
import synthwave84Json from "./themes/synthwave-84.json";
import shadesOfPurpleJson from "./themes/shades-of-purple.json";
import cobalt2Json from "./themes/cobalt2.json";
import andromedaJson from "./themes/andromeda.json";
import atomOneLightJson from "./themes/atom-one-light.json";
import noctisJson from "./themes/noctis.json";
import catppuccinMochaJson from "./themes/catppuccin-mocha.json";
import gruvboxDarkMediumJson from "./themes/gruvbox-dark-medium.json";
import sublimeMaterialDarkJson from "./themes/sublime-material-dark.json";
import omniJson from "./themes/omni.json";
import jellyfishJson from "./themes/jellyfish.json";
import darculaJson from "./themes/darcula.json";
import themeJsonSchema from "./theme.schema.json";
import { parseThemeCatalog, ThemeDefinitionError, type ThemeDefinition } from "./themeSchema";

declare const registeredThemeIdBrand: unique symbol;
export type RegisteredThemeId = string & { readonly [registeredThemeIdBrand]: "RegisteredThemeId" };
export type ThemePreference = RegisteredThemeId;
export type RegisteredThemeDefinition = Omit<ThemeDefinition, "id"> & { readonly id: RegisteredThemeId };

const BUILTIN_THEME_JSON: readonly unknown[] = [
  agentpartyLightJson,
  agentpartyDarkJson,
  githubLightJson,
  githubDarkJson,
  draculaJson,
  nordJson,
  solarizedDarkJson,
  oneDarkProJson,
  atomOneDarkJson,
  ayuMirageJson,
  winterIsComingJson,
  nightOwlJson,
  oneMonokaiJson,
  tokyoNightJson,
  palenightJson,
  synthwave84Json,
  shadesOfPurpleJson,
  cobalt2Json,
  andromedaJson,
  atomOneLightJson,
  noctisJson,
  catppuccinMochaJson,
  gruvboxDarkMediumJson,
  sublimeMaterialDarkJson,
  omniJson,
  jellyfishJson,
  darculaJson,
];

const BUILTIN_THEME_SOURCES = [
  "themes/agentparty-light.json",
  "themes/agentparty-dark.json",
  "themes/github-light.json",
  "themes/github-dark.json",
  "themes/dracula.json",
  "themes/nord.json",
  "themes/solarized-dark.json",
  "themes/one-dark-pro.json",
  "themes/atom-one-dark.json",
  "themes/ayu-mirage.json",
  "themes/winter-is-coming.json",
  "themes/night-owl.json",
  "themes/one-monokai.json",
  "themes/tokyo-night.json",
  "themes/palenight.json",
  "themes/synthwave-84.json",
  "themes/shades-of-purple.json",
  "themes/cobalt2.json",
  "themes/andromeda.json",
  "themes/atom-one-light.json",
  "themes/noctis.json",
  "themes/catppuccin-mocha.json",
  "themes/gruvbox-dark-medium.json",
  "themes/sublime-material-dark.json",
  "themes/omni.json",
  "themes/jellyfish.json",
  "themes/darcula.json",
] as const;

/** Static imports keep startup and first paint synchronous; no directory scan occurs. */
const parsedThemes = parseThemeCatalog(BUILTIN_THEME_JSON, BUILTIN_THEME_SOURCES);
export const THEMES: readonly RegisteredThemeDefinition[] = Object.freeze(
  parsedThemes.map((theme) => Object.freeze({ ...theme, id: theme.id as RegisteredThemeId })),
);
/** Bundled for editor/tooling consumers; runtime validation remains in themeSchema.ts. */
export const THEME_JSON_SCHEMA: unknown = themeJsonSchema;

export const THEME_PREFERENCES: readonly ThemePreference[] = Object.freeze(THEMES.map(({ id }) => id));
const themeById: ReadonlyMap<ThemePreference, RegisteredThemeDefinition> = new Map(THEMES.map((theme) => [theme.id, theme]));

export function requireRegisteredThemeId(value: string, source = "theme catalog"): RegisteredThemeId {
  if (!themeById.has(value as RegisteredThemeId)) throw new ThemeDefinitionError(source, "id", `unregistered theme id '${value}'`);
  return value as RegisteredThemeId;
}

export const DEFAULT_THEME_PREFERENCE = requireRegisteredThemeId("agentparty-light", "theme catalog.default");
export const DEFAULT_THEME = themeById.get(DEFAULT_THEME_PREFERENCE)!;
export const THEME_METADATA = Object.freeze(THEMES.map(({ id, label, scheme, color }) => Object.freeze({ id, label, scheme, background: color["bg-0"] })));
export const THEME_BACKGROUNDS: Readonly<Record<ThemePreference, string>> = Object.freeze(
  Object.fromEntries(THEMES.map(({ id, color }) => [id, color["bg-0"]])),
);

export function isRegisteredThemeId(value: unknown): value is ThemePreference {
  return typeof value === "string" && themeById.has(value as RegisteredThemeId);
}

export function registeredTheme(id: string): RegisteredThemeDefinition | undefined { return themeById.get(id as RegisteredThemeId); }
