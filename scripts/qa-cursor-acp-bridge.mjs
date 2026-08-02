/*
 * Cursor ACP bridge — stub QA.
 *
 * Runs the REAL EmbeddedHarnessRouter + CursorHarnessBridge + relay MCP stub
 * against a FAKE `cursor-agent acp` (below), so the full wire is exercised
 * without a Cursor account: Anthropic request → router → bridge → ACP →
 * relay MCP spawn → /acp-bridge callback → tool_use response → tool_result
 * continuation → final answer. The fake agent implements the measured ACP
 * surface (initialize/authenticate/session/new/set_config_option/prompt,
 * agent_message_chunk, MCP server spawning) and re-calls a tool when it sees
 * the bridge's STILL RUNNING instruction — the >60s poll-loop contract.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const outDir = qaTempDir();

// Short relay hold so the PENDING loop is testable in milliseconds.
process.env.AGENTPARTY_ACP_RELAY_HOLD_MS = "500";

// ---------- fake cursor-agent (CJS .js so resolveCursorAgentCommand wraps it with node) ----------
const FAKE_AGENT = String.raw`
const { spawn } = require("child_process");
const readline = require("readline");
if (!process.argv.includes("acp")) { process.stderr.write("expected acp subcommand"); process.exit(2); }
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let mcp; let mcpNextId = 1; const mcpPending = new Map();
function mcpCall(method, params) {
  const id = mcpNextId++;
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => mcpPending.set(id, { resolve, reject }));
}
function startMcp(server) {
  const env = { ...process.env };
  for (const e of server.env || []) env[e.name] = e.value;
  mcp = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "inherit"], env });
  const mrl = readline.createInterface({ input: mcp.stdout });
  mrl.on("line", (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const w = mcpPending.get(m.id);
    if (w) { mcpPending.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); }
  });
  return mcpCall("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-agent", version: "0" } });
}
async function callToolUntilDone(name, args) {
  for (let i = 0; i < 40; i += 1) {
    const r = await mcpCall("tools/call", { name, arguments: args });
    const text = (r.content || []).map((c) => c.text || "").join("");
    if (!text.startsWith("STILL RUNNING")) return { text, isError: r.isError === true };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { text: "gave up", isError: true };
}
let cancelled = false;
rl.on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: {} });
  else if (msg.method === "authenticate") send({ jsonrpc: "2.0", id: msg.id, result: {} });
  else if (msg.method === "session/new") {
    if ((msg.params.mcpServers || []).length > 0) await startMcp(msg.params.mcpServers[0]);
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1", models: { availableModels: [{ modelId: "grok-4.5[effort=high,fast=true]", name: "grok-4.5" }] } } });
  } else if (msg.method === "session/set_config_option") send({ jsonrpc: "2.0", id: msg.id, result: {} });
  else if (msg.method === "session/cancel") cancelled = true;
  else if (msg.method === "session/prompt") {
    cancelled = false;
    const text = (msg.params.prompt || []).map((p) => p.text || "").join("\n");
    const images = (msg.params.prompt || []).filter((p) => p.type === "image");
    const chunk = (t) => send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: t } } } });
    if (images.length > 0) {
      chunk("saw-image:" + images.map((i) => i.mimeType).join(","));
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }
    const toolMatch = /USE_TOOL:(\S+)\s+(\{.*\})/.exec(text);
    if (toolMatch) {
      const outcome = await callToolUntilDone(toolMatch[1], JSON.parse(toolMatch[2]));
      chunk("tool said: " + outcome.text);
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: cancelled ? "cancelled" : "end_turn" } });
    } else if (text.includes("STREAM3")) {
      chunk("one "); chunk("two "); chunk("three");
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    } else {
      chunk("echo:" + text.slice(-40));
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;
const fakeAgentPath = path.join(outDir, "fake-cursor-agent.js");
writeFileSync(fakeAgentPath, FAKE_AGENT);
process.env.AGENTPARTY_CURSOR_BIN = fakeAgentPath;

// ---------- bundle the real router ----------
const bundled = await build({
  entryPoints: [path.join(projectRoot, "src/core/routerShim.ts")],
  bundle: true, format: "cjs", platform: "node", write: false, external: ["electron"],
});
const routerFile = path.join(outDir, "router-shim.cjs");
writeFileSync(routerFile, bundled.outputFiles[0].text);
const { EmbeddedHarnessRouter } = createRequire(import.meta.url)(routerFile);

const workspacesDir = path.join(outDir, "acp-bridge-ws");
const router = new EmbeddedHarnessRouter({
  preferredPort: 0,
  authToken: "qa-token",
  cursorBridge: {
    relayScriptPath: path.join(projectRoot, "scripts", "agentparty-acp-mcp-relay.mjs"),
    workspacesDir,
  },
});
await router.start();
const base = router.baseUrl;

const TOOLS = [{ name: "get_time", description: "Returns the time.", input_schema: { type: "object", properties: {}, required: [] } }];
async function messages(body, token = "agentparty-native-session:qa1") {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "Grok 4.5 Cursor", max_tokens: 400, ...body }),
  });
  const text = await response.text();
  return { status: response.status, text, json: safeParse(text) };
}
const safeParse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };

console.log("\nplain turn (non-stream):");
{
  const r = await messages({ stream: false, messages: [{ role: "user", content: "hello bridge" }] });
  assert(r.status === 200, `HTTP 200 (got ${r.status})`);
  const text = (r.json?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  assert(text.includes("echo:"), `fake model text came back through the bridge (got ${JSON.stringify(text.slice(0, 60))})`);
  assert(r.json?.stop_reason === "end_turn", "stop_reason end_turn");
}

console.log("\ntool round-trip with a slow harness (PENDING loop):");
{
  const history = [{ role: "user", content: "USE_TOOL:get_time {}" }];
  const first = await messages({ stream: false, messages: history, tools: TOOLS });
  const toolUse = (first.json?.content || []).find((b) => b.type === "tool_use");
  assert(first.json?.stop_reason === "tool_use", `first response stops for tool_use (got ${first.json?.stop_reason})`);
  assert(toolUse?.name === "get_time", "tool_use block names the harness tool");
  // Answer SLOWLY (3× the relay hold) so the agent must loop on STILL RUNNING.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  history.push({ role: "assistant", content: first.json.content });
  history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: [{ type: "text", text: "12:34" }] }] });
  const second = await messages({ stream: false, messages: history, tools: TOOLS });
  const text = (second.json?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  assert(text.includes("tool said: 12:34"), `tool result reached the model through the PENDING loop (got ${JSON.stringify(text.slice(0, 80))})`);
  assert(second.json?.stop_reason === "end_turn", "continuation finishes the turn");
}

console.log("\nstreaming SSE:");
{
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { Authorization: "Bearer agentparty-native-session:qa2", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "Grok 4.5 Cursor", max_tokens: 400, stream: true, messages: [{ role: "user", content: "STREAM3" }] }),
  });
  assert((response.headers.get("content-type") || "").includes("text/event-stream"), "SSE content type");
  const raw = await response.text();
  const events = raw.split("\n\n").filter(Boolean).map((block) => /event: (\S+)/.exec(block)?.[1]);
  const deltas = raw.split("\n\n").filter((block) => block.includes("text_delta"));
  assert(events[0] === "message_start" && events.includes("message_stop"), `SSE frames ordered (got ${events.join(",")})`);
  assert(deltas.length >= 3, `incremental text deltas (got ${deltas.length})`);
  assert(raw.includes("one ") && raw.includes("three"), "chunk text preserved");
}

console.log("\nimage attachment forwarding:");
{
  const r = await messages({
    stream: false,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "what color is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
      ],
    }],
  }, "agentparty-native-session:qa-img");
  const text = (r.json?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  assert(text.includes("saw-image:image/png"), `Anthropic image block reached ACP as an image block (got ${JSON.stringify(text.slice(0, 60))})`);
}

console.log("\nno-bridge router refuses explicitly:");
{
  const bare = new EmbeddedHarnessRouter({ preferredPort: 0, authToken: "qa-token" });
  await bare.start();
  const response = await fetch(`${bare.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { Authorization: "Bearer qa-token", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "Grok 4.5 Cursor", max_tokens: 100, stream: false, messages: [{ role: "user", content: "x" }] }),
  });
  const payload = await response.json();
  assert(response.status === 500 && String(payload?.error?.message || "").includes("Cursor ACP bridge"), "explicit bridge-missing error, no fallback");
  bare.dispose();
}

console.log("\nrelay auth:");
{
  const response = await fetch(`${base}/acp-bridge/tools`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
    body: JSON.stringify({ conversation: "nope" }),
  });
  assert(response.status === 401, `relay rejects a bad bridge token (got ${response.status})`);
}

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
router.dispose();
process.exitCode = failures.length ? 1 : 0;
// fetch keepalive sockets can hold the loop open briefly; hard-stop like other QA scripts.
setTimeout(() => process.exit(process.exitCode), 1500).unref();
