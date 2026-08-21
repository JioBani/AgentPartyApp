/* Seven-preset theme model, migration, first paint, ownership, and token checks. */
import { build } from "esbuild";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (condition, message) => { console.log(`  ${condition ? "✓" : "✗"} ${message}`); if (!condition) failures.push(message); };

async function bundle(entry, name) {
  const result = await build({ entryPoints: [path.join(root, entry)], bundle: true, format: "esm", platform: "neutral", write: false });
  const file = path.join(qaTempDir(), name);
  writeFileSync(file, result.outputFiles[0].text);
  return import(`${pathToFileURL(file).href}?v=${Date.now()}`);
}

const theme = await bundle("src/shared/appTheme.ts", "app-theme.mjs");
const registry = await bundle("src/renderer/theme/themes.ts", "theme-registry.mjs");
const schema = await bundle("src/shared/themeSchema.ts", "theme-schema.mjs");
const expected = ["agentparty-light", "agentparty-dark", "github-light", "github-dark", "dracula", "nord", "solarized-dark"];

function definitionError(mutator, expectedPath, message) {
  const candidate = structuredClone(registry.THEMES[0]);
  mutator(candidate);
  let error;
  try { schema.parseThemeDefinition(candidate, "candidate.json"); } catch (caught) { error = caught; }
  assert(error instanceof schema.ThemeDefinitionError && error.message.includes(`candidate.json.${expectedPath}`), message);
}

console.log("\ndeclarative JSON schema + strict parser:");
const themesDirectory = path.join(root, "src/shared/themes");
const jsonFiles = readdirSync(themesDirectory).filter((file) => file.endsWith(".json"));
const jsonThemes = jsonFiles.map((file) => JSON.parse(readFileSync(path.join(themesDirectory, file), "utf8")));
const parsedJsonThemes = schema.parseThemeCatalog(jsonThemes, jsonFiles);
assert(jsonFiles.length === 7, "exactly seven built-in JSON theme files exist");
assert(parsedJsonThemes.every(({ schemaVersion }) => schemaVersion === 1), "every built-in JSON uses schemaVersion 1");
assert(expected.every((id) => parsedJsonThemes.some((entry) => entry.id === id)), "JSON catalog contains the exact public ids");
assert(registry.THEMES.every((entry) => JSON.stringify(entry) === JSON.stringify(parsedJsonThemes.find(({ id }) => id === entry.id))), "runtime catalog exactly matches the JSON definitions");
const jsonSchema = JSON.parse(readFileSync(path.join(root, "src/shared/theme.schema.json"), "utf8"));
assert(jsonSchema.$schema === "https://json-schema.org/draft/2020-12/schema" && jsonSchema.additionalProperties === false, "editor JSON Schema uses draft 2020-12 and strict root keys");
const schemaOptional = structuredClone(registry.THEMES[0]);
delete schemaOptional.$schema;
assert(schema.parseThemeDefinition(schemaOptional).id === "agentparty-light", "$schema is optional at runtime");
definitionError((value) => { delete value.color["bg-0"]; }, "color.bg-0", "missing color token reports its full path");
definitionError((value) => { value.color.surprise = "#fff"; }, "color.surprise", "unknown color token reports its full path");
definitionError((value) => { delete value.shape["radius-card"]; }, "shape.radius-card", "missing shape token reports its full path");
definitionError((value) => { value.shape.surprise = "1px"; }, "shape.surprise", "unknown shape token reports its full path");
definitionError((value) => { value.surprise = true; }, "surprise", "unknown root property reports its full path");
definitionError((value) => { value.id = "Bad Theme"; }, "id", "invalid id format is rejected");
definitionError((value) => { value.color.accent = ""; }, "color.accent", "empty CSS values are rejected");
definitionError((value) => { value.color.accent = "red; } body { color: red"; }, "color.accent", "unsafe CSS declaration syntax is rejected");
definitionError((value) => { value.color.accent = "url(https://example.test/a)"; }, "color.accent", "CSS url values are rejected before stylesheet generation");
definitionError((value) => { value.schemaVersion = 2; }, "schemaVersion", "unsupported schema versions are rejected");
let duplicateError;
try { schema.parseThemeCatalog([registry.THEMES[0], registry.THEMES[0]], ["one.json", "two.json"]); } catch (caught) { duplicateError = caught; }
assert(duplicateError instanceof schema.ThemeDefinitionError && duplicateError.message.includes("two.json.id") && duplicateError.message.includes("duplicate id 'agentparty-light'"), "duplicate ids are rejected before lookup-map construction with the source path");
let defaultError;
try { schema.requireThemeInCatalog(parsedJsonThemes, "missing-default"); } catch (caught) { defaultError = caught; }
assert(defaultError instanceof schema.ThemeDefinitionError && defaultError.message.includes("theme catalog.default"), "a missing default theme fails catalog initialization visibly");

