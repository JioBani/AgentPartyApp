import { z } from "zod";
import type { CodexPolicy } from "../shared/codexPolicy";
import type { CursorPolicy } from "../shared/cursorPolicy";

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
  serviceTier?: string;
  effort?: string;
  /** Initial single-mode permission for the Claude Code harness. */
  permissionMode?: string;
  /** Initial two-axis permission for the Codex harness. */
  codexPolicy?: CodexPolicy;
  /** Initial Cursor agent mode + approval mode. */
  cursorPolicy?: CursorPolicy;
}

export interface PartyPermissionRequest {
  permissionMode?: string;
  codexPolicy?: CodexPolicy;
  cursorPolicy?: CursorPolicy;
}

/**
 * A Message Gate override patch for one member. Each axis is optional; a `null`
 * clears that axis back to inherit (party rule / settings reviewer default).
 * See `shared/messageGate.ts`.
 */
export interface PartyGatePatch {
  mode?: "inherit" | "on" | "off";
  rule?: string | null;
  reviewer?: { model: string; effort: string } | null;
}

/**
 * A patch of the PARTY-WIDE gate. Unlike {@link PartyGatePatch} there is no
 * `mode`: the party level IS the default, so enablement is a plain boolean.
 * Omitted keys keep their current value.
 */
export interface PartyGateGlobalPatch {
  enabled?: boolean;
  rule?: string;
  reviewer?: { model: string; effort: string } | null;
}

// The capability surface a hosted member can drive. Every method routes through
// the same `AppController`/`PartyApplicationService` path the UI and HTTP use,
// and resolves to a plain result (never throws) so tool handlers stay trivial.
export interface PartyBridge {
  /** Fire-and-forget send to another member; errors if target is off/missing.
   *  `interrupt: true` stops the recipient's in-flight turn first so the message
   *  is handled immediately instead of queueing behind it. `force: true` bypasses
   *  the Message Gate review (surfaced as a "forced" badge). */
  send(from: string, to: string, content: string, interrupt?: boolean, force?: boolean, forceReason?: string): Promise<PartyToolResult>;
  /** Create a member in the caller's own party and auto-start its session. */
  createMember(request: PartyCreateMemberRequest): Promise<PartyToolResult>;
  /** Remove a member from the caller's own party (cannot remove `main`). */
  removeMember(name: string): Promise<PartyToolResult>;
  /** Change another member's permission policy in the caller's own party. */
  setPermission(name: string, request: PartyPermissionRequest): Promise<PartyToolResult>;
  /** Set another member's Message Gate override (mode / rule / reviewer). */
  gateSet(name: string, patch: PartyGatePatch): Promise<PartyToolResult>;
  /** Set the PARTY-WIDE Message Gate every "inherit" member follows. */
  partyGateSet(patch: PartyGateGlobalPatch): Promise<PartyToolResult>;
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
  /** Give THIS member its own Discord channel (creating it if needed). */
  discordConnect(channelName?: string): Promise<PartyToolResult>;
  /** Post one message from THIS member into its Discord channel. */
  discordSend(content: string): Promise<PartyToolResult>;
  /** Stop bridging THIS member; the Discord channel and its history remain. */
  discordDisconnect(): Promise<PartyToolResult>;
}

/** MCP server name for the in-process party tool surface. */
export const PARTY_MCP_SERVER = "agentparty-app";
/** Namespaced prefix of the party tools as the agent sees them (mcp__<server>__<tool>). */
export const PARTY_TOOL_PREFIX = `mcp__${PARTY_MCP_SERVER}__`;
export const PARTY_TOOL_NAMES = ["send", "member-create", "member-remove", "member-permission", "gate-set", "party-gate-set", "list", "list-models", "member-status", "interrupt", "broadcast", "discord-connect", "discord-send", "discord-disconnect"] as const;
export type PartyToolName = (typeof PARTY_TOOL_NAMES)[number];

