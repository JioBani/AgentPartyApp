/*
 * Runs the desktop main-process compiler with its single authoritative config.
 * Mobile Link is intentionally excluded there while the feature is detached.
 * Extra arguments are passed through: `--noEmit` for type checks, nothing for
 * builds, and `--watch` for development.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { binPath } from "./lib/installRoot.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const tsc = binPath(projectRoot, "tsc");

const child = spawn(tsc, ["-p", "tsconfig.main.json", ...process.argv.slice(2)], {
  cwd: projectRoot,
  shell: isWin,
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
