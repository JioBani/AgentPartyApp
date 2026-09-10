/*
 * QA for Codex AgentParty tools. Runs CodexAdapter against the deterministic
 * fake app-server and verifies app-server item/tool/call requests route through
 * the same in-process PartyBridge used by Claude.
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const qaDir = qaTempDir();

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "OK" : "FAIL"} ${msg}`); if (!cond) failures.push(msg); };

async function load(entry, name) {
  const out = path.join(qaDir, name);
  await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  return import(pathToFileURL(out).href);
}

const fakeServer = path.join(projectRoot, "scripts", "fake-codex-appserver.mjs");
const workspace = path.join(os.tmpdir(), `agentparty-codex-party-tools-${process.pid}`);
const toolOut = path.join(os.tmpdir(), `agentparty-codex-party-tool-${process.pid}.json`);
mkdirSync(workspace, { recursive: true });
try { rmSync(toolOut, { force: true }); } catch {}

process.env.AGENTPARTY_CODEX_BIN = process.execPath;
process.env.AGENTPARTY_CODEX_ARGS = JSON.stringify([fakeServer]);
process.env.AGENTPARTY_FAKE_CODEX_TOOL_OUT = toolOut;

const { CodexAdapter } = await load("src/core/codexAdapter.ts", "codex-party-tools.mjs");

let listCalls = 0;
const bridge = {
  async send() { return { ok: true }; },
  async createMember() { return { ok: true }; },
  async removeMember() { return { ok: true }; },
  async setPermission() { return { ok: true }; },
  async setRuntime() { return { ok: true }; },
  async list() {
    listCalls += 1;
    return { ok: true, data: { members: [{ name: "main", status: "running", harness: "codex" }] } };
  },
  async listModels() { return { ok: true, data: { harnesses: [], models: [] } }; },
};

const adapter = new CodexAdapter({
  id: "codex-party-tools",
  cwd: workspace,
  model: "gpt-5.4-mini",
  effort: "low",
  permissionMode: "default",
  policy: { sandbox: "read-only", approval: "on-request", guardian: false },
  debugEnabled: true,
  storageDir: workspace,
  partyBridge: bridge,
  partyIdentity: { party: "team-qa", member: "main", role: "qa" },
});

const events = [];
adapter.on("event", (event) => events.push(event));

console.log("\nCodex party tool assertions:");
try {
  adapter.start();
  await waitFor(() => events.some((event) => event.type === "session" && event.sessionId === "thr-fake"), "session start");

  const mcp = await adapter.listMcpServers();
  const partyServer = mcp.servers.find((server) => server.name === "agentparty-app");
  assert(Boolean(partyServer), "Codex MCP snapshot includes the app-hosted agentparty-app surface");
  assert(partyServer?.tools?.length === 18, "agentparty-app exposes all eighteen party tools (coordination, runtime, gates, permissions, Discord, and attachments)");
  assert(
    partyServer?.tools?.some((tool) => tool.name === "mcp__agentparty-app__party-gate-set"),
    "the PARTY-WIDE gate is drivable by an agent, not just the per-member override",
  );
  assert(partyServer?.tools?.some((tool) => tool.name === "mcp__agentparty-app__list"), "party tool names use the same mcp__agentparty-app__ prefix");

  adapter.sendUserTurn("KIND=partyTool call list");
  await waitFor(() => events.some((event) => event.type === "turn_complete"), "party tool turn complete");

  assert(listCalls === 1, "Codex item/tool/call invoked PartyBridge.list exactly once");
  assert(events.some((event) => event.type === "tool_call" && event.name === "mcp__agentparty-app__list" && event.status === "completed"), "tool call is surfaced in the transcript as completed");
  assert(existsSync(toolOut), "fake app-server received a dynamic tool response");
  const response = JSON.parse(readFileSync(toolOut, "utf8"));
  assert(response.success === true, "dynamic tool response marks success=true");
  assert(/main/.test(response.contentItems?.[0]?.text || ""), "dynamic tool response carries bridge data");

  const logPath = adapter.getSnapshot().logPath;
  const frames = readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const outbound = frames.filter((frame) => frame.direction === "out").map((frame) => frame.payload);
  const threadStart = outbound.find((message) => message.method === "thread/start");
  const turnStart = outbound.find((message) => message.method === "turn/start");
  const disabledSkills = threadStart?.params?.config?.skills?.config || [];
  assert(threadStart?.params?.config?.dynamic_tools?.length === 1, "thread config preserves the AgentParty dynamic tool");
  assert(
    disabledSkills.length === 1
      && disabledSkills[0].enabled === false
      && /control-in-app-browser[\\/]SKILL\.md$/i.test(disabledSkills[0].path),
    "thread config disables only the unsupported in-app-browser skill by SKILL.md path",
  );
  assert(
    threadStart?.params?.developerInstructions?.includes("# AgentParty — party member session")
      && threadStart.params.developerInstructions.includes("team-qa")
      && threadStart.params.developerInstructions.includes("main"),
    "Codex installs the party primer once as thread-scoped developer instructions",
  );
  assert(
    turnStart?.params?.input?.[0]?.text === "KIND=partyTool call list",
    "Codex sends only the user's text on turn/start instead of repeating the party primer",
  );
} finally {
  adapter.dispose();
}

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nCODEX PARTY TOOLS PASSED");
process.exit(failures.length ? 1 : 0);

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
