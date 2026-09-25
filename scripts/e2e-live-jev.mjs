/* Real-app Jev API, member-scoped stdio MCP, Message Gate, and usage smoke. */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, delay } from "./lib/electron-e2e.mjs";
import { qaRunDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = qaRunDir("jev-live");
const workspace = path.join(runRoot, "workspace");
const userData = path.join(runRoot, "userdata");
const realSettingsPath = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "AgentParty", "settings.json");
const realSettings = JSON.parse(fs.readFileSync(realSettingsPath, "utf8"));
const key = process.env.OPENROUTER_API_KEY || realSettings.openRouterApiKey;
if (!key) throw new Error("An OpenRouter key is required for live Jev E2E.");

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const value = server.address().port;
    server.close(() => resolve(value));
  });
});
const app = createElectronE2eApp({ root, workspace, userData, port, env: { OPENROUTER_API_KEY: key } });
const check = (condition, description) => {
  if (!condition) throw new Error(description);
  console.log(`PASS ${description}`);
};
const request = {
  state: { posting: "Backend software engineer. Applicants need at least three years of experience." },
  questions: {
    backend: {
      type: "noul",
      instructions: "Is this a backend engineering position?",
      criteria: { true: "Backend software engineering", false: "Not backend software engineering" },
    },
    remote: { type: "noul", instructions: "Does this posting explicitly allow remote work?" },
    family: { type: "choice", instructions: "Which job family is this posting?", criteria: { backend: "Backend engineering", frontend: "Frontend engineering", other: "Other job family" } },
    seniority: { type: "score", instructions: "What experience level is required?", criteria: ["Entry level", "Around three years", "At least five years"] },
  },
};

