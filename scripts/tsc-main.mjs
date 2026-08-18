/*
 * `tsc -p <the right main tsconfig>` — with or without the optional mobile
 * pipe, decided by `mobile-pipe.mjs`. Extra arguments are passed through, so
 * this stands in for the plain tsc call everywhere: `--noEmit` for the type
 * check, nothing for the build, `--watch` for dev.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mainTsconfig, mobilePipeNotice } from "./mobile-pipe.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const tsc = path.join(projectRoot, "node_modules", ".bin", isWin ? "tsc.cmd" : "tsc");

const notice = mobilePipeNotice();
if (notice) console.log(notice);

const child = spawn(tsc, ["-p", mainTsconfig(), ...process.argv.slice(2)], {
  cwd: projectRoot,
  shell: isWin,
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
