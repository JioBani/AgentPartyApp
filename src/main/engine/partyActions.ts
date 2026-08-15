import type { PartyMutationResult } from "./engineConnection";
import type { PartyApplicationService } from "../application/partyApplicationService";
import { sanitizeAttachments } from "../../shared/attachments";
import { normalizeAutoCompact } from "../../shared/autoCompact";

export type PartyActionName = "send" | "close" | "resume" | "respawn" | "open" | "start" | "bind" | "remove" | "status" | "interrupt" | "force-stop" | "broadcast" | "auto-compact" | "permission" | "gate" | "outbound-interrupt" | "sleep" | "wake" | "keep-awake";

type PartyActionHandler = (party: PartyApplicationService, name: string, body: any, partyId?: string) => PartyMutationResult | Promise<PartyMutationResult>;

const PARTY_ACTIONS: Record<PartyActionName, PartyActionHandler> = {
  // Member-originated sends go through the gated path (Message Gate review); a
  // human user turn uses sendMemberMessage instead and is never gated.
  send: (party, name, body, partyId) => party.sendGatedMessage(name, String(body.content || ""), body.from, sanitizeAttachments(body.attachments), partyId, { interrupt: typeof body.interrupt === "boolean" ? body.interrupt : undefined, force: body.force === true, forceReason: typeof body.forceReason === "string" ? body.forceReason : undefined }),
  close: (party, name, _body, partyId) => party.closeMember(name, partyId),
  resume: (party, name, _body, partyId) => party.resumeMember(name, partyId),
  respawn: (party, name, body, partyId) => party.respawnMember(name, body, partyId),
  open: (party, name, _body, partyId) => party.openMember(name, partyId),
  // Per-member auto-compaction threshold. `body.autoCompact = {on,at}` sets it;
  // null/omitted clears the override (member falls back to the global default).
  "auto-compact": (party, name, body, partyId) => party.setMemberAutoCompact(name, normalizeAutoCompact(body?.autoCompact), partyId),
  permission: (party, name, body, partyId) => party.setMemberPermission(name, body || {}, partyId),
  // Per-member Message Gate override (mode/rule/reviewer patch). Cross-editable.
  gate: (party, name, body, partyId) => party.setMemberGate(name, body?.gate ?? body ?? {}, partyId),
  "outbound-interrupt": (party, name, body, partyId) => party.setMemberOutboundInterrupt(name, body?.outboundInterrupt, partyId),
  // Idle sleep, driven by hand. The sweep does this on its own after the
  // configured quiet period; these exist so a person or a QA run does not have
  // to wait it out to exercise the same code path.
  sleep: (party, name, _body, partyId) => party.sleepMember(name, partyId),
  wake: (party, name, _body, partyId) => party.wakeMember(name, partyId),
  // `body.keepAwake = true` pins the member awake; false/null lets it follow the
  // global setting again.
  "keep-awake": (party, name, body, partyId) => party.setMemberKeepAwake(name, body?.keepAwake === true, partyId),
  start: (party, name, body, partyId) => party.startMember(name, body, {}, partyId),
  bind: (party, name, body, partyId) => party.bindMember(name, String(body.sessionId || ""), partyId),
  remove: (party, name, _body, partyId) => party.removeMember(name, partyId),
  // Turn-state read; name "*" (or "all") means every member of the party.
  status: (party, name, _body, partyId) => party.memberTurnStatus(name === "*" || name === "all" ? undefined : name, partyId) as unknown as PartyMutationResult,
  // Stop a member's in-flight turn; name "*"/"all" stops every member (body.exclude optional).
  interrupt: (party, name, body, partyId) =>
    name === "*" || name === "all"
      ? party.interruptAllMembers(partyId, typeof body.exclude === "string" ? body.exclude : undefined)
      : party.interruptMember(name, partyId),
  // Releases a turn the harness never closed, so input stops queueing behind it.
  // The composer surfaces this only after a Stop went unanswered.
  "force-stop": (party, name, _body, partyId) => party.forceStopMember(name, partyId),
  // Party-wide message; the URL member name is ignored (callers use "*").
  broadcast: (party, _name, body, partyId) => party.broadcastMessage(String(body.content || ""), String(body.from || "user"), partyId, { interrupt: typeof body.interrupt === "boolean" ? body.interrupt : undefined, force: body.force === true, forceReason: typeof body.forceReason === "string" ? body.forceReason : undefined }),
};

/**
 * The complete action list, in declaration order. The API route table expands
 * this into one endpoint + one RPC method per action, so adding an action here
 * publishes it everywhere instead of needing a matching route edit.
 */
export const PARTY_ACTION_NAMES = Object.keys(PARTY_ACTIONS) as PartyActionName[];

export function runPartyAction(party: PartyApplicationService, name: string, action: string, body: any, partyId?: string): PartyMutationResult | Promise<PartyMutationResult> {
  const handler = PARTY_ACTIONS[action as PartyActionName];
  if (!handler) {
    throw new Error(`Unknown party action '${action}'.`);
  }
  return handler(party, name, body || {}, partyId);
}
