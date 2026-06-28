/*
 * LIVE e2e for the in-process party MCP bridge (docs/PARTY_COMMUNICATION.md).
 * NOT in the test suite — it makes a billed Sonnet call on the distro's
 * logged-in Claude subscription.
 *
 * Spawns a REAL member session through the WSL engine (which bundles the party
 * bridge) and asks the agent to call its `list-models` party tool. Verifies the
 * one thing the stubbed integration test cannot: that the real Claude agent
 * actually SEES and CALLS the in-process `agentparty-app` tools, and that
 * canUseTool auto-allows them (permissionMode=default, no approval prompt).
 *
 * Requires: WSL distro logged in (~/.claude), SDK in ~/.agent_party_app/server.
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(qaDir, { recursive: true });

async function bundle(entry, outName) {
  const out = path.join(qaDir, outName);
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
  writeFileSync(out, r.outputFiles[0].text);
  return out;
}

const serverBundle = await bundle("src/main/engine/transport/engineServerEntry.ts", "engine-server.mjs");
const clientBundle = await bundle("src/main/engine/transport/remoteEngineClient.ts", "engine-client.mjs");
const wslBundle = await bundle("src/main/engine/transport/wslEngine.ts", "wsl-engine.mjs");
const { RemoteEngineClient } = await import(pathToFileURL(clientBundle).href);
const { spawnWslEngine } = await import(pathToFileURL(wslBundle).href);

const distro = process.env.QA_WSL_DISTRO || "Ubuntu-22.04";
const wslWs = process.env.QA_WSL_WS || "/home/dev/agentparty-wsl-e2e";
const model = process.env.QA_MODEL || "sonnet";
const openRouterApiKey = process.env.OPENROUTER_API_KEY || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`LIVE party MCP e2e via WSL engine (${distro} @ ${wslWs}) — model=${model}:`);
const handle = spawnWslEngine({ distro, workspacePosix: wslWs, serverBundleWinPath: serverBundle, openRouterApiKey });
const client = new RemoteEngineClient(handle.transport, wslWs, handle.dispose);

let mainSessionId = "";
const toolCalls = [];
const approvalsForParty = [];
const texts = [];
let completed = false;
let errored = "";
const seenTypes = new Set();

client.onEvent((channel, payload) => {
  if (channel !== "session:events" || !Array.isArray(payload?.events)) return;
  if (mainSessionId && payload.sessionId && payload.sessionId !== mainSessionId) return;
  for (const ev of payload.events) {
    seenTypes.add(ev.type);
    if (ev.type === "tool_call") toolCalls.push({ name: ev.name, status: ev.status });
    if (ev.type === "approval_request" && String(ev.toolName || "").includes("agentparty-app")) approvalsForParty.push(ev.toolName);
    if (ev.type === "assistant_text_delta") texts.push(ev.text || "");
    if (ev.type === "turn_complete") completed = true;
    if (ev.type === "error") errored = ev.message || "error";
    if (ev.type === "status" && ev.detail) process.stdout.write(`    · ${ev.status}: ${String(ev.detail).slice(0, 80)}\n`);
  }
});

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

try {
  // Fresh party (auto-creates `main`), started as a REAL session with the bridge.
  await client.createParty({ name: "live-qa" });
  const started = await client.startMember("main", { model, effort: process.env.QA_EFFORT || "low", permissionMode: "default" });
  mainSessionId = started?.session?.id || "";
  console.log(`  main member session: ${mainSessionId} (${started?.session?.snapshot?.status})`);
  assert(Boolean(mainSessionId), "member session started");

  await client.sendUserTurn(
    mainSessionId,
    "You are the 'main' member of an Agent Party. You have party tools from the 'agentparty-app' MCP server, " +
      "including 'list-models' which lists the models available for creating new members. " +
      "Call the list-models party tool now, then reply with exactly: COUNT=<number of models it returned>. " +
      "You must call the tool — do not guess.",
  );
  console.log("  sent turn; awaiting real agent tool call…");

  for (let i = 0; i < 90 && !completed && !errored; i++) await sleep(1000);

  const partyToolCalls = toolCalls.filter((t) => String(t.name || "").includes("agentparty-app"));
  console.log("");
  console.log(`  event types seen: ${[...seenTypes].join(", ")}`);
  console.log(`  party tool calls: ${JSON.stringify(partyToolCalls)}`);
  console.log(`  model said: ${JSON.stringify(texts.join("").trim().slice(0, 200))}`);
  if (errored) console.log(`  harness error: ${errored}`);

  assert(partyToolCalls.length > 0, "the real agent CALLED an agentparty-app party tool");
  assert(partyToolCalls.some((t) => String(t.name).includes("list-models")), "specifically called list-models");
  assert(approvalsForParty.length === 0, "party tool was auto-allowed (no approval prompt emitted)");
  assert(completed && !errored, "turn completed without harness error");
  assert(/COUNT=\d+/.test(texts.join("")), "agent reported a model COUNT from the tool result");
} catch (e) {
  console.error("failed:", e?.message || e);
  failures.push(String(e?.message || e));
} finally {
  client.dispose();
}

console.log(failures.length ? `\nLIVE PARTY e2e FAILED (${failures.length})` : "\nLIVE PARTY e2e PASSED (real agent called the in-process MCP tool)");
process.exit(failures.length ? 1 : 0);
