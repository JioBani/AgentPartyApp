import { z } from "zod";

// Boundary 2 of the party-communication design (docs/PARTY_COMMUNICATION.md):
// the seam through which an app-hosted member session reaches the app's party
// features. The handler implementations live in the main process
// (`PartyApplicationService`); this interface lets `core` build the in-process
// MCP tool surface without importing anything from `main`.
//
// A bridge instance is always paired with a `PartyIdentity` bound at session
// construction, so the agent never states (and cannot spoof) who it is — that is
// where "zero model-memory reliance" comes from.

export interface PartyIdentity {
  /** The party this session's member belongs to. */
  party: string;
  /** This session's member name — stamped as `from` on every send. */
  member: string;
  /** This member's role/requirement, surfaced in the session primer. */
  role?: string;
}

export interface PartyToolResult {
  ok: boolean;
  /** Human-readable reason when `ok` is false (surfaced to the agent verbatim). */
  error?: string;
  /** Optional structured payload for info requests (list / listModels). */
  data?: unknown;
}

export interface PartyCreateMemberRequest {
  name: string;
  role: string;
  /** Harness id; `claude-code` and `codex` are supported. */
  harness?: string;
  model?: string;
  /** Reasoning/thinking mode (adaptive|enabled|disabled) for the new member. */
  reasoning?: string;
  reasoningBudget?: number;
  effort?: string;
}

// The capability surface a hosted member can drive. Every method routes through
// the same `AppController`/`PartyApplicationService` path the UI and HTTP use,
// and resolves to a plain result (never throws) so tool handlers stay trivial.
export interface PartyBridge {
  /** Fire-and-forget send to another member; errors if target is off/missing.
   *  `interrupt: true` stops the recipient's in-flight turn first so the message
   *  is handled immediately instead of queueing behind it. */
  send(from: string, to: string, content: string, interrupt?: boolean): Promise<PartyToolResult>;
  /** Create a member in the caller's own party and auto-start its session. */
  createMember(request: PartyCreateMemberRequest): Promise<PartyToolResult>;
  /** Remove a member from the caller's own party (cannot remove `main`). */
  removeMember(name: string): Promise<PartyToolResult>;
  /** List the caller's party members and their status. */
  list(): Promise<PartyToolResult>;
  /** Discover available harnesses + models + per-model reasoning options. */
  listModels(): Promise<PartyToolResult>;
  /** Turn state of one member (or, with no name, every member) in the caller's party. */
  status(name?: string): Promise<PartyToolResult>;
  /** Stop a member's in-flight turn; target "all" stops every member except the caller. */
  interrupt(target: string): Promise<PartyToolResult>;
  /** Send a message to every other member of the caller's party. */
  broadcast(content: string, interrupt?: boolean): Promise<PartyToolResult>;
}

/** MCP server name for the in-process party tool surface. */
export const PARTY_MCP_SERVER = "agentparty-app";
/** Namespaced prefix of the party tools as the agent sees them (mcp__<server>__<tool>). */
export const PARTY_TOOL_PREFIX = `mcp__${PARTY_MCP_SERVER}__`;
export const PARTY_TOOL_NAMES = ["send", "member-create", "member-remove", "list", "list-models", "member-status", "interrupt", "broadcast"] as const;
export type PartyToolName = (typeof PARTY_TOOL_NAMES)[number];

const partyDynamicToolDescriptions: Record<PartyToolName, string> = {
  send: "Send a message to another member of your party. Errors if the recipient is not running or does not exist. Delivery is QUEUED, not instant: if the recipient is mid-turn, your message is only picked up AFTER their current turn finishes (for a Codex member, at its next tool call), so do not expect an immediate reply — a delayed response means they are still finishing earlier work, not that the message was lost. Set interrupt=true ONLY when the message cannot wait: it stops the recipient's current turn so the message is handled right away.",
  "member-create": "Create a new member in your party and start its session. Call list-models first for valid harness, model, and reasoning options.",
  "member-remove": "Remove a member from your party. Cannot remove 'main'.",
  list: "List your party's members and their current status.",
  "list-models": "Discover available harnesses, models, and reasoning options for member-create.",
  "member-status": "Check whether a member's turn is running (busy) or stopped (idle/error). Omit name to get every member's turn state.",
  interrupt: "Stop a member's in-flight turn. Pass a member name, or 'all' to stop every member except yourself. You cannot interrupt yourself.",
  broadcast: "Send a message to EVERY other member of your party at once. Like send, each delivery is QUEUED: a member that is mid-turn only picks it up after its current turn finishes (for a Codex member, at its next tool call). Set interrupt=true to stop their current turns so the message is handled right away.",
};

