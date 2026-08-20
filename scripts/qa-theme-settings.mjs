/*
 * Theme preference: stored value, default, and the API's strict reject.
 *
 * The renderer toggle used to persist `light`/`dark` in localStorage. Settings
 * now own `theme` as `system` | `light` | `dark`. The default stays `light` so
 * an upgrading user who never chose a theme sees the same first paint.
 */
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const outDir = qaTempDir();
const bundled = await build({
  entryPoints: [path.join(projectRoot, "src/shared/appTheme.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const outFile = path.join(outDir, "app-theme.mjs");
writeFileSync(outFile, bundled.outputFiles[0].text);
const {
  APPEARANCE_DESKTOP_ONLY_ERROR,
  AppearanceOwnerError,
  DEFAULT_THEME_PREFERENCE,
  THEME_PREFERENCES,
  appearanceAccess,
  appearanceOwnerError,
  bindAppearanceUpdates,
  cycleThemePreference,
  isThemePreference,
  migrateLegacyThemeValue,
  normalizeThemePreference,
  requireThemePreference,
  resolveAppliedTheme,
  windowBackgroundFor,
  appearanceStateOf,
} = await import(pathToFileURL(outFile).href);

console.log("\ntheme preference (settings.json + API):");
assert(DEFAULT_THEME_PREFERENCE === "light", "default stays light (current first paint)");
assert(THEME_PREFERENCES.join(",") === "system,light,dark", "preference set is system | light | dark");
assert(isThemePreference("system") && isThemePreference("light") && isThemePreference("dark"), "all three preferences are accepted");
assert(!isThemePreference("Light") && !isThemePreference("") && !isThemePreference(null), "case, empty, and null are not preferences");

assert(normalizeThemePreference("system") === "system", "normalize keeps system");
assert(normalizeThemePreference("light") === "light", "normalize keeps light");
assert(normalizeThemePreference("dark") === "dark", "normalize keeps dark");
assert(normalizeThemePreference(undefined) === "light", "missing stored value heals to light");
assert(normalizeThemePreference("auto") === "light", "stale stored value heals to light");
assert(normalizeThemePreference(1) === "light", "non-string stored value heals to light");

assert(requireThemePreference("system") === "system", "API accepts system");
assert(requireThemePreference("light") === "light", "API accepts light");
assert(requireThemePreference("dark") === "dark", "API accepts dark");
let rejected = "";
try {
  requireThemePreference("auto");
} catch (error) {
  rejected = error instanceof Error ? error.message : String(error);
}
assert(rejected.includes("지원하지 않는 테마입니다") && rejected.includes("auto"), "API rejects an unknown value instead of healing it");
rejected = "";
try {
  requireThemePreference(undefined);
} catch (error) {
  rejected = error instanceof Error ? error.message : String(error);
}
assert(rejected.includes("지원하지 않는 테마입니다"), "API rejects a missing value instead of defaulting");

console.log("\neffective theme + cycle + legacy migrate:");
assert(resolveAppliedTheme("light", true) === "light", "locked light ignores OS dark");
assert(resolveAppliedTheme("dark", false) === "dark", "locked dark ignores OS light");
assert(resolveAppliedTheme("system", false) === "light", "system + OS light paints light");
assert(resolveAppliedTheme("system", true) === "dark", "system + OS dark paints dark");
assert(cycleThemePreference("system") === "light", "cycle system → light");
assert(cycleThemePreference("light") === "dark", "cycle light → dark (same first step as the old toggle)");
assert(cycleThemePreference("dark") === "system", "cycle dark → system");
assert(migrateLegacyThemeValue(undefined, "dark") === "dark", "legacy dark migrates when settings have no theme");
assert(migrateLegacyThemeValue(undefined, "light") === null, "legacy light is the old first-paint default, not a user choice");
assert(migrateLegacyThemeValue("system", "dark") === null, "explicit system is not overridden by legacy dark");
assert(migrateLegacyThemeValue("light", "dark") === null, "explicit light is not overridden by legacy dark");
assert(migrateLegacyThemeValue("dark", "light") === null, "explicit dark is not overridden by legacy light");
assert(migrateLegacyThemeValue(undefined, "system") === null, "legacy system is not a stored-value we used to write");
assert(migrateLegacyThemeValue(undefined, null) === null, "no legacy value means no migration write");

console.log("\ndesktop ownership + nativeTheme disposer:");
assert(appearanceAccess({ appearance: { isDark: () => false } }) === "local", "a nativeTheme host is local");
assert(appearanceAccess({ appearanceRemote: { getAppearance: async () => ({}) } }) === "remote", "a HostChannel remote is remote");
assert(appearanceAccess({ appearanceRemote: { getAppearance: async () => ({}) }, appearance: { isDark: () => false } }) === "remote", "remote wins so a distro never writes locally");
assert(appearanceAccess({}) === "unavailable", "neither host nor channel is unavailable");
const owner = appearanceOwnerError();
assert(owner instanceof AppearanceOwnerError && owner.code === "appearance_desktop_only", "the reject is a typed AppearanceOwnerError");
assert(owner.message === APPEARANCE_DESKTOP_ONLY_ERROR, "the error names the desktop-only rule");
let calls = 0;
let disposed = 0;
const stop = bindAppearanceUpdates({
  setSource() {},
  isDark() { return false; },
  onUpdated(listener) {
    listener();
    calls += 1;
    return () => { disposed += 1; };
  },
}, () => undefined);
assert(calls === 1, "bindAppearanceUpdates subscribes immediately");
stop();
assert(disposed === 1, "the disposer unsubscribes nativeTheme");
bindAppearanceUpdates(undefined, () => { throw new Error("must not run"); })();
assert(true, "no host yields a no-op disposer");
assert(windowBackgroundFor("light") === "#e7e8eb", "light window chrome matches bg-0");
assert(windowBackgroundFor("dark") === "#0a0b0e", "dark window chrome matches bg-0");
assert(windowBackgroundFor("system", true) === "#0a0b0e", "system + OS dark uses dark chrome");
assert(appearanceStateOf("dark", false, true).background === "#0a0b0e", "appearance payload carries the chrome colour");

if (failures.length) {
  console.error(`\nFAILED ${failures.length}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nqa-theme-settings: ok");
