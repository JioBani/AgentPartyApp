import { z } from "zod";
import type { CodexPolicy } from "../shared/codexPolicy";
import type { CursorPolicy } from "../shared/cursorPolicy";
import { MEMBER_EXECUTION_HOSTS, type MemberExecutionLocationRequest } from "../shared/memberLocation";
import { readImageFile } from "./imageFile";

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

/** Image bytes read beside a remote member before crossing execution hosts. */
export interface PartyHostImage {
  dataBase64: string;
  filename: string;
  mediaType: string;
}

const PARTY_HOST_IMAGE_FIELD = "__agentpartyHostImage";

export interface PartyCreateMemberRequest {
  name: string;
  role: string;
  /** Exact tab-group id from list(), or a unique member name in that group. */
  tabGroup?: string;
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
  /**
   * Explicit execution host and cwd. When omitted, the member inherits the
   * caller's location. Use list-locations for recent validated suggestions.
   */
  location?: MemberExecutionLocationRequest;
}

/**
 * Narrowing for {@link PartyBridge.listModels}. Every field is optional and
 * every field is a FILTER — never a page cursor — so a caller can always widen
 * back to the whole catalog by dropping arguments.
 *
 * With no field set the tool answers with a compact INDEX (one row per distinct
 * model) instead of the full route table: the table is a harness×provider cross
 * product, so most of its ~120 rows are the same handful of models repeated,
 * and dumping it costs ~10k tokens to answer "which models exist".
 *
 * The index still lists **every** model, and names the harnesses a model cannot
 * run on rather than dropping them, because the failure mode that matters here
 * is a caller concluding a model does not exist when it does.
 */
export interface PartyModelQuery {
  /** Harness id (`claude-code` | `codex` | `cursor` | `grok`). */
  harness?: string;
  /** Provider id (`anthropic` | `openai` | `openrouter` | `xai` | `cursor` | `deepseek`). */
  provider?: string;
  /** Case-insensitive substring matched against both the model id and its label. */
  query?: string;
  /** Include routes that cannot currently be used. Off by default; the count is always reported. */
  includeUnavailable?: boolean;
}

/**
 * Query for the member-facing party list.
 *
 * The default is deliberately a coordination summary. A party-wide Message
 * Gate rule can be several thousand characters and the old shape repeated that
 * same text once per inheriting member. Exact-name detail keeps every setting
 * inspectable without making the common "who is here?" call scale as
 * `members x rule length`.
 */
export interface PartyListQuery {
  /** Return full configuration for exactly this member instead of all summaries. */
  name?: string;
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
  /** List compact member summaries, or full configuration for one exact name. */
  list(query?: PartyListQuery): Promise<PartyToolResult>;
  /** List supported execution hosts plus recent/default cwd suggestions. */
  listLocations(): Promise<PartyToolResult>;
  /** Discover available harnesses + models + per-model reasoning options.
   *  With no query this answers with a compact index; any filter switches to
   *  full detail rows for the matches. See {@link PartyModelQuery}. */
  listModels(query?: PartyModelQuery): Promise<PartyToolResult>;
  /** Turn state of one member (or, with no name, every member) in the caller's party. */
  status(name?: string): Promise<PartyToolResult>;
  /** Stop a member's in-flight turn; target "all" stops every member except the caller. */
  interrupt(target: string): Promise<PartyToolResult>;
  /** Send a message to every other member of the caller's party. */
  broadcast(content: string, interrupt?: boolean, exclude?: string[]): Promise<PartyToolResult>;
  /** Give THIS member its own Discord channel (creating it if needed). */
  discordConnect(channelName?: string): Promise<PartyToolResult>;
  /** Post one message from THIS member into its Discord channel. */
  discordSend(content: string): Promise<PartyToolResult>;
  /** Upload one image file from THIS member's machine into its Discord thread. */
  discordSendImage(path: string, caption?: string, hostImage?: PartyHostImage): Promise<PartyToolResult>;
  /** Stop bridging THIS member; the Discord channel and its history remain. */
  discordDisconnect(): Promise<PartyToolResult>;
  /**
   * Put an image into THIS member's own conversation for the user to look at.
   * The picture never enters the model's context — the app keeps the bytes and
   * the tool result carries only a reference.
   */
  attachImage(input: { path?: string; url?: string; caption?: string; hostImage?: PartyHostImage }): Promise<PartyToolResult>;
}