const partyDynamicToolSchemas: Record<PartyToolName, Record<string, unknown>> = {
  send: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient member name in your party." },
      content: { type: "string", description: "Message body." },
      interrupt: { type: "boolean", description: "Stop the recipient's in-flight turn first so the message is handled immediately. Default false: the message QUEUES and is only seen after the recipient finishes its current turn (a Codex member picks it up at its next tool call). Set true only when the message cannot wait for the current turn to end." },
    },
    required: ["to", "content"],
    additionalProperties: false,
  },
  "member-create": {
    type: "object",
    properties: {
      name: { type: "string", description: "New member name (letters, digits, _ or -)." },
      role: { type: "string", description: "Short role description for the new member." },
      harness: { type: "string", description: "Harness id, e.g. claude-code or codex. Defaults to claude-code." },
      model: { type: "string", description: "Model id from list-models." },
      reasoning: { type: "string", description: "Reasoning/thinking mode: adaptive | enabled | disabled." },
      reasoningBudget: { type: "number", description: "Thinking token budget when applicable." },
      effort: { type: "string", description: "Effort level: low | medium | high | xhigh | max." },
    },
    required: ["name", "role"],
    additionalProperties: false,
  },
  "member-remove": {
    type: "object",
    properties: {
      name: { type: "string", description: "Member name to remove." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  list: { type: "object", properties: {}, additionalProperties: false },
  "list-models": { type: "object", properties: {}, additionalProperties: false },
  "member-status": {
    type: "object",
    properties: {
      name: { type: "string", description: "Member name to check. Omit to get every member's turn state." },
    },
    additionalProperties: false,
  },
  interrupt: {
    type: "object",
    properties: {
      target: { type: "string", description: "Member name to stop, or 'all' for every member except yourself." },
    },
    required: ["target"],
    additionalProperties: false,
  },
  broadcast: {
    type: "object",
    properties: {
      content: { type: "string", description: "Message body sent to every other member." },
      interrupt: { type: "boolean", description: "Stop each recipient's in-flight turn first so the message is handled immediately. Default false: the message QUEUES behind each recipient's current turn and is only seen once that turn finishes (a Codex member picks it up at its next tool call)." },
    },
    required: ["content"],
    additionalProperties: false,
  },
};

export interface PartyDynamicToolSpec {
  type: "namespace";
  name: string;
  description: string;
  tools: Array<{
    type: "function";
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
}

export function buildPartyDynamicToolSpec(): PartyDynamicToolSpec {
  return {
    type: "namespace",
    name: PARTY_MCP_SERVER,
    description: "AgentParty app party controls for messaging and member management.",
    tools: PARTY_TOOL_NAMES.map((name) => ({
      type: "function",
      name,
      description: partyDynamicToolDescriptions[name],
      inputSchema: partyDynamicToolSchemas[name],
    })),
  };
}

export function partyToolNameOf(tool: string): PartyToolName | undefined {
  const plain = tool.startsWith(PARTY_TOOL_PREFIX) ? tool.slice(PARTY_TOOL_PREFIX.length) : tool;
  return (PARTY_TOOL_NAMES as readonly string[]).includes(plain) ? plain as PartyToolName : undefined;
}

export async function invokePartyTool(bridge: PartyBridge, identity: PartyIdentity, tool: string, args: unknown): Promise<PartyToolResult> {
  const name = partyToolNameOf(tool);
  if (!name) {
    return { ok: false, error: `Unknown AgentParty tool '${tool}'.` };
  }
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  switch (name) {
    case "send": {
      const to = typeof input.to === "string" ? input.to : "";
      const content = typeof input.content === "string" ? input.content : "";
      if (!to || !content) {
        return { ok: false, error: "send requires string arguments: to, content." };
      }
      return bridge.send(identity.member, to, content, input.interrupt === true);
    }
    case "member-create": {
      const memberName = typeof input.name === "string" ? input.name : "";
      const role = typeof input.role === "string" ? input.role : "";
      if (!memberName || !role) {
        return { ok: false, error: "member-create requires string arguments: name, role." };
      }
      return bridge.createMember({
        name: memberName,
        role,
        harness: typeof input.harness === "string" ? input.harness : undefined,
        model: typeof input.model === "string" ? input.model : undefined,
        reasoning: typeof input.reasoning === "string" ? input.reasoning : undefined,
        reasoningBudget: typeof input.reasoningBudget === "number" ? input.reasoningBudget : undefined,
        effort: typeof input.effort === "string" ? input.effort : undefined,
      });
    }
    case "member-remove": {
      const memberName = typeof input.name === "string" ? input.name : "";
      if (!memberName) {
        return { ok: false, error: "member-remove requires string argument: name." };
      }
      return bridge.removeMember(memberName);
    }
    case "list":
      return bridge.list();
    case "list-models":
      return bridge.listModels();
    case "member-status":
      return bridge.status(typeof input.name === "string" && input.name ? input.name : undefined);
    case "interrupt": {
      const target = typeof input.target === "string" ? input.target : "";
      if (!target) {
        return { ok: false, error: "interrupt requires string argument: target (a member name, or 'all')." };
      }
      return bridge.interrupt(target);
    }
    case "broadcast": {
      const content = typeof input.content === "string" ? input.content : "";
      if (!content) {
        return { ok: false, error: "broadcast requires string argument: content." };
      }
      return bridge.broadcast(content, input.interrupt === true);
    }
  }
}

/**
 * Session-start primer injected into a member's system prompt. Gives the model
 * deterministic knowledge of the app, its identity, the communication protocol,
 * and — critically — which tool surface to drive, so it never confuses our
 * in-process `agentparty-app` tools with legacy `agentparty` MCP servers that
 * may also be present (project `.mcp.json`, plugins). This is how we avoid
 * relying on model memory: the correct surface is stated up front, every time.
 */
export function buildPartyPrimer(identity: PartyIdentity): string {
  const tool = (name: string) => `${PARTY_TOOL_PREFIX}${name}`;
  const roleLine = identity.role ? `- Your role: ${identity.role}` : "- Your role: (none specified)";
  return [
    "# AgentParty — party member session",
    "",
    "You are a member running inside the **AgentParty** desktop app, where several AI coding sessions (members) share one workspace and message each other. You can drive the app's party features directly through its in-process tools.",
    "",
    "Your identity is fixed by the app (never restate or change it):",
    `- Party: ${identity.party}`,
    `- Your member name: ${identity.member}`,
    roleLine,
    "",
    "## Party tools — use ONLY this surface",
    "All party actions go through the `agentparty-app` server. These are the only party tools you may call:",
    `- \`${tool("send")}\` — message another member of your party (errors if the recipient is not running). Your \`from\` is set automatically to \`${identity.member}\` — never supply it. **Delivery is QUEUED, not instant**: if the recipient is mid-turn, your message is only picked up AFTER their current turn finishes (a Codex member at its next tool call), so do not expect an immediate reply. Pass \`interrupt: true\` ONLY when it cannot wait — that stops their current turn so the message is handled right away.`,
    `- \`${tool("broadcast")}\` — send one message to EVERY other member at once (same QUEUE-then-current-turn timing, and the same optional \`interrupt\`).`,
    `- \`${tool("member-status")}\` — check whether a member's turn is running (busy) or stopped; omit \`name\` for all members.`,
    `- \`${tool("interrupt")}\` — stop a member's in-flight turn (\`target\`: member name, or 'all' for everyone except you). You cannot interrupt yourself.`,
    `- \`${tool("member-create")}\` — create a new member and start its session (call \`${tool("list-models")}\` first for valid harness/model/reasoning options).`,
    `- \`${tool("member-remove")}\` — remove a member from your party (cannot remove 'main').`,
    `- \`${tool("list")}\` — list your party's members and their status.`,
    `- \`${tool("list-models")}\` — discover available harnesses, models, and reasoning options.`,
    "",
    "⚠️ Other similarly-named tools — e.g. `mcp__agentparty__*` or `mcp__plugin_*_agentparty__*` — are LEGACY and must not be used. Drive every party action through the `agentparty-app__*` tools above.",
    "",
    "## Communication protocol",
    "- Messages from other members arrive as a user turn wrapped in `<channel source=\"agentparty\" from=\"…\" to=\"…\">…</channel>`.",
    `- To reply or initiate, call \`${tool("send")}\` with the recipient's member name. Replies are asynchronous: the other member's response arrives later as its own incoming message.`,
    "- **Turn timing (read this to avoid \"tangled\" turns).** Each member handles ONE turn at a time. A message you send lands in the recipient's queue and is only read when their CURRENT turn ends — for a Codex member, at its next tool call. So right after you send: they have NOT seen it yet if they were busy, and a slow reply means they are still finishing earlier work, not that your message was dropped. It will be handled in order once their turn completes.",
    `- Before assuming a message was missed, check \`${tool("member-status")}\` (or \`${tool("list")}\`) to see if the member is busy. When a message genuinely cannot wait for their current turn, use \`interrupt: true\` on \`${tool("send")}\`/\`${tool("broadcast")}\`, or call \`${tool("interrupt")}\` — this stops their turn so your message is seen immediately.`,
  ].join("\n");
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
/** Minimal structural type of the SDK's `tool(...)` factory (avoids importing the SDK here). */
type ToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<McpToolResult>,
) => unknown;

/**
 * Builds the party tool definitions for the in-process MCP server. Pure and
 * SDK-agnostic (the `tool` factory is injected), so it is unit-testable without
 * spawning a session: each returned def carries a `.handler` that routes to the
 * bridge with the caller's identity closure-bound (`from` is never agent input).
 */
export function buildPartyToolDefs(tool: ToolFactory, bridge: PartyBridge, identity: PartyIdentity): unknown[] {
  const envelope = (result: PartyToolResult): McpToolResult => ({
    content: [{ type: "text", text: JSON.stringify(result.data ?? { ok: result.ok, error: result.error }) }],
    isError: !result.ok,
  });
  return [
    tool(
      "send",
      "Send a message to another member of your party. Fire-and-forget: it delivers to the recipient's live session (their reply comes back later as their own message). Errors if the recipient is not running or does not exist. Set interrupt=true to stop the recipient's current turn so your message is handled immediately.",
      {
        to: z.string().describe("Recipient member name in your party."),
        content: z.string().describe("Message body."),
        interrupt: z.boolean().optional().describe("Stop the recipient's in-flight turn first (default false: the message queues behind it)."),
      },
      async (args: { to: string; content: string; interrupt?: boolean }) => envelope(await bridge.send(identity.member, args.to, args.content, args.interrupt === true)),
    ),
    tool(
      "member-create",
      "Create a new member in your party and start its session. You choose the harness, model, and reasoning — call list-models first to see valid options.",
      {
        name: z.string().describe("New member name (letters, digits, _ or -)."),
        role: z.string().describe("Short role description for the new member."),
        harness: z.string().optional().describe("Harness id (e.g. 'claude-code'). Defaults to claude-code."),
        model: z.string().optional().describe("Model id from list-models."),
        reasoning: z.string().optional().describe("Reasoning/thinking mode: adaptive | enabled | disabled."),
        reasoningBudget: z.number().optional().describe("Thinking token budget when applicable."),
        effort: z.string().optional().describe("Effort level: low | medium | high | xhigh | max."),
      },
      async (args: { name: string; role: string; harness?: string; model?: string; reasoning?: string; reasoningBudget?: number; effort?: string }) =>
        envelope(await bridge.createMember(args)),
    ),
    tool(
      "member-remove",
      "Remove a member from your party (cannot remove 'main'). Closes its session if running.",
      { name: z.string().describe("Member name to remove.") },
      async (args: { name: string }) => envelope(await bridge.removeMember(args.name)),
    ),
    tool("list", "List your party's members and their current status.", {}, async () => envelope(await bridge.list())),
    tool(
      "list-models",
      "Discover the harnesses and models available for member-create, including each model's reasoning options, performance, cost, and context window.",
      {},
      async () => envelope(await bridge.listModels()),
    ),
    tool(
      "member-status",
      "Check whether a member's turn is running (busy) or stopped (idle/error). Omit name to get every member's turn state.",
      { name: z.string().optional().describe("Member name to check. Omit for all members.") },
      async (args: { name?: string }) => envelope(await bridge.status(args.name || undefined)),
    ),
    tool(
      "interrupt",
      "Stop a member's in-flight turn. Pass a member name, or 'all' to stop every member except yourself. You cannot interrupt yourself.",
      { target: z.string().describe("Member name to stop, or 'all'.") },
      async (args: { target: string }) => envelope(await bridge.interrupt(args.target)),
    ),
    tool(
      "broadcast",
      "Send a message to EVERY other member of your party at once. Set interrupt=true to stop their current turns so the message is handled immediately.",
      {
        content: z.string().describe("Message body sent to every other member."),
        interrupt: z.boolean().optional().describe("Stop each recipient's in-flight turn first (default false)."),
      },
      async (args: { content: string; interrupt?: boolean }) => envelope(await bridge.broadcast(args.content, args.interrupt === true)),
    ),
  ];
}
