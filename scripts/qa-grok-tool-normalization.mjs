/* Grok ACP tool-call normalization, using shapes captured from Grok Build 1.0.0. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = await build({
  entryPoints: [path.join(root, "src/core/grokAdapter.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const output = path.join(qaTempDir(), "grok-tool-normalization.mjs");
writeFileSync(output, built.outputFiles[0].text);
const {
  GrokAdapter,
  grokAutomaticPermissionDecision,
  grokToolName,
  grokToolStatus,
  grokToolResult,
  selectGrokPermissionOption,
} = await import(pathToFileURL(output).href);
const acpBuilt = await build({
  entryPoints: [path.join(root, "src/core/grokAcp.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const acpOutput = path.join(qaTempDir(), "grok-acp-open-request.mjs");
writeFileSync(acpOutput, acpBuilt.outputFiles[0].text);
const { GrokAcpSession, grokAcpOpenRequest, grokAcpTurnCostUsd, grokAcpTurnUsage } = await import(pathToFileURL(acpOutput).href);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const command = "Write-Output GROK_TOOL_OK";
const start = { toolCallId: "call-1", title: "run_terminal_command", name: "run_terminal_command", rawInput: { command } };
const progress = {
  toolCallId: "call-1",
  title: `Execute \`${command}\``,
  name: "run_terminal_command",
  kind: "execute",
  status: "in_progress",
  content: [{ type: "content", content: { type: "text", text: "GROK_TOOL_OK\r\n" } }],
  rawOutput: { type: "Bash", output_for_prompt: "GROK_TOOL_OK\n", exit_code: 0, current_dir: "C:\\work" },
};

assert.equal(grokToolName(start), "shell", "vendor terminal tool maps to the shared shell card");
assert.equal(grokToolName(progress), "shell", "human-readable Execute title never becomes the tool name");
assert.equal(grokToolStatus(undefined), "started", "a sparse update is not mistaken for completion");
assert.equal(grokToolStatus("in_progress"), "started", "in-progress stays running");
assert.equal(grokToolStatus("completed"), "completed", "completed stays terminal");
assert.equal(grokToolStatus("cancelled"), "failed", "cancelled is visibly non-successful");
assert.deepEqual(grokToolResult(progress), {
  text: "GROK_TOOL_OK\n",
  detail: undefined,
  cwd: "C:\\work",
  exitCode: 0,
  durationMs: undefined,
  terminal: false,
}, "Grok output/cwd/exit metadata survives normalization");

const completed = grokToolResult({ ...progress, status: "completed", rawOutput: { ...progress.rawOutput, output_for_prompt: "exit: 0\nGROK_TOOL_OK\n" } });
assert.equal(completed.text, "GROK_TOOL_OK\n", "duplicated exit prefix is removed because exit code has its own UI field");
assert.equal(completed.terminal, true, "completed update closes the lifecycle");

const fallback = grokToolResult({ status: "completed", content: [{ type: "content", content: { type: "text", text: "fallback" } }] });
assert.equal(fallback.text, "fallback", "ACP content remains a result fallback when rawOutput is absent");
const descriptionOnly = grokToolResult({ content: [{ type: "content", content: { type: "text", text: "Run output test" } }] });
assert.equal(descriptionOnly.text, undefined, "an unstatused human description is not misrendered as command output");

assert.deepEqual(grokAcpOpenRequest({ cwd: "C:\\work", resumeSessionId: "persisted-thread" }), {
  method: "session/load",
  params: { sessionId: "persisted-thread", cwd: "C:\\work", mcpServers: [] },
}, "a persisted Grok thread is loaded instead of silently replaced with session/new");
assert.deepEqual(grokAcpOpenRequest({ cwd: "C:\\work" }), {
  method: "session/new",
  params: { cwd: "C:\\work", mcpServers: [] },
}, "a member with no prior thread still creates a new Grok session");

const realTurnCompletedUsage = {
  inputTokens: 18809,
  outputTokens: 29,
  totalTokens: 18838,
  cachedReadTokens: 5376,
  cacheCreationTokens: 0,
  reasoningTokens: 24,
  costUsdTicks: 286528000,
};
assert.deepEqual(grokAcpTurnUsage(realTurnCompletedUsage), {
  input: 13433,
  output: 29,
  cacheRead: 5376,
  cacheWrite: 0,
  reasoning: 24,
}, "Grok's vendor turn_completed event becomes disjoint ledger token buckets");
assert.equal(grokAcpTurnCostUsd(realTurnCompletedUsage), 0.0286528, "exact Grok cost ticks become USD");
assert.deepEqual(grokAcpTurnUsage({
  input_tokens: 13433,
  output_tokens: 29,
  cache_read_input_tokens: 5376,
  cache_creation_input_tokens: 0,
  total_tokens: 18838,
  reasoning_tokens: 24,
}), {
  input: 13433,
  output: 29,
  cacheRead: 5376,
  cacheWrite: 0,
  reasoning: 24,
}, "headless snake_case usage keeps its already-uncached input bucket");

const acpUsageProbe = new GrokAcpSession({ command: "unused", cwd: "C:\\work" });
acpUsageProbe.active = { handlers: {}, text: [], thought: [] };
acpUsageProbe.onServerMessage({
  method: "_x.ai/session/update",
  params: { update: { sessionUpdate: "turn_completed", usage: realTurnCompletedUsage } },
});
assert.deepEqual(acpUsageProbe.active.usage, {
  input: 13433,
  output: 29,
  cacheRead: 5376,
  cacheWrite: 0,
  reasoning: 24,
}, "the vendor _x.ai/session/update notification is no longer discarded");
assert.equal(acpUsageProbe.active.costUsd, 0.0286528, "vendor completion cost reaches the active turn");

const permissionOptions = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];
const permissionRequest = {
  requestId: "rpc-9",
  sessionId: "thread",
  toolCall: { toolCallId: "tool-9", title: "use_tool", name: "use_tool", kind: "other", rawInput: { tool_name: "agentparty-app__send" } },
  options: permissionOptions,
};
assert.equal(grokAutomaticPermissionDecision("default", permissionRequest), "allow", "party tools are auto-approved in every mode");
assert.equal(grokAutomaticPermissionDecision("auto", { ...permissionRequest, toolCall: { ...permissionRequest.toolCall, rawInput: {} } }), "allow", "auto mode approves ACP requests");
assert.equal(grokAutomaticPermissionDecision("dontAsk", { ...permissionRequest, toolCall: { ...permissionRequest.toolCall, rawInput: {} } }), "deny", "dontAsk rejects ACP requests");
assert.equal(grokAutomaticPermissionDecision("default", { ...permissionRequest, toolCall: { ...permissionRequest.toolCall, rawInput: {} } }), undefined, "default mode waits for the approval UI");
assert.equal(selectGrokPermissionOption(permissionOptions, "allow", false)?.optionId, "once", "allow selects the exact ACP allow-once option id");
assert.equal(selectGrokPermissionOption(permissionOptions, "allow", true)?.optionId, "always", "always-allow selects the exact ACP persistent option id");

console.log("Grok account usage lifecycle:");
{
  const session = {
    availableModels: [{ modelId: "grok-4.5" }], model: "grok-4.5", acpSessionId: "usage-thread",
    async start() {}, async setModel() {}, async setMode() {}, dispose() {}, cancel() {},
    async prompt() { return { stopReason: "end_turn", text: "", thought: "" }; },
    async billingUsage() {
      return { config: { creditUsagePercent: 14, currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-08-09T16:10:35Z", end: "2026-08-16T16:10:35Z",
      } } };
    },
  };
  const events = [];
  const adapter = new GrokAdapter({ sessionId: "usage", cwd: "C:\\work", usageSourceId: "bg-grok", sessionFactory: () => session });
  adapter.on("event", (event) => events.push(event));
  adapter.start();
  await delay(20);
  const usage = events.find((event) => event.type === "usage_limit");
  assert.equal(usage?.provider, "grok", "Grok billing emits the Grok provider meter");
  assert.equal(usage?.windows?.[0]?.utilization, 14, "Grok billing percent reaches usage_limit");
  assert.equal(usage?.sourceId, "bg-grok", "Grok usage source participates in SessionManager fan-in");
  adapter.dispose();
}

console.log("Grok interrupt lifecycle:");
{
  let finishPrompt;
  let promptHandlers;
  let cancelCount = 0;
  const session = {
    availableModels: [{ modelId: "grok-4.5" }], model: "grok-4.5", acpSessionId: "grok-test-thread",
    async start() {}, async setModel() {}, async setMode() {}, dispose() {},
    prompt(_text, handlers) {
      promptHandlers = handlers;
      return new Promise((resolve) => { finishPrompt = resolve; });
    },
    cancel() {
      cancelCount += 1;
    },
  };
  const events = [];
  const adapter = new GrokAdapter({ sessionId: "s-interrupt", cwd: "C:\\work", sessionFactory: () => session });
  adapter.on("event", (event) => events.push(event));
  adapter.start();
  await delay(20);
  adapter.sendUserTurn("keep working");
  await delay(10);
  assert.equal(adapter.getSnapshot().status, "requesting", "an active Grok turn uses the app-wide busy status");
  adapter.interrupt();
  assert.equal(cancelCount, 1, "Stop sends exactly one ACP cancellation");
  assert.equal(adapter.getSnapshot().status, "interrupting", "Stop immediately exposes the interrupting state to the UI");
  promptHandlers.onText("late buffered output");
  assert.equal(adapter.getSnapshot().status, "interrupting", "late ACP output cannot hide the interrupting/Force Stop state");
  finishPrompt({
    stopReason: "cancelled", text: "", thought: "",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1 },
  });
  await delay(20);
  assert.equal(adapter.getSnapshot().status, "idle", "cancel completion returns the member to idle");
  assert.equal(adapter.getSnapshot().turnState, "complete", "cancel completion closes app-side turn accounting");
  assert(events.some((event) => event.type === "diagnostic" && event.category === "interrupt"), "intentional cancellation is an info notice");
  assert(!events.some((event) => event.type === "error"), "intentional cancellation is not a red error");
  const completedTurn = events.find((event) => event.type === "turn_complete");
  assert.equal(completedTurn?.stopReason, "cancelled", "cancelled turn still records its usage/stop reason");
  adapter.dispose();
}

console.log("Grok adapter resume wiring:");
{
  const session = {
    availableModels: [{ modelId: "grok-4.5" }], model: "grok-4.5", acpSessionId: "persisted-grok-thread",
    async start() {}, async setModel() {}, async setMode() {}, dispose() {}, cancel() {},
    async prompt() { return { stopReason: "end_turn", text: "", thought: "" }; },
  };
  const adapter = new GrokAdapter({
    sessionId: "app-session", cwd: "C:\\work", resumeSessionId: "persisted-grok-thread", sessionFactory: () => session,
  });
  adapter.start();
  await delay(20);
  assert.equal(adapter.getSnapshot().sessionId, "persisted-grok-thread", "restored adapter exposes the persisted Grok thread id");
  adapter.dispose();
}

console.log("Grok ACP permission lifecycle:");
{
  const makeSession = (capture) => ({
    availableModels: [{ modelId: "grok-4.5" }], model: "grok-4.5", acpSessionId: "permission-thread",
    async start() {}, async setModel() {}, async setMode() {}, dispose() {}, cancel() {},
    async prompt(_text, handlers) {
      capture.outcome = await handlers.onPermissionRequest({
        ...permissionRequest,
        toolCall: { ...permissionRequest.toolCall, rawInput: {} },
      });
      return { stopReason: "end_turn", text: "done", thought: "" };
    },
  });

  const automatic = {};
  const autoAdapter = new GrokAdapter({ sessionId: "auto", cwd: "C:\\work", permissionMode: "auto", sessionFactory: () => makeSession(automatic) });
  autoAdapter.start();
  await delay(20);
  autoAdapter.sendUserTurn("coordinate");
  await delay(20);
  assert.deepEqual(automatic.outcome, { outcome: "selected", optionId: "once" }, "auto mode returns a valid selected ACP outcome");
  assert.equal(autoAdapter.getSnapshot().pendingApprovalCount, 0, "auto mode never strands an approval card");
  autoAdapter.dispose();

  const manual = {};
  const events = [];
  const defaultAdapter = new GrokAdapter({ sessionId: "default", cwd: "C:\\work", permissionMode: "default", sessionFactory: () => makeSession(manual) });
  defaultAdapter.on("event", (event) => events.push(event));
  defaultAdapter.start();
  await delay(20);
  defaultAdapter.sendUserTurn("run a tool");
  await delay(20);
  assert.equal(defaultAdapter.getSnapshot().pendingApprovalCount, 1, "default mode exposes one pending approval");
  assert(events.some((event) => event.type === "approval_request" && event.requestId === "rpc-9"), "default mode renders the existing approval UI");
  defaultAdapter.respondApproval("rpc-9", "allow");
  await delay(20);
  assert.deepEqual(manual.outcome, { outcome: "selected", optionId: "once" }, "approval UI resolves the exact ACP request");
  assert.equal(defaultAdapter.getSnapshot().pendingApprovalCount, 0, "resolved approval is removed from member status");
  defaultAdapter.dispose();
}

console.log("Grok tool normalization QA passed.");
