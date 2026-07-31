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

// Cursor owns the stdio MCP pipe. When it tears the session down (Stop, member
// remove, process recycle), writes here race the close and throw EPIPE. That
// uncaught exception used to crash this server and show up in Cursor's own
// logger.js stack as "broken pipe". Swallow pipe teardown; keep real errors.
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
const codexPolicySchema = {
  type: "object",
  properties: {
    sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] },
    approval: { type: "string", enum: ["untrusted", "on-request", "never"] },
    guardian: { type: "boolean" },
  },
  required: ["sandbox", "approval", "guardian"],
  additionalProperties: false,
};
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const gateReviewerSchema = {
  type: ["object", "null"],
  properties: {
    model: { type: "string" },
    effort: { type: "string" },
  },
  required: ["model", "effort"],
  additionalProperties: false,
};

const tools = [
  {
    name: "send",
    description: "Send a message to another member of your AgentParty party.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient member name." },
        content: { type: "string", description: "Message body." },
        interrupt: { type: "boolean", description: "Stop the recipient's current turn before delivery." },
        force: { type: "boolean", description: "Bypass Message Gate review for an urgent message." },
        forceReason: { type: "string", description: "Why the Message Gate was bypassed." },
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
        permissionMode: { type: "string" },
        codexPolicy: codexPolicySchema,
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
    name: "member-permission",
    description: "Change another AgentParty member's persisted permission.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, permissionMode: { type: "string" }, codexPolicy: codexPolicySchema },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "gate-set",
    description: "Set another member's Message Gate override.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        mode: { type: "string", enum: ["inherit", "on", "off"] },
        rule: { type: ["string", "null"] },
        reviewer: gateReviewerSchema,
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "party-gate-set",
    description: "Set the party-wide Message Gate default.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        rule: { type: "string" },
        reviewer: gateReviewerSchema,
      },
      additionalProperties: false,
    },
  },
  {
    name: "list",
    description: "List AgentParty members and their current status.",
    annotations: readOnlyAnnotations,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list-models",
    description: "List available AgentParty harnesses and model routes.",
    annotations: readOnlyAnnotations,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "member-status",
    description: "Check one member's turn status, or every member when name is omitted.",
    annotations: readOnlyAnnotations,
    inputSchema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "interrupt",
    description: "Stop another member's in-flight turn; target may be a member name or all.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
  },
  {
    name: "broadcast",
    description: "Send a message to every other member in the party.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" }, interrupt: { type: "boolean" } },
      required: ["content"],
      additionalProperties: false,
    },
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
      return post("/api/harness/party/messages", {
        to: String(args.to || ""),
        from: member,
        content: String(args.content || ""),
        interrupt: args.interrupt === true,
        force: args.force === true,
        forceReason: typeof args.forceReason === "string" ? args.forceReason : undefined,
      }, { "x-agentparty-member": member });
    case "member-create": {
      const created = await post("/api/party/members", {
        partyId: party || undefined,
        name: String(args.name || ""),
        requirement: String(args.role || ""),
        role: String(args.role || ""),
        runtime: String(args.harness || "claude-code"),
        model: typeof args.model === "string" ? args.model : undefined,
        reasoning: typeof args.reasoning === "string" ? args.reasoning : undefined,
        reasoningBudget: typeof args.reasoningBudget === "number" ? args.reasoningBudget : undefined,
        effort: typeof args.effort === "string" ? args.effort : undefined,
        permissionMode: typeof args.permissionMode === "string" ? args.permissionMode : undefined,
        codexPolicy: args.codexPolicy && typeof args.codexPolicy === "object" ? args.codexPolicy : undefined,
      });
      if (created?.member?.name) {
        await post(`/api/party/members/${encodeURIComponent(created.member.name)}/start`, {
          model: typeof args.model === "string" ? args.model : undefined,
          effort: typeof args.effort === "string" ? args.effort : undefined,
          permissionMode: typeof args.permissionMode === "string" ? args.permissionMode : undefined,
          codexPolicy: args.codexPolicy && typeof args.codexPolicy === "object" ? args.codexPolicy : undefined,
        }).catch((error) => ({ ok: false, error: error.message }));
      }
      return created;
    }
    case "member-remove":
      return post(`/api/party/members/${encodeURIComponent(String(args.name || ""))}/remove`, {});
    case "member-permission":
      return post(`/api/party/members/${encodeURIComponent(String(args.name || ""))}/permission`, {
        permissionMode: typeof args.permissionMode === "string" ? args.permissionMode : undefined,
        codexPolicy: args.codexPolicy && typeof args.codexPolicy === "object" ? args.codexPolicy : undefined,
      });
    case "gate-set": {
      const gate = {};
      if (args.mode === "inherit" || args.mode === "on" || args.mode === "off") gate.mode = args.mode;
      if ("rule" in args && (args.rule === null || typeof args.rule === "string")) gate.rule = args.rule;
      if ("reviewer" in args && (args.reviewer === null || typeof args.reviewer === "object")) gate.reviewer = args.reviewer;
      return post(`/api/party/members/${encodeURIComponent(String(args.name || ""))}/gate`, { gate });
    }
    case "party-gate-set": {
      if (!party) return { ok: false, error: "AGENTPARTY_PARTY is not set." };
      const state = await get("/api/harness/party");
      const current = state?.parties?.find((item) => item.id === party)?.gate || { enabled: false, rule: "" };
      const gate = { ...current };
      if (typeof args.enabled === "boolean") gate.enabled = args.enabled;
      if (typeof args.rule === "string") gate.rule = args.rule;
      if ("reviewer" in args && (args.reviewer === null || typeof args.reviewer === "object")) {
        if (args.reviewer === null) delete gate.reviewer;
        else gate.reviewer = args.reviewer;
      }
      return post(`/api/parties/${encodeURIComponent(party)}/gate`, gate);
    }
    case "list":
      return get("/api/harness/party");
    case "list-models":
      return get("/api/models");
    case "member-status":
      return post(`/api/party/members/${encodeURIComponent(String(args.name || "*"))}/status`, {});
    case "interrupt": {
      const target = String(args.target || "");
      if (target === member) return { ok: false, error: "You cannot interrupt yourself." };
      return post(`/api/party/members/${encodeURIComponent(target === "all" ? "*" : target)}/interrupt`, target === "all" ? { exclude: member } : {});
    }
    case "broadcast":
      return post("/api/party/broadcast", { from: member, content: String(args.content || ""), interrupt: args.interrupt === true });
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
  const response = await fetch(baseUrl + path, { headers: partyHeaders() });
  return readResponse(response, path);
}

async function post(path, body, headers = {}) {
  const response = await fetch(baseUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...partyHeaders(), ...headers },
    body: JSON.stringify(body || {}),
  });
  return readResponse(response, path);
}

function partyHeaders() {
  return {
    "x-agentparty-member": member,
    ...(party ? { "x-agentparty-party": party } : {}),
  };
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
  try {
    if (!process.stdout.writable) return;
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    if (isPipeClosedError(error)) return;
    throw error;
  }
}

function isPipeClosedError(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_PREMATURE_CLOSE";
}
