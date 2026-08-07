import type { CreateMemberInput, CreatePartyInput, CreateSessionInput, SessionView, StartPartyMemberInput, TranscriptSave, TranscriptSaveResult } from "../../shared/types";
import type { CodexPolicy } from "../../shared/codexPolicy";
import { requireCodexPolicy } from "../../shared/codexPolicy";
import type { CursorPolicy } from "../../shared/cursorPolicy";
import { requireCursorPolicy } from "../../shared/cursorPolicy";
import type { ImageAttachment } from "../../shared/attachments";
import type { QueueCommand } from "../../shared/messageQueue";
import type { McpAuthResult, McpServerSnapshot } from "../../shared/mcp";
import { workspaceKey } from "../../shared/workspaceLocation";
import { expandScenarioByName, scenarioNames } from "../../shared/subagentScenarios";
import type { PartyApplicationService } from "../application/partyApplicationService";
import type { SessionManager } from "../sessionManager";
import type { EngineConnection, PartyListing, PartyMutationResult, QaEmitInput, QaInteractionInput, QaMemberSpec, QaQuestion } from "./engineConnection";
import { runPartyAction } from "./partyActions";
import type { CodexAuthenticationUpdate } from "../../shared/codexAuthentication";
import type { IdleSleepSettings } from "../../shared/idleSleep";
import { inspectCursorAgent } from "../../core/cursorAgentCli";
import { getSettings } from "../settings";
import { aggregateUsage, selectTurns, type TokenUsageAggregate, type TokenUsageQuery, type TokenUsageTurnsQuery, type TurnUsageRecord } from "../../shared/tokenUsage";

export interface LocalEngineDeps {
  workspacePath: string;
  party: PartyApplicationService;
  sessionManager: SessionManager;
}

/**
 * In-process engine for a local workspace (Windows desktop, or inside a WSL
 * distro when this code runs as the distro's engine). A thin facade over the
 * workspace's {@link PartyApplicationService} and the shared
 * {@link SessionManager}. The work is synchronous; methods are async only to
 * satisfy the {@link EngineConnection} contract (a remote engine must be async).
 * See docs/WSL_REMOTE.md §6.
 */
export class LocalEngine implements EngineConnection {
  constructor(private readonly deps: LocalEngineDeps) {}

  get workspacePath(): string {
    return this.deps.workspacePath;
  }

  private get party(): PartyApplicationService {
    return this.deps.party;
  }

  async setIdleSleep(settings: IdleSleepSettings) {
    this.party.setIdleSleep(settings);
  }

  async setCodexAuthentication(update: CodexAuthenticationUpdate) {
    return this.deps.sessionManager.setCodexAuthentication(update);
  }

  // --- Party --------------------------------------------------------------
  async listParty(viewPartyId?: string): Promise<PartyListing> {
    return this.party.list(viewPartyId);
  }

  async createParty(input: CreatePartyInput) {
    return this.party.createParty(input);
  }

  async selectParty(partyId: string) {
    return this.party.selectParty(partyId);
  }

  async removeParty(partyId: string) {
    return this.party.removeParty(partyId);
  }

  async setPartyGate(partyId: string | undefined, gate: unknown) {
    return this.party.setPartyGate(partyId, gate);
  }

  async createMember(input: CreateMemberInput) {
    return this.party.createMember(input);
  }

  async sendPartyMessage(name: string, content: string, from?: string, attachments?: ImageAttachment[], partyId?: string, options?: { interrupt?: boolean; force?: boolean; forceReason?: string }): Promise<PartyMutationResult> {
    // The programmatic/agent send path (HTTP /api/party/messages, party:send IPC)
    // is gated; the human user turn uses sendUserMessage and is never gated.
    return this.party.sendGatedMessage(name, content, from, attachments, partyId, options);
  }

