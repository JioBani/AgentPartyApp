/*
 * Background-task liveness QA.
 *
 * Idle-sleep tears a harness process down. The one thing it must never do is
 * tear one down while work is still running behind a finished turn — a
 * backgrounded shell, a workflow, a detached subagent. This proves the signal it
 * reads is both SAFE (detached work keeps the member awake) and USEFUL (ordinary
 * foreground tool calls do not).
 *
 * The rule under test was settled by MEASUREMENT, not reasoning, after a first
 * attempt shipped a guard that protected nothing. Driving a real member through
 * the automation API with harness debug logging on showed:
 *
 *   - a foreground `Bash` emits NO `task_*` events at all;
 *   - a `run_in_background: true` Bash emits `task_started` and nothing more
 *     while it runs.
 *
 * The earlier version required `task_updated.patch.is_backgrounded` before
 * counting a task. That patch belongs to the Ctrl+B path and never arrives for
 * `run_in_background`, so the count stayed 0, the member was torn down with a
 * live background shell, and the guard existed in name only. These assertions
 * pin the measured shape so that cannot come back.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = qaTempDir();

const built = await build({
  entryPoints: [path.join(projectRoot, "src/core/backgroundTasks.ts")],
  bundle: true, format: "esm", platform: "node", write: false, external: ["electron"],
});
const bundlePath = path.join(qaDir, "background-tasks.mjs");
writeFileSync(bundlePath, built.outputFiles[0].text);
const { BackgroundTaskTracker } = await import(pathToFileURL(bundlePath).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

console.log("Background task liveness:");

// --- The measured shape: only backgrounded work raises a task. ---------------
const measured = new BackgroundTaskTracker();
// Verbatim from a real run's debug log (foreground `echo hello` in the same
// session produced no task_* event at all, which is why none appears here).
measured.started({
  task_id: "bntf39f8e",
  tool_use_id: "toolu_01LDrwKAvMVdhtqAB7aBcdU7",
  description: "Sleep 300 seconds in background",
  task_type: "local_bash",
});
assert(measured.count === 1, `a run_in_background Bash keeps the member awake on task_started alone (got ${measured.count})`);
measured.notified({ task_id: "bntf39f8e", status: "completed" });
assert(measured.count === 0, `and releases it when the harness reports it settled (got ${measured.count})`);

// --- Recorded traffic: replay must not throw and must stay conservative. -----
const fixture = path.join(projectRoot, "scripts/fixtures/subagents/claude-haiku-2subagents.jsonl");
const recorded = readFileSync(fixture, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
  .filter(Boolean);

const replay = new BackgroundTaskTracker();
let started = 0;
for (const message of recorded) {
  if (message.type !== "system") continue;
  if (message.subtype === "task_started") { started += 1; replay.started(message); }
  if (message.subtype === "task_updated") replay.updated(message);
  if (message.subtype === "task_notification") replay.notified(message);
}
assert(started === 5, `the recording still exercises the path (${started} task_started)`);
// The two `local_agent` subagents settle; the three `local_bash` entries never
// do. Under the measured rule those keep the member awake, which is the
// deliberate bias — wrong in the direction that costs memory, not work. Asserted
// so the conservatism is a recorded decision rather than an accident, and so the
// number moves visibly if a future SDK settles them.
assert(
  replay.count === 3,
  `unsettled recorded tasks keep the member awake (got ${replay.count}: ${replay.describe().join(", ") || "none"})`,
);

// --- Terminal statuses release the member. -----------------------------------
const mixed = new BackgroundTaskTracker();
mixed.started({ task_id: "t1", task_type: "local_workflow" });
assert(mixed.count === 1, `a workflow task counts (got ${mixed.count})`);
mixed.updated({ task_id: "t1", patch: { status: "failed" } });
assert(mixed.count === 0, `a failed background task no longer blocks sleep (got ${mixed.count})`);
assert(mixed.describe().length === 0, "and is no longer named as a reason");

// --- A restart must not inherit the dead query's tasks. -----------------------
const restarted = new BackgroundTaskTracker();
restarted.started({ task_id: "t3", task_type: "local_bash" });
restarted.reset();
assert(restarted.count === 0, "a restarted session starts with nothing in flight");

if (failures.length) {
  console.log(`\nBACKGROUND TASKS FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("\nBACKGROUND TASKS PASSED");
