/*
 * Product E2E for AgentParty MCP response budgets. Launches the real Electron
 * process and drives the same member-scoped HTTP/MCP route used by harnesses.
 */
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, removePath } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = `${process.pid}-${Date.now()}`;
const workspace = path.join(os.tmpdir(), `ap-party-tool-budget-ws-${runId}`);
const userData = path.join(os.tmpdir(), `ap-party-tool-budget-ud-${runId}`);
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

const port = await freePort();
const app = createElectronE2eApp({ root, workspace, userData, port });
const { get, post } = app;

try {
  await app.prepare();
  await app.launch();
  const appRoot = (await get("/api/state")).runtime?.appRoot;
  assert(
    typeof appRoot === "string" && (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep),
    `running the build from this worktree (${appRoot})`,
  );

  const members = [
    { name: "main", role: "coordinates the party", runtime: "codex", model: "gpt-5.4-mini" },
    ...Array.from({ length: 20 }, (_, index) => ({
      name: `worker-${String(index + 1).padStart(2, "0")}`,
      role: index === 0 ? "x".repeat(400) : `bounded-output worker ${index + 1}`,
      runtime: "codex",
      model: "gpt-5.4-mini",
    })),
  ];
  await post("/api/qa/reset").catch(() => undefined);
  await post("/api/qa/seed", { party: "party tool response budget", members });
  const partyId = (await get("/api/party")).currentPartyId;
  const toolRoute = `/api/parties/${encodeURIComponent(partyId)}/members/main/mcp-tools`;

  const tools = await get(toolRoute);
  const listSpec = tools.tools?.find((tool) => tool.name === "list");
  assert(listSpec?.inputSchema?.properties?.name?.type === "string", "shipped MCP list schema exposes exact-name detail");

  const longRule = "r".repeat(5_000);
  const gateReceipt = await post(`${toolRoute}/party-gate-set`, {
    arguments: { enabled: true, rule: longRule },
  });
  const gateBytes = jsonBytes(gateReceipt);
  assert(gateReceipt.ok === true && gateReceipt.data?.gate?.ruleChars === 5_000, "party-gate-set confirms the complete rule length");
  assert(!("rule" in (gateReceipt.data?.gate || {})), "party-gate-set does not echo arbitrary rule text");
  assert(gateBytes < 1_000, `party-gate-set response stays below 1 KB (${gateBytes} bytes)`);

  const summary = await post(`${toolRoute}/list`, { arguments: {} });
  const summaryBytes = jsonBytes(summary);
  assert(summary.ok === true && summary.data?.detail === "summary" && summary.data?.totalMembers === 21, "default list returns all 21 compact summaries");
  assert(summary.data?.members?.every((member) => !("gate" in member) && !("model" in member) && !("location" in member)), "default list omits repeated configuration and gate rules");
  const longRoleSummary = summary.data?.members?.find((member) => member.name === "worker-01");
  assert(longRoleSummary?.roleTruncated === true && longRoleSummary.role.length === 160, "unbounded role text is visibly truncated in summaries");
  assert(summaryBytes < 12_000, `21-member list response stays below 12 KB (${summaryBytes} bytes)`);

  const detail = await post(`${toolRoute}/list`, { arguments: { name: "worker-01" } });
  const detailBytes = jsonBytes(detail);
  assert(detail.ok === true && detail.data?.detail === "member" && detail.data?.members?.length === 1, "name filter returns exactly one detailed member");
  assert(detail.data?.members?.[0]?.gate?.rule === longRule, "one-member detail preserves the full effective gate rule for inspection");
  assert(detailBytes < 8_000, `single-member detail includes the rule only once (${detailBytes} bytes)`);

  const missing = await post(`${toolRoute}/list`, { arguments: { name: "missing-member" } });
  assert(missing.ok === false && /does not exist/i.test(missing.error || ""), "unknown member detail fails visibly");

  console.log(`\nMeasured: list summary ${summaryBytes} B, one-member detail ${detailBytes} B, gate receipt ${gateBytes} B`);
} catch (error) {
  app.kill();
  throw error;
} finally {
  await app.close().catch(() => app.kill());
  await removePath(workspace);
  await removePath(userData);
}

console.log(failures.length ? `\nPARTY TOOL OUTPUT BUDGET E2E FAILED (${failures.length})` : "\nPARTY TOOL OUTPUT BUDGET E2E PASSED");
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
