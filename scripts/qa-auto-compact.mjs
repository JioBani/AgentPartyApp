/*
 * Auto-compact pure-logic test (offline, no Electron). Locks the per-member
 * auto-compaction contract in src/shared/autoCompact.ts: bounds/step clamping,
 * inheritance (member setting → global default → built-in), the token estimate,
 * normalization of stored/HTTP values, and the threshold-crossing test that the
 * renderer trigger fires on. See docs/디자인 핸드오프/design_handoff_workbench.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(qaDir, { recursive: true });

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function loadModule(entry, name) {
  const out = path.join(qaDir, name);
  await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  return import(pathToFileURL(out).href);
}

const A = await loadModule("src/shared/autoCompact.ts", "auto-compact.mjs");
const {
  AUTO_COMPACT_MIN, AUTO_COMPACT_MAX, DEFAULT_AUTO_COMPACT,
  clampAutoCompactAt, normalizeAutoCompact, resolveAutoCompact, thresholdTokens, shouldAutoCompact,
} = A;

console.log("\nAuto-compact pure logic:");

// bounds + step (settable band is 10..95 — below 10% / above 95% blocked)
assert(clampAutoCompactAt(80) === 80, "80 stays 80");
assert(AUTO_COMPACT_MIN === 10 && AUTO_COMPACT_MAX === 95, "settable band excludes <10 and >95 (10..95)");
assert(clampAutoCompactAt(10) === 10 && clampAutoCompactAt(95) === 95, "boundaries 10 and 95 are selectable");
assert(clampAutoCompactAt(9) === AUTO_COMPACT_MIN, "9 (and below) clamps up to min (10)");
assert(clampAutoCompactAt(96) === AUTO_COMPACT_MAX, "96 (and above) clamps down to max (95)");
assert(clampAutoCompactAt(200) === AUTO_COMPACT_MAX, "way above clamps to max (95)");
assert(clampAutoCompactAt(82) === 82, "integer values are preserved (step 1)");
assert(clampAutoCompactAt(82.6) === 83, "fractional rounds to nearest integer");
assert(clampAutoCompactAt("abc") === DEFAULT_AUTO_COMPACT.at, "garbage → default threshold, not NaN");

// default is OFF (no silent surprise compaction on a fresh install)
assert(DEFAULT_AUTO_COMPACT.on === false, "built-in default is OFF");

// normalize (stored/HTTP coercion)
assert(normalizeAutoCompact(undefined) === undefined, "undefined → undefined (clears override)");
assert(normalizeAutoCompact(null) === undefined, "null → undefined");
const n = normalizeAutoCompact({ on: 1, at: 77 });
assert(n.on === true && n.at === 77, "coerces truthy on + keeps integer at (77)");
assert(normalizeAutoCompact({ at: 90 }).on === false, "missing on → false");

// inheritance: member setting > global default > built-in
assert(resolveAutoCompact({ on: true, at: 70 }, { on: false, at: 90 }).at === 70, "member's own setting wins");
assert(resolveAutoCompact(undefined, { on: true, at: 90 }).at === 90, "no member setting → global default");
assert(resolveAutoCompact(undefined, undefined).on === false, "no setting + no default → built-in (off)");

// token estimate
assert(thresholdTokens(80, 200000) === 160000, "80% of 200K = 160K tokens");
assert(thresholdTokens(80, undefined) === undefined, "unknown window → no estimate (never guessed)");
assert(thresholdTokens(80, 0) === undefined, "zero window → no estimate");

// crossing test (what the renderer trigger fires on)
assert(shouldAutoCompact({ on: true, at: 80 }, 160000, 200000) === true, "used/total == threshold → fires");
assert(shouldAutoCompact({ on: true, at: 80 }, 170000, 200000) === true, "above threshold → fires");
assert(shouldAutoCompact({ on: true, at: 80 }, 150000, 200000) === false, "below threshold → no fire");
assert(shouldAutoCompact({ on: false, at: 50 }, 199000, 200000) === false, "off → never fires even when full");
assert(shouldAutoCompact({ on: true, at: 80 }, 160000, undefined) === false, "unknown window → never fires (no fabricated denominator)");
assert(shouldAutoCompact({ on: true, at: 80 }, undefined, 200000) === false, "unknown usage → never fires");

console.log(failures.length ? `\nAUTO-COMPACT FAILED (${failures.length})` : "\nAUTO-COMPACT PASSED");
process.exit(failures.length ? 1 : 0);
