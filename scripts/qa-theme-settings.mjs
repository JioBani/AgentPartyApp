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
  isThemePreference,
  normalizeThemePreference,
  requireThemePreference,
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

if (failures.length) {
  console.error(`\nFAILED ${failures.length}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nqa-theme-settings: ok");
