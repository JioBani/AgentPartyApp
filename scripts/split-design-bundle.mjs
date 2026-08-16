/*
 * Splits what was captured into the two things it actually is.
 *
 *   build/design-bundle/   → the DESIGN SYSTEM: foundations + components.
 *                            What something is, its variants, and when to use it.
 *   build/design-project/  → the PROJECT: whole screens and modals, built out of
 *                            those components.
 *
 * They were one pile at first, and that pile read as "a project" rather than a
 * design system — screens are the output of a system, not the system. Each side
 * gets its own copy of the app stylesheets and font, because a page can only
 * link within its own project.
 *
 * Run after the build/capture scripts:
 *   node scripts/split-design-bundle.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEM_DIR = path.join(root, "build", "design-bundle");
const PROJECT_DIR = path.join(root, "build", "design-project");

/** Directories that belong to the project rather than the design system. */
const PROJECT_DIRS = ["screens", "modals", "workbench", "transcript", "cards"];
/** Shared assets both sides need their own copy of. */
const SHARED = ["app", "foundations/tokens.css", "foundations/stage.css"];

function copyRecursive(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) copyRecursive(path.join(from, entry), path.join(to, entry));
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function main() {
  if (!fs.existsSync(path.join(SYSTEM_DIR, "components"))) {
    throw new Error("no components/ — run scripts/capture-design-components.mjs first.");
  }
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });

  for (const shared of SHARED) {
    const from = path.join(SYSTEM_DIR, shared);
    if (fs.existsSync(from)) copyRecursive(from, path.join(PROJECT_DIR, shared));
  }

  let moved = 0;
  for (const dir of PROJECT_DIRS) {
    const from = path.join(SYSTEM_DIR, dir);
    if (!fs.existsSync(from)) continue;
    copyRecursive(from, path.join(PROJECT_DIR, dir));
    moved += fs.readdirSync(from).length;
    // The design system must not keep them: a card index listing screens is
    // exactly what made the first upload read as a project.
    fs.rmSync(from, { recursive: true, force: true });
  }

  // The per-screen card markers stay useful inside the project, but the
  // system-side index files must be rebuilt without them.
  for (const stale of ["_ds_manifest.json", "_sizes.json", "_capture.json"]) {
    const from = path.join(SYSTEM_DIR, stale);
    if (fs.existsSync(from)) {
      if (stale === "_capture.json") fs.copyFileSync(from, path.join(PROJECT_DIR, stale));
      fs.rmSync(from);
    }
  }

  const systemPages = countPages(SYSTEM_DIR);
  const projectPages = countPages(PROJECT_DIR);
  console.log(`design system  → ${SYSTEM_DIR}  (${systemPages} pages)`);
  console.log(`design project → ${PROJECT_DIR} (${projectPages} pages, ${moved} files moved)`);
  console.log("next: verify → manifest → upload each to its own project.");
}

function countPages(dir, count = 0) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count = countPages(path.join(dir, entry.name), count);
    else if (entry.name.endsWith(".html")) count += 1;
  }
  return count;
}

main();