const partyDynamicToolDescriptions: Record<PartyToolName, string> = {
  send: "Send a message to another member of your party. Errors if the recipient is not running or does not exist. Delivery is QUEUED, not instant: if the recipient is mid-turn, your message is only picked up AFTER their current turn finishes (for a Codex member, at its next tool call), so do not expect an immediate reply — a delayed response means they are still finishing earlier work, not that the message was lost. Set interrupt=true ONLY when the message cannot wait: it stops the recipient's current turn so the message is handled right away.",
  "member-create": "Create a new member in your party and start its session. Call list-models first for valid harness, model, and reasoning options.",
  "member-remove": "Remove a member from your party. Cannot remove 'main'.",
  "member-permission": "Change another member's permission. Use permissionMode for Claude Code, codexPolicy for Codex, or cursorPolicy for Cursor. Call list-models to inspect each route's harness and permission contract.",
  "gate-set": "Set another member's Message Gate — the delivery-time reviewer of that member's OUTGOING messages. mode: inherit|on|off. rule: the communication rule text the reviewer enforces (null to inherit the party rule). reviewer: {model, effort} for a custom headless reviewer (null to use the settings default). Any member may edit any member's gate.",
  "party-gate-set": "Set the PARTY-WIDE Message Gate — the default every member with mode 'inherit' follows. enabled: turn the party gate on/off. rule: the communication rule text enforced party-wide. reviewer: {model, effort} for a party-wide headless reviewer (null to use the settings default). This changes the default for EVERY inheriting member at once, so prefer gate-set when only one member should be affected. A member that set mode on/off, or its own rule, keeps overriding this.",
  list: "List your party's members and their current status.",
  "list-models": "Discover available harnesses, models, and reasoning options for member-create.",
  "member-status": "Check whether a member's turn is running (busy) or stopped (idle/error). Omit name to get every member's turn state.",
  interrupt: "Stop a member's in-flight turn. Pass a member name, or 'all' to stop every member except yourself. You cannot interrupt yourself.",
  "discord-connect": "Bridge YOURSELF to Discord so the user can read your reports and reply from a phone or another PC. Creates (or reuses) a text channel named after you in the user's server. Call this once, before discord-send. Only affects you — you cannot bridge another member.",
  "discord-send": "Post one message from you into YOUR Discord channel. Plain text only — Discord's limit is 2000 characters and longer content is REJECTED, not truncated, so split long reports into several sends. If Discord rate limits you the tool returns an error containing retry_after_ms: wait that long, then send again yourself (nothing is queued or retried for you). Write for a person reading on a phone: summarize, do not paste raw logs or diffs.",
  "discord-disconnect": "Stop bridging yourself to Discord. The channel and its history stay in Discord; you simply stop sending and receiving there.",
  broadcast: "Send a message to EVERY other member of your party at once. Like send, each delivery is QUEUED: a member that is mid-turn only picks it up after its current turn finishes (for a Codex member, at its next tool call). Set interrupt=true to stop their current turns so the message is handled right away.",
};

