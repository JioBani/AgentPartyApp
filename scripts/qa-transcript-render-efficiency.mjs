/* Pure regressions for transcript structural sharing and volatile snapshot skips. */
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(qaTempDir(), "transcript-render-efficiency.mjs");
const bundled = await build({
  entryPoints: [path.join(root, "scripts/fixtures/transcriptRenderEfficiency.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
writeFileSync(output, bundled.outputFiles[0].text);
const { run } = await import(pathToFileURL(output).href);

const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "ok" : "FAIL"}: ${message}`);
  if (!condition) failures.push(message);
};
run(assert);

console.log(failures.length ? `\nTRANSCRIPT RENDER EFFICIENCY FAILED (${failures.length})` : "\nTRANSCRIPT RENDER EFFICIENCY PASSED");
process.exit(failures.length ? 1 : 0);