/**
 * The agent tool uses two opt-in flags instead of a tri-state boolean. Some
 * harnesses materialize an omitted optional boolean as `false`; treating that
 * as an explicit queue request silently disables the saved Runtime/member
 * preference. `interrupt:true` and `queue:true` remain unambiguous, while a
 * legacy `interrupt:false` safely falls back to inheritance.
 */
function partyToolInterruptOf(input: Record<string, unknown>): { value: boolean | undefined; error?: string } {
  if (input.interrupt === true && input.queue === true) {
    return { value: undefined, error: "Choose only one delivery override: interrupt=true or queue=true." };
  }
  if (input.interrupt === true) return { value: true };
  if (input.queue === true) return { value: false };
  return { value: undefined };
}

function partyToolDeliveryArgs(interrupt: boolean | undefined): { interrupt?: true; queue?: true } {
  return interrupt === true ? { interrupt: true } : interrupt === false ? { queue: true } : {};
}

/**
 * Rebuilds the PartyBridge capability surface around one transport-neutral tool
 * invoker. Cross-host sessions use this in the execution engine: the model sees
 * the exact same tools as an in-process member, while every mutation is still
 * executed by the original party owner.
 */
export function partyBridgeFromInvoker(
  invoke: (tool: PartyToolName, args: unknown) => Promise<PartyToolResult>,
): PartyBridge {
  const hostInvoke = (tool: PartyToolName, args: unknown) => invokePartyToolFromExecutionHost(invoke, tool, args);
  return {
    send: (_from, to, content, interrupt, force, forceReason) => hostInvoke("send", {
      to,
      content,
      ...partyToolDeliveryArgs(interrupt),
      force,
      forceReason,
    }),
    createMember: (request) => hostInvoke("member-create", request),
    removeMember: (name) => hostInvoke("member-remove", { name }),
    setPermission: (name, request) => hostInvoke("member-permission", { name, ...request }),
    gateSet: (name, patch) => hostInvoke("gate-set", { name, ...patch }),
    partyGateSet: (patch) => hostInvoke("party-gate-set", patch),
    list: (query) => hostInvoke("list", query || {}),
    listLocations: () => hostInvoke("list-locations", {}),
    listModels: (query) => hostInvoke("list-models", query || {}),
    status: (name) => hostInvoke("member-status", name ? { name } : {}),
    interrupt: (target) => hostInvoke("interrupt", { target }),
    broadcast: (content, interrupt, exclude) => hostInvoke("broadcast", { content, ...partyToolDeliveryArgs(interrupt), exclude }),
    discordConnect: (channelName) => hostInvoke("discord-connect", channelName ? { channelName } : {}),
    discordSend: (content) => hostInvoke("discord-send", { content }),
    discordSendImage: (path, caption) => hostInvoke("discord-send-image", { path, caption }),
    discordDisconnect: () => hostInvoke("discord-disconnect", {}),
    attachImage: (input) => hostInvoke("attach-image", input),
  };
}

/**
 * Reads file arguments on the member's execution host before forwarding them
 * to the desktop's global party owner. The reserved byte field is removed from
 * model input and rebuilt, so it cannot be spoofed by an agent.
 */
