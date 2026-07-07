import type { PartyMutationResult } from "./engineConnection";
import type { PartyApplicationService } from "../application/partyApplicationService";
import { sanitizeAttachments } from "../../shared/attachments";

export type PartyActionName = "send" | "close" | "resume" | "open" | "start" | "bind" | "remove";

type PartyActionHandler = (party: PartyApplicationService, name: string, body: any, partyId?: string) => PartyMutationResult;

const PARTY_ACTIONS: Record<PartyActionName, PartyActionHandler> = {
  send: (party, name, body, partyId) => party.sendMessage(name, String(body.content || ""), body.from, sanitizeAttachments(body.attachments), partyId),
  close: (party, name, _body, partyId) => party.closeMember(name, partyId),
  resume: (party, name, _body, partyId) => party.resumeMember(name, partyId),
  open: (party, name, _body, partyId) => party.openMember(name, partyId),
  start: (party, name, body, partyId) => party.startMember(name, body, {}, partyId),
  bind: (party, name, body, partyId) => party.bindMember(name, String(body.sessionId || ""), partyId),
  remove: (party, name, _body, partyId) => party.removeMember(name, partyId),
};

export function runPartyAction(party: PartyApplicationService, name: string, action: string, body: any, partyId?: string): PartyMutationResult {
  const handler = PARTY_ACTIONS[action as PartyActionName];
  if (!handler) {
    throw new Error(`Unknown party action '${action}'.`);
  }
  return handler(party, name, body || {}, partyId);
}
