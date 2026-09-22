import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const { MuseAdapter, museApprovalMode } = await import(pathToFileURL(path.join(root, "dist", "core", "museAdapter.js")).href);
const { buildModelRoutes } = await import(pathToFileURL(path.join(root, "dist", "core", "modelRegistry.js")).href);
const { MUSE_BUNDLED_MODELS, normalizeMuseModels, supersedesMuseDiscovery } = await import(pathToFileURL(path.join(root, "dist", "shared", "museModels.js")).href);

const discoveredModels = normalizeMuseModels([
  { modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3", isDefault: false, isActive: true, providerId: "meta", profileId: "tbh", contextLimit: 1_007_997, outputLimit: 128_000 },
  { modelId: "muse-spark-1.3-contributor", displayLabel: "Muse Spark 1.3 Contributor", isDefault: true, isActive: true, providerId: "meta", profileId: "tbh", contextLimit: 1_007_997, outputLimit: 128_000 },
  { modelId: "muse-spark-1.2", displayLabel: "Muse Spark 1.2", isDefault: false, isActive: true, providerId: "meta", profileId: "tbh", contextLimit: 1_007_997, outputLimit: 128_000 },
  { modelId: "muse-spark-1.2-contributor", displayLabel: "Muse Spark 1.2 Contributor", isDefault: false, isActive: true, providerId: "meta", profileId: "tbh", contextLimit: 1_007_997, outputLimit: 128_000 },
]);
assert.equal(discoveredModels.length, 4, "all account-visible Muse models survive normalization");
assert.deepEqual(new Set(MUSE_BUNDLED_MODELS.map((model) => model.model)), new Set(discoveredModels.map((model) => model.model)), "the host-without-profile fallback contains every measured public Muse model");
assert.equal(discoveredModels[0].model, "muse-spark-1.3-contributor", "Muse provider default is ordered first");
const museRoutes = buildModelRoutes("sonnet", [], [], undefined, discoveredModels).filter((route) => route.harnessId === "muse");
assert.deepEqual(museRoutes.map((route) => route.model), discoveredModels.map((model) => model.model), "every discovered Muse model becomes a selectable route");
assert(!museRoutes.some((route) => route.model === "muse-default"), "the compatibility fallback does not hide or duplicate a ready provider catalog");
assert(museRoutes.every((route) => route.capabilities.effort.options.some((option) => option.id === "ultra")), "Muse routes expose the CLI's full effort vocabulary");
assert.equal(museRoutes[0].pricing.context, "1.01M", "Muse context limit is carried into the catalog");
assert.equal(buildModelRoutes("sonnet", [], [], undefined, []).filter((route) => route.harnessId === "muse")[0].model, "muse-default", "discovery failure keeps the explicit compatibility fallback");
assert(supersedesMuseDiscovery({ status: "pending", models: [] }, { status: "ready", models: discoveredModels, at: "2026-09-22T01:00:00.000Z" }), "a settled Muse discovery replaces pending routes");
assert(!supersedesMuseDiscovery({ status: "ready", models: discoveredModels, at: "2026-09-22T01:00:00.000Z" }, { status: "pending", models: [] }), "a late pending snapshot cannot replace settled Muse routes");

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
    async listPending() { return { approvals: [], userInputs: [] }; },
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

wire.onNotification("approval/requested", {
  approvalId: "approval-notification", sessionId: "muse-session-qa", itemId: "tool-3", toolName: "mcp__agentparty_app__list",
  rawArgs: "{}", subject: { kind: "toolAction", toolName: "mcp__agentparty_app__list" }, currentRequirementId: { approvalId: "approval-notification", sourceIndex: 0 },
  availableChoices: [{ choiceId: "allow-notification", decision: "approved", label: "Allow", scope: "once" }, { choiceId: "abort-notification", decision: "abort", label: "Reject", scope: "once" }],
});
assert(events.some((event) => event.type === "approval_request" && event.requestId === "approval-notification"), "durable approval/requested notifications reach the approval UI");
const approvalEventCount = events.filter((event) => event.type === "approval_request" && event.requestId === "approval-notification").length;
wire.onNotification("approval/updated", { approvalId: "approval-notification", rawArgs: "{\"scope\":\"updated\"}" });
assert.equal(events.filter((event) => event.type === "approval_request" && event.requestId === "approval-notification").length, approvalEventCount + 1,
  "approval updates refresh the visible request instead of being deduplicated");
assert.equal(adapter.respondApproval("approval-notification", "allow"), true);
await waitFor(() => calls.some((call) => call.method === "approval" && call.choiceId === "allow-notification"));

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
