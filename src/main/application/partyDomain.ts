import type { AppSettings, CreateMemberInput, HarnessId, PartyDefinition, PartyMember, PartyMessage } from "../../shared/types";
import { harnessDefaultsOf } from "../../shared/types";
import { DEFAULT_CODEX_POLICY } from "../../shared/codexPolicy";

export function createPartyDefinition(name: string, now = new Date().toISOString()): PartyDefinition {
  return {
    id: `party-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildPartyMember(input: CreateMemberInput, settings: AppSettings, now = new Date().toISOString()): PartyMember {
  const name = normalizeMemberName(input.name);
  const role = String(input.role || input.requirement || "").trim();
  if (!input.partyId) {
    throw new Error("Party id is required.");
  }
  if (!name || !role) {
    throw new Error("Member name and role are required.");
  }

  // A member is created from ITS harness's defaults (not one global profile), so
  // e.g. a Codex member starts with the Codex default model + sandbox policy.
  const runtime = normalizeRuntime(input.runtime || settings.selectedHarnessId);
  const harnessId: HarnessId = runtime === "codex" ? "codex" : "claude-code";
  const profile = harnessDefaultsOf(settings, harnessId);
  return {
    partyId: input.partyId,
    name,
    role,
    runtime,
    status: "idle",
    model: input.model || profile.model,
    effort: input.effort || profile.effort,
    reasoning: input.reasoning ?? profile.reasoning,
    reasoningBudget: input.reasoningBudget ?? profile.reasoningBudget,
    permissionMode: input.permissionMode || profile.permissionMode || "default",
    // Codex members carry the harness's two-axis policy default; Claude members don't use it.
    codexPolicy: harnessId === "codex" ? { ...(profile.codexPolicy || DEFAULT_CODEX_POLICY) } : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

export function createPartyMessage(target: PartyMember, content: string, from = "user", now = new Date().toISOString()): PartyMessage {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Message content is required.");
  }
  return {
    partyId: target.partyId,
    id: `party-msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    from: normalizeMemberName(from) || "user",
    to: target.name,
    content: trimmed,
    createdAt: now,
    delivered: false,
    targetSessionId: target.sessionId,
  };
}

export function buildChannelPayload(message: PartyMessage, target: PartyMember): string {
  const role = target.role ? `\n<agentparty_role member="${escapeAttribute(target.name)}">\n${target.role}\n</agentparty_role>` : "";
  return `<channel source="agentparty" from="${escapeAttribute(message.from)}" to="${escapeAttribute(message.to)}">\n${message.content}\n</channel>${role}`;
}

export function normalizeRuntime(value: unknown): PartyMember["runtime"] {
  return value === "codex" ? "codex" : value === "claude" ? "claude" : "claude-code";
}

export function normalizeHarnessId(value: unknown): "claude-code" | "codex" {
  return value === "codex" ? "codex" : "claude-code";
}

export function normalizeMemberName(value: unknown): string {
  return String(value || "").trim().replace(/\s+/g, "-");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
