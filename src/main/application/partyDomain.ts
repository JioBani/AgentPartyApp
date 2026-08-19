import type { AppSettings, CreateMemberInput, HarnessId, PartyDefinition, PartyMember, PartyMessage } from "../../shared/types";
import { harnessDefaultsOf, harnessForRuntime, isPermissionModeSetting } from "../../shared/types";
import { DEFAULT_CODEX_POLICY, requireCodexPolicy } from "../../shared/codexPolicy";
import { cursorPolicyOf, requireCursorPolicy } from "../../shared/cursorPolicy";

export function createPartyDefinition(name: string, groupId?: string, now = new Date().toISOString()): PartyDefinition {
  return {
    id: `party-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    groupId,
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
  // Only the NAME is required. A role describes what a member is for, and there
  // are members that need none — the person opening it already knows. The
  // session primer states `(none specified)` rather than an empty line, so an
  // unset role reaches the member as a fact about itself instead of arriving as
  // blank text it has to interpret.
  //
  // The agent-facing `member-create` tool still demands one: when an agent
  // creates a member for another agent, nobody else is there to say what it is
  // for.
  if (!name) {
    throw new Error("Member name is required.");
  }
  if (input.permissionMode !== undefined && !isPermissionModeSetting(input.permissionMode)) {
    throw new Error(`Unknown Claude permission mode '${input.permissionMode}'.`);
  }
  const requestedCodexPolicy = input.codexPolicy === undefined ? undefined : requireCodexPolicy(input.codexPolicy);
  const requestedCursorPolicy = input.cursorPolicy === undefined ? undefined : requireCursorPolicy(input.cursorPolicy);

  // A member is created from ITS harness's defaults (not one global profile), so
  // e.g. a Codex member starts with the Codex default model + sandbox policy.
  const runtime = normalizeRuntime(input.runtime || settings.selectedHarnessId);
  const harnessId: HarnessId = harnessForRuntime(runtime);
  const profile = harnessDefaultsOf(settings, harnessId);
  const model = input.model || profile.model;
  return {
    partyId: input.partyId,
    name,
    role,
    runtime,
    status: "idle",
    model,
    effort: input.effort || profile.effort,
    reasoning: input.reasoning ?? profile.reasoning,
    reasoningBudget: input.reasoningBudget ?? profile.reasoningBudget,
    serviceTier: input.serviceTier ?? profile.serviceTier,
    permissionMode: harnessId === "claude-code" ? input.permissionMode || profile.permissionMode || "default" : undefined,
    // Permission semantics belong to the selected harness. Cross-routed models
    // do not replace the Claude Code SDK or Codex app-server process.
    codexPolicy: harnessId === "codex"
      ? { ...(requestedCodexPolicy || profile.codexPolicy || DEFAULT_CODEX_POLICY) }
      : undefined,
    cursorPolicy: harnessId === "cursor"
      ? cursorPolicyOf(requestedCursorPolicy || profile.cursorPolicy, input.permissionMode || profile.permissionMode)
      : undefined,
    // Fixed for the member's life. Stored verbatim rather than normalized so a
    // WSL location keeps the distro the caller chose; `parseMemberLocation` is
    // the one place that interprets it.
    location: input.location ? String(input.location).trim() || undefined : undefined,
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
  return value === "codex" ? "codex" : value === "cursor" ? "cursor" : value === "grok" ? "grok" : value === "claude" ? "claude" : "claude-code";
}

export function normalizeHarnessId(value: unknown): HarnessId {
  return value === "codex" ? "codex" : value === "cursor" ? "cursor" : value === "grok" ? "grok" : "claude-code";
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
