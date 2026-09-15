/*
 * Full-process E2E for the member-runtime MCP tool. Launches the real Electron
 * app, discovers and invokes the shipped stdio MCP relay, and checks the shared
 * HTTP action against real persisted party state. Mock harness sessions keep it
 * deterministic and make no provider calls.
 */
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp } from "./lib/electron-e2e.mjs";
import { qaRunDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = qaRunDir("member-runtime-tool");
const workspace = path.join(runRoot, "workspace");
const userData = path.join(runRoot, "userdata");
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "OK" : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};

const port = await freePort();
const app = createElectronE2eApp({ root, workspace, userData, port });
const { get, post } = app;

try {
  await app.prepare();
  await app.launch();
  const appRoot = (await get("/api/state")).runtime?.appRoot;
  assert(typeof appRoot === "string" && (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep), "running the build from this worktree");

  const seeded = await post("/api/qa/seed", {
    party: "member runtime tool e2e",
    members: [
      { name: "main", role: "MCP caller", autoReply: false },
      { name: "worker", role: "runtime target", runtime: "cursor", model: "Grok 4.5", effort: "medium", autoReply: false },
      { name: "codex-worker", role: "pre-start runtime target", runtime: "codex", model: "gpt-5.4", effort: "medium", autoReply: false },
    ],
  });
  const partyId = seeded.currentPartyId;
  const member = async (name) => (await get("/api/party")).members.find((item) => item.name === name);
  const invoke = (tool, arguments_) => post(`/api/parties/${partyId}/members/main/mcp-tools/${tool}`, { arguments: arguments_ });

  const tools = await get(`/api/parties/${partyId}/members/main/mcp-tools`);
  const runtimeSpec = tools.tools?.find((tool) => tool.name === "member-runtime");
  assert(runtimeSpec?.inputSchema?.properties?.fast?.type === "boolean", "real stdio MCP discovery exposes member-runtime with boolean Fast mode");

  const before = await member("worker");
  const liveChange = await invoke("member-runtime", { name: "worker", effort: "high" });
  const afterLive = await member("worker");
  assert(liveChange.ok && liveChange.data?.effort === "high", "real stdio MCP changes a supported effort");
  assert(afterLive?.effort === "high" && afterLive?.sessionId === before?.sessionId, "mutable effort is persisted without restarting the live member");

  const invalid = await invoke("member-runtime", { name: "worker", effort: "ultra" });
  assert(!invalid.ok && /Use: low, medium, high/.test(invalid.error || ""), "unsupported effort is rejected with valid catalog options");
  assert((await member("worker"))?.effort === "high", "invalid MCP input leaves the runtime unchanged");

  await post("/api/party/members/worker/close", {});
  const fastOn = await invoke("member-runtime", { name: "worker", fast: true });
  const afterFast = await member("worker");
  assert(fastOn.ok && fastOn.data?.fast === true && fastOn.data?.serviceTier === "fast", "Fast=true maps to Cursor's native fast tier");
  assert(afterFast?.status === "closed" && !afterFast?.sessionId, "changing a stopped member persists settings without unexpectedly starting it");

  const httpChange = await post("/api/party/members/worker/runtime", { fast: false, effort: "low" });
  const afterHttp = await member("worker");
  assert(httpChange.ok && afterHttp?.serviceTier === "standard" && afterHttp?.effort === "low", "HTTP runtime action shares the same catalog-validated implementation");

  const codexBefore = await member("codex-worker");
  const baiChange = await invoke("member-runtime", { name: "codex-worker", model: "DeepSeek V4.1 Flash B.AI" });
  const codexAfter = await member("codex-worker");
  assert(baiChange.ok && codexAfter?.model === "DeepSeek V4.1 Flash B.AI" && codexAfter?.effort === "high", "model-only MCP change replaces an incompatible inherited effort with the B.AI default");
  assert(codexAfter?.sessionId === codexBefore?.sessionId, "same-harness model and effort change is applied without losing the prewarmed session");
  const invalidBaiEffort = await invoke("member-runtime", { name: "codex-worker", effort: "medium" });
  assert(!invalidBaiEffort.ok && /Use: low, high, max/.test(invalidBaiEffort.error || ""), "B.AI rejects a non-advertised effort instead of silently changing it");
  await post("/api/party/members/codex-worker/close", {});
  const stoppedBaiChange = await invoke("member-runtime", { name: "codex-worker", effort: "max" });
  const stoppedCodex = await member("codex-worker");
  assert(stoppedBaiChange.ok && stoppedCodex?.status === "closed" && stoppedCodex?.effort === "max", "MCP runtime change persists before a member session exists");

  const self = await invoke("member-runtime", { name: "main", effort: "high" });
  assert(!self.ok && /calling member/i.test(self.error || ""), "MCP refuses to mutate its own in-flight caller session");

  const apiSpec = await get("/api/spec");
  assert(JSON.stringify(apiSpec).includes("/api/party/members/:name/runtime"), "local automation API publishes the member runtime capability");

  await app.close();
} catch (error) {
  app.kill();
  throw error;
}

console.log(failures.length ? `\nMEMBER RUNTIME TOOL E2E FAILED (${failures.length})` : "\nMEMBER RUNTIME TOOL E2E PASSED");
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
