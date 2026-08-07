/*
 * Regression: a debug log write must never take the app down.
 *
 * Seen for real. A session's storage directory was deleted while its harness was
 * still running; the next `fs.appendFileSync` in RawLogger.write threw ENOENT
 * from a stdout handler, nothing caught it, and Electron showed "A JavaScript
 * error occurred in the main process". The whole app died because one debug line
 * could not be stored.
 *
 * The trigger there was a QA cleanup, but the failure mode is not exotic: a full
 * disk, a file locked by a backup agent, or a revoked permission all arrive as
 * the same throw from the same line, on a user's machine, mid-session.
 *
 * So the rule: raw logging is an aid, and an aid that can kill its host is worse
 * than no aid. It must degrade to OFF and say so — never silently (debug mode
 * still reads as on, so a quietly-stopped file would send someone hunting).
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = await build({
  entryPoints: [path.join(projectRoot, "src/core/rawLogger.ts")],
  bundle: true, format: "esm", platform: "node", write: false, external: ["electron"],
});
const bundlePath = path.join(qaTempDir(), "raw-logger.mjs");
writeFileSync(bundlePath, built.outputFiles[0].text);
const { RawLogger } = await import(pathToFileURL(bundlePath).href);

let failures = 0;
const assert = (condition, label, detail) => {
  console.log(`  ${condition ? "✓" : "✗"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!condition) failures += 1;
};

const baseDir = path.join(os.tmpdir(), `agentparty-qa-rawlog-${process.pid}`);
rmSync(baseDir, { recursive: true, force: true });

console.log("\nNormal operation:");
let disabled = [];
const logger = RawLogger.open({ baseDir, sessionId: "s-1", maxFiles: 10, maxBytes: 1_000_000, onDisabled: (r) => disabled.push(r) });
assert(Boolean(logger), "opens against a writable directory");
logger.write("in", { hello: "world" });
assert(existsSync(logger.filePath), "the line reached a file on disk");
assert(readFileSync(logger.filePath, "utf8").includes("world"), "with the payload in it");
assert(disabled.length === 0, "and nothing was reported", disabled.join("; "));

console.log("\nThe directory disappears under a live logger (the reported crash):");
rmSync(baseDir, { recursive: true, force: true });
let threw;
try {
  logger.write("in", { after: "removal" });
} catch (error) {
  threw = error;
}
assert(!threw, "write does not throw", threw && String(threw.message).slice(0, 70));
assert(disabled.length === 1, "the failure is reported exactly once", `${disabled.length} report(s)`);
assert(/ENOENT|no such file/i.test(disabled[0] || ""), "and the report names the real cause", (disabled[0] || "").slice(0, 80));

// Sticky causes (a full disk, a lock) would otherwise repeat the report forever
// and re-attempt an append per harness line.
const reportsAfterFirst = disabled.length;
logger.write("in", { again: 1 });
logger.write("in", { again: 2 });
assert(disabled.length === reportsAfterFirst, "further writes stay quiet", `${disabled.length} total`);

console.log("\nAn unusable location at open time:");
disabled = [];
// A FILE where the log directory should be: mkdir fails, the same way a revoked
// permission would, and the caller must get undefined rather than an exception.
const blocked = path.join(os.tmpdir(), `agentparty-qa-rawlog-blocked-${process.pid}`);
rmSync(blocked, { recursive: true, force: true });
mkdirSync(path.dirname(blocked), { recursive: true });
writeFileSync(blocked, "not a directory");
let openThrew;
let opened;
try {
  opened = RawLogger.open({ baseDir: blocked, sessionId: "s-2", maxFiles: 10, maxBytes: 1_000, onDisabled: (r) => disabled.push(r) });
} catch (error) {
  openThrew = error;
}
assert(!openThrew, "open does not throw", openThrew && String(openThrew.message).slice(0, 70));
assert(opened === undefined, "it returns no logger");
assert(disabled.length === 1, "and reports why", (disabled[0] || "").slice(0, 80));

console.log("\nRetention still prunes:");
disabled = [];
const pruneDir = path.join(os.tmpdir(), `agentparty-qa-rawlog-prune-${process.pid}`);
rmSync(pruneDir, { recursive: true, force: true });
for (let i = 0; i < 4; i += 1) {
  RawLogger.open({ baseDir: pruneDir, sessionId: `s-${i}`, maxFiles: 2, maxBytes: 1_000, onDisabled: (r) => disabled.push(r) });
}
assert(readdirSync(pruneDir).length <= 2, "no more than maxFiles remain", `${readdirSync(pruneDir).length} files`);
assert(disabled.length === 0, "with nothing reported", disabled.join("; "));

rmSync(baseDir, { recursive: true, force: true });
rmSync(blocked, { recursive: true, force: true });
rmSync(pruneDir, { recursive: true, force: true });

console.log("");
if (failures) {
  console.log(`RAW LOGGER RESILIENCE FAILED (${failures})`);
  process.exit(1);
}
console.log("RAW LOGGER RESILIENCE PASSED");
