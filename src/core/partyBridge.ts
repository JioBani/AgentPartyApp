import { z } from "zod";
import type { CodexPolicy } from "../shared/codexPolicy";
import type { CursorPolicy } from "../shared/cursorPolicy";

// Boundary 2 of the party-communication design (the party-communication design):
// the seam through which an app-hosted member session reaches the app's party
// features. The handler implementations live in the main process
// (`PartyApplicationService`); this interface lets `core` build the in-process
// MCP tool surface without importing anything from `main`.
//
// A bridge instance is always paired with a `PartyIdentity` bound at session
// construction, so the agent never states (and cannot spoof) who it is — that is
// where "zero model-memory reliance" comes from.

// The identity, the tool-surface names and the session primer live in
// `shared/partyPrimer`, so the settings screen can show and edit the very text a
// member session is built from. Re-exported here because this module is what
// `core`/`main` already import for everything party-related.
export type { PartyIdentity } from "../shared/partyPrimer";
export { PARTY_MCP_SERVER, PARTY_TOOL_PREFIX, buildPartyPrimer } from "../shared/partyPrimer";

import type { PartyIdentity } from "../shared/partyPrimer";
import { PARTY_MCP_SERVER, PARTY_TOOL_PREFIX } from "../shared/partyPrimer";

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
  /** Upload one image file from THIS member's machine into its Discord thread. */
  discordSendImage(path: string, caption?: string): Promise<PartyToolResult>;
  /** Stop bridging THIS member; the Discord channel and its history remain. */
  discordDisconnect(): Promise<PartyToolResult>;
  /**
   * Put an image into THIS member's own conversation for the user to look at.
   * The picture never enters the model's context — the app keeps the bytes and
   * the tool result carries only a reference.
   */
  attachImage(input: { path?: string; url?: string; caption?: string }): Promise<PartyToolResult>;
}

export const PARTY_TOOL_NAMES = ["send", "member-create", "member-remove", "member-permission", "gate-set", "party-gate-set", "list", "list-models", "member-status", "interrupt", "broadcast", "discord-connect", "discord-send", "discord-send-image", "discord-disconnect", "attach-image"] as const;
export type PartyToolName = (typeof PARTY_TOOL_NAMES)[number];

const partyDynamicToolDescriptions: Record<PartyToolName, string> = {
  send: "Send a message to another member of your party. Errors if the recipient is not running or does not exist. If interrupt is omitted, your member override and then the Runtime default decide whether a busy recipient is stopped. Set interrupt=true to cut in, or interrupt=false to explicitly queue behind the current turn.",
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
  "discord-send-image": "Upload an image FILE from this machine into your Discord thread, so the user can see a screenshot, chart or diagram instead of reading a description of it. `path` is a path on the machine you are running on. Optional `caption` is posted with it (same 2000-character rule). Over-size images are REJECTED with the limit stated, not silently dropped. Images only — this is not a general file transfer.",
  "attach-image": "Show the user an image in THIS conversation — a screenshot you took, a chart you produced, or a picture on the web. Give `path` (a file on the machine you are running on) or `url` (http/https), not both. The picture is displayed to the USER ONLY: it is not added to your context and you will not see it, so describe in your reply whatever you need the conversation to remember about it. Prefer this over pasting a file path into your text when the point is for a human to LOOK at something.",
  "discord-disconnect": "Stop bridging yourself to Discord. The channel and its history stay in Discord; you simply stop sending and receiving there.",
  broadcast: "Send a message to EVERY other member of your party at once. If interrupt is omitted, your member override and then the Runtime default apply. Set true to cut in or false to explicitly queue behind busy recipients.",
};

