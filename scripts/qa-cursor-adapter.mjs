import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-cursor-qa-"));
const argsOut = path.join(temp, "args.ndjson");
process.env.AGENTPARTY_CURSOR_ARGS = JSON.stringify([path.join(root, "scripts", "fixtures", "fake-cursor-agent.mjs")]);
process.env.AGENTPARTY_FAKE_CURSOR_ARGS_OUT = argsOut;

const { CursorAdapter, cursorModelSlug } = await import(pathToFileURL(path.join(root, "dist", "core", "cursorAdapter.js")).href);
const { inspectCursorAgent } = await import(pathToFileURL(path.join(root, "dist", "core", "cursorAgentCli.js")).href);
const { prepareCursorPartyRuntime } = await import(pathToFileURL(path.join(root, "dist", "core", "cursorPartyPlugin.js")).href);

assert.equal(cursorModelSlug("Grok 4.5", "low"), "cursor-grok-4.5-low");
assert.equal(cursorModelSlug("Grok 4.5", "medium"), "cursor-grok-4.5-medium");
assert.equal(cursorModelSlug("Grok 4.5", "high"), "cursor-grok-4.5-high");
assert.equal(cursorModelSlug("Grok 4.5", "low", "fast"), "cursor-grok-4.5-low-fast");
assert.equal(cursorModelSlug("Grok 4.5", "medium", "fast"), "cursor-grok-4.5-medium-fast");
assert.equal(cursorModelSlug("Grok 4.5", "high", "fast"), "cursor-grok-4.5-high-fast");
assert.equal(cursorModelSlug("Auto", "high"), "auto");
assert.throws(() => cursorModelSlug("Grok 4.5", "high", "turbo"), /service tier must be 'standard' or 'fast'/);
assert.throws(() => cursorModelSlug("Grok 4.5", "max"), /effort must be 'low', 'medium', or 'high'/);
assert.throws(
  () =>
    new CursorAdapter({
      id: "invalid-model",
      cwd: root,
      model: "Other",
      effort: "high",
      permissionMode: "default",
    }),
  /supports only 'Auto' and 'Grok 4.5'/,
);

const pluginA = prepareCursorPartyRuntime({
  baseDir: path.join(temp, "plugins"),
  sessionId: "session-a",
  automationBaseUrl: "http://127.0.0.1:1",
  identity: { party: "party", member: "a", role: "qa" },
});
const pluginB = prepareCursorPartyRuntime({
  baseDir: path.join(temp, "plugins"),
  sessionId: "resume-b",
  automationBaseUrl: "http://127.0.0.1:1",
  identity: { party: "party", member: "b", role: "qa" },
});
const manifestA = JSON.parse(fs.readFileSync(path.join(pluginA.pluginDir, ".cursor-plugin", "plugin.json"), "utf8"));
const manifestB = JSON.parse(fs.readFileSync(path.join(pluginB.pluginDir, ".cursor-plugin", "plugin.json"), "utf8"));
assert.equal(manifestA.name, "agentparty-session");
assert.equal(manifestB.name, manifestA.name);
assert.equal(path.basename(pluginA.pluginDir), "agentparty-session");
assert.equal(path.basename(pluginB.pluginDir), path.basename(pluginA.pluginDir));
assert.notEqual(path.dirname(pluginA.pluginDir), path.dirname(pluginB.pluginDir));

const mcpProtocol = spawnSync(process.execPath, [path.join(root, "scripts", "agentparty-codex-mcp-server.mjs")], {
  input: [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    "",
  ].join("\n"),
  encoding: "utf8",
});
assert.equal(mcpProtocol.status, 0);
const toolList = mcpProtocol.stdout.trim().split(/\r?\n/).map(JSON.parse).find((message) => message.id === 2).result.tools;
assert.equal(toolList.length, 11);
assert(toolList.some((tool) => tool.name === "gate-set"));
assert(toolList.some((tool) => tool.name === "party-gate-set"));
for (const name of ["list", "list-models", "member-status"]) {
  const tool = toolList.find((entry) => entry.name === name);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
}

const adapter = new CursorAdapter({
  id: "qa-cursor",
  cwd: root,
  executablePath: process.execPath,
  model: "Grok 4.5",
  effort: "high",
  cursorPolicy: { mode: "plan", approval: "auto-review" },
  debugEnabled: true,
  storageDir: temp,
});
const events = [];
const snapshots = [];
adapter.on("event", (event) => events.push(event));
adapter.on("snapshot", (snapshot) => snapshots.push(snapshot));
adapter.start();
process.env.AGENTPARTY_FAKE_CURSOR_EXIT_DELAY_MS = "150";
adapter.sendUserTurn("first");
await waitFor(() => events.some((event) => event.type === "turn_complete"));
assert.equal(adapter.getSnapshot().sessionId, "cursor-fake-session");
assert.equal(adapter.getSnapshot().contextTokens, 15);
assert.deepEqual(adapter.getSnapshot().cursorPolicy, { mode: "plan", approval: "auto-review" });
assert(events.some((event) => event.type === "reasoning_delta" && event.text === "checking"));
assert(events.some((event) => event.type === "tool_call" && event.status === "completed"));
assert(events.some((event) => event.type === "assistant_text_delta" && event.text === "CURSOR_FAKE_OK"));

