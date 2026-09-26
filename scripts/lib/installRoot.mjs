/*
 * Where the dependency install lives, as Node itself would find it.
 *
 * Worktrees sit INSIDE the main checkout (`.worktrees/<topic>`) and have no
 * node_modules of their own: Node resolves packages by walking up the tree, so
 * they use the main checkout's single install with no link to manage (only
 * packaging needs one — see linkInstallForPackaging). Scripts
 * that name a tool or package by PATH must walk up the same way — a hard-coded
 * `<projectRoot>/node_modules` only works in the main checkout.
 */
import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/** The nearest directory at or above `from` that has a node_modules folder. */
export function findInstallRoot(from) {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, "node_modules"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`No node_modules at or above ${from}. Run \`npm install\` in the main checkout.`);
    }
    dir = parent;
  }
}

/** A path inside the install that serves `from` (e.g. installPath(root, ".bin", "tsc.cmd")). */
export function installPath(from, ...segments) {
  return path.join(findInstallRoot(from), "node_modules", ...segments);
}

/** The .bin shim for a build tool, as npm scripts would run it. */
export function binPath(from, name) {
  return installPath(from, ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

/**
 * electron-builder is the one tool that does NOT walk up: it reads the Electron
 * version and collects the app's production dependencies from
 * `<projectRoot>/node_modules` only. For a worktree, link that folder to the
 * shared install for the duration of the packaging run and remove the LINK
 * (never its target) when the process exits — success, failure, or Ctrl+C.
 * A link left behind by a killed run is removed by scripts/remove-worktree.mjs.
 *
 * Returns true when a link was created (i.e. this is a worktree).
 */
export function linkInstallForPackaging(projectRoot) {
  const local = path.join(projectRoot, "node_modules");
  if (existsSync(local)) return false;
  const shared = installPath(projectRoot);
  if (process.platform === "win32") {
    const made = spawnSync("cmd", ["/c", "mklink", "/J", local, shared], { encoding: "utf8" });
    if (made.status !== 0) throw new Error(`could not link ${local} → ${shared}: ${made.stderr || made.stdout}`);
  } else {
    symlinkSync(shared, local, "dir");
  }
  const unlink = () => {
    if (!lstatSync(local, { throwIfNoEntry: false })?.isSymbolicLink()) return;
    // rmdir on a junction / unlink on a symlink removes the link itself only.
    if (process.platform === "win32") spawnSync("cmd", ["/c", "rmdir", local]);
    else unlinkSync(local);
  };
  process.on("exit", unlink);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));
  return true;
}
