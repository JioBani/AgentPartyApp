/* Five-preset theme model, migration, first paint, ownership, and token checks. */
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
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
const expected = ["github-light", "github-dark", "dracula", "nord", "solarized-dark"];

console.log("\nfive preset ids + strict API validation:");
assert(theme.DEFAULT_THEME_PREFERENCE === "github-light", "GitHub Light is the safe default");
assert(JSON.stringify(theme.THEME_PREFERENCES) === JSON.stringify(expected), "exactly five preset ids are exposed in order");
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
assert(theme.normalizeThemePreference("light") === "github-light", "branch settings light migrates to GitHub Light");
assert(theme.normalizeThemePreference("dark") === "github-dark", "branch settings dark migrates to GitHub Dark");
assert(theme.normalizeThemePreference("system") === "github-light", "removed System setting migrates safely to GitHub Light");
assert(theme.migrateLegacyThemeValue(undefined, "light") === "github-light", "legacy localStorage light migrates");
assert(theme.migrateLegacyThemeValue(undefined, "dark") === "github-dark", "legacy localStorage dark migrates");
assert(theme.themeFromRendererStorage("system", "dark") === "github-dark", "removed system preference preserves its last dark paint");
assert(theme.themeFromRendererStorage("nord", "dark") === "nord", "current preference key wins over stale applied cache");
assert(theme.themeFromRendererStorage(undefined, "dracula") === "dracula", "current preset in applied cache is preserved");
assert(theme.themeFromRendererStorage("solarized-dark", "light") === "solarized-dark", "Solarized preference wins over stale light cache");
assert(theme.migrateLegacyThemeValue("nord", "dark") === null, "stored preset wins over stale cache");
assert(theme.firstPaintFrom({ preference: "dracula", applied: "dracula", stored: true }, "light").applied === "dracula", "stored settings win before React");
assert(theme.firstPaintFrom({ preference: "github-light", applied: "github-light", stored: false }, "dark").applied === "github-dark", "legacy cache is used only without stored settings");
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
assert(registry.THEMES.length === 5 && registry.THEMES.map(({ id }) => id).join(",") === expected.join(","), "registry has exactly the five public presets");
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