console.log("\nseven preset ids + strict API validation:");
assert(theme.DEFAULT_THEME_PREFERENCE === "agentparty-light", "AgentParty Light is the safe default");
assert(JSON.stringify(theme.THEME_PREFERENCES) === JSON.stringify(expected), "exactly seven preset ids are exposed in order");
for (const id of expected) {
  assert(theme.isThemePreference(id), `${id} is accepted`);
  assert(theme.requireThemePreference(id) === id, `${id} passes strict API validation`);
}
for (const invalid of ["system", "light", "dark", "auto", "", null, undefined]) {
  let error;
  try { theme.requireThemePreference(invalid); } catch (caught) { error = caught; }
  assert(error instanceof theme.InvalidThemeError && error.status === 400 && error.code === "invalid_theme", `${String(invalid)} is strict invalid_theme 400`);
}

console.log("\nlegacy migration + synchronous first paint:");
assert(theme.normalizeThemePreference("light") === "agentparty-light", "branch settings light migrates to AgentParty Light");
assert(theme.normalizeThemePreference("dark") === "agentparty-dark", "branch settings dark migrates to AgentParty Dark");
assert(theme.normalizeThemePreference("system") === "agentparty-light", "removed System setting migrates safely to AgentParty Light");
assert(theme.migrateLegacyThemeValue(undefined, "light") === "agentparty-light", "legacy localStorage light migrates");
assert(theme.migrateLegacyThemeValue(undefined, "dark") === "agentparty-dark", "legacy localStorage dark migrates");
assert(theme.themeFromRendererStorage("system", "dark") === "agentparty-dark", "removed system preference preserves its last dark paint");
assert(theme.themeFromRendererStorage("nord", "dark") === "nord", "current preference key wins over stale applied cache");
assert(theme.themeFromRendererStorage(undefined, "dracula") === "dracula", "current preset in applied cache is preserved");
assert(theme.themeFromRendererStorage("solarized-dark", "light") === "solarized-dark", "Solarized preference wins over stale light cache");
assert(theme.migrateLegacyThemeValue("nord", "dark") === null, "stored preset wins over stale cache");
assert(theme.firstPaintFrom({ preference: "dracula", applied: "dracula", stored: true }, "light").applied === "dracula", "stored settings win before React");
assert(theme.firstPaintFrom({ preference: "agentparty-light", applied: "agentparty-light", stored: false }, "dark").applied === "agentparty-dark", "legacy cache is used only without stored settings");
const boot = { preference: "solarized-dark", applied: "solarized-dark", stored: true };
assert(JSON.stringify(theme.parseAppearanceBootArgs(theme.appearanceBootArgs(boot))) === JSON.stringify(boot), "boot argv round-trips a preset");
assert(theme.parseAppearanceBootArgs(theme.appearanceBootArgs({ ...boot, applied: "nord" })) === null, "mismatched preference/applied boot is rejected");
assert(theme.retainAppearanceOnInitialState({ theme: "github-light" }, { theme: "github-light", locale: "en" }, "nord").theme === "nord", "late initial state cannot overwrite a committed theme");

console.log("\ndesktop ownership + chrome background:");
assert(theme.appearanceAccess({ appearance: { desktop: true } }) === "local", "desktop marker owns local appearance");
assert(theme.appearanceAccess({ appearanceRemote: {} }) === "remote", "HostChannel remote owns headless appearance");
assert(theme.appearanceAccess({ appearance: { desktop: true }, appearanceRemote: {} }) === "remote", "remote wins so WSL never writes distro settings");
assert(theme.appearanceAccess({}) === "unavailable", "missing owner fails visibly");
const owner = theme.appearanceOwnerError();
assert(owner.status === 403 && owner.code === "appearance_desktop_only", "owner error is typed HTTP 403");
for (const id of expected) assert(theme.appearanceStateOf(id, true).background === theme.THEME_BACKGROUNDS[id], `${id} chrome matches bg-0`);

