/* Seven-preset theme model, migration, first paint, ownership, and token checks. */
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
const expected = ["agentparty-light", "agentparty-dark", "github-light", "github-dark", "dracula", "nord", "solarized-dark"];

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
}
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
