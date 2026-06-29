import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CreateMemberInput,
  CreatePartyInput,
  PartyCommandResult,
  PartyDefinition,
  PartyMember,
  PartyMessage,
  StartPartyMemberInput,
  SessionView,
} from "../../shared/types";
import { defaultMemberProfileOf } from "../../shared/types";
import { log } from "../logger";
import { PartyRepository, StoredPartyState } from "../partyRepository";
import { getSettings } from "../settings";
import type { SessionManager, SessionPartyBinding } from "../sessionManager";
import type { PartyBridge } from "../../core/partyBridge";
import { buildModelRoutes } from "../../core/modelRegistry";
import { harnesses } from "../harness/types";

export interface PartyApplicationDeps {
  sessionManager: SessionManager;
  getWorkspacePath: () => string;
}

export class PartyApplicationService {
  private readonly repository = new PartyRepository();

  constructor(private readonly deps: PartyApplicationDeps) {}

  list(): { parties: PartyDefinition[]; currentPartyId?: string; members: PartyMember[]; messages: PartyMessage[] } {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    return this.view(state);
  }

  createParty(input: CreatePartyInput): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const name = String(input.name || "").trim() || "New Party";
    const now = new Date().toISOString();
    const party: PartyDefinition = {
      id: `party-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name,
      createdAt: now,
      updatedAt: now,
    };
    state.parties.push(party);
    state.currentPartyId = party.id;
    // `main` is born from the default creation profile (harness/model/reasoning).
    const main = this.buildMember({ partyId: party.id, name: "main", requirement: "Primary user-facing agent for this party." });
    state.members.push(main);
    this.writeRoleFile(workspace, main);
    this.repository.write(workspace, state);
    log("info", "party", "party created", { workspace, partyId: party.id, name: party.name });
    // Auto-init main's session (no turn — like prewarm) so the party is usable
    // immediately. Non-fatal: a start failure (auth/executable) must not block
    // party creation, but it is surfaced rather than swallowed.
    try {
      const started = this.startMember("main");
      return { ...started, message: `Party '${party.name}' created with main member.` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log("warn", "party", "main session auto-start failed", { workspace, partyId: party.id, error: detail });
      return this.result(`Party '${party.name}' created, but main session did not start: ${detail}`, state, main);
    }
  }

  selectParty(partyId: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const party = this.requireParty(state, partyId);
    state.currentPartyId = party.id;
    party.updatedAt = new Date().toISOString();
    this.repository.write(workspace, state);
    return this.result(`Party '${party.name}' selected.`, state);
  }

  createMember(input: CreateMemberInput): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const party = this.requireParty(state, input.partyId || state.currentPartyId);
    const member = this.buildMember({ ...input, partyId: party.id });
    if (state.members.some((item) => item.partyId === party.id && item.name === member.name)) {
      throw new Error(`Party member '${member.name}' already exists in '${party.name}'.`);
    }
    state.members.push(member);
    party.updatedAt = new Date().toISOString();
    this.writeRoleFile(workspace, member, input.initialTask);
    this.repository.write(workspace, state);
    log("info", "party", "member created", { workspace, partyId: party.id, member: member.name, runtime: member.runtime });
    return this.result(`Member '${member.name}' created.`, state, member);
  }

  openMember(name: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name);
    if (!member.sessionId) {
      member.status = "opened";
      member.updatedAt = new Date().toISOString();
      this.repository.write(workspace, state);
    }
    return this.result(`Member '${member.name}' opened.`, state, member);
  }

  startMember(name: string, input: StartPartyMemberInput = {}, options: { mock?: boolean; autoReply?: boolean } = {}): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name);
    this.applyRuntimeDefaults(member, input);
    const session = this.createMemberSession(workspace, member, input, options);
    member.sessionId = session.id;
    member.status = "running";
    member.updatedAt = new Date().toISOString();
    this.repository.write(workspace, state);
    log("info", "party", "member session started", { workspace, partyId: member.partyId, member: member.name, sessionId: session.id, cwd: workspace });
    return { ...this.result(`Member '${member.name}' session started.`, state, member), session };
  }

  resumeMember(name: string): PartyCommandResult {
    return this.startMember(name);
  }

  bindMember(name: string, sessionId: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name);
    if (!this.deps.sessionManager.hasSession(sessionId)) {
      throw new Error(`Session '${sessionId}' is not active.`);
    }
    member.sessionId = sessionId;
    member.status = "running";
    member.updatedAt = new Date().toISOString();
    this.repository.write(workspace, state);
    log("info", "party", "member bound to session", { workspace, partyId: member.partyId, member: member.name, sessionId });
    return this.result(`Member '${member.name}' bound to active session.`, state, member);
  }

  closeMember(name: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name);
    if (member.sessionId) {
      this.deps.sessionManager.closeSession(member.sessionId);
    }
    member.sessionId = undefined;
    member.status = "closed";
    member.updatedAt = new Date().toISOString();
    this.repository.write(workspace, state);
    log("info", "party", "member closed", { workspace, partyId: member.partyId, member: member.name });
    return this.result(`Member '${member.name}' closed.`, state, member);
  }

  removeMember(name: string): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const member = this.requireMember(state, name);
    if (member.name === "main") {
      throw new Error("Main member cannot be removed. Remove or recreate the party instead.");
    }
    if (member.sessionId) {
      this.deps.sessionManager.closeSession(member.sessionId);
    }
    state.members = state.members.filter((item) => !(item.partyId === member.partyId && item.name === member.name));
    state.messages = state.messages.filter((message) => message.partyId !== member.partyId || (message.from !== member.name && message.to !== member.name));
    fs.rmSync(this.repository.memberDir(workspace, member.partyId || "default", member.name), { recursive: true, force: true });
    this.repository.write(workspace, state);
    log("info", "party", "member removed", { workspace, partyId: member.partyId, member: member.name });
    return this.result(`Member '${member.name}' removed.`, state);
  }

  sendMessage(to: string, content: string, from = "user"): PartyCommandResult {
    const workspace = this.workspacePath();
    const state = this.ensureMigrated(this.repository.read(workspace));
    const target = this.requireMember(state, to);
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("Message content is required.");
    }
    const message: PartyMessage = {
      partyId: target.partyId,
      id: `party-msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      from: normalizeMemberName(from) || "user",
      to: target.name,
      content: trimmed,
      createdAt: new Date().toISOString(),
      delivered: false,
      targetSessionId: target.sessionId,
    };
    if (target.sessionId && this.deps.sessionManager.hasSession(target.sessionId)) {
      this.deps.sessionManager.sendUserTurn(target.sessionId, buildChannelPayload(message, target));
      message.delivered = true;
      target.status = "running";
    } else {
      message.error = "target_member_has_no_active_session";
      target.status = target.sessionId ? "missing_session" : "opened";
    }
    target.updatedAt = message.createdAt;
    state.messages.push(message);
    this.repository.write(workspace, state);
    log("info", "party", "message routed", { workspace, partyId: target.partyId, from: message.from, to: message.to, delivered: message.delivered, targetSessionId: message.targetSessionId });
    return {
      ...this.result(message.delivered ? `Message delivered to '${target.name}'.` : `Message queued for '${target.name}', but no active session is bound.`, state, target),
      partyMessage: message,
    };
  }

  private buildMember(input: CreateMemberInput): PartyMember {
    const name = normalizeMemberName(input.name);
    const role = String(input.role || input.requirement || "").trim();
    if (!input.partyId) {
      throw new Error("Party id is required.");
    }
    if (!name || !role) {
      throw new Error("Member name and role are required.");
    }
    // A member is born with the default creation profile (derived from the
    // single runtime defaults); explicit input wins.
    const profile = defaultMemberProfileOf(getSettings());
    const now = new Date().toISOString();
    return {
      partyId: input.partyId,
      name,
      role,
      runtime: normalizeRuntime(input.runtime || profile.harness),
      status: "idle",
      model: input.model || profile.model,
      effort: input.effort || profile.effort,
      reasoning: input.reasoning ?? profile.reasoning,
      reasoningBudget: input.reasoningBudget ?? profile.reasoningBudget,
      permissionMode: input.permissionMode || profile.permissionMode,
      createdAt: now,
      updatedAt: now,
    };
  }

  private applyRuntimeDefaults(member: PartyMember, input: StartPartyMemberInput): void {
    const settings = getSettings();
    member.model = input.model || member.model || settings.claudeModel;
    member.effort = input.effort || member.effort || settings.claudeEffort;
    member.permissionMode = input.permissionMode || member.permissionMode || settings.claudePermissionMode;
  }

  private createMemberSession(
    workspace: string,
    member: PartyMember,
    input: StartPartyMemberInput,
    options: { mock?: boolean; autoReply?: boolean },
  ): SessionView {
    const settings = getSettings();
    const createInput = {
      workspacePath: workspace,
      selectedHarnessId: normalizeHarnessId(member.runtime),
      selectedProviderId: input.selectedProviderId || settings.selectedProviderId,
      model: member.model,
      effort: member.effort as any,
      thinking: member.reasoning,
      thinkingBudget: member.reasoningBudget,
      permissionMode: member.permissionMode,
    };
    if (options.mock) {
      return this.deps.sessionManager.createMockSession(createInput, { autoReply: options.autoReply });
    }
    // Give the member's session the in-process party tool surface, with its
    // identity closure-bound so `from` is never agent-supplied.
    const binding: SessionPartyBinding = {
      bridge: this.partyBridgeFor(member.partyId || "default", member.name),
      identity: { party: member.partyId || "default", member: member.name, role: member.role },
    };
    return this.deps.sessionManager.createSession(createInput, undefined, binding);
  }

  private ensureMigrated(state: StoredPartyState): StoredPartyState {
    if (state.parties.length > 0) {
      return state;
    }
    if (state.members.length === 0) {
      return state;
    }
    const now = new Date().toISOString();
    const party: PartyDefinition = { id: "default", name: "Default Party", createdAt: now, updatedAt: now };
    return {
      ...state,
      parties: [party],
      currentPartyId: party.id,
      members: state.members.map((member) => ({ ...member, partyId: member.partyId || party.id })),
      messages: state.messages.map((message) => ({ ...message, partyId: message.partyId || party.id })),
    };
  }

  private result(message: string, state: StoredPartyState, member?: PartyMember): PartyCommandResult {
    const view = this.view(state);
    return { ok: true, message, ...view, member: member ? this.withLiveStatus(member) : undefined };
  }

  private view(state: StoredPartyState): { parties: PartyDefinition[]; currentPartyId?: string; members: PartyMember[]; messages: PartyMessage[] } {
    const currentPartyId = state.currentPartyId || state.parties[0]?.id;
    return {
      parties: state.parties,
      currentPartyId,
      members: state.members.filter((member) => member.partyId === currentPartyId).map((member) => this.withLiveStatus(member)),
      messages: state.messages.filter((message) => message.partyId === currentPartyId),
    };
  }

  private requireParty(state: StoredPartyState, partyId?: string): PartyDefinition {
    const party = state.parties.find((item) => item.id === partyId) || state.parties[0];
    if (!party) {
      throw new Error("Create a party before creating members or sessions.");
    }
    state.currentPartyId = party.id;
    return party;
  }

  private requireMember(state: StoredPartyState, name: string): PartyMember {
    const party = this.requireParty(state, state.currentPartyId);
    const normalized = normalizeMemberName(name);
    const member = state.members.find((item) => item.partyId === party.id && item.name === normalized);
    if (!member) {
      throw new Error(`Party member '${normalized || name}' does not exist in '${party.name}'.`);
    }
    return member;
  }

  private withLiveStatus(member: PartyMember): PartyMember {
    if (member.sessionId && this.deps.sessionManager.hasSession(member.sessionId)) {
      return { ...member, status: "running" };
    }
    if (member.sessionId) {
      return { ...member, status: "missing_session" };
    }
    return member;
  }

  private writeRoleFile(workspace: string, member: PartyMember, initialTask?: string): void {
    const dir = this.repository.memberDir(workspace, member.partyId || "default", member.name);
    fs.mkdirSync(dir, { recursive: true });
    const content = [
      `# ${member.name}`,
      "",
      `Party: ${member.partyId || "default"}`,
      `Runtime: ${member.runtime || "claude-code"}`,
      `Role: ${member.role || ""}`,
      "",
      "Session cwd must remain the project root. This file is role context only, not a working directory.",
      initialTask ? `\nInitial task:\n${initialTask.trim()}\n` : "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "MEMBER.md"), content);
  }

  // --- Party bridge (Boundary 2 of docs/PARTY_COMMUNICATION.md) -------------
  // The in-process capability surface handed to a member's session. Every method
  // routes through the same service methods the UI/HTTP use, never throws (tool
  // handlers stay trivial), and re-broadcasts party state so the UI updates.
  // `from` is closure-bound to the calling member; operations resolve against
  // the active party (the app is single-active-party — see §12 limitation).
  private partyBridgeFor(party: string, selfMember: string): PartyBridge {
    const notify = () => this.deps.sessionManager.notifyPartyChanged(this.workspacePath());
    return {
      send: async (from, to, content) => {
        try {
          const result = this.sendMessage(to, content, from || selfMember);
          notify();
          if (!result.partyMessage?.delivered) {
            return { ok: false, error: `Member '${to}' is not running. Start it (or member-create it) before sending.` };
          }
          return { ok: true };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      createMember: async (request) => {
        const harness = String(request.harness || "claude-code").toLowerCase();
        if (harness === "codex") {
          return { ok: false, error: "The 'codex' harness is not implemented yet — use 'claude-code'." };
        }
        if (harness !== "claude-code") {
          return { ok: false, error: `Unknown harness '${request.harness}'. Use 'claude-code'.` };
        }
        try {
          this.createMember({
            partyId: party,
            name: request.name,
            requirement: request.role,
            role: request.role,
            runtime: "claude-code",
            model: request.model,
            effort: request.effort,
            reasoning: request.reasoning,
            reasoningBudget: request.reasoningBudget,
          });
          const started = this.startMember(request.name);
          notify();
          return { ok: true, data: { ok: true, name: request.name, status: started.member?.status ?? "running" } };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      removeMember: async (name) => {
        try {
          this.removeMember(name);
          notify();
          return { ok: true };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      list: async () => {
        const state = this.ensureMigrated(this.repository.read(this.workspacePath()));
        const members = state.members
          .filter((member) => (member.partyId || "default") === (state.currentPartyId || party))
          .map((member) => this.withLiveStatus(member))
          .map((member) => ({
            name: member.name,
            role: member.role ?? "",
            status: member.status,
            harness: member.runtime ?? "claude-code",
            model: member.model ?? "",
          }));
        return { ok: true, data: { members } };
      },
      listModels: async () => ({ ok: true, data: partyModelDiscovery() }),
    };
  }

  private workspacePath(): string {
    return this.deps.getWorkspacePath() || process.cwd();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The rich harness + model catalog returned by the `list-models` party tool, so
 * an agent can fill `member-create` correctly. Reads the same catalog
 * (`buildModelRoutes`) the UI and routing use.
 */
function partyModelDiscovery(): {
  harnesses: Array<{ id: string; label: string; status: string }>;
  models: Array<Record<string, unknown>>;
} {
  const routes = buildModelRoutes(getSettings().claudeModel, [], []);
  return {
    harnesses: harnesses.map((harness) => ({ id: harness.id, label: harness.label, status: harness.status })),
    models: routes.map((route) => {
      const thinking = route.capabilities.thinking;
      const effort = route.capabilities.effort;
      const reasoning = thinking.supported
        ? {
            effort: effort.supported ? { options: effort.options.map((option) => option.id), default: effort.defaultValue } : undefined,
            thinking: thinking.modes ? { modes: thinking.modes.map((mode) => mode.id), default: thinking.defaultValue } : undefined,
            budget: thinking.budget,
          }
        : null;
      return {
        id: route.model,
        label: route.label,
        provider: route.providerId,
        perf: route.meta?.perf,
        costTier: route.meta?.costTier,
        inPerM: route.meta?.inPerM,
        outPerM: route.meta?.outPerM,
        ioPerM: route.meta?.ioPerM,
        context: route.meta?.context,
        reasoning,
      };
    }),
  };
}

function buildChannelPayload(message: PartyMessage, target: PartyMember): string {
  const role = target.role ? `\n<agentparty_role member="${escapeAttribute(target.name)}">\n${target.role}\n</agentparty_role>` : "";
  return `<channel source="agentparty" from="${escapeAttribute(message.from)}" to="${escapeAttribute(message.to)}">\n${message.content}\n</channel>${role}`;
}

function normalizeRuntime(value: unknown): PartyMember["runtime"] {
  return value === "codex" ? "codex" : value === "claude" ? "claude" : "claude-code";
}

function normalizeHarnessId(value: unknown): "claude-code" | "codex" {
  return value === "codex" ? "codex" : "claude-code";
}

function normalizeMemberName(value: unknown): string {
  return String(value || "").trim().replace(/\s+/g, "-");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
