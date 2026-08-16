import { sanitizeAttachments } from "../../../shared/attachments";
import { parseQueueCommand } from "../../../shared/messageQueue";
import { PARTY_ACTION_NAMES } from "../../engine/partyActions";
import { ApiError, camelAction, optText, required, text, type MethodRoute } from "../methodRegistry";

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
    handler: (p, ctx) => ctx.controller.createParty(ctx.workspace, { ...p, name: required(p.name, "name") }, ctx.windowId),
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
    name: "party.message",
    http: "POST /api/party/messages",
    handler: (p, ctx) => ctx.controller.sendPartyMessage(
      ctx.workspace,
      text(p.to),
      text(p.content),
      text(p.from, ctx.caller || "agent"),
      sanitizeAttachments(p.attachments),
      ctx.windowId,
      deliveryOptions(p),
      ctx.partyId,
    ),
  },
  {
    name: "party.messageFromHarness",
    http: "POST /api/harness/party/messages",
    remote: false,
    handler: (p, ctx) => ctx.controller.sendPartyMessage(
      ctx.workspace,
      text(p.to),
      text(p.content),
      text(p.from, ctx.caller || "agent"),
      sanitizeAttachments(p.attachments),
      ctx.windowId,
      deliveryOptions(p),
      ctx.partyId,
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
    ),
  },
  {
    name: "member.create",
    http: "POST /api/party/members",
    handler: (p, ctx) => ctx.controller.createPartyMember(
      ctx.workspace,
      { ...p, name: required(p.name, "name"), requirement: required(p.requirement, "requirement") },
      ctx.windowId,
    ),
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
      // These blocks are a saved copy, written at some instant T inside the
      // read — genuinely async for a WSL workspace, which crosses a process
      // boundary. `before ≤ T ≤ after`. A seq taken after the answer is built
      // makes the phone skip (T, after], events the saved copy does NOT
      // contain: loss. Taken before, it re-applies (before, T]: duplication.
      // 01 §5.3 chose the same way for the rewind snapshot — zero loss, and
      // duplicates are the reducer's problem to be idempotent about.
      const seq = ctx.currentSeq?.();
      const blocks = await ctx.controller.getMemberTranscript(ctx.workspace, text(p.name), ctx.windowId);
      return seq === undefined ? { ok: true, blocks } : { ok: true, blocks, seq };
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