function luminance(hex) {
  const parts = hex.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16) / 255).map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * parts[0] + .7152 * parts[1] + .0722 * parts[2];
}
function contrast(a, b) {
  const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright + .05) / (dark + .05);
}

console.log("\ncomplete preset tokens + contrast:");
assert(registry.THEMES.length === 7 && registry.THEMES.map(({ id }) => id).join(",") === expected.join(","), "registry has exactly the seven public presets");
const original = {
  "agentparty-light": { "bg-0": "#e7e8eb", "bg-1": "#f3f4f6", "bg-2": "#ffffff", "bg-3": "#eef0f3", "bg-4": "#e6e9ed", "bg-input": "#ffffff", "border-subtle": "#e2e5ea", border: "#d3d7df", "border-strong": "#c0c5ce", "text-0": "#171a1f", "text-1": "#454b56", "text-2": "#6c7480", "text-3": "#9aa1ac", accent: "#3f6fe6", live: "#b9791d", success: "#2f8f5e", danger: "#cf4b45", warning: "#b07816", grid: "rgba(20,25,35,.07)", scrim: "rgba(20,23,29,.42)", shadow: "rgba(20,23,29,.13)", "shadow-strong": "rgba(20,23,29,.2)" },
  "agentparty-dark": { "bg-0": "#0a0b0e", "bg-1": "#0e1014", "bg-2": "#14171d", "bg-3": "#1b1f27", "bg-4": "#222731", "bg-input": "#0c0e12", "border-subtle": "#1c2028", border: "#262b35", "border-strong": "#333a46", "text-0": "#e7e9ee", "text-1": "#aeb4c0", "text-2": "#79808d", "text-3": "#535965", accent: "#5b8cff", live: "#e0a14e", success: "#54b585", danger: "#e0635d", warning: "#d9a441", grid: "rgba(255,255,255,.06)", scrim: "rgba(0,0,0,.5)", shadow: "rgba(0,0,0,.4)", "shadow-strong": "rgba(0,0,0,.6)" },
};
for (const [id, tokens] of Object.entries(original)) {
  const preset = registry.THEMES.find((entry) => entry.id === id);
  assert(Object.entries(tokens).every(([key, value]) => preset?.color[key] === value), `${id} preserves every original 23dc88b color token`);
  const originalShape = { "radius-window": "9px", "radius-panel": "11px", "radius-card": "10px", "radius-button": "7px", "radius-input": "8px", "radius-pill": "6px", "radius-badge": "5px", "border-width": "1px", "focus-ring-width": "1px" };
  assert(Object.entries(originalShape).every(([key, value]) => preset?.shape[key] === value), `${id} preserves every original 23dc88b shape token`);
}
assert(registry.THEMES.filter(({ id }) => !id.startsWith("agentparty-")).every(({ shape }) => shape["focus-ring-width"] === "2px"), "the other five presets keep their 2px focus ring");
const tokenKeys = Object.keys(registry.THEMES[0].color).sort().join(",");
for (const preset of registry.THEMES) {
  assert(Object.keys(preset.color).sort().join(",") === tokenKeys, `${preset.label} defines every color token`);
  assert(preset.color["bg-0"] === theme.THEME_BACKGROUNDS[preset.id], `${preset.label} shares the first-paint background`);
  assert(contrast(preset.color["text-0"], preset.color["bg-2"]) >= 7, `${preset.label} primary text has enhanced contrast`);
  assert(contrast(preset.color["text-2"], preset.color["bg-2"]) >= 4.5, `${preset.label} muted text meets WCAG AA`);
  assert(contrast(preset.color["danger-fg"], preset.color.danger) >= 4.5 && contrast(preset.color["warning-fg"], preset.color.warning) >= 4.5, `${preset.label} small danger/warning badge text meets WCAG AA`);
  assert(preset.color.selection && preset.color["selection-fg"] && preset.color.status && preset.color["status-fg"], `${preset.label} defines selection and status colors`);
}

if (failures.length) {
  console.error(`\nFAILED ${failures.length}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nqa-theme-settings: ok");
