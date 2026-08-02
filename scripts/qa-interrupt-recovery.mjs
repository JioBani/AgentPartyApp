/*
 * Manual force stop — a stop request must never brick a member.
 *
 * "interrupting" counts as a busy turn, and busy turns queue every later send.
 * Only the harness's turn-end signal clears it, so a turn the harness broke
 * (observed: `[ede_diagnostic] ... stop_reason=tool_use`, and the codex
 * app-server dying mid-turn) left the member stuck in "작업중" forever: chats
 * were accepted by the UI and silently never dispatched.
 *
 * Drives ClaudeAdapter against a fake SDK whose `interrupt()` resolves but which
 * NEVER emits the turn's `result` — the exact wedge — and asserts that:
 *   1) NOTHING recovers on a timer (a slow-but-healthy interrupt must never be
 *      torn out from under the harness), and
 *   2) the user's force stop (the composer's "강제 종료", offered once a Stop has
 *      gone unanswered) releases the turn and flushes what was queued behind it.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const outDir = qaTempDir();

const built = await build({
  entryPoints: [path.join(projectRoot, "src/core/claudeAdapter.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
  external: ["electron", "@anthropic-ai/claude-agent-sdk"],
});
const file = path.join(outDir, "claude-adapter-interrupt.mjs");
writeFileSync(file, built.outputFiles[0].text);
const { ClaudeAdapter } = await import(pathToFileURL(file).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A query that accepts input and an interrupt, but never completes the turn. */
function wedgedQuery() {
  return {
    async interrupt() {},                        // request accepted...
    close() {},
    // ...but the stream yields nothing, so no `result` message ever arrives.
    async *[Symbol.asyncIterator]() { await new Promise(() => {}); },
    supportedCommands: async () => [],
    supportedModels: async () => [],
    mcpServerStatus: async () => ({}),
  };
}

const adapter = new ClaudeAdapter({
  id: "s-interrupt", cwd: os.tmpdir(), model: "sonnet", effort: "medium",
  permissionMode: "default", storageDir: path.join(outDir, "interrupt-store"),
  sdkLoader: async () => ({ query: () => wedgedQuery(), createSdkMcpServer: () => ({}), tool: () => ({}) }),
});

const dispatched = [];
adapter.on("event", (event) => {
  if (event.type === "status" && event.status === "sent") dispatched.push(event.detail);
});

console.log("\nmanual force stop:");

adapter.start();
await sleep(120);
adapter.sendUserTurn("first");
await sleep(60);
assert(dispatched.includes("first"), "the first turn dispatches");

adapter.interrupt();
await sleep(30);
assert(adapter.getSnapshot().status === "interrupting", "stop puts the session in 'interrupting'");

// A send while wedged is queued — this is the state the user hit.
adapter.sendUserTurn("second");
await sleep(30);
assert(adapter.getSnapshot().queuedTurnCount === 1, "a send during 'interrupting' is queued, not dropped");
assert(!dispatched.includes("second"), "the queued send has NOT reached the harness yet");

// The harness never closes the turn — and nothing may auto-recover. Only the
// user decides when a Stop has gone unanswered for long enough.
await sleep(600);
assert(adapter.getSnapshot().status === "interrupting", "no timer escalates on its own — still 'interrupting'");
assert(!dispatched.includes("second"), "and the queued message is still held");

// The user presses 강제 종료.
adapter.forceStop();
await sleep(60);
const recovered = adapter.getSnapshot();
assert(recovered.status !== "interrupting", `force stop leaves 'interrupting' (now ${recovered.status})`);
assert(dispatched.includes("second"), "the queued message is flushed once the turn is released");
assert(recovered.queuedTurnCount === 0, "nothing stays queued behind the dead turn");

// Recovery hands the session back to NORMAL turn accounting: the flushed
// "second" is now the live turn, so "third" queues behind it (correct
// backpressure) instead of being dropped or stuck on the dead turn.
assert(recovered.status === "requesting", "the flushed turn becomes the live turn");
adapter.sendUserTurn("third");
await sleep(60);
assert(adapter.getSnapshot().queuedTurnCount === 1, "a later send queues behind the live turn, not the dead one");

// Force-stopping an idle session must be inert, not a way to desync state.
adapter.forceStop();
adapter.forceStop();
assert(adapter.getSnapshot().queuedTurnCount === 0, "repeated force stops drain rather than corrupt the queue");

adapter.dispose();

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
