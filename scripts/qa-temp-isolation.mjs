/*
 * The QA scripts must not write their bundles anywhere two worktrees share.
 *
 * This is a guard against a fault that CANNOT be seen from inside the test that
 * suffers it. When two lanes wrote their bundles to the same path, the loser
 * imported the winner's code, every assertion passed, and the summary said
 * green — for source the lane had never written. Nothing in the output named
 * the file it actually ran. So the invariant is checked here instead of hoped
 * for, and the check is by ACTUAL behaviour: bundles are written and their
 * locations compared, not merely a constant re-read.
 *
 * Run: node scripts/qa-temp-isolation.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { qaTempDir, qaTempFile, projectRoot } from "./lib/qaTemp.mjs";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

console.log("\nQA bundles live in the worktree, not the shared install:");
{
  const dir = qaTempDir();
  assert(fs.existsSync(dir), "the directory is created on demand");
  assert(path.resolve(dir).startsWith(path.resolve(here) + path.sep), `it is inside THIS worktree (${dir})`);
  assert(!path.resolve(dir).split(path.sep).includes("node_modules"), "and not inside node_modules — that install is shared between every worktree");
  assert(path.resolve(projectRoot) === path.resolve(here), "the root it derives from is the checkout the script lives in");
}

/*
 * The shared install is shared through a LINK, so a path check alone can be
 * fooled: `<worktree>/node_modules/...` looks lane-private and is not. Resolve
 * it and prove the bundle directory is not under the real shared location.
 */
console.log("\nthe shared install really is shared — and the bundles are not in it:");
{
  const link = path.join(here, "node_modules");
  const realInstall = fs.existsSync(link) ? fs.realpathSync(link) : "";
  const realTemp = fs.realpathSync(qaTempDir());
  assert(Boolean(realInstall), "the install is reachable from this worktree");
  assert(!realTemp.startsWith(realInstall + path.sep), `the bundles resolve outside it (${realTemp})`);
  if (realInstall && !realInstall.startsWith(path.resolve(here) + path.sep)) {
    console.log(`  · confirmed shared: node_modules resolves to ${realInstall}`);
  }
}

/*
 * Every script, not just this one.
 *
 * The first pass at this fix rewrote 69 scripts by matching how they spelled
 * the path — and missed two that spelled it differently. They kept writing to
 * the shared install while the check above reported isolation, because the
 * check only ever looked at its own answer. That is the same fault one level
 * up: a guard that inspects part of the surface and reports on all of it.
 *
 * So the rule is stated about the whole surface. Any script that bundles a
 * module and imports the result has to get its directory from this one helper —
 * whatever spelling it would otherwise have invented.
 */
console.log("\nevery bundling script asks the same place where to write:");
{
  const dir = path.join(here, "scripts");
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".mjs") && !name.endsWith(".js")) continue;
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    // "Bundles something and imports what it built" — the shape that needs a
    // private place to put it.
    const bundles = /from "esbuild"/.test(text) && /pathToFileURL/.test(text);
    if (!bundles) continue;
    if (!/qaTempDir\(|qaTempFile\(|qaRunDir\(/.test(text)) {
      offenders.push(name);
    }
  }
  assert(offenders.length === 0, offenders.length
    ? `these decide for themselves where to write: ${offenders.join(", ")}`
    : "no script rolls its own scratch location");
}

/*
 * The property that actually matters, exercised rather than reasoned about: two
 * checkouts must not choose the same file for the same bundle name. Asking the
 * OTHER worktree's own copy of this module keeps the test honest — it reads the
 * answer that worktree would really use.
 */
console.log("\ntwo worktrees choose different files for the same bundle name:");
{
  const mine = qaTempFile("collision-probe.mjs");
  const others = siblingWorktrees();
  if (!others.length) {
    // Never silently "pass" a check that did not run.
    assert(false, "SKIPPED — no sibling worktree found to compare against (run from a worktree checkout)");
  }
  const behind = [];
  for (const other of others) {
    const answer = askWorktree(other, "collision-probe.mjs");
    if (!answer) {
      // A checkout that predates this fix still writes into the shared install,
      // which is somewhere this worktree no longer writes at all — so it cannot
      // collide with THIS lane. It can still collide with other old checkouts,
      // and that is worth saying out loud rather than counting as clean.
      behind.push(path.basename(other));
      continue;
    }
    assert(path.resolve(answer) !== path.resolve(mine), `${path.basename(other)} picks a different file (${answer})`);
  }
  if (behind.length) {
    console.log(`  · ${behind.length} checkout(s) not on this fix yet: ${behind.join(", ")}`);
    console.log("    They write to the shared install, so they cannot collide with THIS worktree —");
    console.log("    but they can still collide with each other until they take this change.");
  }
}

console.log(failures.length ? `\nQA TEMP ISOLATION FAILED (${failures.length})` : "\nQA TEMP ISOLATION PASSED");
process.exit(failures.length ? 1 : 0);

/** Every other worktree of this repository, from git itself rather than a guess. */
function siblingWorktrees() {
  try {
    const listing = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: here, encoding: "utf8" });
    return listing
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter((dir) => path.resolve(dir) !== path.resolve(here));
  } catch {
    return [];
  }
}

/** Asks a worktree's OWN copy of the helper where it would put a bundle. */
function askWorktree(dir, name) {
  const helper = path.join(dir, "scripts", "lib", "qaTemp.mjs");
  if (!fs.existsSync(helper)) {
    return "";
  }
  try {
    return execFileSync(
      process.execPath,
      ["-e", `import(${JSON.stringify(pathToUrl(helper))}).then((m) => process.stdout.write(m.qaTempFile(${JSON.stringify(name)})))`],
      { cwd: dir, encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
}

function pathToUrl(file) {
  return new URL(`file:///${path.resolve(file).replace(/\\/g, "/")}`).href;
}