  async sendUserMessage(name: string, text: string, attachments?: ImageAttachment[], partyId?: string, options?: { interrupt?: boolean }) {
    return this.party.sendUserMessage(name, text, attachments, partyId, options);
  }

  async getMemberQueue(name: string, partyId?: string) {
    return this.party.getMemberQueue(name, partyId);
  }

  async runQueueCommand(name: string, command: QueueCommand, partyId?: string) {
    return this.party.runQueueCommand(name, command, partyId);
  }

  async closeMember(name: string, partyId?: string) {
    return this.party.closeMember(name, partyId);
  }

  async resumeMember(name: string, partyId?: string) {
    return this.party.resumeMember(name, partyId);
  }

  async respawnMember(name: string, input?: StartPartyMemberInput, partyId?: string) {
    return this.party.respawnMember(name, input, partyId);
  }

  async openMember(name: string, partyId?: string) {
    return this.party.openMember(name, partyId);
  }

  async startMember(name: string, input?: StartPartyMemberInput, partyId?: string) {
    return this.party.startMember(name, input, {}, partyId);
  }

  async bindMember(name: string, sessionId: string, partyId?: string) {
    return this.party.bindMember(name, sessionId, partyId);
  }

  async removeMember(name: string, partyId?: string) {
    return this.party.removeMember(name, partyId);
  }

  async partyAction(name: string, action: string, body: any, partyId?: string): Promise<PartyMutationResult> {
    return runPartyAction(this.party, name, action, body, partyId);
  }

  async getMemberTranscript(name: string, partyId?: string) {
    return this.party.getMemberTranscript(name, partyId);
  }

  async saveMemberTranscript(name: string, save: TranscriptSave, partyId?: string): Promise<TranscriptSaveResult> {
    return this.party.saveMemberTranscript(name, save, partyId);
  }

  async getPartyLayout(partyId?: string) {
    return this.party.getPartyLayout(partyId);
  }

  async setPartyLayout(layout: unknown, partyId?: string) {
    return this.party.setPartyLayout(layout, partyId);
  }

  // --- Models ---------------------------------------------------------------
  async listCodexModels(refresh?: boolean) {
    if (refresh) {
      return this.deps.sessionManager.refreshCodexModels();
    }
    return this.deps.sessionManager.getCodexModelState();
  }

  // --- Cursor CLI (host-scoped: local host here, the distro in a WSL engine) --
  async getCursorStatus() {
    return inspectCursorAgent(getSettings().cursorExecutablePath);
  }

  // --- Sessions -----------------------------------------------------------
  async createSession(input?: CreateSessionInput | string): Promise<SessionView> {
    return this.deps.sessionManager.createSession(this.withWorkspace(input));
  }

  listResumableSessions() {
    return this.deps.sessionManager.listResumableSessions(this.workspacePath);
  }

  async resumeSession(sessionId: string): Promise<SessionView> {
    return this.deps.sessionManager.resumeSession(sessionId, this.workspacePath);
  }

  async listWorkspaceSessions(): Promise<SessionView[]> {
    const key = workspaceKey(this.workspacePath);
    return this.deps.sessionManager.listSessions().filter((session) => workspaceKey(session.workspace) === key);
  }

  async getTokenUsage(query: TokenUsageQuery): Promise<TokenUsageAggregate> {
    const records = this.deps.sessionManager.readUsageLedger(this.workspacePath, query.fromMs, query.toMs);
    return aggregateUsage(records, query);
  }

  async getTokenUsageTurns(query: TokenUsageTurnsQuery): Promise<TurnUsageRecord[]> {
    const records = this.deps.sessionManager.readUsageLedger(this.workspacePath, query.fromMs, query.toMs);
    return selectTurns(records, query);
  }

  // --- Session control ----------------------------------------------------
  async sendUserTurn(sessionId: string, text: string, attachments?: ImageAttachment[]): Promise<void> {
    this.deps.sessionManager.sendUserTurn(sessionId, text, attachments);
  }

