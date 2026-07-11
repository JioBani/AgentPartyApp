import type { PartyMutationResult } from "./engineConnection";
import type { PartyApplicationService } from "../application/partyApplicationService";
import { sanitizeAttachments } from "../../shared/attachments";

export type PartyActionName = "send" | "close" | "resume" | "respawn" | "open" | "start" | "bind" | "remove" | "status" | "interrupt" | "broadcast";

type PartyActionHandler = (party: PartyApplicationService, name: string, body: any, partyId?: string) => PartyMutationResult;

const PARTY_ACTIONS: Record<PartyActionName, PartyActionHandler> = {
  send: (party, name, body, partyId) => party.sendMessage(name, String(body.content || ""), body.from, sanitizeAttachments(body.attachments), partyId, { interrupt: body.interrupt === true }),
  close: (party, name, _body, partyId) => party.closeMember(name, partyId),
  resume: (party, name, _body, partyId) => party.resumeMember(name, partyId),
  respawn: (party, name, body, partyId) => party.respawnMember(name, body, partyId),
  open: (party, name, _body, partyId) => party.openMember(name, partyId),
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
  // Party-wide message; the URL member name is ignored (callers use "*").
  broadcast: (party, _name, body, partyId) => party.broadcastMessage(String(body.content || ""), String(body.from || "user"), partyId, { interrupt: body.interrupt === true }),
};

export function runPartyAction(party: PartyApplicationService, name: string, action: string, body: any, partyId?: string): PartyMutationResult {
  const handler = PARTY_ACTIONS[action as PartyActionName];
  if (!handler) {
    throw new Error(`Unknown party action '${action}'.`);
  }
  return handler(party, name, body || {}, partyId);
}
