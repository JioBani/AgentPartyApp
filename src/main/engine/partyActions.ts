import type { PartyMutationResult } from "./engineConnection";
import type { PartyApplicationService } from "../application/partyApplicationService";
import { sanitizeAttachments } from "../../shared/attachments";

export type PartyActionName = "send" | "close" | "resume" | "open" | "start" | "bind" | "remove";

type PartyActionHandler = (party: PartyApplicationService, name: string, body: any) => PartyMutationResult;

const PARTY_ACTIONS: Record<PartyActionName, PartyActionHandler> = {
  send: (party, name, body) => party.sendMessage(name, String(body.content || ""), body.from, sanitizeAttachments(body.attachments)),
  close: (party, name) => party.closeMember(name),
  resume: (party, name) => party.resumeMember(name),
  open: (party, name) => party.openMember(name),
  start: (party, name, body) => party.startMember(name, body),
  bind: (party, name, body) => party.bindMember(name, String(body.sessionId || "")),
  remove: (party, name) => party.removeMember(name),
};

export function runPartyAction(party: PartyApplicationService, name: string, action: string, body: any): PartyMutationResult {
  const handler = PARTY_ACTIONS[action as PartyActionName];
  if (!handler) {
    throw new Error(`Unknown party action '${action}'.`);
  }
  return handler(party, name, body || {});
}
