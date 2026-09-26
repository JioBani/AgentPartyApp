#!/usr/bin/env node
/*
 * Removes worktrees without ever deleting through a link.
 *
 *   node scripts/remove-worktree.mjs .worktrees/<topic> [more…]
 *
 * The shared install was wiped twice (2026-08-17, 2026-08-23) by a recursive
 * delete that walked through a worktree's node_modules junction, and a
 * worktree's own install can hide a link too (npm's `file:` dependency
 * `@agentparty/protocol` points into another checkout). So for each worktree:
 *
 *   1. find EVERY link (junction/symlink) inside it and remove only the link,
 *   2. check that the shared install and every link target are unchanged,
 *   3. `git worktree remove --force`, then `git worktree prune`.
 *
 * It stops at the first surprise and leaves everything after it untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findInstallRoot } from "./lib/installRoot.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shared = path.join(findInstallRoot(repo), "node_modules");
const entries = (dir) => fs.readdirSync(dir).length;

function fail(message) {
  console.error(`STOP: ${message}`);
  process.exit(1);
}

/** Every reparse point under `root`, outermost first. Windows-only mechanism; elsewhere, symlinks. */
function linksUnder(root) {
  if (process.platform === "win32") {
    const ps = `Get-ChildItem -LiteralPath '${root.replace(/'/g, "''")}' -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }`;
    const out = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout;
    return out.split(/\r?\n/).filter(Boolean).sort((a, b) => a.length - b.length);
  }
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) found.push(full);
      else if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return found;
}

function unlink(link) {
  if (!fs.lstatSync(link, { throwIfNoEntry: false })) return; // an outer link already took it
  if (process.platform === "win32") {
    let isDir = true;
    try { isDir = fs.statSync(link).isDirectory(); } catch { /* dangling: a junction */ }
    // rmdir / del on a link remove the link itself, never what it points at.
    spawnSync("cmd", isDir ? ["/c", "rmdir", link] : ["/c", "del", "/q", link]);
  } else {
    fs.unlinkSync(link);
  }
  if (fs.lstatSync(link, { throwIfNoEntry: false })) fail(`could not remove the link ${link}`);
}

const targets = process.argv.slice(2);
if (!targets.length) fail("name at least one worktree path");
const sharedBefore = entries(shared);

for (const arg of targets) {
  const worktree = path.resolve(arg);
  if (worktree === repo) fail("refusing to remove the main checkout");
  if (!fs.existsSync(worktree)) fail(`${arg} does not exist`);

  const links = linksUnder(worktree);
  const watched = links
    .map((link) => { try { return fs.realpathSync(link); } catch { return null; } })
    .filter((target) => target && !target.startsWith(worktree + path.sep))
    .map((target) => ({ target, count: entries(target) }));
  const unchanged = (step) => {
    if (entries(shared) !== sharedBefore) fail(`the shared install changed ${step} (${arg})`);
    for (const { target, count } of watched) {
      if (!fs.existsSync(target) || entries(target) !== count) fail(`link target ${target} changed ${step} (${arg})`);
    }
  };

  links.forEach(unlink);
  unchanged("while unlinking");
  const removed = spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree], { encoding: "utf8" });
  if (removed.status !== 0 && fs.existsSync(worktree)) {
    if (linksUnder(worktree).length) fail(`${arg}: ${removed.stderr.trim()} (links remain)`);
    // git refused (e.g. its .git file is gone) and no link is left inside:
    // a plain recursive delete can no longer reach outside the folder.
    fs.rmSync(worktree, { recursive: true, force: true });
  }
  spawnSync("git", ["-C", repo, "worktree", "prune"]);
  if (fs.existsSync(worktree)) fail(`${arg} is still there — a process may hold files in it`);
  unchanged("while removing");
  console.log(`removed ${arg} (links unlinked: ${links.length})`);
}
