/*
 * Codex-facing AgentParty MCP server.
 *
 * Codex app-server loads MCP servers from its config. Unlike Claude's SDK, the
 * current Codex app-server build does not expose client-provided dynamic tools
 * from thread/start config, so Codex sessions get the same party surface through
 * this local stdio MCP server. Each tool routes back through the app's local
 * automation HTTP API, which reaches the same AppController methods as the UI.
 */
import readline from "node:readline";
import fs from "node:fs";

const baseUrl = process.env.AGENTPARTY_AUTOMATION_BASE_URL || "";
const member = process.env.AGENTPARTY_MEMBER || "agent";
const callLog = process.env.AGENTPARTY_CODEX_MCP_OUT || "";

const tools = [
  {
    name: "send",
    description: "Send a message to another member of your AgentParty party.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient member name." },
        content: { type: "string", description: "Message body." },
      },
      required: ["to", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "member-create",
    description: "Create a new AgentParty member and start its session.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        harness: { type: "string" },
        model: { type: "string" },
        reasoning: { type: "string" },
        reasoningBudget: { type: "number" },
        effort: { type: "string" },
      },
      required: ["name", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "member-remove",
    description: "Remove an AgentParty member.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "list",
    description: "List AgentParty members and their current status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list-models",
    description: "List available AgentParty harnesses and model routes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  void handleLine(line).catch((error) => {
    try {
      const id = JSON.parse(line)?.id;
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
      }
    } catch {
      // Invalid input; no usable request id.
    }
  });
});

async function handleLine(line) {
  if (!line.trim()) {
    return;
  }
  const msg = JSON.parse(line);
  if (msg.id === undefined) {
    return;
  }
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
      send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
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

async function callTool(name, args) {
  recordCall(name, args);
  assertBaseUrl();
  switch (name) {
    case "send":
      return post("/api/harness/party/messages", { to: String(args.to || ""), from: member, content: String(args.content || "") }, { "x-agentparty-member": member });
    case "member-create": {
      const created = await post("/api/party/members", {
        name: String(args.name || ""),
        requirement: String(args.role || ""),
        role: String(args.role || ""),
        runtime: String(args.harness || "claude-code"),
        model: typeof args.model === "string" ? args.model : undefined,
        reasoning: typeof args.reasoning === "string" ? args.reasoning : undefined,
        reasoningBudget: typeof args.reasoningBudget === "number" ? args.reasoningBudget : undefined,
        effort: typeof args.effort === "string" ? args.effort : undefined,
      });
      if (created?.member?.name) {
        await post(`/api/party/members/${encodeURIComponent(created.member.name)}/start`, {
          model: typeof args.model === "string" ? args.model : undefined,
          effort: typeof args.effort === "string" ? args.effort : undefined,
        }).catch((error) => ({ ok: false, error: error.message }));
      }
      return created;
    }
    case "member-remove":
      return post(`/api/party/members/${encodeURIComponent(String(args.name || ""))}/remove`, {});
    case "list":
      return get("/api/harness/party");
    case "list-models":
      return get("/api/models");
    default:
      return { ok: false, error: `Unknown AgentParty tool '${name}'.` };
  }
}

function assertBaseUrl() {
  if (!baseUrl) {
    throw new Error("AGENTPARTY_AUTOMATION_BASE_URL is not set.");
  }
}

async function get(path) {
  const response = await fetch(baseUrl + path, { headers: { "x-agentparty-member": member } });
  return readResponse(response, path);
}

async function post(path, body, headers = {}) {
  const response = await fetch(baseUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body || {}),
  });
  return readResponse(response, path);
}

async function readResponse(response, path) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  if (!response.ok) {
    return { ok: false, error: `${path} returned ${response.status}`, data };
  }
  return data;
}

function recordCall(name, args) {
  if (!callLog) {
    return;
  }
  try {
    fs.appendFileSync(callLog, `${JSON.stringify({ at: new Date().toISOString(), member, name, args })}\n`);
  } catch {
    // Diagnostics only; never break the tool path.
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
