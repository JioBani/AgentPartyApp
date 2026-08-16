/*
 * Points the screens project at the DESIGN SYSTEM instead of its own copy.
 *
 * claude.ai/design mounts an attached design system inside the consuming project
 * at `_ds/<design-system-slug>/`, so a screen can link the system's tokens and
 * stylesheets directly. Doing that is the difference between "a project that
 * happens to look the same" and "a project built out of the design system": the
 * screens then move when the system moves, and there is exactly one copy of the
 * tokens rather than two that can drift.
 *
 * The local `app/` + `foundations/` copies are kept only so the pages can be
 * VERIFIED offline (a link to `_ds/…` resolves locally too, once mirrored) and
 * are not uploaded — the server already has them under the design system.
 *
 * Run: node scripts/link-design-project.mjs [--ds <slug>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_DIR = path.join(root, "build", "design-project");
const dsArg = process.argv.indexOf("--ds");
const DS_SLUG = dsArg > 0
  ? process.argv[dsArg + 1]
  : process.env.DESIGN_SYSTEM_SLUG
  || "agentparty-design-system-as-built-18fbdba3-0e2b-4008-9606-4c6b11063246";

/** `screens/foo.html` sits one level down, so `_ds/…` is one `../` away. */
const REWRITES = [
  ["../foundations/tokens.css", `../_ds/${DS_SLUG}/foundations/tokens.css`],
  ["../foundations/stage.css", `../_ds/${DS_SLUG}/foundations/stage.css`],
  ["../app/design-system.css", `../_ds/${DS_SLUG}/app/design-system.css`],
  ["../app/styles.css", `../_ds/${DS_SLUG}/app/styles.css`],
];

function pages(dir, prefix = "") {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...pages(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".html")) found.push(rel);
  }
  return found;
}

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
  const list = pages(PROJECT_DIR);
  if (list.length === 0) throw new Error(`no pages in ${PROJECT_DIR} — run the capture + split first.`);

  let rewritten = 0;
  for (const relative of list) {
    const file = path.join(PROJECT_DIR, relative);
    const before = fs.readFileSync(file, "utf8");
    let after = before;
    for (const [from, to] of REWRITES) after = after.split(from).join(to);
    if (after !== before) {
      fs.writeFileSync(file, after);
      rewritten += 1;
    }
  }

  // Mirror the system's assets where the rewritten links now point, so the local
  // verify pass exercises the SAME urls the server will serve.
  const mirror = path.join(PROJECT_DIR, "_ds", DS_SLUG);
  fs.rmSync(mirror, { recursive: true, force: true });
  for (const asset of ["app", "foundations"]) {
    const from = path.join(PROJECT_DIR, asset);
    if (fs.existsSync(from)) copyRecursive(from, path.join(mirror, asset));
  }
  // The project's own copies are now dead weight — the pages no longer name them.
  for (const asset of ["app", "foundations"]) {
    fs.rmSync(path.join(PROJECT_DIR, asset), { recursive: true, force: true });
  }

  console.log(`${rewritten}/${list.length} pages now link the design system at _ds/${DS_SLUG}`);
  console.log("upload the pages only — the _ds/ mirror exists locally for verification and is already on the server.");
}

main();
