/*
 * Real-app E2E for batch party coordination. It drives both the public HTTP
 * automation routes and the shipped stdio MCP relay against one Electron
 * process, with a protocol-faithful fake Codex backend to avoid provider cost.
 */
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp } from "./lib/electron-e2e.mjs";
import { qaRunDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = qaRunDir("party-batch-tools");
const workspace = path.join(runRoot, "workspace");
const userData = path.join(runRoot, "userdata");
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

const port = await freePort();
const app = createElectronE2eApp({
  root,
  workspace,
  userData,
  port,
  env: {
    AGENTPARTY_CODEX_BIN: process.execPath,
    AGENTPARTY_CODEX_ARGS: JSON.stringify([path.join(root, "scripts", "fake-codex-appserver.mjs")]),
  },
});
const { get, post } = app;

try {
  await app.prepare();
  await app.launch();
  const appRoot = (await get("/api/state")).runtime?.appRoot;
  assert(typeof appRoot === "string" && (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep), "running the build from this worktree");

  await post("/api/settings", {
    selectedHarnessId: "codex",
    harnessDefaults: {
      codex: {
        model: "gpt-5.4",
        effort: "low",
        codexPolicy: { sandbox: "read-only", approval: "never", guardian: false },
      },
    },
    workspacePath: workspace,
  });
  const createdParty = await post("/api/parties", { name: "BATCH-TOOLS-E2E", location: workspace });
  const partyId = createdParty.currentPartyId;

  const httpCreated = await post("/api/party/members", {
    members: [
      { partyId, name: "http-a", requirement: "HTTP batch A", runtime: "codex", model: "gpt-5.4", location: workspace },
      { partyId, name: "http-b", requirement: "HTTP batch B", runtime: "codex", model: "gpt-5.4", location: workspace },
    ],
  });
  assert(httpCreated.ok && httpCreated.created?.length === 2 && httpCreated.failed?.length === 0, "HTTP member creation accepts a members array");
  let party = await get("/api/party");
  assert(["http-a", "http-b"].every((name) => party.members.some((member) => member.name === name)), "HTTP batch-created members are in the real party state");

  const httpSent = await post("/api/party/messages", { from: "main", to: ["http-a", "http-b"], content: "HTTP batch delivery" });
  const httpReached = [...(httpSent.delivered || []), ...(httpSent.queuedMembers || [])];
  assert(httpSent.ok && httpReached.sort().join() === "http-a,http-b" && httpSent.failed?.length === 0, "HTTP message send accepts multiple recipients and reports delivery state per member");

  const httpBroadcast = await post("/api/party/broadcast", { from: "main", content: "HTTP excluded broadcast", exclude: ["http-b"] });
  const httpBroadcastOutcomes = [...(httpBroadcast.delivered || []), ...(httpBroadcast.queuedMembers || []), ...(httpBroadcast.failed || []).map((item) => item.name)];
  assert(httpBroadcastOutcomes.includes("http-a") && !httpBroadcastOutcomes.includes("http-b"), "HTTP broadcast excludes the selected member from every result bucket");

  const httpRemoved = await post("/api/party/members/remove", { name: ["http-a", "main", "http-b"] });
  assert(httpRemoved.ok && httpRemoved.removed?.sort().join() === "http-a,http-b" && httpRemoved.failed?.some((item) => item.name === "main"), "HTTP batch removal reports partial failure and preserves main");

  const tools = await get(`/api/parties/${partyId}/members/main/mcp-tools`);
  assert(tools.tools?.find((tool) => tool.name === "send")?.inputSchema?.properties?.to?.oneOf?.length === 2, "shipped MCP discovery exposes array recipients");
  assert(tools.tools?.find((tool) => tool.name === "member-create")?.inputSchema?.properties?.members?.type === "array", "shipped MCP discovery exposes batch member creation");
  assert(tools.tools?.find((tool) => tool.name === "broadcast")?.inputSchema?.properties?.exclude?.type === "array", "shipped MCP discovery exposes broadcast exclusions");

  const invokeMcp = (tool, arguments_) => post(`/api/parties/${partyId}/members/main/mcp-tools/${tool}`, { arguments: arguments_ });
  const mcpCreated = await invokeMcp("member-create", { members: [
    { name: "mcp-a", role: "MCP batch A", harness: "codex", model: "gpt-5.4", location: { host: "windows", cwd: workspace } },
    { name: "mcp-b", role: "MCP batch B", harness: "codex", model: "gpt-5.4", location: { host: "windows", cwd: workspace } },
  ] });
  assert(mcpCreated.ok && mcpCreated.data?.created?.length === 2 && mcpCreated.data?.failed?.length === 0, "real stdio MCP member-create accepts a members array");

  const mcpSent = await invokeMcp("send", { to: ["mcp-a", "mcp-b"], content: "MCP batch delivery" });
  const mcpReached = [...(mcpSent.data?.delivered || []), ...(mcpSent.data?.queuedMembers || [])];
  assert(mcpSent.ok && mcpReached.sort().join() === "mcp-a,mcp-b" && mcpSent.data?.failed?.length === 0, "real stdio MCP send reaches multiple recipients once each");

  const mcpBroadcast = await invokeMcp("broadcast", { content: "MCP excluded broadcast", exclude: ["mcp-b"] });
  const mcpBroadcastOutcomes = [...(mcpBroadcast.data?.delivered || []), ...(mcpBroadcast.data?.queuedMembers || []), ...(mcpBroadcast.data?.failed || []).map((item) => item.name)];
  assert(mcpBroadcast.ok && mcpBroadcastOutcomes.includes("mcp-a") && !mcpBroadcastOutcomes.includes("mcp-b"), "real stdio MCP broadcast honors exclude");

  const mcpRemoved = await invokeMcp("member-remove", { name: ["mcp-a", "mcp-b"] });
  assert(mcpRemoved.ok && mcpRemoved.data?.removed?.sort().join() === "mcp-a,mcp-b" && (mcpRemoved.data?.failed || []).length === 0, "real stdio MCP member-remove accepts arrays");
  party = await get("/api/party");
  assert(party.members.length === 1 && party.members[0]?.name === "main", "all successful batch removals persist in the real app state");

  // 'main' carries no special protection any more: it is removable like any
  // other member, and the party is then simply empty.
  const mainRemoved = await invokeMcp("member-remove", { name: "main" });
  assert(mainRemoved.ok && mainRemoved.data?.removed?.join() === "main", "real stdio MCP member-remove removes 'main'");
  party = await get("/api/party");
  assert(party.members.length === 0, "a party with its last member removed is empty rather than refusing");

  await app.close();
} catch (error) {
  app.kill();
  throw error;
}

console.log(failures.length ? `\nPARTY BATCH TOOLS E2E FAILED (${failures.length})` : "\nPARTY BATCH TOOLS E2E PASSED");
process.exit(failures.length ? 1 : 0);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
