/* Pure regression coverage for model-authored local file paths. */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [path.join(root, "src/shared/localFiles.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const bundlePath = path.join(qaTempDir(), "localFiles.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const local = await import(pathToFileURL(bundlePath).href);

const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

assert(local.normalizeLocalFileTarget("/C:/Project/발표.html", "win32") === "C:/Project/발표.html", "URL-shaped Windows drive path loses its synthetic leading slash");
assert(local.normalizeLocalFileTarget("\\C:\\Project\\발표.html", "win32") === "C:\\Project\\발표.html", "backslash-prefixed Windows drive path is restored");
assert(local.normalizeLocalFileTarget("C:\\Project\\발표.html", "win32") === "C:\\Project\\발표.html", "normal Windows drive path is unchanged");
assert(local.normalizeLocalFileTarget("/home/dev/발표.html", "linux") === "/home/dev/발표.html", "POSIX/WSL absolute path is unchanged");
assert(local.normalizeLocalFileTarget("/C:/literal-posix-name", "linux") === "/C:/literal-posix-name", "drive-like POSIX filename is unchanged off Windows");
assert(local.normalizeLocalFileTarget("\\\\server\\share\\발표.html", "win32") === "\\\\server\\share\\발표.html", "UNC path is unchanged");
assert(local.isWindowsDrivePath("C:/Project/a.html") && local.isWindowsDrivePath("/C:/Project/a.html"), "plain and URL-shaped drive paths are classified as files");

if (failures.length) {
  console.error(`\nLOCAL FILE PATH QA FAILED (${failures.length})`);
  process.exit(1);
}
console.log("\nLOCAL FILE PATH QA PASSED");
