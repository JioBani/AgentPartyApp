#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(label, command, args) {
  const startedAt = Date.now();
  console.log(`\n== ${label} ==`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32" && /\.cmd$/i.test(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
  console.log(`== ${label} OK (${((Date.now() - startedAt) / 1000).toFixed(1)}s) ==`);
}

const node = process.execPath;
run("release source lint", node, ["scripts/release-lint.mjs"]);
run("single build and Windows packaging", node, ["scripts/package-win.mjs", "--no-open"]);
run("packaged application E2E", node, ["scripts/e2e-packaged-release.mjs"]);
run("release artifact lint", node, ["scripts/release-lint.mjs", "--artifacts"]);

console.log("\nRELEASE PREPARE PASSED — commit/tag/push, then publish the existing artifacts.");
