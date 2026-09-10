import { sanitizeAttachments } from "../../../shared/attachments";
import { parseQueueCommand } from "../../../shared/messageQueue";
import { buildPartyMcpToolSpecs } from "../../../core/partyBridge";
import { PARTY_ACTION_NAMES } from "../../engine/partyActions";
import type { CreateMemberInput } from "../../../shared/types";
import { ApiError, camelAction, flag, optText, required, text, type MethodRoute } from "../methodRegistry";

/**
 * Member actions that do NOT get a generated `/:action` endpoint:
 * - `open` gives a member a TAB, which is window state the engine-side action
 *   table cannot reach, so it is routed through `openPartyMember` instead.
 * - `broadcast` is party-wide and is addressed as `/api/party/broadcast`.
 */
const NON_MEMBER_ACTIONS = new Set(["open", "broadcast"]);

/** Delivery options shared by the two message-send routes. */
function deliveryOptions(p: Record<string, any>) {
  return {
    interrupt: typeof p.interrupt === "boolean" ? p.interrupt : undefined,
    force: p.force === true,
    forceReason: typeof p.forceReason === "string" ? p.forceReason : undefined,
  };
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ApiError(400, `${field} must be a non-empty array of strings.`);
  }
  const values = value.map((item) => String(item).trim());
  if (new Set(values).size !== values.length) {
    throw new ApiError(400, `${field} contains duplicate values.`);
  }
  return values;
}

function nonEmptyArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || !value.length) {
    throw new ApiError(400, `${field} must be a non-empty array.`);
  }
  return value;
}

function createMemberInput(value: unknown, label: string): CreateMemberInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, `${label} must be an object.`);
  }
  const input = value as Record<string, any>;
  return {
    ...input,
    name: required(input.name, `${label}.name`),
    requirement: required(input.requirement, `${label}.requirement`),
  } as CreateMemberInput;
}