const partyDynamicToolSchemas: Record<PartyToolName, Record<string, unknown>> = {
  send: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient member name in your party." },
      content: { type: "string", description: "Message body." },
      interrupt: { type: "boolean", description: "Explicit true cuts in; explicit false queues behind the current turn. Omit to use your member override, then the Runtime default." },
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
  "discord-send-image": {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to an image file on the machine you are running on." },
      caption: { type: "string", description: "Optional text posted with the image, at most 2000 characters." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  "discord-disconnect": { type: "object", properties: {}, additionalProperties: false },
  "attach-image": {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to an image file on the machine you are running on. Give this or url, not both." },
      url: { type: "string", description: "http/https address of an image. Stored as the address, so it renders from its source." },
      caption: { type: "string", description: "Optional one-line label shown under the image." },
    },
    additionalProperties: false,
  },
  broadcast: {
    type: "object",
    properties: {
      content: { type: "string", description: "Message body sent to every other member." },
      interrupt: { type: "boolean", description: "Explicit true cuts in; explicit false queues. Omit to use your member override, then the Runtime default." },
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
        typeof input.interrupt === "boolean" ? input.interrupt : undefined,
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
      return bridge.broadcast(content, typeof input.interrupt === "boolean" ? input.interrupt : undefined);
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
    case "discord-send-image": {
      const imagePath = input.path;
      if (typeof imagePath !== "string" || !imagePath) {
        return { ok: false, error: "discord-send-image requires string argument: path." };
      }
      return bridge.discordSendImage(imagePath, typeof input.caption === "string" ? input.caption : undefined);
    }
    case "discord-disconnect":
      return bridge.discordDisconnect();
    case "attach-image": {
      const imagePath = typeof input.path === "string" ? input.path : undefined;
      const url = typeof input.url === "string" ? input.url : undefined;
      if (!imagePath && !url) {
        return { ok: false, error: "attach-image requires one of: path, url." };
      }
      if (imagePath && url) {
        return { ok: false, error: "attach-image takes path OR url, not both." };
      }
      return bridge.attachImage({ path: imagePath, url, caption: typeof input.caption === "string" ? input.caption : undefined });
    }
  }
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
      "Send a message to another member of your party. Fire-and-forget: it delivers to the recipient's live session (their reply comes back later as their own message). A recipient that is idle, not started, or SLEEPING is started or woken and keeps its conversation. Errors only if it does not exist or was explicitly closed. Omit interrupt to use your member override then Runtime default; true cuts in, false queues.",
      {
        to: z.string().describe("Recipient member name in your party."),
        content: z.string().describe("Message body."),
        interrupt: z.boolean().optional().describe("Explicitly stop (true) or queue behind (false) the recipient's in-flight turn. Omit to use your member override, then the Runtime default."),
        force: z.boolean().optional().describe("Bypass the Message Gate review and deliver even if your gate would reject (surfaced as a 'forced' badge). Use only when the message must go through. Default false."),
        forceReason: z.string().optional().describe("Why you forced past the gate (recorded and shown). Provide when force=true."),
      },
      async (args: { to: string; content: string; interrupt?: boolean; force?: boolean; forceReason?: string }) =>
        envelope(await bridge.send(identity.member, args.to, args.content, typeof args.interrupt === "boolean" ? args.interrupt : undefined, args.force === true, args.forceReason)),
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
      "Send a message to EVERY other member of your party at once. Omit interrupt to use your member override then Runtime default; true cuts in, false queues.",
      {
        content: z.string().describe("Message body sent to every other member."),
        interrupt: z.boolean().optional().describe("Explicitly interrupt (true) or queue (false). Omit to use your member override, then the Runtime default."),
      },
      async (args: { content: string; interrupt?: boolean }) => envelope(await bridge.broadcast(args.content, typeof args.interrupt === "boolean" ? args.interrupt : undefined)),
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
      "discord-send-image",
      "Upload an image FILE from this machine into your Discord thread, so the user can SEE a screenshot, chart or diagram instead of reading a description of it. `path` is a path on the machine you are running on. Over-size images are REJECTED with the limit stated, never silently dropped. Images only — not a general file transfer.",
      {
        path: z.string().describe("Path to an image file on the machine you are running on."),
        caption: z.string().optional().describe("Optional text posted with the image, at most 2000 characters."),
      },
      async (args: { path: string; caption?: string }) => envelope(await bridge.discordSendImage(args.path, args.caption)),
    ),
    tool(
      "discord-disconnect",
      "Stop bridging yourself to Discord. The channel and its history stay in Discord.",
      {},
      async () => envelope(await bridge.discordDisconnect()),
    ),
    tool(
      "attach-image",
      partyDynamicToolDescriptions["attach-image"],
      {
        path: z.string().optional().describe("Path to an image file on the machine you are running on. Give this or url, not both."),
        url: z.string().optional().describe("http/https address of an image. Stored as the address, so it renders from its source."),
        caption: z.string().optional().describe("Optional one-line label shown under the image."),
      },
      async (args: { path?: string; url?: string; caption?: string }) => {
        if (!args.path && !args.url) {
          return envelope({ ok: false, error: "attach-image requires one of: path, url." });
        }
        if (args.path && args.url) {
          return envelope({ ok: false, error: "attach-image takes path OR url, not both." });
        }
        return envelope(await bridge.attachImage(args));
      },
    ),
  ];
}