adapter.setEffort("medium");
adapter.setCursorPolicy({ mode: "ask", approval: "unrestricted" });
adapter.sendUserTurn("second");
await waitFor(() => snapshots.some((snapshot) => snapshot.queuedTurnCount === 1));
assert(
  snapshots.some((snapshot) => snapshot.queuedTurnCount === 1 && snapshot.status === "requesting"),
  "a turn queued after Cursor result but before process exit remains visibly busy",
);
await waitFor(() => events.filter((event) => event.type === "turn_complete").length === 2);
assert(
  snapshots.some((snapshot) => snapshot.status === "responding"),
  "Cursor init maps to the shared responding state",
);
assert(
  !snapshots.some((snapshot) => snapshot.queuedTurnCount > 0 && snapshot.status === "idle"),
  "queued Cursor handoff never publishes an idle snapshot",
);
const invocations = fs.readFileSync(argsOut, "utf8").trim().split(/\r?\n/).map(JSON.parse);
assert(invocations[0].includes("cursor-grok-4.5-high"));
assert(invocations[0].includes("plan"));
assert(invocations[0].includes("--auto-review"));
assert(invocations[1].includes("cursor-grok-4.5-medium"));
assert(invocations[1].includes("ask"));
assert(invocations[1].includes("--force"));
assert(!invocations[1].includes("--auto-review"));
assert(invocations[1].includes("--resume"));
assert(invocations[1].includes("cursor-fake-session"));

adapter.restart();
assert.equal(adapter.getSnapshot().sessionId, undefined);
assert.equal(adapter.getSnapshot().turnCount, 0);
adapter.sendUserTurn("after hard restart");
await waitFor(() => events.filter((event) => event.type === "turn_complete").length === 3);
const restartedInvocations = fs.readFileSync(argsOut, "utf8").trim().split(/\r?\n/).map(JSON.parse);
assert(!restartedInvocations[2].includes("--resume"));
adapter.dispose();
delete process.env.AGENTPARTY_FAKE_CURSOR_EXIT_DELAY_MS;

const status = await inspectCursorAgent(process.execPath);
assert.equal(status.installed, true);
assert.equal(status.version, "2099.01.01-fake");
assert.equal(status.grok45Models.length, 3);

process.env.AGENTPARTY_FAKE_CURSOR_NAMED_ERROR = "1";
const failing = new CursorAdapter({
  id: "qa-cursor-failure",
  cwd: root,
  executablePath: process.execPath,
  model: "Grok 4.5",
  effort: "high",
  debugEnabled: false,
  storageDir: temp,
  pluginDir: path.join(temp, "cursor-plugin"),
});
const failures = [];
failing.on("event", (event) => failures.push(event));
failing.sendUserTurn("fail");
// The adapter may also emit an unrelated rate-limit info diagnostic on start
// (the usage poller); the turn failure is the cursor-cli one.
await waitFor(() => failures.some((event) => event.type === "diagnostic" && event.category === "cursor-cli"));
const diagnostic = failures.find((event) => event.type === "diagnostic" && event.category === "cursor-cli");
assert.match(diagnostic.detail, /Named models unavailable/);
assert.match(diagnostic.recovery, /not fall back to Auto/);

delete process.env.AGENTPARTY_FAKE_CURSOR_NAMED_ERROR;
process.env.AGENTPARTY_FAKE_CURSOR_MCP = "1";
failing.sendUserTurn("recover with mcp");
await waitFor(() => failures.some((event) => event.type === "turn_complete"));
assert.equal(failing.getSnapshot().lastError, undefined);
const mcp = await failing.listMcpServers();
assert.equal(mcp.servers[0].state, "connected");
assert.deepEqual(
  mcp.servers[0].tools.map((tool) => tool.name),
  ["send", "member-create", "member-remove", "member-permission", "gate-set", "party-gate-set", "list", "list-models", "member-status", "interrupt", "broadcast"],
);
failing.dispose();

// Stop (interrupt) must release the turn cleanly — never as a cursor-cli error.
process.env.AGENTPARTY_FAKE_CURSOR_HOLD_MS = "30000";
const stopping = new CursorAdapter({
  id: "qa-cursor-interrupt",
  cwd: root,
  executablePath: process.execPath,
  model: "Grok 4.5",
  effort: "high",
  debugEnabled: false,
  storageDir: temp,
});
const stopEvents = [];
stopping.on("event", (event) => stopEvents.push(event));
stopping.sendUserTurn("hold then stop");
await waitFor(() => stopEvents.some((event) => event.type === "status" && event.status === "sent"));
await waitFor(() => stopping.getSnapshot().status === "responding" || stopping.getSnapshot().pid);
stopping.interrupt();
await waitFor(() => stopEvents.some((event) => event.type === "status" && event.status === "interrupted"));
assert.equal(stopping.getSnapshot().status, "idle");
assert.equal(stopping.getSnapshot().lastError, undefined);
assert(
  !stopEvents.some((event) => event.type === "diagnostic" && event.category === "cursor-cli"),
  "Stop must not emit a Cursor Agent turn failed diagnostic",
);
assert(
  !stopEvents.some((event) => event.type === "error"),
  "Stop must not emit an error event",
);
stopping.dispose();
delete process.env.AGENTPARTY_FAKE_CURSOR_HOLD_MS;

console.log("CURSOR ADAPTER QA PASSED");

async function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for Cursor adapter event.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
