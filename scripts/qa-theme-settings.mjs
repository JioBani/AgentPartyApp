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
  DEFAULT_THEME_PREFERENCE,
  THEME_PREFERENCES,
  cycleThemePreference,
  isThemePreference,
  migrateLegacyThemeValue,
  normalizeThemePreference,
  requireThemePreference,
  resolveAppliedTheme,
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

if (failures.length) {
  console.error(`\nFAILED ${failures.length}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nqa-theme-settings: ok");