try {
  await app.prepare();
  await app.launch();
  const state = await app.get("/api/state");
  check(state.runtime?.appRoot?.toLowerCase().startsWith(root.toLowerCase()), "real app runs from feature worktree");
  const providers = await app.get("/api/jev/providers");
  check(providers.defaultProvider === "openrouter" && providers.providers?.[0]?.configured, "provider discovery reports configured OpenRouter");
  const defaultSet = await app.post("/api/jev/providers/default", { provider: "openrouter" });
  check(defaultSet.defaultProvider === "openrouter", "local API sets the default Jev provider");
  const direct = await app.post("/api/jev/decisions", request);
  check(typeof direct.answers?.backend?.noul === "number" && typeof direct.answers?.remote?.noul === "number" && typeof direct.answers?.family?.choice === "string" && typeof direct.answers?.seniority?.score === "number" && direct.usage?.costUsd > 0, "local API receives all three Jev answer types and measured cost");

  const seed = await app.post("/api/qa/seed", { party: "Jev live E2E", members: [
    { name: "judge", model: "sonnet", role: "Gate sender", autoReply: false },
    { name: "peer", model: "sonnet", role: "Gate recipient", autoReply: false },
  ] });
  check(seed.created?.length === 2, "real app seeded two mock party members");
  const partyId = (await app.get("/api/party")).currentPartyId;
  const toolsRoute = `/api/parties/${partyId}/members/judge/mcp-tools`;
  const before = await app.get(toolsRoute);
  check(!before.tools?.some((tool) => tool.name === "jev-decide"), "Jev MCP tools are hidden while disabled");
  const disabled = await app.post(`${toolsRoute}/jev-providers`, { arguments: {} });
  check(!disabled.ok && /disabled/i.test(disabled.error || ""), "disabled Jev MCP invocation fails visibly");
  await app.post("/api/settings", { jevMcpEnabled: true });
  const after = await app.get(toolsRoute);
  check(after.tools?.some((tool) => tool.name === "jev-decide-file"), "Jev MCP tools appear through real stdio discovery");
  const mcp = (tool, args) => app.post(`${toolsRoute}/${tool}`, { arguments: args });
  const listed = await mcp("jev-providers", {});
  check(listed.ok && listed.data?.defaultProvider === "openrouter", "member-scoped MCP lists Jev providers");
  const selected = await mcp("jev-default-provider", { provider: "openrouter" });
  check(selected.ok && selected.data?.defaultProvider === "openrouter", "member-scoped MCP sets the default Jev provider");
  const inline = await mcp("jev-decide", { ...request, provider: "openrouter" });
  check(inline.ok && typeof inline.data?.answers?.remote?.noul === "number" && typeof inline.data?.answers?.family?.choice === "string" && typeof inline.data?.answers?.seniority?.score === "number", "member-scoped MCP returns all three Jev answer types");
  const outputPath = path.join(runRoot, "decision.json");
  const written = await mcp("jev-decide-file", { ...request, path: outputPath });
  check(written.ok && written.data?.path === outputPath, "member-scoped MCP writes on the member host");
  check(typeof JSON.parse(fs.readFileSync(outputPath, "utf8")).answers?.backend?.noul === "number", "file contains complete Jev answer");

  const gate = await mcp("party-gate-set", { axis: "send", enabled: true, rule: "Every outgoing message must contain the exact word APPLE.", reviewer: { model: "jev", effort: "none" } });
  check(gate.ok, "Message Gate accepts Jev as reviewer");
  const rejected = await mcp("send", { to: "peer", content: "BANANA" });
  check(!rejected.ok && /규칙|rule|gate/i.test(rejected.error || ""), "live Jev gate rejects a clear violation");
  const usage = await app.get("/api/token-usage/turns?range=5h");
  const records = Array.isArray(usage) ? usage : usage.turns || [];
  check(records.some((entry) => entry.trigger === "jev-decision" && entry.costUsd > 0), "direct Jev calls enter the cost ledger");
  check(records.some((entry) => entry.trigger === "gate-review" && entry.provider === "openrouter" && entry.costUsd > 0), "Jev gate cost enters the gate ledger");
  const aggregate = await app.get("/api/token-usage?range=5h");
  check(aggregate.totals?.costUsd >= records.filter((entry) => entry.provider === "openrouter").reduce((sum, entry) => sum + (entry.costUsd || 0), 0), "reported Jev spend enters the dashboard total");

  await app.post("/api/settings", { gateDefaults: { model: "jev", effort: "none" } });
  await app.post("/api/navigation", { view: "agent", tab: "gate" });
  await delay(300);
  for (const bounds of [{ width: 1440, height: 900 }, { width: 1100, height: 720 }]) {
    const resized = await app.post("/api/qa/window/bounds", bounds);
    check(resized.bounds?.width === bounds.width && resized.bounds?.height === bounds.height, `window reaches ${bounds.width}x${bounds.height}`);
    await delay(150);
    const card = await app.post("/api/measure", { selector: '[data-layout-card="agent-jev"]', limit: 1 });
    if (!card.elements?.[0]?.box?.width) console.log("Jev card measure:", JSON.stringify(card).slice(0, 800));
    check(card.elements?.[0]?.box?.width > 200 && !card.elements?.[0]?.scrollable?.horizontal, `Jev settings card fits ${bounds.width}px window`);
    for (const theme of ["light", "dark"]) {
      await app.post("/api/appearance/theme", { theme: `agentparty-${theme}` });
      await delay(150);
      const shot = path.join(runRoot, `jev-gate-${bounds.width}-${theme}.png`);
      const capture = await app.post("/api/capture", { path: shot, scrollY: "bottom" });
      check(capture.bytes > 1000 && fs.existsSync(shot), `Jev gate UI captured at ${bounds.width}px in ${theme} theme`);
    }
  }
  const opened = await app.post("/api/capture", { click: '[data-layout-card="agent-gate"] .wb-model-picker-trigger' });
  check(opened.clicked === true, "Message Gate model catalog opens from the rendered picker");
  const jevRow = await app.post("/api/measure", { selector: '.wb-modal-catalog [data-model="jev"]', limit: 1 });
  check(jevRow.elements?.[0]?.box?.width > 0, "Jev is selectable in the Message Gate model catalog");
  const modalShot = path.join(runRoot, "jev-gate-catalog-1100-dark.png");
  await app.post("/api/capture", { path: modalShot });
  check(fs.existsSync(modalShot), "open Message Gate catalog captured for visual review");
  await app.post("/api/capture", { click: ".wb-modal-catalog .wb-modal-head .wb-icon-btn" });
  const clicked = await app.post("/api/capture", { click: '[data-layout-card="agent-jev"] .set-toggle' });
  check(clicked.clicked === true, "Jev MCP setting toggles through the rendered UI");
  const uiState = await app.get("/api/state");
  check(uiState.settings?.jevMcpEnabled === false, "UI toggle persists through AppController settings");
  await app.close();
  console.log(`JEV LIVE E2E PASSED (${runRoot})`);
} catch (error) {
  app.kill();
  throw error;
}