const partyDynamicToolSchemas: Record<PartyToolName, Record<string, unknown>> = {
  send: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient member name in your party." },
      content: { type: "string", description: "Message body." },
      interrupt: { type: "boolean", description: "Stop the recipient's in-flight turn first so the message is handled immediately. Default false: the message QUEUES and is only seen after the recipient finishes its current turn (a Codex member picks it up at its next tool call). Set true only when the message cannot wait for the current turn to end." },
      force: { type: "boolean", description: "Bypass the Message Gate review and deliver even if your gate would reject. Use ONLY when the message genuinely must go through; it is surfaced as a 'forced' badge. Default false." },
      forceReason: { type: "string", description: "Why you forced past the gate (recorded and shown). Provide when force=true." },
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
      permissionMode: { type: "string", description: "Initial Claude permission: default | acceptEdits | bypassPermissions | plan | dontAsk | auto." },
      codexPolicy: {
        type: "object",
        description: "Initial Codex permission policy.",
        properties: {
          sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] },
          approval: { type: "string", enum: ["untrusted", "on-request", "never"] },
          guardian: { type: "boolean" },
        },
        required: ["sandbox", "approval", "guardian"],
        additionalProperties: false,
      },
      cursorPolicy: {
        type: "object",
        description: "Initial Cursor mode and approval policy.",
        properties: {
          mode: { type: "string", enum: ["agent", "ask", "plan"] },
          approval: { type: "string", enum: ["allowlist", "auto-review", "unrestricted"] },
        },
        required: ["mode", "approval"],
      },
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
  "member-permission": {
    type: "object",
    properties: {
      name: { type: "string", description: "Target member name in your party." },
      permissionMode: { type: "string", description: "Claude permission: default | acceptEdits | bypassPermissions | plan | dontAsk | auto." },
      codexPolicy: {
        type: "object",
        description: "Codex permission policy (all fields required).",
        properties: {
          sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] },
          approval: { type: "string", enum: ["untrusted", "on-request", "never"] },
          guardian: { type: "boolean" },
        },
        required: ["sandbox", "approval", "guardian"],
        additionalProperties: false,
      },
      cursorPolicy: {
        type: "object",
        description: "Cursor mode and approval policy (all fields required).",
        properties: {
          mode: { type: "string", enum: ["agent", "ask", "plan"] },
          approval: { type: "string", enum: ["allowlist", "auto-review", "unrestricted"] },
        },
        required: ["mode", "approval"],
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  "gate-set": {
    type: "object",
    properties: {
      name: { type: "string", description: "Target member name in your party." },
      mode: { type: "string", enum: ["inherit", "on", "off"], description: "inherit = follow the party gate; on/off = override just enablement." },
      rule: { type: ["string", "null"], description: "Communication rule the reviewer enforces for this member's outgoing messages. null = inherit the party rule." },
      reviewer: {
        type: ["object", "null"],
        description: "Custom headless reviewer for this member (null = use the settings default).",
        properties: {
          model: { type: "string", description: "Model id from list-models." },
          effort: { type: "string", description: "Effort level: low | medium | high | xhigh | max." },
        },
        required: ["model", "effort"],
        additionalProperties: false,
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  "party-gate-set": {
    type: "object",
    properties: {
      enabled: { type: "boolean", description: "Turn the party-wide gate on or off. Every member with mode 'inherit' follows this." },
      rule: { type: "string", description: "Communication rule enforced party-wide for inheriting members." },
      reviewer: {
        type: ["object", "null"],
        description: "Party-wide headless reviewer (null = use the settings default). A member's own reviewer still wins.",
        properties: {
          model: { type: "string", description: "Model id from list-models." },
          effort: { type: "string", description: "Effort level: low | medium | high | xhigh | max." },
        },
        required: ["model", "effort"],
        additionalProperties: false,
      },
    },
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
  "discord-connect": {
    type: "object",
    properties: {
      channelName: { type: "string", description: "Optional channel name. Defaults to your member name (lowercased, spaces become dashes)." },
    },
    additionalProperties: false,
  },
  "discord-send": {
    type: "object",
    properties: {
      content: { type: "string", description: "Message text, at most 2000 characters. Longer content is rejected — split it yourself." },
    },
    required: ["content"],
    additionalProperties: false,
  },
  "discord-disconnect": { type: "object", properties: {}, additionalProperties: false },
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
      return bridge.send(
        identity.member,
        to,
        content,
        input.interrupt === true,
        input.force === true,
        typeof input.forceReason === "string" ? input.forceReason : undefined,
      );
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
        permissionMode: typeof input.permissionMode === "string" ? input.permissionMode : undefined,
        codexPolicy: input.codexPolicy && typeof input.codexPolicy === "object" ? input.codexPolicy as CodexPolicy : undefined,
        cursorPolicy: input.cursorPolicy && typeof input.cursorPolicy === "object" ? input.cursorPolicy as CursorPolicy : undefined,
      });
    }
    case "member-remove": {
      const memberName = typeof input.name === "string" ? input.name : "";
      if (!memberName) {
        return { ok: false, error: "member-remove requires string argument: name." };
      }
      return bridge.removeMember(memberName);
    }
    case "member-permission": {
      const memberName = typeof input.name === "string" ? input.name : "";
      if (!memberName) {
        return { ok: false, error: "member-permission requires string argument: name." };
      }
      return bridge.setPermission(memberName, {
        permissionMode: typeof input.permissionMode === "string" ? input.permissionMode : undefined,
        codexPolicy: input.codexPolicy && typeof input.codexPolicy === "object" ? input.codexPolicy as CodexPolicy : undefined,
        cursorPolicy: input.cursorPolicy && typeof input.cursorPolicy === "object" ? input.cursorPolicy as CursorPolicy : undefined,
      });
    }
    case "gate-set": {
      const memberName = typeof input.name === "string" ? input.name : "";
      if (!memberName) {
        return { ok: false, error: "gate-set requires string argument: name." };
      }
      const patch: PartyGatePatch = {};
      if (input.mode === "inherit" || input.mode === "on" || input.mode === "off") {
        patch.mode = input.mode;
      }
      if ("rule" in input) {
        patch.rule = input.rule === null ? null : typeof input.rule === "string" ? input.rule : undefined;
      }
      if ("reviewer" in input) {
        patch.reviewer = input.reviewer === null
          ? null
          : input.reviewer && typeof input.reviewer === "object"
            ? input.reviewer as { model: string; effort: string }
            : undefined;
      }
      return bridge.gateSet(memberName, patch);
    }
    case "party-gate-set": {
      const patch: PartyGateGlobalPatch = {};
      if (typeof input.enabled === "boolean") {
        patch.enabled = input.enabled;
      }
      if (typeof input.rule === "string") {
        patch.rule = input.rule;
      }
      if ("reviewer" in input) {
        patch.reviewer = input.reviewer === null
          ? null
          : input.reviewer && typeof input.reviewer === "object"
            ? input.reviewer as { model: string; effort: string }
            : undefined;
      }
      if (!Object.keys(patch).length) {
        return { ok: false, error: "party-gate-set requires at least one of: enabled, rule, reviewer." };
      }
      return bridge.partyGateSet(patch);
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
    case "discord-connect":
      return bridge.discordConnect(typeof input.channelName === "string" && input.channelName ? input.channelName : undefined);
    case "discord-send": {
      const content = typeof input.content === "string" ? input.content : "";
      if (!content) {
        return { ok: false, error: "discord-send requires string argument: content." };
      }
      return bridge.discordSend(content);
    }
    case "discord-disconnect":
      return bridge.discordDisconnect();
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
    `- \`${tool("member-permission")}\` — change another member's permission; use \`permissionMode\` (Claude Code), \`codexPolicy\` (Codex), or \`cursorPolicy\` (Cursor).`,
    `- \`${tool("gate-set")}\` — set another member's Message Gate (the reviewer of that member's OUTGOING messages): \`mode\` (inherit|on|off), \`rule\` (text to enforce, null to inherit the party rule), \`reviewer\` ({model, effort}, null for the default).`,
    `- \`${tool("party-gate-set")}\` — set the PARTY-WIDE gate every inheriting member follows: \`enabled\`, \`rule\`, \`reviewer\`. It moves every inheriting member at once, so reach for \`${tool("gate-set")}\` when only one member should change.`,
    `- \`${tool("list")}\` — list your party's members and their status.`,
    `- \`${tool("list-models")}\` — discover available harnesses, models, and reasoning options.`,
    `- \`${tool("discord-connect")}\` / \`${tool("discord-send")}\` / \`${tool("discord-disconnect")}\` — bridge YOURSELF to Discord so the user can follow you from a phone or another PC. See the section below.`,
    "",
    "⚠️ Other similarly-named tools — e.g. `mcp__agentparty__*` or `mcp__plugin_*_agentparty__*` — are LEGACY and must not be used. Drive every party action through the `agentparty-app__*` tools above.",
    "",
    "## Communication protocol",
    "- Messages from other members arrive as a user turn wrapped in `<channel source=\"agentparty\" from=\"…\" to=\"…\">…</channel>`.",
    `- To reply or initiate, call \`${tool("send")}\` with the recipient's member name. Replies are asynchronous: the other member's response arrives later as its own incoming message.`,
    "- **Turn timing (read this to avoid \"tangled\" turns).** Each member handles ONE turn at a time. A message you send lands in the recipient's queue and is only read when their CURRENT turn ends — for a Codex member, at its next tool call. So right after you send: they have NOT seen it yet if they were busy, and a slow reply means they are still finishing earlier work, not that your message was dropped. It will be handled in order once their turn completes.",
    `- Before assuming a message was missed, check \`${tool("member-status")}\` (or \`${tool("list")}\`) to see if the member is busy. When a message genuinely cannot wait for their current turn, use \`interrupt: true\` on \`${tool("send")}\`/\`${tool("broadcast")}\`, or call \`${tool("interrupt")}\` — this stops their turn so your message is seen immediately.`,
    "",
    "## Message Gate — your outgoing messages may be reviewed",
    `- Your party may enable a **Message Gate**: before a message you send (\`${tool("send")}\` or \`${tool("broadcast")}\`) is delivered, a lightweight reviewer model checks it against the party's communication rules (e.g. "be concise", "don't route through the orchestrator — talk to the owner directly").`,
    `- If the reviewer **rejects** your message, it is NOT delivered and the \`${tool("send")}\` tool returns \`{ok:false, error:"<reason>"}\`. The reason tells you exactly which rule you broke and how to fix it — rewrite your message to comply and send again. This is normal, not an error on your side.`,
    `- If a message genuinely must go through even though it would be rejected (a real blocker/urgent alert), call \`${tool("send")}\` with \`force: true\` and a short \`forceReason\`. Use this sparingly — every forced send is surfaced to the user.`,
    "- The gate is fail-open: if the reviewer itself errors, your message is delivered unreviewed (with a visible notice), so a gate problem never blocks your work.",
    `- You can also configure another member's gate with \`${tool("gate-set")}\` when coordinating (e.g. tighten or relax a teammate's outgoing-message rules).`,
    "",
    "## Discord bridge — reporting to the user when they are away",
    `- If the user asks you to "connect to Discord" (or to report there), call \`${tool("discord-connect")}\` once. It creates or reuses a channel named after you in the user's server. Then use \`${tool("discord-send")}\` to report.`,
    "- Messages the user types in that channel arrive here as an ordinary user turn wrapped in `<channel source=\"discord\" from=\"…\">…</channel>`. Reply the same way you reply to the user in the app — and when the reply is meant for Discord, send it with `discord-send` as well, because the user is reading there, not in the app.",
    "- **Write for a person on a phone.** Summarize the situation in a few lines. Do NOT paste raw logs, diffs, stack traces or file dumps.",
    `- **2000 characters is a hard limit.** \`${tool("discord-send")}\` REJECTS longer content instead of truncating it — split the report into several sends yourself.`,
    "- **Rate limits are yours to handle.** Nothing is queued or retried for you. If the tool returns an error containing `retry_after_ms`, wait at least that long, then send again.",
    "- **Text only.** There are no buttons, menus, modals or file uploads, by design. Never claim the user can click something — ask them to reply in plain text.",
    "- Approvals and permission prompts are NOT available over Discord. If you are blocked on one, say so in the channel and ask the user to handle it in the app.",
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
        force: z.boolean().optional().describe("Bypass the Message Gate review and deliver even if your gate would reject (surfaced as a 'forced' badge). Use only when the message must go through. Default false."),
        forceReason: z.string().optional().describe("Why you forced past the gate (recorded and shown). Provide when force=true."),
      },
      async (args: { to: string; content: string; interrupt?: boolean; force?: boolean; forceReason?: string }) =>
        envelope(await bridge.send(identity.member, args.to, args.content, args.interrupt === true, args.force === true, args.forceReason)),
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
        permissionMode: z.string().optional().describe("Initial Claude permission mode."),
        codexPolicy: z.object({
          sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
          approval: z.enum(["untrusted", "on-request", "never"]),
          guardian: z.boolean(),
        }).optional().describe("Initial Codex permission policy."),
        cursorPolicy: z.object({
          mode: z.enum(["agent", "ask", "plan"]),
          approval: z.enum(["allowlist", "auto-review", "unrestricted"]),
        }).optional().describe("Initial Cursor mode and approval policy."),
      },
      async (args: PartyCreateMemberRequest) =>
        envelope(await bridge.createMember(args)),
    ),
    tool(
      "member-remove",
      "Remove a member from your party (cannot remove 'main'). Closes its session if running.",
      { name: z.string().describe("Member name to remove.") },
      async (args: { name: string }) => envelope(await bridge.removeMember(args.name)),
    ),
    tool(
      "member-permission",
      "Change another member's permission. Use permissionMode for Claude Code, codexPolicy for Codex, or cursorPolicy for Cursor; list-models reports each harness's permission contract.",
      {
        name: z.string().describe("Target member name in your party."),
        permissionMode: z.string().optional().describe("Claude permission mode."),
        codexPolicy: z.object({
          sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
          approval: z.enum(["untrusted", "on-request", "never"]),
          guardian: z.boolean(),
        }).optional().describe("Codex permission policy."),
        cursorPolicy: z.object({
          mode: z.enum(["agent", "ask", "plan"]),
          approval: z.enum(["allowlist", "auto-review", "unrestricted"]),
        }).optional().describe("Cursor mode and approval policy."),
      },
      async (args: { name: string } & PartyPermissionRequest) => envelope(await bridge.setPermission(args.name, args)),
    ),
    tool(
      "gate-set",
      "Set another member's Message Gate (the delivery-time reviewer of that member's OUTGOING messages). mode: inherit|on|off. rule: the communication rule to enforce (null to inherit the party rule). reviewer: {model, effort} for a custom headless reviewer (null to use the settings default). Any member may edit any member's gate.",
      {
        name: z.string().describe("Target member name in your party."),
        mode: z.enum(["inherit", "on", "off"]).optional().describe("inherit = follow the party gate; on/off overrides just enablement."),
        rule: z.string().nullable().optional().describe("Communication rule the reviewer enforces (null = inherit the party rule)."),
        reviewer: z.object({
          model: z.string().describe("Model id from list-models."),
          effort: z.string().describe("Effort level: low | medium | high | xhigh | max."),
        }).nullable().optional().describe("Custom headless reviewer (null = use the settings default)."),
      },
      async (args: { name: string } & PartyGatePatch) => envelope(await bridge.gateSet(args.name, args)),
    ),
    tool(
      "party-gate-set",
      "Set the PARTY-WIDE Message Gate — the default every member with mode 'inherit' follows. This changes the default for EVERY inheriting member at once, so prefer gate-set when only one member should be affected. A member that set its own mode or rule keeps overriding this.",
      {
        enabled: z.boolean().optional().describe("Turn the party-wide gate on or off."),
        rule: z.string().optional().describe("Communication rule enforced party-wide for inheriting members."),
        reviewer: z.object({
          model: z.string().describe("Model id from list-models."),
          effort: z.string().describe("Effort level: low | medium | high | xhigh | max."),
        }).nullable().optional().describe("Party-wide headless reviewer (null = use the settings default). A member's own reviewer still wins."),
      },
      async (args: PartyGateGlobalPatch) => envelope(await bridge.partyGateSet(args)),
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
    tool(
      "discord-connect",
      "Bridge YOURSELF to Discord so the user can read your reports and reply from a phone or another PC. Creates (or reuses) a text channel named after you. Call once, before discord-send. Affects only you.",
      { channelName: z.string().optional().describe("Optional channel name. Defaults to your member name.") },
      async (args: { channelName?: string }) => envelope(await bridge.discordConnect(args.channelName)),
    ),
    tool(
      "discord-send",
      "Post one message from you into YOUR Discord channel. Plain text only, at most 2000 characters — longer content is REJECTED, not truncated, so split it yourself. On a rate limit the error carries retry_after_ms: wait that long and send again (nothing is queued or retried for you). Write for a person on a phone: summarize, never paste raw logs or diffs.",
      { content: z.string().describe("Message text, at most 2000 characters.") },
      async (args: { content: string }) => envelope(await bridge.discordSend(args.content)),
    ),
    tool(
      "discord-disconnect",
      "Stop bridging yourself to Discord. The channel and its history stay in Discord.",
      {},
      async () => envelope(await bridge.discordDisconnect()),
    ),
  ];
}
