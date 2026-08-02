/*
 * Interrupt notice vs real failure (R-90 / R-91).
 *
 * Claude's SDK closes a stopped turn with `is_error: true` ("Request interrupted
 * by user" / `error_during_execution`). That used to paint a red error block —
 * the same shape as a real failure — so members treated a normal stop as a bug.
 *
 * R-90: an intentional stop becomes an info diagnostic (what happened + what next).
 * R-91: a real failure (interrupt request rejected, or a turn error without a stop)
 *       still emits `type: "error"`.
 *
 * Also locks Cursor's finishInterrupted path on the same guidance shape.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = qaTempDir();

async function bundle(entry, name) {
  const built = await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true, format: "esm", platform: "node", write: false,
    external: ["electron", "@anthropic-ai/claude-agent-sdk"],
  });
  const file = path.join(outDir, name);
  writeFileSync(file, built.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

function interruptingQuery(resultMsg, { rejectInterrupt = false } = {}) {
  let resolveIter;
  const gate = new Promise((r) => { resolveIter = r; });
  return {
    async interrupt() {
      if (rejectInterrupt) throw new Error("interrupt RPC failed: no such turn");
      resolveIter();
    },
    close() {},
    async *[Symbol.asyncIterator]() {
      yield { type: "assistant", message: { content: [{ type: "text", text: "작업 중..." }] } };
      await gate;
      if (resultMsg) yield resultMsg;
    },
    supportedCommands: async () => [],
    supportedModels: async () => [],
    mcpServerStatus: async () => ({}),
    initializationResult: async () => ({}),
  };
}

const { ClaudeAdapter } = await bundle("src/core/claudeAdapter.ts", "claude-interrupt-notice.mjs");

async function runClaude(label, { resultMsg, rejectInterrupt = false, callInterrupt = true }) {
  const events = [];
  const adapter = new ClaudeAdapter({
    id: "s-" + label, cwd: os.tmpdir(), model: "sonnet", effort: "medium",
    permissionMode: "default", storageDir: path.join(outDir, "store-" + label),
    sdkLoader: async () => ({
      query: () => interruptingQuery(resultMsg, { rejectInterrupt }),
      createSdkMcpServer: () => ({}),
      tool: () => ({}),
    }),
  });
  adapter.on("event", (e) => events.push(e));
  adapter.start();
  await sleep(80);
  adapter.sendUserTurn("long task");
  await sleep(80);
  if (callInterrupt) adapter.interrupt();
  await sleep(250);
  return events.filter((e) => e.type !== "assistant_text_delta" && e.status !== "spawned" && e.status !== "closed" && e.status !== "sent");
}

console.log("\nR-90 — intentional interrupt is guidance, not a red error:");
{
  const events = await runClaude("user-interrupt", {
    resultMsg: {
      type: "result", subtype: "error_during_execution", is_error: true,
      errors: ["Request interrupted by user"], result: "", session_id: "x",
    },
  });
  const notice = events.find((e) => e.type === "diagnostic" && e.category === "interrupt");
  const errors = events.filter((e) => e.type === "error");
  assert(Boolean(notice), "stop emits an interrupt diagnostic");
  assert(notice?.severity === "info", "diagnostic is info (not warning/error severity)");
  assert(/중단/.test(notice?.title || ""), "title says the turn was stopped");
  assert(/실패가 아닙니다/.test(notice?.detail || ""), "detail says this is not a failure");
  assert(/먼저 처리/.test(notice?.recovery || ""), "recovery tells the member what to do next");
  assert(errors.length === 0, "no red error event on an intentional stop");
}

console.log("\nR-90 — interruptRequested even when is_error is false:");
{
  const events = await runClaude("interrupt-success-shaped", {
    resultMsg: { type: "result", subtype: "error_during_execution", is_error: false, result: "", session_id: "x" },
  });
  assert(events.some((e) => e.type === "diagnostic" && e.category === "interrupt"), "still guidance when subtype is error_during_execution without is_error");
  assert(!events.some((e) => e.type === "error"), "still no red error");
}

console.log("\nR-91 — real turn failure without a stop stays an error:");
{
  const events = [];
  const adapter = new ClaudeAdapter({
    id: "s-real-fail", cwd: os.tmpdir(), model: "sonnet", effort: "medium",
    permissionMode: "default", storageDir: path.join(outDir, "store-real-fail"),
    sdkLoader: async () => ({
      query: () => ({
        async interrupt() {},
        close() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result", subtype: "error_during_execution", is_error: true,
            errors: ["API rate limit exceeded"], result: "", session_id: "x",
          };
        },
        supportedCommands: async () => [],
        supportedModels: async () => [],
        mcpServerStatus: async () => ({}),
        initializationResult: async () => ({}),
      }),
      createSdkMcpServer: () => ({}),
      tool: () => ({}),
    }),
  });
  adapter.on("event", (e) => events.push(e));
  adapter.start();
  await sleep(80);
  adapter.sendUserTurn("boom");
  await sleep(200);
  const errors = events.filter((e) => e.type === "error");
  assert(errors.some((e) => /rate limit/i.test(e.message || "")), "real failure still emits type=error");
  assert(!events.some((e) => e.type === "diagnostic" && e.category === "interrupt"), "real failure is not painted as an interrupt notice");
}

console.log("\nR-91 — interrupt request itself failing stays an error:");
{
  const events = await runClaude("interrupt-rpc-fail", {
    rejectInterrupt: true,
    resultMsg: null,
  });
  assert(events.some((e) => e.type === "error" && /interrupt RPC failed/i.test(e.message || "")), "failed interrupt request is type=error");
  assert(!events.some((e) => e.type === "diagnostic" && e.category === "interrupt"), "failed interrupt request is not guidance");
}

console.log(failures.length ? `\nINTERRUPT NOTICE FAILED (${failures.length})` : "\nINTERRUPT NOTICE PASSED");
process.exit(failures.length ? 1 : 0);