export async function invokePartyToolFromExecutionHost(
  invoke: (tool: PartyToolName, args: unknown) => Promise<PartyToolResult>,
  tool: string,
  args: unknown,
): Promise<PartyToolResult> {
  const name = partyToolNameOf(tool);
  if (!name) return { ok: false, error: `Unknown AgentParty tool '${tool}'.` };
  const input = args && typeof args === "object" && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {};
  delete input[PARTY_HOST_IMAGE_FIELD];
  if ((name === "attach-image" || name === "discord-send-image") && typeof input.path === "string" && input.path) {
    try {
      input[PARTY_HOST_IMAGE_FIELD] = readImageFile(input.path);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return invoke(name, input);
}

export const PARTY_TOOL_NAMES = ["send", "member-create", "member-remove", "member-permission", "gate-set", "party-gate-set", "list", "list-locations", "list-models", "member-status", "interrupt", "broadcast", "discord-connect", "discord-send", "discord-send-image", "discord-disconnect", "attach-image"] as const;
export type PartyToolName = (typeof PARTY_TOOL_NAMES)[number];

const partyDynamicToolDescriptions: Record<PartyToolName, string> = {
  send: "Send the same message to one or more members of your party. Pass `to` as one member name or an array of names. Batch results separate delivered, queued, and failed recipients. Omit both delivery flags to use your member override and then the Runtime default. Set interrupt=true to cut in, or queue=true to explicitly wait behind the current turn. Legacy interrupt=false is treated as omitted so model-generated false values cannot disable the saved setting.",
  "member-create": "Create and start one or more members. Use the existing top-level fields for one member, or pass `members` as an array of member objects for a batch. Pass tabGroup as a tabGroups[].id returned by list (or a unique member name in that open group); omit it to create a new tab group. Call list-models for valid harness/model settings and list-locations for recent validated cwd suggestions. Pass location: {host, cwd, distro?} to choose Windows or WSL explicitly; omit it to inherit your own execution location.",
  "member-remove": "Remove one or more members from your party. Pass `name` as one member name or an array of names. Cannot remove 'main'.",
  "member-permission": "Change another member's permission. Use permissionMode for Claude Code, codexPolicy for Codex, or cursorPolicy for Cursor. Call list-models to inspect each route's harness and permission contract.",
  "gate-set": "Set another member's Message Gate — the delivery-time reviewer of that member's OUTGOING messages. mode: inherit|on|off. rule: the communication rule text the reviewer enforces (null to inherit the party rule). reviewer: {model, effort} for a custom headless reviewer (null to use the settings default). Any member may edit any member's gate. The result confirms ruleChars without echoing the rule; use list {name} when you need to inspect it.",
  "party-gate-set": "Set the PARTY-WIDE Message Gate — the default every member with mode 'inherit' follows. enabled: turn the party gate on/off. rule: the communication rule text enforced party-wide. reviewer: {model, effort} for a party-wide headless reviewer (null to use the settings default). This changes the default for EVERY inheriting member at once, so prefer gate-set when only one member should be affected. A member that set mode on/off, or its own rule, keeps overriding this. The result confirms ruleChars without echoing the rule.",
  list: "List compact member summaries and current tabGroups. Pass `name` to inspect one member's full model, permission, location, and Message Gate settings. Full detail for every member is intentionally unavailable because long inherited gate rules would be repeated once per member. Pass a chosen tabGroups[].id to member-create.tabGroup.",
  "list-locations": "List the execution hosts this app supports plus recent and default cwd suggestions. Use a returned host/cwd/distro tuple as member-create.location. Entries with problem are shown for diagnostics but must not be used until repaired.",
  "list-models": "Discover available harnesses, models, and reasoning options for member-create. Called with NO arguments it returns a compact index of every model — label, which harnesses run it, and the id to pass to member-create when that id differs from the label. Pass `harness`, `provider`, and/or `query` to get the FULL detail (effort/thinking options, service tier, pricing, context window) for just the matches; that is the cheap way to answer 'what settings does this one model take'. Filters narrow, they never paginate: dropping them always widens back to everything. A filter that matches nothing is an ERROR listing what does exist, never an empty result — so an empty answer never means 'this model is unavailable'. Routes that cannot currently be used are excluded from detail rows but their count is always reported and `includeUnavailable: true` brings them back with the reason.",
  "member-status": "Check whether a member's turn is running (busy) or stopped (idle/error). Omit name to get every member's turn state.",
  interrupt: "Stop a member's in-flight turn. Pass a member name, or 'all' to stop every member except yourself. You cannot interrupt yourself.",
  "discord-connect": "Bridge YOURSELF to Discord so the user can read your reports and reply from a phone or another PC. Creates (or reuses) a text channel named after you in the user's server. Call this once, before discord-send. Only affects you — you cannot bridge another member.",
  "discord-send": "Post one message from you into YOUR Discord channel. Plain text only — Discord's limit is 2000 characters and longer content is REJECTED, not truncated, so split long reports into several sends. If Discord rate limits you the tool returns an error containing retry_after_ms: wait that long, then send again yourself (nothing is queued or retried for you). Write for a person reading on a phone: summarize, do not paste raw logs or diffs.",
  "discord-send-image": "Upload an image FILE from this machine into your Discord thread, so the user can see a screenshot, chart or diagram instead of reading a description of it. `path` is a path on the machine you are running on. Optional `caption` is posted with it (same 2000-character rule). Over-size images are REJECTED with the limit stated, not silently dropped. Images only — this is not a general file transfer.",
  "attach-image": "Show the user an image in THIS conversation — a screenshot you took, a chart you produced, or a picture on the web. Give `path` (a file on the machine you are running on) or `url` (http/https), not both. The picture is displayed to the USER ONLY: it is not added to your context and you will not see it, so describe in your reply whatever you need the conversation to remember about it. Prefer this over pasting a file path into your text when the point is for a human to LOOK at something.",
  "discord-disconnect": "Stop bridging yourself to Discord. The channel and its history stay in Discord; you simply stop sending and receiving there.",
  broadcast: "Send a message to every other member of your party at once. Pass `exclude` with member names that must not receive it. Omit both delivery flags to use your member override and then the Runtime default. Set interrupt=true to cut in or queue=true to explicitly wait behind busy recipients.",
};

const partyCreateMemberDynamicProperties: Record<string, unknown> = {
  name: { type: "string", description: "New member name (letters, digits, _ or -)." },
  role: { type: "string", description: "Short role description for the new member." },
  tabGroup: { type: "string", description: "Exact tabGroups[].id returned by list, or a unique member name in that open group. Omit to open a new tab group." },
  harness: { type: "string", description: "Harness id, e.g. claude-code or codex. Defaults to claude-code." },
  model: { type: "string", description: "Model id from list-models." },
  reasoning: { type: "string", description: "Reasoning/thinking mode: adaptive | enabled | disabled." },
  reasoningBudget: { type: "number", description: "Thinking token budget when applicable." },
  effort: { type: "string", description: "Effort level: low | medium | high | xhigh | max." },
  serviceTier: { type: "string", description: "Optional service tier from list-models. Omit (or pass 'inherit') to follow the harness's own config; 'standard' forces the default speed; a native id like 'priority' forces Fast (higher credit burn)." },
  permissionMode: { type: "string", description: "Initial Claude permission: default | acceptEdits | bypassPermissions | plan | dontAsk | auto." },
  location: {
    type: "object",
    description: "Explicit execution host and cwd. Omit to inherit the caller's location; call list-locations for suggestions.",
    properties: {
      host: { type: "string", enum: [...MEMBER_EXECUTION_HOSTS], description: "Execution host. WSL is Windows-only; future native hosts extend this field." },
      cwd: { type: "string", description: "Absolute path in that host's native syntax." },
      distro: { type: "string", description: "Required when host is wsl; omit for windows." },
    },
    required: ["host", "cwd"],
    additionalProperties: false,
  },
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
    additionalProperties: false,
  },
};

const partyDynamicToolSchemas: Record<PartyToolName, Record<string, unknown>> = {
  send: {
    type: "object",
    properties: {
      to: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        ],
        description: "One recipient member name, or a non-empty array of unique member names.",
      },
      content: { type: "string", description: "Message body." },
      interrupt: { type: "boolean", description: "True forces a cut-in. False is treated as omitted for harness compatibility; use queue=true to force waiting." },
      queue: { type: "boolean", description: "True forces this message to wait behind the recipient's current turn. False is treated as omitted." },
      force: { type: "boolean", description: "Bypass the Message Gate review and deliver even if your gate would reject. Use ONLY when the message genuinely must go through; it is surfaced as a 'forced' badge. Default false." },
      forceReason: { type: "string", description: "Why you forced past the gate (recorded and shown). Provide when force=true." },
    },
    required: ["to", "content"],
    additionalProperties: false,
  },
  "member-create": {
    type: "object",
    properties: {
      ...partyCreateMemberDynamicProperties,
      members: {
        type: "array",
        minItems: 1,
        description: "Batch of members to create. Do not combine with the top-level single-member fields.",
        items: {
          type: "object",
          properties: partyCreateMemberDynamicProperties,
          required: ["name", "role"],
          additionalProperties: false,
        },
      },
    },
    oneOf: [
      { required: ["name", "role"], not: { required: ["members"] } },
      { required: ["members"], not: { anyOf: [{ required: ["name"] }, { required: ["role"] }] } },
    ],
    additionalProperties: false,
  },
  "member-remove": {
    type: "object",
    properties: {
      name: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        ],
        description: "One member name, or a non-empty array of unique member names to remove.",
      },
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
  list: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact member name to inspect in full. Omit for compact summaries of every member." },
    },
    additionalProperties: false,
  },
  "list-locations": { type: "object", properties: {}, additionalProperties: false },
  "list-models": {
    type: "object",
    properties: {
      harness: { type: "string", description: "Only models runnable on this harness: claude-code | codex | cursor | grok." },
      provider: { type: "string", description: "Only models served by this provider: anthropic | openai | openrouter | xai | cursor | deepseek." },
      query: { type: "string", description: "Case-insensitive substring matched against the model id AND its label, e.g. \"grok\" or \"4.6\"." },
      includeUnavailable: { type: "boolean", description: "Include routes that cannot currently be used, each with the reason. Default false; the excluded count is reported either way." },
    },
    additionalProperties: false,
  },
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
      interrupt: { type: "boolean", description: "True forces a cut-in for busy recipients. False is treated as omitted for harness compatibility; use queue=true to force waiting." },
      queue: { type: "boolean", description: "True forces the message to wait behind busy recipients. False is treated as omitted." },
      exclude: {
        type: "array",
        items: { type: "string" },
        uniqueItems: true,
        description: "Member names to exclude from this broadcast in addition to yourself.",
      },
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

