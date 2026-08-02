/*
 * Contract test: the selected harness owns the wire protocol. A Claude Code
 * request must reach every provider as Anthropic Messages without being flattened
 * into Chat Completions; Codex custom providers must remain Responses-based.
 */
import { build } from "esbuild";
import http from "node:http";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const outDir = qaTempDir();

async function load(entry, name) {
  const out = path.join(outDir, name);
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });
  return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

const { EmbeddedHarnessRouter } = await load("src/core/routerShim.ts", "harness-protocol-router.mjs");
const { HARNESS_PROTOCOLS } = await load("src/shared/harnessProtocols.ts", "harness-protocol-registry.mjs");
const { CODEX_CLAUDE_SUBSCRIPTION_PROVIDER, CODEX_OPENROUTER_PROVIDER } = await load("src/shared/codexProviders.ts", "harness-protocol-codex.mjs");

const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};

assert(HARNESS_PROTOCOLS["claude-code"].wireApi === "messages", "Claude Code owns the Anthropic Messages protocol");
assert(HARNESS_PROTOCOLS.codex.wireApi === "responses", "Codex owns the OpenAI Responses protocol");
assert(CODEX_CLAUDE_SUBSCRIPTION_PROVIDER.wireApi === "responses", "Codex + Claude subscription remains Responses");
assert(CODEX_OPENROUTER_PROVIDER.wireApi === "responses", "Codex + OpenRouter remains Responses");

let observed;
const upstream = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "gpt-5.4-mini" }] }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  observed = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
  };
  res.writeHead(200, { "Content-Type": "application/json", "x-request-id": "qa-anthropic-request" });
  res.end(JSON.stringify({
    id: "msg_qa_protocol",
    type: "message",
    role: "assistant",
    model: "gpt-5.4-mini",
    content: [{ type: "text", text: "PROTOCOL_OK" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 2 },
  }));
});

await listen(upstream);
const upstreamPort = upstream.address().port;
const gateway = new EmbeddedHarnessRouter({
  preferredPort: 0,
  authToken: "qa-client",
  subscriptionProxyBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
  subscriptionProxyApiKey: "qa-upstream",
});

try {
  await gateway.start();
  const healthResponse = await fetch(`${gateway.baseUrl}/health`);
  const health = await healthResponse.json();
  assert(health.protocol === "anthropic-messages", "gateway advertises its harness protocol");

  const messages = [
    { role: "user", content: [{ type: "text", text: "OLD_REQUEST" }] },
    { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    { role: "user", content: [{ type: "text", text: "NEW_REQUEST" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "cancelled" }] },
  ];
  const response = await fetch(`${gateway.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: "Bearer qa-client",
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-gpt-5.4-mini",
      system: [{ type: "text", text: "SYSTEM" }],
      messages,
      tools: [{ name: "Read", description: "Read", input_schema: { type: "object" } }],
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      max_tokens: 32,
      stream: false,
      models: ["unrequested-fallback"],
      fallbacks: ["unrequested-fallback"],
    }),
  });
  const payload = await response.json();

  assert(response.status === 200 && payload.content?.[0]?.text === "PROTOCOL_OK", "native Anthropic response is relayed without response conversion");
  assert(observed?.method === "POST" && observed?.url === "/v1/messages", "GPT subscription receives POST /v1/messages, not /chat/completions");
  assert(observed?.body?.model === "gpt-5.4-mini", "only the provider model alias is resolved");
  assert(JSON.stringify(observed?.body?.messages) === JSON.stringify(messages), "interrupt, user and tool blocks remain Anthropic and in order");
  assert(observed?.body?.system?.[0]?.text === "SYSTEM" && observed?.body?.tools?.[0]?.name === "Read", "system and tools remain Anthropic-native");
  assert(observed?.body?.thinking?.type === "disabled" && observed?.body?.output_config?.effort === "low", "thinking and effort remain harness-native");
  assert(observed?.body?.models === undefined && observed?.body?.fallbacks === undefined, "unrequested model fallback fields are rejected at the gateway");
  assert(observed?.headers?.["anthropic-version"] === "2023-06-01", "Anthropic protocol headers are preserved");
} finally {
  gateway.dispose();
  await close(upstream);
}

console.log(failures.length ? `\nHARNESS PROTOCOL FAILED (${failures.length})` : "\nHARNESS PROTOCOL PASSED");
process.exit(failures.length ? 1 : 0);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
