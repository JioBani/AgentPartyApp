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
import { APPROVAL_SCENARIOS, approvalScenarioNames } from "../../shared/approvalScenarios";
import { claudeApprovalFields, codexApprovalFields } from "../../shared/approvalRequest";
import { GALLERY_CASES, GALLERY_MODELS, GALLERY_PARTY } from "../../shared/designGallery";
import { fileEditsFrom } from "../../shared/codexItems";
import type { PartyApplicationService } from "../application/partyApplicationService";
import type { SessionManager } from "../sessionManager";
import type { EngineConnection, PartyListing, PartyMutationResult, QaEmitInput, QaInteractionInput, QaMemberSpec, QaQuestion } from "./engineConnection";
import { runPartyAction } from "./partyActions";
import type { IdleSleepSettings } from "../../shared/idleSleep";
import type { MemberMessagingSettings } from "../../shared/memberMessaging";
import { inspectCursorAgent } from "../../core/cursorAgentCli";
import { getSettings } from "../settings";
import { aggregateUsage, selectTurns, type TokenUsageAggregate, type TokenUsageQuery, type TokenUsageTurnsQuery, type TurnUsageRecord } from "../../shared/tokenUsage";
import { log } from "../logger";

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
 * See the WSL remote-engine design §6.
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

  async setMemberMessaging(settings: MemberMessagingSettings) {
    this.party.setMemberMessaging(settings);
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

  async invokePartyToolAs(member: string, tool: string, args: unknown, partyId?: string) {
    return this.party.invokePartyToolAs(member, tool, args, partyId);
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

  async getTranscriptImage(file: string) {
    return this.party.getTranscriptImage(file);
  }

  async getHarnessOriginal(name: string, partyId?: string) {
    return this.party.getHarnessOriginal(name, partyId);
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
    // Checked BEFORE the adapter is touched: a live model change is the one way
    // into a locked cross-harness pair that does not pass through createMember.
    this.party.assertSessionModelAllowed(sessionId, model);
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
    if (body.type === "approval") {
      return this.qaInjectApproval(name, body.scenario, body.requestId);
    }
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

  /**
   * Builds the card design gallery: one mock member per case, each already
   * showing its card.
   *
   * It composes the EXISTING injection paths rather than adding a second way to
   * make a card. A gallery with its own private rendering would be the one
   * screen guaranteed to disagree with the product.
   *
   * Nothing here talks to a harness: every member is a mock session, and the
   * resolved states are produced by answering through the same approve call the
   * card's own button makes.
   */
  async qaDesignGallery(): Promise<{ party: string; members: string[] }> {
    const parties = this.party.list().parties;
    const existing = parties.find((item) => item.name === GALLERY_PARTY);
    if (existing) {
      this.party.selectParty(existing.id);
    } else {
      this.party.createParty({ name: GALLERY_PARTY });
    }
    const members: string[] = [];
    for (const item of GALLERY_CASES) {
      const model = GALLERY_MODELS[item.runtime];
      if (!model) {
        throw new Error(`Gallery case '${item.member}' names harness '${item.runtime}', which has no recorded traffic — add its recordings before listing it.`);
      }
      const sessionId = this.startMockMember({
        name: item.member,
        role: item.caption,
        runtime: item.runtime,
        model,
        autoReply: false,
      });
      if (!sessionId) {
        throw new Error(`Gallery member '${item.member}' could not be started — the gallery must not be shown half-built.`);
      }
      if (item.scenario) {
        const { requestId } = await this.qaInjectApproval(item.member, item.scenario);
        if (item.resolve) {
          this.deps.sessionManager.approve(sessionId, requestId, item.resolve);
        }
      }
      if (item.questions) {
        const { requestId } = await this.qaInteraction(item.member, { type: "askUserQuestion", questions: item.questions as QaQuestion[] });
        if (item.answers) {
          this.deps.sessionManager.approve(sessionId, requestId, "allow", { answers: item.answers });
        }
      }
      this.applyBlocks(sessionId, item.events);
      members.push(item.member);
    }
    log("info", "qa", "design gallery built", { party: GALLERY_PARTY, members: members.length });
    return { party: GALLERY_PARTY, members };
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
        runtime: spec.runtime || "claude-code",
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

  /**
   * Injects a RECORDED approval request as the owning harness would emit it.
   *
   * Two refusals here rather than a convincing fake, following the qaKillHarness
   * precedent ([#21], where a mock status stood in for a real process kill and
   * hid a defect in two harnesses):
   *
   * - an unknown scenario names the available ones instead of injecting nothing;
   * - a REAL member is refused outright. A card injected there would carry a
   *   requestId the harness has never heard of, so its buttons could not resolve
   *   anything — `respondApproval` would answer "Unknown approval request". A
   *   card that looks live and cannot be answered is worse than no card, and it
   *   is precisely the substitution B-18 exists to remove. Getting a real
   *   approval means running a real turn (scripts/record-approval-traffic.mjs
   *   shows which prompts actually raise one).
   */
  private qaInjectApproval(name: string, scenario: string, requestId?: string): { requestId: string } {
    const recorded = APPROVAL_SCENARIOS[scenario];
    if (!recorded) {
      throw new Error(
        `Unknown approval scenario '${scenario}'. Available: ${approvalScenarioNames().join(", ")}`,
      );
    }
    const sessionId = this.qaSessionIdFor(name);
    if (!this.deps.sessionManager.isMockSession(sessionId)) {
      throw new Error(
        `Member '${name}' runs a REAL harness, so a recorded approval cannot be injected into it: `
          + "the harness never issued this request, so the card's buttons would have nothing to answer. "
          + "Inject into a mock member, or drive the real harness until it asks for approval itself.",
      );
    }
    const fields = recorded.harness === "codex"
      ? codexApprovalFields(recorded.method, recorded.params, fileEditsFrom((recorded as any).changes))
      : claudeApprovalFields(recorded.toolName, recorded.input, recorded.options as any);
    const id = requestId || `qa-approval-${name}-${Date.now()}`;
    this.deps.sessionManager.injectMockEvent(sessionId, { type: "approval_request", requestId: id, ...fields });
    return { requestId: id };
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
    // Carried through, not dropped: without these the mock can only ever make
    // the plainest question. `secret` decides whether the answer is masked —
    // a QA tool that silently un-masks a secret prompt is worse than none.
    secret: Boolean(q.secret),
    other: q.other === undefined ? undefined : Boolean(q.other),
    options: (Array.isArray(q.options) ? q.options : [])
      .map((o) => ({ label: String(o.label || ""), description: o.description ? String(o.description) : undefined }))
      .filter((o) => o.label),
  }));
}