export interface PartyMcpToolSpec {
  name: PartyToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

/**
 * Canonical tool descriptions served to every out-of-process MCP relay.
 * Keeping names and schemas here prevents the raw stdio script from becoming a
 * second, stale copy of the AgentParty capability surface.
 */
export function buildPartyMcpToolSpecs(): PartyMcpToolSpec[] {
  const readOnly = new Set<PartyToolName>(["list", "list-locations", "list-models", "member-status"]);
  return PARTY_TOOL_NAMES.map((name) => ({
    name,
    description: partyDynamicToolDescriptions[name],
    inputSchema: partyDynamicToolSchemas[name],
    ...(readOnly.has(name) ? {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    } : {}),
  }));
}

export function buildPartyDynamicToolSpec(): PartyDynamicToolSpec {
  return {
    type: "namespace",
    name: PARTY_MCP_SERVER,
    description: "AgentParty app party controls for messaging and member management.",
    tools: buildPartyMcpToolSpecs().map(({ name, description, inputSchema }) => ({
      type: "function",
      name,
      description,
      inputSchema,
    })),
  };
}

export function partyToolNameOf(tool: string): PartyToolName | undefined {
  const plain = tool.startsWith(PARTY_TOOL_PREFIX) ? tool.slice(PARTY_TOOL_PREFIX.length) : tool;
  return (PARTY_TOOL_NAMES as readonly string[]).includes(plain) ? plain as PartyToolName : undefined;
}

function memberNamesOf(value: unknown, field: string, allowEmpty = false): { names?: string[]; single: boolean; error?: string } {
  const single = typeof value === "string";
  const raw = single ? [value] : Array.isArray(value) ? value : undefined;
  if (!raw || (!allowEmpty && !raw.length) || raw.some((item) => typeof item !== "string" || !item.trim())) {
    return { single, error: `${field} must be a member name or a non-empty array of member names.` };
  }
  const names = raw.map((item) => String(item).trim());
  if (new Set(names).size !== names.length) {
    return { single, error: `${field} contains duplicate member names.` };
  }
  return { names, single };
}

function createMemberRequestOf(value: unknown, label: string): { request?: PartyCreateMemberRequest; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: `${label} must be a member object.` };
  }
  const input = value as Record<string, unknown>;
  const memberName = typeof input.name === "string" ? input.name.trim() : "";
  const role = typeof input.role === "string" ? input.role.trim() : "";
  if (!memberName || !role) {
    return { error: `${label} requires string fields: name, role.` };
  }
  if (input.tabGroup !== undefined && typeof input.tabGroup !== "string") {
    return { error: `${label}.tabGroup must be a tab group id or an existing member name.` };
  }
  return {
    request: {
      name: memberName,
      role,
      tabGroup: typeof input.tabGroup === "string" ? input.tabGroup : undefined,
      harness: typeof input.harness === "string" ? input.harness : undefined,
      model: typeof input.model === "string" ? input.model : undefined,
      reasoning: typeof input.reasoning === "string" ? input.reasoning : undefined,
      reasoningBudget: typeof input.reasoningBudget === "number" ? input.reasoningBudget : undefined,
      effort: typeof input.effort === "string" ? input.effort : undefined,
      serviceTier: typeof input.serviceTier === "string" ? input.serviceTier : undefined,
      permissionMode: typeof input.permissionMode === "string" ? input.permissionMode : undefined,
      codexPolicy: input.codexPolicy && typeof input.codexPolicy === "object" ? input.codexPolicy as CodexPolicy : undefined,
      cursorPolicy: input.cursorPolicy && typeof input.cursorPolicy === "object" ? input.cursorPolicy as CursorPolicy : undefined,
      location: input.location && typeof input.location === "object" ? input.location as MemberExecutionLocationRequest : undefined,
    },
  };
}