  async forceStopSession(sessionId: string): Promise<void> {
    this.deps.sessionManager.forceStop(sessionId);
  }

  async interruptSession(sessionId: string): Promise<void> {
    this.deps.sessionManager.interrupt(sessionId);
  }

  async restartSession(sessionId: string): Promise<void> {
    this.deps.sessionManager.restart(sessionId);
  }

  async compactSession(sessionId: string): Promise<void> {
    this.deps.sessionManager.compact(sessionId);
  }

  async setSessionModel(sessionId: string, model: string, providerId?: string, runtimeModel?: string): Promise<void> {
    this.deps.sessionManager.setModel(sessionId, model, providerId, runtimeModel);
    // Capture the runtime change on the owning member so a reopen/restart
    // restores the model the user last chose (same as permission mode below).
    this.party.syncMemberModel(sessionId, model);
  }

  async setSessionEffort(sessionId: string, effort: string): Promise<void> {
    this.deps.sessionManager.setEffort(sessionId, effort);
    this.party.syncMemberEffort(sessionId, effort);
  }

  async setSessionThinking(sessionId: string, mode: string, budget?: number): Promise<void> {
    this.deps.sessionManager.setThinking(sessionId, mode, budget);
    // Capture the runtime change on the owning member (same rationale as
    // effort/permission): without it a thinking change silently reverted to the
    // start-time value on the next reopen/restart.
    this.party.syncMemberThinking(sessionId, mode, budget);
  }

  async setSessionPermissionMode(sessionId: string, permissionMode: string): Promise<void> {
    this.deps.sessionManager.setPermissionMode(sessionId, permissionMode);
    // Capture the runtime change on the owning member so a reopen/restart
    // restores the user's chosen mode instead of reverting to the start-time value.
    this.party.syncMemberPermissionMode(sessionId, permissionMode);
  }

  async setSessionCodexPolicy(sessionId: string, policy: CodexPolicy): Promise<void> {
    const validated = requireCodexPolicy(policy);
    this.deps.sessionManager.setCodexPolicy(sessionId, validated);
    this.party.syncMemberCodexPolicy(sessionId, validated);
  }

  async setSessionCursorPolicy(sessionId: string, policy: CursorPolicy): Promise<void> {
    const validated = requireCursorPolicy(policy);
    this.deps.sessionManager.setCursorPolicy(sessionId, validated);
    this.party.syncMemberCursorPolicy(sessionId, validated);
  }

  async approveSession(sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): Promise<void> {
    this.deps.sessionManager.approve(sessionId, requestId, behavior, updatedInput, message);
  }

  async closeSession(sessionId: string): Promise<boolean> {
    return this.deps.sessionManager.closeSession(sessionId);
  }

  listSessionMcpServers(sessionId: string): Promise<McpServerSnapshot> {
    return this.deps.sessionManager.listMcpServers(sessionId);
  }

  reconnectSessionMcpServer(sessionId: string, server: string): Promise<void> {
    return this.deps.sessionManager.reconnectMcpServer(sessionId, server);
  }

  setSessionMcpServerEnabled(sessionId: string, server: string, enabled: boolean): Promise<void> {
    return this.deps.sessionManager.setMcpServerEnabled(sessionId, server, enabled);
  }

  authenticateSessionMcpServer(sessionId: string, server: string): Promise<McpAuthResult> {
    return this.deps.sessionManager.authenticateMcpServer(sessionId, server);
  }

  private withWorkspace(input?: CreateSessionInput | string): CreateSessionInput {
    if (typeof input === "string" || !input) {
      return { workspacePath: this.workspacePath };
    }
    return { ...input, workspacePath: input.workspacePath || this.workspacePath };
  }

