import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const result = await build({
    entryPoints: [path.join(root, "src/shared/themeCatalog.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    logLevel: "silent",
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`;
  const catalog = await import(moduleUrl);
  console.log(`[theme-catalog] validated ${catalog.THEMES.length} built-in themes: ${catalog.THEME_PREFERENCES.join(", ")}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[theme-catalog] validation failed: ${message}`);
  process.exitCode = 1;
}