function createMemberRequestsOf(input: Record<string, unknown>): { requests?: PartyCreateMemberRequest[]; single: boolean; error?: string } {
  if (input.members !== undefined) {
    if (input.name !== undefined || input.role !== undefined) {
      return { single: false, error: "member-create accepts either top-level single-member fields or members, not both." };
    }
    if (!Array.isArray(input.members) || !input.members.length) {
      return { single: false, error: "member-create.members must be a non-empty array." };
    }
    const requests: PartyCreateMemberRequest[] = [];
    for (let index = 0; index < input.members.length; index += 1) {
      const parsed = createMemberRequestOf(input.members[index], `member-create.members[${index}]`);
      if (parsed.error) return { single: false, error: parsed.error };
      requests.push(parsed.request as PartyCreateMemberRequest);
    }
    const names = requests.map((request) => request.name);
    if (new Set(names).size !== names.length) {
      return { single: false, error: "member-create.members contains duplicate member names." };
    }
    return { requests, single: false };
  }
  const parsed = createMemberRequestOf(input, "member-create");
  return parsed.error
    ? { single: true, error: parsed.error }
    : { requests: [parsed.request as PartyCreateMemberRequest], single: true };
}

export async function invokePartyTool(bridge: PartyBridge, identity: PartyIdentity, tool: string, args: unknown): Promise<PartyToolResult> {
  const name = partyToolNameOf(tool);
  if (!name) {
    return { ok: false, error: `Unknown AgentParty tool '${tool}'.` };
  }
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  switch (name) {
    case "send": {
      const content = typeof input.content === "string" ? input.content : "";
      const targets = memberNamesOf(input.to, "send.to");
      if (targets.error) return { ok: false, error: targets.error };
      if (!content) return { ok: false, error: "send requires string argument: content." };
      const delivery = partyToolInterruptOf(input);
      if (delivery.error) return { ok: false, error: delivery.error };
      const sendOne = (to: string) => bridge.send(
        identity.member, to, content, delivery.value, input.force === true,
        typeof input.forceReason === "string" ? input.forceReason : undefined,
      );
      if (targets.single) return sendOne(targets.names![0]);
      const delivered: string[] = [];
      const queuedMembers: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      for (const target of targets.names!) {
        const result = await sendOne(target);
        if (!result.ok) failed.push({ name: target, error: result.error || "not_delivered" });
        else if ((result.data as { queued?: boolean } | undefined)?.queued) queuedMembers.push(target);
        else delivered.push(target);
      }
      return { ok: delivered.length + queuedMembers.length > 0, ...(delivered.length + queuedMembers.length ? {} : { error: "Message was not delivered to any requested member." }), data: { delivered, queuedMembers, failed } };
    }
    case "member-create": {
      const members = createMemberRequestsOf(input);
      if (members.error) return { ok: false, error: members.error };
      if (members.single) return bridge.createMember(members.requests![0]);
      const created: unknown[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      for (const request of members.requests!) {
        const result = await bridge.createMember(request);
        if (result.ok) created.push(result.data ?? { name: request.name });
        else failed.push({ name: request.name, error: result.error || "not_created" });
      }
      return { ok: created.length > 0, ...(created.length ? {} : { error: "No requested members were created." }), data: { created, failed } };
    }
    case "member-remove": {
      const members = memberNamesOf(input.name, "member-remove.name");
      if (members.error) return { ok: false, error: members.error };
      if (members.single) return bridge.removeMember(members.names![0]);
      const removed: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      for (const memberName of members.names!) {
        const result = await bridge.removeMember(memberName);
        if (result.ok) removed.push(memberName);
        else failed.push({ name: memberName, error: result.error || "not_removed" });
      }
      return { ok: removed.length > 0, ...(removed.length ? {} : { error: "No requested members were removed." }), data: { removed, failed } };
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
      return bridge.list({
        name: typeof input.name === "string" && input.name ? input.name : undefined,
      });
    case "list-locations":
      return bridge.listLocations();
    case "list-models":
      return bridge.listModels({
        harness: typeof input.harness === "string" && input.harness ? input.harness : undefined,
        provider: typeof input.provider === "string" && input.provider ? input.provider : undefined,
        query: typeof input.query === "string" && input.query ? input.query : undefined,
        includeUnavailable: input.includeUnavailable === true,
      });
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
      const delivery = partyToolInterruptOf(input);
      if (delivery.error) return { ok: false, error: delivery.error };
      let exclude: string[] | undefined;
      if (input.exclude !== undefined) {
        const parsed = memberNamesOf(input.exclude, "broadcast.exclude", true);
        if (parsed.error) return { ok: false, error: parsed.error };
        exclude = parsed.names;
      }
      return bridge.broadcast(content, delivery.value, exclude);
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
      return bridge.discordSendImage(
        imagePath,
        typeof input.caption === "string" ? input.caption : undefined,
        partyHostImageOf(input[PARTY_HOST_IMAGE_FIELD]),
      );
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
      return bridge.attachImage({
        path: imagePath,
        url,
        caption: typeof input.caption === "string" ? input.caption : undefined,
        hostImage: partyHostImageOf(input[PARTY_HOST_IMAGE_FIELD]),
      });
    }
  }
}

function partyHostImageOf(value: unknown): PartyHostImage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const image = value as Record<string, unknown>;
  return typeof image.dataBase64 === "string"
    && typeof image.filename === "string"
    && typeof image.mediaType === "string"
    ? { dataBase64: image.dataBase64, filename: image.filename, mediaType: image.mediaType }
    : undefined;
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
  const envelope = (result: PartyToolResult): McpToolResult => {
    const payload = result.data === undefined
      ? { ok: result.ok, error: result.error }
      : result.ok
        ? result.data
        : { ok: false, error: result.error, data: result.data };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      isError: !result.ok,
    };
  };
  const memberCreateOptionalFields = {
    tabGroup: z.string().optional().describe("Exact tabGroups[].id returned by list, or a unique member name in that open group. Omit to create a new tab group."),
    harness: z.string().optional().describe("Harness id (e.g. 'claude-code'). Defaults to claude-code."),
    model: z.string().optional().describe("Model id from list-models."),
    reasoning: z.string().optional().describe("Reasoning/thinking mode: adaptive | enabled | disabled."),
    reasoningBudget: z.number().optional().describe("Thinking token budget when applicable."),
    effort: z.string().optional().describe("Effort level: low | medium | high | xhigh | max."),
    serviceTier: z.string().optional().describe("Optional service tier from list-models. Omit (or 'inherit') to follow the harness's own config; 'standard' forces default speed; 'priority' forces Fast."),
    permissionMode: z.string().optional().describe("Initial Claude permission mode."),
    location: z.object({
      host: z.enum(MEMBER_EXECUTION_HOSTS).describe("Execution host. WSL is Windows-only; future native hosts extend this field."),
      cwd: z.string().describe("Absolute path in the selected host's native syntax."),
      distro: z.string().optional().describe("Required when host is wsl; omit for windows."),
    }).optional().describe("Explicit execution location. Omit to inherit your own; call list-locations for suggestions."),
    codexPolicy: z.object({
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
      approval: z.enum(["untrusted", "on-request", "never"]),
      guardian: z.boolean(),
    }).optional().describe("Initial Codex permission policy."),
    cursorPolicy: z.object({
      mode: z.enum(["agent", "ask", "plan"]),
      approval: z.enum(["allowlist", "auto-review", "unrestricted"]),
    }).optional().describe("Initial Cursor mode and approval policy."),
  };
  const memberCreateItem = z.object({
    name: z.string().describe("New member name (letters, digits, _ or -)."),
    role: z.string().describe("Short role description for the new member."),
    ...memberCreateOptionalFields,
  });
  return [
    tool(
      "send",
      "Send the same message to one or more party members. Pass `to` as one name or an array. Fire-and-forget: replies arrive later as their own messages. Batch results separate delivered, queued, and failed recipients. Omit both delivery flags to use your member override then Runtime default; interrupt=true cuts in and queue=true explicitly waits.",
      {
        to: z.union([z.string(), z.array(z.string()).min(1)]).describe("One recipient name or a non-empty array of unique recipient names."),
        content: z.string().describe("Message body."),
        interrupt: z.boolean().optional().describe("True forces a cut-in. False is treated as omitted for harness compatibility; use queue=true to force waiting."),
        queue: z.boolean().optional().describe("True forces this message to wait behind the recipient's current turn. False is treated as omitted."),
        force: z.boolean().optional().describe("Bypass the Message Gate review and deliver even if your gate would reject (surfaced as a 'forced' badge). Use only when the message must go through. Default false."),
        forceReason: z.string().optional().describe("Why you forced past the gate (recorded and shown). Provide when force=true."),
      },
      async (args: { to: string | string[]; content: string; interrupt?: boolean; queue?: boolean; force?: boolean; forceReason?: string }) =>
        envelope(await invokePartyTool(bridge, identity, "send", args)),
    ),
    tool(
      "member-create",
      "Create and start one or more members. Use the top-level fields for one member, or `members` for a batch. Pass tabGroup as a tabGroups[].id returned by list (or a unique member name in that group); omit it for a new group. Call list-models first for valid settings.",
      {
        name: z.string().optional().describe("Single-member form: new member name."),
        role: z.string().optional().describe("Single-member form: short role description."),
        ...memberCreateOptionalFields,
        members: z.array(memberCreateItem).min(1).optional().describe("Batch form. Do not combine with top-level name/role fields."),
      },
      async (args: PartyCreateMemberRequest | { members: PartyCreateMemberRequest[] }) =>
        envelope(await invokePartyTool(bridge, identity, "member-create", args)),
    ),
    tool(
      "member-remove",
      "Remove one or more members from your party (cannot remove 'main'). Closes running sessions. Batch results report removed and failed names separately.",
      { name: z.union([z.string(), z.array(z.string()).min(1)]).describe("One member name or a non-empty array of unique member names.") },
      async (args: { name: string | string[] }) => envelope(await invokePartyTool(bridge, identity, "member-remove", args)),
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
      partyDynamicToolDescriptions["gate-set"],
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
      partyDynamicToolDescriptions["party-gate-set"],
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
    tool(
      "list",
      partyDynamicToolDescriptions.list,
      { name: z.string().optional().describe("Exact member name for full detail. Omit for compact summaries of every member.") },
      async (args: PartyListQuery) => envelope(await bridge.list(args)),
    ),
    tool("list-locations", partyDynamicToolDescriptions["list-locations"], {}, async () => envelope(await bridge.listLocations())),
    tool(
      "list-models",
      partyDynamicToolDescriptions["list-models"],
      {
        harness: z.string().optional().describe("Only models runnable on this harness: claude-code | codex | cursor | grok."),
        provider: z.string().optional().describe("Only models served by this provider: anthropic | openai | openrouter | xai | cursor | deepseek."),
        query: z.string().optional().describe("Case-insensitive substring matched against the model id AND its label, e.g. \"grok\" or \"4.6\"."),
        includeUnavailable: z.boolean().optional().describe("Include routes that cannot currently be used, each with the reason. Default false; the excluded count is reported either way."),
      },
      async (args: PartyModelQuery) => envelope(await bridge.listModels(args)),
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
      "Send a message to every other member of your party at once. Use exclude to omit selected members. Omit both delivery flags to use your member override then Runtime default; interrupt=true cuts in and queue=true explicitly waits.",
      {
        content: z.string().describe("Message body sent to every other member."),
        interrupt: z.boolean().optional().describe("True forces a cut-in for busy recipients. False is treated as omitted for harness compatibility; use queue=true to force waiting."),
        queue: z.boolean().optional().describe("True forces the message to wait behind busy recipients. False is treated as omitted."),
        exclude: z.array(z.string()).optional().describe("Member names to exclude in addition to yourself."),
      },
      async (args: { content: string; interrupt?: boolean; queue?: boolean; exclude?: string[] }) =>
        envelope(await invokePartyTool(bridge, identity, "broadcast", args)),
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