  // --- QA (test-only) -----------------------------------------------------
  async qaSeed(input: { party?: string; members?: QaMemberSpec[] }): Promise<{ created: string[]; listing: PartyListing }> {
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
        this.applyCommands(sessionId, spec.commands);
        this.applyBlocks(sessionId, spec.blocks);
        this.applyStatus(sessionId, spec.status);
      }
      created.push(spec.name);
    }
    return { created, listing: this.party.list() };
  }

  async qaCreateMockMember(spec: QaMemberSpec): Promise<{ sessionId?: string; listing: PartyListing }> {
    const sessionId = this.startMockMember(spec);
    if (sessionId) {
      this.applyCommands(sessionId, spec.commands);
      this.applyBlocks(sessionId, spec.blocks);
      this.applyStatus(sessionId, spec.status);
    }
    return { sessionId, listing: this.party.list() };
  }

  async qaEmit(name: string, body: QaEmitInput): Promise<void> {
    const sessionId = this.qaSessionIdFor(name);
    this.applyBlocks(sessionId, body.events);
    this.applyStatus(sessionId, body.status);
  }

  /**
   * Injects a named subagent scenario as `subagent` events through the same mock
   * path as `qaEmit`, so the subagent dock/detail can be designed and QA'd without
   * ever spawning a real subagent. Unknown scenario names fail loudly (no silent
   * no-op) so a typo is visible.
   */
  async qaEmitSubagents(name: string, scenario: string): Promise<{ scenario: string; count: number }> {
    const events = expandScenarioByName(scenario, new Date().toISOString());
    if (!events) {
      throw new Error(`Unknown subagent scenario '${scenario}'. Available: ${scenarioNames().join(", ")}`);
    }
    const sessionId = this.qaSessionIdFor(name);
    this.applyBlocks(sessionId, events);
    return { scenario, count: events.length };
  }

  async qaInteraction(name: string, body: QaInteractionInput): Promise<{ requestId: string }> {
    const sessionId = this.qaSessionIdFor(name);
    const requestId = body.requestId || `qa-ask-${name}-${Date.now()}`;
    const questions = normalizeQuestions(body.questions);
    // Mirrors exactly what ClaudeAdapter emits for AskUserQuestion, so the mock
    // is indistinguishable from a real interaction in the renderer.
    this.deps.sessionManager.injectMockEvent(sessionId, {
      type: "approval_request",
      requestId,
      toolName: "AskUserQuestion",
      input: { questions },
      title: "AskUserQuestion",
    });
    return { requestId };
  }

  async qaReset(): Promise<PartyListing> {
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

  private applyCommands(sessionId: string | undefined, commands?: QaMemberSpec["commands"]): void {
    if (!sessionId || !commands || commands.length === 0) {
      return;
    }
    // A `session` event carrying the inventory is exactly what ClaudeAdapter
    // emits on init, so the mock drives the palette identically.
    this.deps.sessionManager.injectMockEvent(sessionId, { type: "session", sessionId, slashCommands: commands });
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

const DEFAULT_QA_QUESTIONS: QaQuestion[] = [
  {
    question: "어떤 작업을 진행할까요?",
    header: "작업 선택",
    multiSelect: false,
    options: [
      { label: "코드 리뷰", description: "현재 변경점을 리뷰합니다." },
      { label: "버그 수정", description: "보고된 버그를 수정합니다." },
      { label: "새 기능", description: "기능을 추가합니다." },
    ],
  },
];

/** Fills defaults so a mock AskUserQuestion always renders a valid card. */
function normalizeQuestions(questions: QaQuestion[] | undefined): QaQuestion[] {
  const source = Array.isArray(questions) && questions.length > 0 ? questions : DEFAULT_QA_QUESTIONS;
  return source.map((q) => ({
    question: String(q.question || "질문"),
    header: q.header ? String(q.header) : undefined,
    multiSelect: Boolean(q.multiSelect),
    options: (Array.isArray(q.options) ? q.options : [])
      .map((o) => ({ label: String(o.label || ""), description: o.description ? String(o.description) : undefined }))
      .filter((o) => o.label),
  }));
}
