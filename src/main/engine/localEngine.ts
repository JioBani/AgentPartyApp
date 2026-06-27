import type { CreateMemberInput, CreatePartyInput, CreateSessionInput, SessionView, StartPartyMemberInput } from "../../shared/types";
import { workspaceKey } from "../../shared/workspaceLocation";
import type { PartyApplicationService } from "../application/partyApplicationService";
import type { SessionManager } from "../sessionManager";
import type { EngineConnection, PartyListing, PartyMutationResult, QaEmitInput, QaMemberSpec } from "./engineConnection";

export interface LocalEngineDeps {
  workspacePath: string;
  party: PartyApplicationService;
  sessionManager: SessionManager;
}

/**
 * In-process engine for a local (Windows) workspace. A thin facade over the
 * workspace's {@link PartyApplicationService} and the shared
 * {@link SessionManager}; behavior is exactly what AppController did inline
 * before the boundary was extracted. See docs/WSL_REMOTE.md §6.
 */
export class LocalEngine implements EngineConnection {
  constructor(private readonly deps: LocalEngineDeps) {}

  get workspacePath(): string {
    return this.deps.workspacePath;
  }

  private get party(): PartyApplicationService {
    return this.deps.party;
  }

  // --- Party --------------------------------------------------------------
  listParty(): PartyListing {
    return this.party.list();
  }

  createParty(input: CreatePartyInput) {
    return this.party.createParty(input);
  }

  selectParty(partyId: string) {
    return this.party.selectParty(partyId);
  }

  createMember(input: CreateMemberInput) {
    return this.party.createMember(input);
  }

  sendPartyMessage(name: string, content: string, from?: string): PartyMutationResult {
    return this.party.sendMessage(name, content, from);
  }

  closeMember(name: string) {
    return this.party.closeMember(name);
  }

  resumeMember(name: string) {
    return this.party.resumeMember(name);
  }

  openMember(name: string) {
    return this.party.openMember(name);
  }

  startMember(name: string, input?: StartPartyMemberInput) {
    return this.party.startMember(name, input);
  }

  bindMember(name: string, sessionId: string) {
    return this.party.bindMember(name, sessionId);
  }

  removeMember(name: string) {
    return this.party.removeMember(name);
  }

  partyAction(name: string, action: string, body: any): PartyMutationResult {
    const handler = this.partyActions()[action];
    if (!handler) {
      throw new Error(`Unknown party action '${action}'.`);
    }
    return handler(name, body || {});
  }

  private partyActions(): Record<string, (name: string, body: any) => PartyMutationResult> {
    return {
      send: (name, body) => this.party.sendMessage(name, String(body.content || ""), body.from),
      close: (name) => this.party.closeMember(name),
      resume: (name) => this.party.resumeMember(name),
      open: (name) => this.party.openMember(name),
      start: (name, body) => this.party.startMember(name, body),
      bind: (name, body) => this.party.bindMember(name, String(body.sessionId || "")),
      remove: (name) => this.party.removeMember(name),
    };
  }

  // --- Sessions -----------------------------------------------------------
  createSession(input?: CreateSessionInput | string): SessionView {
    return this.deps.sessionManager.createSession(this.withWorkspace(input));
  }

  listResumableSessions() {
    return this.deps.sessionManager.listResumableSessions(this.workspacePath);
  }

  resumeSession(sessionId: string): SessionView {
    return this.deps.sessionManager.resumeSession(sessionId, this.workspacePath);
  }

  listWorkspaceSessions(): SessionView[] {
    const key = workspaceKey(this.workspacePath);
    return this.deps.sessionManager.listSessions().filter((session) => workspaceKey(session.workspace) === key);
  }

  private withWorkspace(input?: CreateSessionInput | string): CreateSessionInput {
    if (typeof input === "string" || !input) {
      return { workspacePath: this.workspacePath };
    }
    return { ...input, workspacePath: input.workspacePath || this.workspacePath };
  }

  // --- QA (test-only) -----------------------------------------------------
  qaSeed(input: { party?: string; members?: QaMemberSpec[] }): { created: string[]; listing: PartyListing } {
    const parties = this.party.list().parties;
    const existing = input.party ? parties.find((item) => item.name === input.party) : undefined;
    if (existing) {
      this.party.selectParty(existing.id);
    } else if (input.party || parties.length === 0) {
      this.party.createParty({ name: input.party || "QA Party" });
    }
    const created: string[] = [];
    for (const spec of input.members || []) {
      const sessionId = this.startMockMember(spec);
      if (sessionId) {
        this.applyBlocks(sessionId, spec.blocks);
        this.applyStatus(sessionId, spec.status);
      }
      created.push(spec.name);
    }
    return { created, listing: this.party.list() };
  }

  qaCreateMockMember(spec: QaMemberSpec): { sessionId?: string; listing: PartyListing } {
    const sessionId = this.startMockMember(spec);
    if (sessionId) {
      this.applyBlocks(sessionId, spec.blocks);
      this.applyStatus(sessionId, spec.status);
    }
    return { sessionId, listing: this.party.list() };
  }

  qaEmit(name: string, body: QaEmitInput): void {
    const sessionId = this.qaSessionIdFor(name);
    this.applyBlocks(sessionId, body.events);
    this.applyStatus(sessionId, body.status);
  }

  qaReset(): PartyListing {
    for (const member of this.party.list().members) {
      if (member.name !== "main" && member.sessionId && this.deps.sessionManager.isMockSession(member.sessionId)) {
        this.party.removeMember(member.name);
      }
    }
    return this.party.list();
  }

  private startMockMember(spec: QaMemberSpec): string | undefined {
    if (!spec.name) {
      throw new Error("QA member requires a name.");
    }
    const exists = this.party.list().members.some((member) => member.name === spec.name);
    if (!exists) {
      this.party.createMember({
        name: spec.name,
        requirement: spec.role || `QA mock member ${spec.name}`,
        runtime: "claude-code",
        model: spec.model,
        effort: spec.effort,
      });
    }
    const result = this.party.startMember(
      spec.name,
      { model: spec.model, effort: spec.effort as StartPartyMemberInput["effort"] },
      { mock: true, autoReply: spec.autoReply ?? true },
    );
    return result.member?.sessionId || result.session?.id;
  }

  private applyBlocks(sessionId: string | undefined, blocks?: unknown[]): void {
    if (!sessionId || !blocks) {
      return;
    }
    for (const event of blocks) {
      this.deps.sessionManager.injectMockEvent(sessionId, event);
    }
  }

  private applyStatus(sessionId: string | undefined, status?: "working" | "idle" | "approval"): void {
    if (!sessionId || !status) {
      return;
    }
    this.deps.sessionManager.setMockStatus(sessionId, status === "working" ? "responding" : "idle");
  }

  private qaSessionIdFor(name: string): string {
    const member = this.party.list().members.find((item) => item.name === name);
    if (!member?.sessionId) {
      throw new Error(`Mock member '${name}' has no active session. Seed it first.`);
    }
    return member.sessionId;
  }
}