export const partyRoutes: MethodRoute[] = [
  {
    name: "party.list",
    http: "GET /api/party",
    handler: (_p, ctx) => ctx.controller.listPartyMembers(ctx.workspace, ctx.windowId, ctx.partyId),
  },
  {
    // Same read under the `/api/harness` prefix an in-session agent's tools use.
    name: "party.listForHarness",
    http: "GET /api/harness/party",
    remote: false,
    handler: (_p, ctx) => ctx.controller.listPartyMembers(ctx.workspace, ctx.windowId, ctx.partyId),
  },
  {
    name: "party.create",
    http: "POST /api/parties",
    // `newWindow` is coerced here rather than trusted: over HTTP it arrives as
    // a string, and a truthy "false" would open a window nobody asked for.
    handler: (p, ctx) => ctx.controller.createParty(ctx.workspace, { ...p, name: required(p.name, "name"), newWindow: flag(p.newWindow) }, ctx.windowId),
  },
  {
    name: "party.select",
    http: "POST /api/parties/:id/select",
    handler: (p, ctx) => ctx.controller.selectParty(ctx.workspace, text(p.id), ctx.windowId),
  },
  {
    name: "party.delete",
    http: "POST /api/parties/:id/delete",
    handler: (p, ctx) => ctx.controller.removeParty(ctx.workspace, text(p.id), ctx.windowId),
  },
  {
    // Party-wide Message Gate default (enablement + rule).
    name: "party.gate",
    http: "POST /api/parties/:id/gate",
    handler: (p, ctx) => ctx.controller.setPartyGate(ctx.workspace, text(p.id), p, ctx.windowId),
  },
  {
    // The member primer — the system/developer prompt every member session
    // starts with — section by section, with its estimated token weight and
    // where each harness installs it. App-global, like the settings it lives in.
    name: "party.primer.get",
    http: "GET /api/party/primer",
    handler: (_p, ctx) => ctx.controller.getPartyPrimer(),
  },
  {
    // Edits ONE section: `text` sets an override (`null` restores the built-in),
    // `enabled` drops an optional section from the primer.
    name: "party.primer.save",
    http: "POST /api/party/primer",
    handler: (p, ctx) => ctx.controller.savePartyPrimerSection({
      section: text(p.section),
      // `null` clears the override; an absent key leaves the text unchanged.
      text: p.text === null ? null : typeof p.text === "string" ? p.text : undefined,
      enabled: typeof p.enabled === "boolean" ? p.enabled : undefined,
    }),
  },
  {
    // Korean reading of one section, on a connected subscription — or `clear`.
    name: "party.primer.translate",
    http: "POST /api/party/primer/translate",
    handler: (p, ctx) => ctx.controller.translatePartyPrimerSection({
      section: text(p.section),
      clear: p.clear === true,
      // Optional pin, so a caller can exercise one specific model instead of the
      // preference order (the UI never sends it).
      model: optText(p.model),
    }),
  },
  {
    /**
     * The party tool surface for a harness whose tools run OUTSIDE this process
     * (Codex, via scripts/agentparty-codex-mcp-server.mjs). The caller is the
     * member named in the identity header, never a body field, so an agent
     * cannot act as somebody else — which is also why a phone cannot call it:
     * it is not a member of the party.
     */
    name: "party.invokeTool",
    http: "POST /api/harness/party/tools/:tool",
    remote: false,
    handler: (p, ctx) => {
      if (!ctx.caller) {
        throw new ApiError(400, "x-agentparty-member-base64url (or legacy x-agentparty-member) header is required.");
      }
      return ctx.controller.invokePartyToolAs(ctx.workspace, ctx.caller, text(p.tool), p, ctx.partyId);
    },
  },
  {
    // Product-E2E route: launches the shipped stdio MCP relay on the named
    // member's Windows/WSL execution host and crosses the same transport
    // boundaries as a real harness tool call.
    name: "party.invokeMemberMcpTool",
    http: "POST /api/parties/:partyId/members/:name/mcp-tools/:tool",
    remote: false,
    handler: (p, ctx) => ctx.controller.invokeMemberPartyMcpTool(
      ctx.workspace,
      text(p.partyId),
      text(p.name),
      text(p.tool),
      p.arguments && typeof p.arguments === "object" ? p.arguments : {},
    ),
  },
  {
    name: "party.listMemberMcpTools",
    http: "GET /api/parties/:partyId/members/:name/mcp-tools",
    remote: false,
    handler: (p, ctx) => ctx.controller.listMemberPartyMcpTools(
      ctx.workspace,
      text(p.partyId),
      text(p.name),
    ),
  },
  {
    // Canonical stdio MCP discovery surface. The relay fetches this instead of
    // carrying a second static list that can omit new tools or stale schemas.
    name: "party.toolSpec",
    http: "GET /api/harness/party/tool-spec",
    remote: false,
    handler: () => ({ ok: true, tools: buildPartyMcpToolSpecs() }),
  },
  {
    name: "party.message",
    http: "POST /api/party/messages",
    handler: (p, ctx) => Array.isArray(p.to)
      ? ctx.controller.sendPartyMessages(
        ctx.workspace, stringArray(p.to, "to"), text(p.content), text(p.from, ctx.caller || "agent"),
        sanitizeAttachments(p.attachments), ctx.windowId, deliveryOptions(p), ctx.partyId,
      )
      : ctx.controller.sendPartyMessage(
        ctx.workspace, text(p.to), text(p.content), text(p.from, ctx.caller || "agent"),
        sanitizeAttachments(p.attachments), ctx.windowId, deliveryOptions(p), ctx.partyId,
      ),
  },
  {
    name: "party.messageFromHarness",
    http: "POST /api/harness/party/messages",
    remote: false,
    handler: (p, ctx) => Array.isArray(p.to)
      ? ctx.controller.sendPartyMessages(
        ctx.workspace, stringArray(p.to, "to"), text(p.content), text(p.from, ctx.caller || "agent"),
        sanitizeAttachments(p.attachments), ctx.windowId, deliveryOptions(p), ctx.partyId,
      )
      : ctx.controller.sendPartyMessage(
        ctx.workspace, text(p.to), text(p.content), text(p.from, ctx.caller || "agent"),
        sanitizeAttachments(p.attachments), ctx.windowId, deliveryOptions(p), ctx.partyId,
      ),
  },
  {
    // A human user turn: never gated, unlike a member-originated `member.send`.
    name: "member.message",
    http: "POST /api/party/members/:name/message",
    handler: (p, ctx) => ctx.controller.sendMemberMessage(
      ctx.workspace,
      text(p.name),
      text(p.text),
      sanitizeAttachments(p.attachments),
      ctx.windowId,
      { interrupt: p.interrupt === true },
      ctx.partyId,
    ),
  },
  {
    name: "member.create",
    http: "POST /api/party/members",
    handler: (p, ctx) => {
      if (p.members === undefined) {
        return ctx.controller.createPartyMember(ctx.workspace, createMemberInput(p, "member"), ctx.windowId);
      }
      if (p.name !== undefined || p.requirement !== undefined) {
        throw new ApiError(400, "Use either top-level single-member fields or members, not both.");
      }
      return ctx.controller.createPartyMembers(
        ctx.workspace,
        nonEmptyArray(p.members, "members").map((member, index) => createMemberInput(member, `members[${index}]`)),
        ctx.windowId,
      );
    },
  },
  {
    name: "member.removeBatch",
    http: "POST /api/party/members/remove",
    handler: (p, ctx) => ctx.controller.removePartyMembers(ctx.workspace, stringArray(p.name, "name"), ctx.windowId, ctx.partyId),
  },
  {
    // Message queue: what a busy member has been sent but not yet handed.
    name: "member.queue",
    http: "GET /api/party/members/:name/queue",
    handler: async (p, ctx) => ({ ok: true, queue: await ctx.controller.getMemberQueue(ctx.workspace, text(p.name), ctx.windowId) }),
  },
  {
    // One mutating endpoint carrying a discriminated action, so the API surface
    // and the UI buttons provably run the same code path. An unknown or
    // malformed action is rejected rather than coerced into a default mutation.
    name: "member.queueCommand",
    http: "POST /api/party/members/:name/queue",
    handler: (p, ctx) => ctx.controller.runQueueCommand(ctx.workspace, text(p.name), parseQueueCommand(p), ctx.windowId),
  },
  {
    // The workbench tab layout for the calling window's party. One copy shared
    // by every window on that party, so a set here moves the other windows too.
    name: "layout.get",
    http: "GET /api/party/layout",
    handler: async (_p, ctx) => ({ ok: true, layout: await ctx.controller.getPartyLayout(ctx.workspace, ctx.windowId) }),
  },
  {
    name: "layout.set",
    http: "POST /api/party/layout",
    handler: async (p, ctx) => ({ ok: true, ...(await ctx.controller.setPartyLayout(ctx.workspace, p.layout, ctx.windowId)) }),
  },
  {
    name: "member.transcript",
    http: "GET /api/party/members/:name/transcript",
    handler: async (p, ctx) => {
      // Sampled BEFORE the read, and that ordering is the whole contract.
      //
      // The outer `seq` is the PHONE transport position, sampled before this
      // genuinely async WSL-capable read to choose zero loss over a possible
      // replay. The returned transcript's own cursor is captured atomically by
      // the engine recorder and makes session-event replay idempotent; these two
      // cursors deliberately describe different streams.
      const seq = ctx.currentSeq?.();
      const snapshot = await ctx.controller.getMemberTranscript(ctx.workspace, text(p.name), ctx.windowId);
      return seq === undefined ? { ok: true, ...snapshot } : { ok: true, ...snapshot, seq };
    },
  },
  {
    // A transcript stores screenshots out-of-line, so its blocks carry a file
    // reference. This is how a caller (or the UI) turns one back into bytes.
    name: "party.transcriptImage",
    http: "GET /api/party/transcript-image/:file",
    handler: (p, ctx) => ctx.controller.getTranscriptImage(ctx.workspace, text(p.file)),
  },
  {
    // The app's transcript has a retention window; the harness's own copy does
    // not. This names where the rest of the history still is.
    name: "member.harnessOriginal",
    http: "GET /api/party/members/:name/harness-original",
    handler: (p, ctx) => ctx.controller.getHarnessOriginal(ctx.workspace, text(p.name), ctx.windowId),
  },
  {
    // Desktop-local takeover: inspect returns cwd+command; launch closes the
    // app adapter and opens that command in the user's default terminal.
    name: "member.cliContinuation",
    http: "POST /api/party/members/:name/cli-continuation",
    remote: false,
    handler: (p, ctx) => ctx.controller.continueMemberInCli(
      ctx.workspace,
      text(p.name),
      text(p.action, "inspect") as "inspect" | "launch",
      ctx.windowId,
    ),
  },
  {
    // Party-wide conveniences, routed through the same action dispatch with the
    // "*" member name.
    name: "party.broadcast",
    http: "POST /api/party/broadcast",
    handler: (p, ctx) => ctx.controller.handlePartyAction(ctx.workspace, "*", "broadcast", p, ctx.windowId, ctx.partyId),
  },
  {
    name: "party.interrupt",
    http: "POST /api/party/interrupt",
    handler: (p, ctx) => ctx.controller.handlePartyAction(ctx.workspace, "*", "interrupt", p, ctx.windowId, ctx.partyId),
  },
  {
    name: "party.status",
    http: "GET /api/party/status",
    handler: (_p, ctx) => ctx.controller.handlePartyAction(ctx.workspace, "*", "status", {}, ctx.windowId, ctx.partyId),
  },
  {
    // Opening a member means giving it a TAB — window state the engine-side
    // action table cannot reach. Sent through the same AppController method the
    // IPC `party:open` uses, so a sidebar click and this call do one thing.
    name: "member.open",
    http: "POST /api/party/members/:name/open",
    handler: (p, ctx) => ctx.controller.openPartyMember(ctx.workspace, text(p.name), ctx.windowId),
  },
  ...PARTY_ACTION_NAMES.filter((action) => !NON_MEMBER_ACTIONS.has(action)).map((action): MethodRoute => ({
    name: `member.${camelAction(action)}`,
    http: `POST /api/party/members/:name/${action}`,
    handler: (p, ctx) => ctx.controller.handlePartyAction(ctx.workspace, text(p.name), action, p, ctx.windowId, ctx.partyId),
  })),
];
