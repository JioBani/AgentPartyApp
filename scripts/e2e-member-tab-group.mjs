/*
 * Full-process product E2E for member placement. Launches the real Electron app
 * and drives the public automation HTTP API used by UI/MCP-backed workflows.
 */
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.join(os.tmpdir(), "ap-member-tab-group-e2e-ws");
const userData = path.join(os.tmpdir(), "ap-member-tab-group-e2e-ud");
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

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

  await post("/api/qa/reset").catch(() => undefined);
  await post("/api/qa/seed", { party: "tab-group-e2e", members: [{ name: "main", role: "anchor" }] });
  const party = await get("/api/party");
  const partyId = party.currentPartyId;
  await post("/api/party/layout", {
    layout: {
      panels: [{ id: "panel-main", tabs: ["main"], active: "main", weight: 1 }],
      focusedPanelId: "panel-main",
    },
  });

  await post("/api/party/members", {
    partyId,
    name: "grouped",
    tabGroup: "panel-main",
    requirement: "tab group E2E",
    runtime: "codex",
    model: "gpt-5.4-mini",
    location: workspace,
  });
  let layout = (await get("/api/party/layout")).layout;
  const anchored = layout.panels.find((panel) => panel.tabs.includes("main"));
  assert(anchored?.tabs.join(",") === "main,grouped", "HTTP member.create appends to the requested existing tab group");
  assert(anchored?.active === "grouped", "the created member becomes active in the requested group");

  await post("/api/party/members", {
    partyId,
    name: "separate",
    requirement: "new group E2E",
    runtime: "codex",
    model: "gpt-5.4-mini",
    location: workspace,
  });
  layout = (await get("/api/party/layout")).layout;
  assert(layout.panels.some((panel) => panel.tabs.length === 1 && panel.tabs[0] === "separate"), "omitting tabGroup preserves the new-group behavior");

  const mcpTools = await get(`/api/parties/${partyId}/members/main/mcp-tools`);
  const createTool = mcpTools.tools?.find((tool) => tool.name === "member-create");
  assert(createTool?.inputSchema?.properties?.tabGroup?.type === "string", "shipped MCP discovery exposes member-create.tabGroup");

  const mcpCreated = await post(`/api/parties/${partyId}/members/main/mcp-tools/member-create`, {
    arguments: {
      name: "mcp-grouped",
      role: "stdio MCP tab group E2E",
      tabGroup: "panel-main",
      harness: "codex",
      model: "gpt-5.4-mini",
      location: { host: "windows", cwd: workspace },
    },
  });
  assert(mcpCreated.ok === true, `shipped stdio MCP member-create accepts tabGroup${mcpCreated.ok ? "" : ` (${JSON.stringify(mcpCreated)})`}`);
  layout = (await get("/api/party/layout")).layout;
  const mcpAnchored = layout.panels.find((panel) => panel.tabs.includes("main"));
  assert(mcpAnchored?.tabs.includes("mcp-grouped"), "MCP-created member is persisted in the requested existing group");
  assert(mcpAnchored?.active === "mcp-grouped", "MCP placement is broadcast and activated like UI/HTTP placement");
  const mcpListed = await post(`/api/parties/${partyId}/members/main/mcp-tools/list`, { arguments: {} });
  assert(
    mcpListed.data?.tabGroups?.some((group) => group.id === "panel-main" && group.anchor === "mcp-grouped" && group.members.includes("main")),
    "MCP list returns discoverable exact tab-group ids for later member-create calls",
  );

  const invalid = await fetch(`${app.baseUrl}/api/party/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      partyId,
      name: "lost",
      tabGroup: "not-open",
      requirement: "must fail",
      runtime: "codex",
      model: "gpt-5.4-mini",
      location: workspace,
    }),
  });
  assert(!invalid.ok && /not open/i.test(await invalid.text()), "an unknown/closed group fails visibly instead of falling back");
  assert(!(await get("/api/party")).members.some((member) => member.name === "lost"), "failed placement does not leave a half-created member");

  const firstWindow = (await get("/api/windows")).windows[0].id;
  await post(`/api/navigation?window=${firstWindow}`, { view: "workbench" });
  await post(`/api/qa/open?window=${firstWindow}`, { panels: [["main"], ["grouped"], ["separate"], ["mcp-grouped"]] });
  await new Promise((resolve) => setTimeout(resolve, 500));
  // Fixture setup through HTTP: old persisted layouts can name a member that
  // has since been removed. The renderer prunes it before showing the tabs.
  const stale = (await get(`/api/party/layout?window=${firstWindow}`)).layout;
  await post(`/api/party/layout?window=${firstWindow}`, {
    layout: { ...stale, panels: stale.panels.map((panel, index) => index === 0 ? { ...panel, tabs: [...panel.tabs, "removed-member"] } : panel) },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const secondWindow = (await post("/api/windows", { workspacePath: workspace, partyId })).id;
  assert(Boolean(secondWindow), "second window opened on the same party");
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const name of ["grouped", "separate"]) {
    await post(`/api/capture?window=${firstWindow}`, { path: path.join(os.tmpdir(), `ap-close-${name}.png`), click: `.wb-tab[data-drop-tab="${name}"] .wb-tab-close` });
  }
  layout = (await get(`/api/party/layout?window=${firstWindow}`)).layout;
  assert(layout.panels.length === 2 && !layout.panels.some((panel) => panel.tabs.some((name) => ["grouped", "separate", "removed-member"].includes(name))), "tab closures persist despite a stale removed-member tab");
  const createdAfterClose = await post(`/api/parties/${partyId}/members/main/mcp-tools/member-create`, {
    arguments: { name: "mcp-after-close", role: "closed tab regression", harness: "codex", model: "gpt-5.4-mini", location: { host: "windows", cwd: workspace } },
  });
  assert(createdAfterClose.ok === true, "member-scoped MCP creates the next member");
  layout = (await get(`/api/party/layout?window=${firstWindow}`)).layout;
  assert(layout.panels.length === 3 && !layout.panels.some((panel) => panel.tabs.some((name) => ["grouped", "separate", "removed-member"].includes(name))), "MCP creation opens only the new tab");
  await post(`/api/window/close?window=${secondWindow}`, {});

  await app.close();
} catch (error) {
  app.kill();
  throw error;
}

console.log(failures.length ? `\nMEMBER TAB GROUP E2E FAILED (${failures.length})` : "\nMEMBER TAB GROUP E2E PASSED");
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
