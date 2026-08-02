/*
 * Proves — by running it — that two checkouts can execute the same unit test at
 * the same time without reading each other's code.
 *
 * The guard in `qa-temp-isolation.mjs` checks WHERE bundles go. This one checks
 * what actually happens when two of them run together, because the fault this
 * replaces was invisible to every check that stopped at intent: both lanes
 * wrote one file, both imported it, and both saw green.
 *
 * It provisions its own second checkout (a throwaway worktree nested inside
 * this one, so it resolves the same install without anything being linked),
 * plants a DIFFERENT value in each copy of the same source, bundles and imports
 * repeatedly on both sides at once, and requires each side to see only its own
 * value. Before this fix that failed: whichever run wrote last decided what
 * both imported.
 *
 * Run: node scripts/qa-temp-collision.mjs   (needs no unit-test slot — it only
 * ever writes inside this worktree)
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Nested on purpose: a sibling directory would have no `node_modules` above it,
// and creating one would mean touching the shared install.
const other = path.join(root, ".qa-collision-checkout");
const branch = "tmp/qa-collision-proof";
const SOURCE = "src/shared/messageQueue.ts";
const MARKER = /export const QUEUE_LIMIT = \d+;/;
const PASSES = 6;

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

/**
 * @param relSource source to bundle
 * @param sharedDir when set, both checkouts write here — the OLD arrangement,
 *   run as a negative control so we know this proof can still detect the fault
 *   it was written for. A green that cannot go red proves nothing.
 */
const probe = (relSource, sharedDir) => `
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { qaTempDir } from "./scripts/lib/qaTemp.mjs";
const shared = ${JSON.stringify(sharedDir || "")};
const out = shared || qaTempDir();
if (shared) mkdirSync(shared, { recursive: true });
for (let i = 0; i < ${PASSES}; i += 1) {
  const built = await build({ entryPoints: [path.join(process.cwd(), ${JSON.stringify(relSource)})], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
  const file = path.join(out, "collision-probe.mjs");
  writeFileSync(file, built.outputFiles[0].text);
  // Long enough that an overlapping writer would win the race if there were one.
  await new Promise((resolve) => setTimeout(resolve, 120));
  const loaded = await import(pathToFileURL(file).href + "?pass=" + i);
  process.stdout.write(JSON.stringify({ file, value: loaded.QUEUE_LIMIT }) + "\\n");
}
`;

async function main() {
  cleanup();
  execFileSync("git", ["worktree", "add", "-q", "--force", "-b", branch, other, "HEAD"], { cwd: root, stdio: "pipe" });

  const originals = new Map();
  try {
    plant(root, 811, originals);
    plant(other, 822, originals);
    fs.writeFileSync(path.join(root, "collision-probe.run.mjs"), probe(SOURCE));
    fs.writeFileSync(path.join(other, "collision-probe.run.mjs"), probe(SOURCE));

    console.log("\ntwo checkouts run the same unit test at the same time:");
    const [a, b] = await Promise.all([
      run(process.execPath, ["collision-probe.run.mjs"], { cwd: root, encoding: "utf8" }),
      run(process.execPath, ["collision-probe.run.mjs"], { cwd: other, encoding: "utf8" }),
    ]);
    const mine = parse(a.stdout);
    const theirs = parse(b.stdout);

    assert(mine.length === PASSES && theirs.length === PASSES, `both sides completed all ${PASSES} passes`);
    assert(mine.every((r) => r.value === 811), `this checkout only ever saw its own source (${distinct(mine)})`);
    assert(theirs.every((r) => r.value === 822), `the other checkout only ever saw its own (${distinct(theirs)})`);
    assert(mine[0].file !== theirs[0].file, "and they never wrote to the same file");
    console.log(`  · ${mine[0].file}`);
    console.log(`  · ${theirs[0].file}`);

    // Negative control: put them back on one directory and require the fault to
    // reappear. Without this the run above could be green because the probe is
    // blind rather than because the fix works.
    console.log("\nnegative control — pointed at ONE directory, the fault comes back:");
    const sharedDir = path.join(root, ".qa-collision-shared");
    fs.writeFileSync(path.join(root, "collision-probe.run.mjs"), probe(SOURCE, sharedDir));
    fs.writeFileSync(path.join(other, "collision-probe.run.mjs"), probe(SOURCE, sharedDir));
    const [c, d] = await Promise.all([
      run(process.execPath, ["collision-probe.run.mjs"], { cwd: root, encoding: "utf8" }),
      run(process.execPath, ["collision-probe.run.mjs"], { cwd: other, encoding: "utf8" }),
    ]);
    const crossed = parse(c.stdout).some((r) => r.value !== 811) || parse(d.stdout).some((r) => r.value !== 822);
    assert(crossed, `sharing one directory really does make a run read the other's source (${distinct(parse(c.stdout))} / ${distinct(parse(d.stdout))})`);
    fs.rmSync(sharedDir, { recursive: true, force: true });
  } finally {
    for (const [file, text] of originals) fs.writeFileSync(file, text);
    fs.rmSync(path.join(root, "collision-probe.run.mjs"), { force: true });
    cleanup();
  }

  console.log(failures.length ? `\nQA TEMP COLLISION FAILED (${failures.length})` : "\nQA TEMP COLLISION PASSED");
  process.exit(failures.length ? 1 : 0);
}

/** Writes a value only this checkout has, remembering the original to restore. */
function plant(checkout, value, originals) {
  const file = path.join(checkout, SOURCE);
  const text = fs.readFileSync(file, "utf8");
  if (!MARKER.test(text)) {
    throw new Error(`No marker to plant in ${file} — this proof needs a constant it can vary.`);
  }
  originals.set(file, text);
  fs.writeFileSync(file, text.replace(MARKER, `export const QUEUE_LIMIT = ${value};`));
}

const parse = (out) => out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const distinct = (rows) => [...new Set(rows.map((r) => r.value))].join(",");

/** Removes the throwaway checkout and its branch, tolerating a half-made one. */
function cleanup() {
  try { execFileSync("git", ["worktree", "remove", "--force", other], { cwd: root, stdio: "pipe" }); } catch { /* not there */ }
  try { fs.rmSync(other, { recursive: true, force: true }); } catch { /* already gone */ }
  try { execFileSync("git", ["worktree", "prune"], { cwd: root, stdio: "pipe" }); } catch { /* nothing to prune */ }
  try { execFileSync("git", ["branch", "-D", branch], { cwd: root, stdio: "pipe" }); } catch { /* never created */ }
}

main().catch((error) => { cleanup(); console.error(error); process.exit(1); });
