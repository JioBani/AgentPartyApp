import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const { MuseAdapter, museApprovalMode } = await import(pathToFileURL(path.join(root, "dist", "core", "museAdapter.js")).href);

assert.equal(museApprovalMode("default"), "onRequest");
assert.equal(museApprovalMode("acceptEdits"), "promptUnmatched");
assert.equal(museApprovalMode("plan"), "denyUnmatched");
assert.equal(museApprovalMode("bypassPermissions"), "allowAll");

let wire;
const calls = [];
const sessionFactory = (options) => {
  wire = options;
  return {
    sessionId: "muse-session-qa",
    async start() {
      return { session: { sessionId: "muse-session-qa", status: "idle", modelId: "muse-spark-qa", providerId: "meta" } };
    },
    async startTurn(text, effort, attachments) {
      calls.push({ method: "turn/start", text, effort, attachments });
      if (text === "stop me") {
        queueMicrotask(() => options.onNotification("turn/started", { turnId: "turn-stop" }));
        setTimeout(() => options.onNotification("turn/completed", { turnId: "turn-stop", terminal: "cancelled", reason: "interrupted" }), 20);
        return { turnId: "turn-stop" };
      }
      queueMicrotask(() => {
        options.onNotification("turn/started", { turnId: "turn-1" });
        options.onNotification("item/started", { item: { itemId: "answer", kind: "agentMessage", status: "inProgress", revision: 1, text: "" } });
        options.onNotification("item/delta", { itemId: "answer", field: "text", delta: "MUSE_" });
        options.onNotification("item/completed", { item: { itemId: "answer", kind: "agentMessage", status: "completed", revision: 2, text: "MUSE_OK" } });
        options.onNotification("item/started", { item: { itemId: "tool", kind: "toolCall", status: "inProgress", revision: 1, tool: "party_list", args: "{}" } });
        options.onNotification("item/completed", { item: { itemId: "tool", kind: "toolCall", status: "completed", revision: 2, tool: "party_list", args: "{}", visibleOutput: "2 members" } });
        options.onNotification("session/contextUsage", { usedTokens: 40, windowTokens: 1000 });
        options.onNotification("session/tokenUsage", { turnId: "turn-1", promptTokens: 12, usage: { inputTokens: 12, cachedTokens: 0, outputTokens: 3, reasoningTokens: 0 } });
        options.onNotification("turn/completed", { turnId: "turn-1", terminal: "completed", reason: "stop" });
      });
      return { turnId: "turn-1" };
    },
    async interrupt(turnId) { calls.push({ method: "interrupt", turnId }); },
    async compact() { calls.push({ method: "compact" }); },
    async setModel(model) { calls.push({ method: "setModel", model }); },
    async setEffort(effort) { calls.push({ method: "setEffort", effort }); },
    async setApprovalMode(mode) { calls.push({ method: "setApprovalMode", mode }); },
    async decideApproval(request, choiceId, feedback) { calls.push({ method: "approval", request, choiceId, feedback }); },
    async answerUserInput(request, answers) { calls.push({ method: "answer", request, answers }); },
    async cancelUserInput(request) { calls.push({ method: "cancel", request }); },
    async listSkills() { return { skills: [{ selector: "review", displayName: "Review", description: "Review changes", source: "user" }] }; },
    dispose() { calls.push({ method: "dispose" }); },
  };
};

const adapter = new MuseAdapter({
  id: "muse-qa",
  cwd: root,
  model: "muse-default",
  effort: "high",
  permissionMode: "default",
  partyPrimer: "PARTY_PRIMER",
  mcpServers: { "agentparty-app": { command: "node", args: ["party.mjs"], env: { PARTY: "p" } } },
  cliResolver: async () => ({ command: "fake-muse", version: "1.3.0", release: "R3401.1" }),
  sessionFactory,
});
const events = [];
adapter.on("event", (event) => events.push(event));
adapter.start();
await waitFor(() => adapter.getSnapshot().harnessAlive);
assert.equal(wire.command, "fake-muse");
assert.equal(wire.modelId, undefined, "muse-default delegates concrete model selection to Muse");
assert.equal(wire.approvalMode, "onRequest");
assert.equal(wire.mcpServers["agentparty-app"].command, "node", "party MCP is session-scoped on MSP start");
assert.equal(adapter.getSnapshot().sessionId, "muse-session-qa");
assert.equal(adapter.getSnapshot().model, "muse-spark-qa", "provider-selected concrete model reaches the snapshot");
assert.equal(adapter.getSnapshot().slashCommands[0].name, "review", "Muse skills feed the command palette");

const image = { kind: "image", mediaType: "image/png", dataBase64: "aGVsbG8=", name: "tiny.png" };
adapter.sendUserTurn("hello", [image]);
await waitFor(() => events.some((event) => event.type === "turn_complete"));
assert.match(calls.find((call) => call.method === "turn/start").text, /^PARTY_PRIMER\n\nhello$/, "party primer rides only on the first fresh turn");
assert.equal(calls.find((call) => call.method === "turn/start").attachments[0].name, "tiny.png");
assert.equal(events.filter((event) => event.type === "assistant_text_delta").map((event) => event.text).join(""), "MUSE_OK", "delta plus authoritative item completion is not duplicated");
assert(events.some((event) => event.type === "tool_call" && event.status === "completed" && event.result === "2 members"));
const complete = events.find((event) => event.type === "turn_complete");
assert.deepEqual(complete.usage, { input: 12, cacheRead: undefined, cacheWrite: undefined, output: 3 });
assert.equal(complete.cost.source, "muse");
assert.equal(adapter.getSnapshot().contextTokens, 40);
assert.equal(adapter.getSnapshot().contextWindow, 1000);

const completionsBeforeForceStop = events.filter((event) => event.type === "turn_complete").length;
adapter.sendUserTurn("stop me");
await waitFor(() => adapter.getSnapshot().turnState === "responding");
adapter.forceStop();
await waitFor(() => events.filter((event) => event.type === "turn_complete").length > completionsBeforeForceStop);
assert.equal(
  events.filter((event) => event.type === "turn_complete").length,
  completionsBeforeForceStop + 1,
  "force stop relies on Muse's terminal event instead of emitting a duplicate completion",
);

wire.onServerRequest("approval/request", {
  approvalId: "approval-1", sessionId: "muse-session-qa", itemId: "tool-2", toolName: "write",
  rawArgs: '{"path":"a.txt"}', subject: { path: "a.txt" }, currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
  availableChoices: [{ choiceId: "allow-once", decision: "approved", label: "Allow", scope: "once" }, { choiceId: "deny", decision: "denied", label: "Deny", scope: "once" }],
});
assert(events.some((event) => event.type === "approval_request" && event.requestId === "approval-1"));
assert.equal(adapter.respondApproval("approval-1", "allow"), true);
await waitFor(() => calls.some((call) => call.method === "approval"));
assert.equal(calls.find((call) => call.method === "approval").choiceId, "allow-once");

adapter.setEffort("xhigh");
adapter.setPermissionMode("plan");
adapter.setModel("muse-spark-next");
await waitFor(() => calls.some((call) => call.method === "setModel"));
assert(calls.some((call) => call.method === "setEffort" && call.effort === "xhigh"));
assert(calls.some((call) => call.method === "setApprovalMode" && call.mode === "denyUnmatched"));
assert(calls.some((call) => call.method === "setModel" && call.model === "muse-spark-next"));
adapter.dispose();

console.log("MUSE ADAPTER QA PASSED");

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Muse adapter state.");
}
