/*
 * Codex/Cursor-facing AgentParty MCP server.
 *
 * The harness loads this stdio relay because it cannot receive the app's
 * in-process dynamic tools. Tool discovery and execution both route through
 * the running app, so there is only one capability contract and one
 * AppController path for Windows, WSL and future execution hosts.
 */
import readline from "node:readline";
import fs from "node:fs";

// Harness teardown races pending writes. A closed stdio pipe is normal; every
// other stream error remains visible.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (isPipeClosedError(error)) return;
    throw error;
  });
}

const baseUrl = process.env.AGENTPARTY_AUTOMATION_BASE_URL || "";
const member = process.env.AGENTPARTY_MEMBER || "agent";
const party = process.env.AGENTPARTY_PARTY || "";
const callLog = process.env.AGENTPARTY_CODEX_MCP_OUT || "";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  void handleLine(line).catch((error) => {
    try {
      const id = JSON.parse(line)?.id;
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
      }
    } catch {
      // Invalid input; there is no request id to answer.
    }
  });
});

async function handleLine(line) {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;

  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agentparty-app", version: "0.1.0" },
        },
      });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: await listTools() } });
      return;
    case "tools/call": {
      const name = String(msg.params?.name || "");
      const args = msg.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {};
      const result = await callTool(name, args);
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: result?.ok === false,
        },
      });
      return;
    }
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } });
  }
}

/** Fetches the canonical core-owned names, descriptions and input schemas. */
async function listTools() {
  assertBaseUrl();
  const result = await get("/api/harness/party/tool-spec");
  if (result?.ok !== true || !Array.isArray(result.tools)) {
    throw new Error(`AgentParty tool discovery returned an invalid response: ${JSON.stringify(result)}`);
  }
  return result.tools;
}

/**
 * Hands the call to the app and returns its answer untouched.
 *
 * `/api/harness/party/tools/<name>` runs the same `invokePartyTool` used by
 * in-process harnesses. Keep this relay a pump: behavior added here would only
 * apply to stdio clients and recreate the contract drift this file removes.
 */
async function callTool(name, args) {
  recordCall(name, args);
  assertBaseUrl();
  return post(`/api/harness/party/tools/${encodeURIComponent(name)}`, args);
}

function assertBaseUrl() {
  if (!baseUrl) throw new Error("AGENTPARTY_AUTOMATION_BASE_URL is not set.");
}

async function get(path) {
  const response = await fetch(baseUrl + path, { headers: partyHeaders() });
  return readResponse(response, path);
}

async function post(path, body) {
  const response = await fetch(baseUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...partyHeaders() },
    body: JSON.stringify(body || {}),
  });
  return readResponse(response, path);
}

function partyHeaders() {
  return {
    // Fetch requires ByteString header values. Base64url preserves Unicode
    // member/party identities while staying ASCII-only.
    "x-agentparty-member-base64url": Buffer.from(member, "utf8").toString("base64url"),
    ...(party ? { "x-agentparty-party-base64url": Buffer.from(party, "utf8").toString("base64url") } : {}),
  };
}

async function readResponse(response, path) {
  const body = await response.text();
  let data;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    data = { text: body };
  }
  if (!response.ok) return { ok: false, error: `${path} returned ${response.status}`, data };
  return data;
}

function recordCall(name, args) {
  if (!callLog) return;
  try {
    fs.appendFileSync(callLog, `${JSON.stringify({ at: new Date().toISOString(), member, name, args })}\n`);
  } catch {
    // Diagnostics only; never break the product tool path.
  }
}

function send(message) {
  try {
    if (process.stdout.writable) process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    if (isPipeClosedError(error)) return;
    throw error;
  }
}

function isPipeClosedError(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_PREMATURE_CLOSE";
}
