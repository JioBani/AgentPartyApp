import type {
  CreateMemberInput,
  CreatePartyInput,
  CreateSessionInput,
  ResumableSessionInfo,
  SessionView,
  StartPartyMemberInput,
  TranscriptSave,
  TranscriptSaveResult,
} from "../../shared/types";
import type { HarnessCommand } from "../../core/events";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import type { HarnessId } from "../../shared/types";
import type { CodexPolicy } from "../../shared/codexPolicy";
import type { CursorPolicy } from "../../shared/cursorPolicy";
import type { ImageAttachment } from "../../shared/attachments";
import type { QueueCommand } from "../../shared/messageQueue";
import type { McpAuthResult, McpServerSnapshot } from "../../shared/mcp";
import type { PartyApplicationService } from "../application/partyApplicationService";
import type { IdleSleepSettings } from "../../shared/idleSleep";
import type { MemberMessagingSettings } from "../../shared/memberMessaging";
import type { CursorAgentStatus } from "../../core/cursorAgentCli";
import type { ClaudeNativeAuthState } from "../../core/claudeNativeAuth";
import type { TokenUsageAggregate, TokenUsageQuery, TokenUsageTurnsQuery, TurnUsageRecord } from "../../shared/tokenUsage";
import type { ApprovalDelivery } from "../../shared/approvals";

/**
 * The engine surface — everything addressed by **workspace**. For a local
 * workspace this is served in-process (`LocalEngine`); for a WSL workspace it
 * will be served by an engine running inside the distro, reached over RPC
 * (`RemoteEngineClient`, later stages). See the WSL remote-engine design §6.
 *
 * Deliberately scoped to the workspace dimension — the exact place local and
 * WSL diverge. Session control addressed by a global session id
 * (send/interrupt/approve/...) stays on the client until the transport stage
 * introduces session→engine routing.
 */
export type PartyListing = ReturnType<PartyApplicationService["list"]>;
export type PartyMutationResult = ReturnType<PartyApplicationService["sendMessage"]>;

/** One mock member to seed for frontend QA. */
export interface QaMemberSpec {
  name: string;
  role?: string;
  /**
   * Harness the mock member belongs to. Mock members used to be forced to
   * `claude-code` while still being given the other harness's model, so a QA
   * screen showing a Codex card carried a Claude runtime badge — and once the
   * beta locked cross-harness pairs, seeding that combination failed outright.
   */
  runtime?: HarnessId;
  model?: string;
  effort?: string;
  status?: "working" | "idle" | "approval";
  autoReply?: boolean;
  blocks?: unknown[];
  /** Seeded slash-command inventory for exercising the command palette in QA. */
  commands?: HarnessCommand[];
}

export interface QaEmitInput {
  events?: unknown[];
  status?: "working" | "idle" | "approval";
}

/** One option of an AskUserQuestion mock interaction. */
export interface QaQuestionOption {
  label: string;
  description?: string;
}

/** One question of an AskUserQuestion mock interaction. */
export interface QaQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  /** Mask the answer (Codex marks this per question with `isSecret`). */
  secret?: boolean;
  /** Whether a written-in answer is accepted besides the listed options. */
  other?: boolean;
  options: QaQuestionOption[];
}

/**
 * Drives a model-style interaction into a mock member without a real model, so
 * the interactive UI can be exercised over the automation API.
 *
 * `approval` replays a RECORDED harness approval (src/shared/approvalScenarios.ts,
 * generated from scripts/fixtures/approvals/*.jsonl) through the same mapping a
 * live harness goes through. It carries no authored values: the card that
 * appears is the one the real harness produces, which is the whole point of
 * B-18 — the previous mock could only ever make a question card, so the
 * approval card's actual content was never verifiable.
 */
export type QaInteractionInput =
  | { type: "askUserQuestion"; requestId?: string; questions?: QaQuestion[] }
  | { type: "approval"; scenario: string; requestId?: string };

/**
 * Every method is async: the engine may be in another host (a WSL distro)
 * reached over a transport, and a remote boundary cannot be synchronous. The
 * in-process {@link LocalEngine} satisfies it by wrapping its synchronous work
 * in promises; `RemoteEngineClient` satisfies it over the wire. See
 * the WSL remote-engine design §6/§7.
 */
export interface EngineConnection {
  readonly workspacePath: string;

  /**
   * Pushes the idle-sleep policy to this engine host.
   *
   * The sweep runs where the SESSIONS live, which for a WSL workspace is inside
   * the distro — and `getSettings()` there reads the engine's own settings.json,
   * not the desktop's. A timeout changed on the desktop therefore never reached
   * the engine that acts on it, and idle sleep silently kept using the built-in
   * default on every remote workspace. The desktop owns the value and engines
   * are told explicitly.
   */
  setIdleSleep(settings: IdleSleepSettings): Promise<void>;
  /** Pushes the desktop-owned member-message default to this engine host. */
  setMemberMessaging(settings: MemberMessagingSettings): Promise<void>;

  // --- Party (workspace-scoped; `partyId` scopes to the CALLING WINDOW's party) --
  // One engine serves every window of a workspace, so which party is active is a
  // per-window fact the desktop passes in via `partyId`. When omitted (HTTP with
  // no window, or first load), the engine falls back to its advisory hint.
  listParty(viewPartyId?: string): Promise<PartyListing>;
  createParty(input: CreatePartyInput): Promise<ReturnType<PartyApplicationService["createParty"]>>;
  selectParty(partyId: string): Promise<ReturnType<PartyApplicationService["selectParty"]>>;
  removeParty(partyId: string): Promise<ReturnType<PartyApplicationService["removeParty"]>>;
  setPartyGate(partyId: string | undefined, gate: unknown): Promise<ReturnType<PartyApplicationService["setPartyGate"]>>;
  createMember(input: CreateMemberInput): Promise<ReturnType<PartyApplicationService["createMember"]>>;
  sendPartyMessage(name: string, content: string, from?: string, attachments?: ImageAttachment[], partyId?: string, options?: { interrupt?: boolean; force?: boolean; forceReason?: string }): Promise<PartyMutationResult>;
  /**
   * One party tool, run AS `member`, for a harness whose tools reach the app
   * over HTTP instead of in-process. Returns the agent-facing result rather
   * than the UI's command result — see `PartyApplicationService.invokePartyToolAs`.
   */
  invokePartyToolAs(member: string, tool: string, args: unknown, partyId?: string): ReturnType<PartyApplicationService["invokePartyToolAs"]>;
  /** User turn to a member (auto-starts its session); the shared UI+API send path. */
  sendUserMessage(name: string, text: string, attachments?: ImageAttachment[], partyId?: string, options?: { interrupt?: boolean }): Promise<ReturnType<PartyApplicationService["sendUserMessage"]>>;
  /** Messages addressed to a busy member that it has not been handed yet (shared/messageQueue.ts). */
  getMemberQueue(name: string, partyId?: string): Promise<ReturnType<PartyApplicationService["getMemberQueue"]>>;
  /** Every queue mutation — send / cancel / edit / move / mergeUp / clear / preference. */
  runQueueCommand(name: string, command: QueueCommand, partyId?: string): Promise<ReturnType<PartyApplicationService["runQueueCommand"]>>;
  closeMember(name: string, partyId?: string): Promise<ReturnType<PartyApplicationService["closeMember"]>>;
  resumeMember(name: string, partyId?: string): Promise<ReturnType<PartyApplicationService["resumeMember"]>>;
  /** Reloads the member's session, resuming the same conversation (respawn). */
  respawnMember(name: string, input?: StartPartyMemberInput, partyId?: string): Promise<ReturnType<PartyApplicationService["respawnMember"]>>;
  openMember(name: string, partyId?: string): Promise<ReturnType<PartyApplicationService["openMember"]>>;
  startMember(name: string, input?: StartPartyMemberInput, partyId?: string): Promise<ReturnType<PartyApplicationService["startMember"]>>;
  bindMember(name: string, sessionId: string, partyId?: string): Promise<ReturnType<PartyApplicationService["bindMember"]>>;
  removeMember(name: string, partyId?: string): Promise<ReturnType<PartyApplicationService["removeMember"]>>;
  /** Dispatches one of the named party actions (HTTP `/api/party/members/:name/:action`). */
  partyAction(name: string, action: string, body: any, partyId?: string): Promise<PartyMutationResult>;
  /** Atomic materialized transcript snapshot, including a live-event cursor when active. */
  getMemberTranscript(name: string, partyId?: string): Promise<ReturnType<PartyApplicationService["getMemberTranscript"]>>;
  /**
   * One screenshot a transcript references, as a data URL. Transcripts store
   * images out-of-line, so this is what materialises them — per image, on
   * display. It belongs to the ENGINE rather than a file read in the renderer
   * so a REMOTE engine serves the images that live on its own disk.
   */
  getTranscriptImage(file: string): Promise<ReturnType<PartyApplicationService["getTranscriptImage"]>>;
  /** Where the harness keeps its own untrimmed copy of this member's conversation. */
  getHarnessOriginal(name: string, partyId?: string): Promise<ReturnType<PartyApplicationService["getHarnessOriginal"]>>;
  /** Resumable native-CLI target, or the concrete reason this member cannot be handed off. */
  getCliContinuationTarget(name: string, partyId?: string): Promise<ReturnType<PartyApplicationService["getCliContinuationTarget"]>>;
  beginCliContinuation(name: string, partyId?: string): Promise<ReturnType<PartyApplicationService["beginCliContinuation"]>>;
  recordCliContinuationProcess(name: string, handoffId: string, process: { terminalPid: number; host: "local" | "wsl"; distro?: string }, partyId?: string): Promise<ReturnType<PartyApplicationService["recordCliContinuationProcess"]>>;
  finishCliContinuation(name: string, handoffId: string, partyId?: string): Promise<ReturnType<PartyApplicationService["finishCliContinuation"]>>;
  /**
   * Persists the member's transcript (renderer-driven, debounced) + captures its
   * resumable thread id. `save.afterId` sends only the appended blocks — the
   * whole array would otherwise dominate this connection's traffic.
   */
  saveMemberTranscript(name: string, save: TranscriptSave, partyId?: string): Promise<TranscriptSaveResult>;
  /** The party's workbench tab layout — one copy, shared by every window on it. */
  getPartyLayout(partyId?: string): Promise<ReturnType<PartyApplicationService["getPartyLayout"]>>;
  /** Records the layout; `changed: false` means it already matched what was stored. */
  setPartyLayout(layout: unknown, partyId?: string): Promise<ReturnType<PartyApplicationService["setPartyLayout"]>>;

  // --- Models (engine-scoped) ----------------------------------------------
  /**
   * Snapshot of the Codex account catalog discovered from the engine host's
   * `codex app-server` (`model/list`). `refresh` re-runs discovery and awaits
   * the fresh settle; otherwise the current snapshot returns immediately
   * (kicking a background discovery on first call).
   */
  listCodexModels(refresh?: boolean): Promise<CodexModelDiscoveryState>;

  /**
   * Cursor Agent CLI status ON THIS ENGINE'S HOST — install/version/models plus
   * login state. Engine-scoped because a WSL workspace runs the CLI inside the
   * distro: inspecting the Windows install answers for the wrong host.
   */
  getCursorStatus(): Promise<CursorAgentStatus>;

  /** Native Claude login on this engine host (Windows, WSL distro, or Unix). */
  getClaudeNativeAuth(force?: boolean): Promise<ClaudeNativeAuthState>;

  // --- Sessions (workspace-scoped) ---------------------------------------
  createSession(input?: CreateSessionInput | string): Promise<SessionView>;
  listResumableSessions(): Promise<{ sessions: ResumableSessionInfo[]; error?: string }>;
  resumeSession(sessionId: string): Promise<SessionView>;
  listWorkspaceSessions(): Promise<SessionView[]>;

  // --- Session control (by id, within this engine's workspace) -----------
  sendUserTurn(sessionId: string, text: string, attachments?: ImageAttachment[]): Promise<void>;
  interruptSession(sessionId: string): Promise<void>;
  /** Force-releases a stuck turn — the UI's "강제 종료", offered after an unanswered Stop. */
  forceStopSession(sessionId: string): Promise<void>;
  restartSession(sessionId: string): Promise<void>;
  compactSession(sessionId: string): Promise<void>;
  setSessionModel(sessionId: string, model: string, providerId?: string, runtimeModel?: string): Promise<void>;
  setSessionEffort(sessionId: string, effort: string): Promise<void>;
  setSessionThinking(sessionId: string, mode: string, budget?: number): Promise<void>;
  setSessionPermissionMode(sessionId: string, permissionMode: string): Promise<void>;
  setSessionCodexPolicy(sessionId: string, policy: CodexPolicy): Promise<void>;
  setSessionCursorPolicy(sessionId: string, policy: CursorPolicy): Promise<void>;
  /** Answers a pending approval and reports whether the harness took it. */
  approveSession(sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): Promise<ApprovalDelivery>;
  closeSession(sessionId: string): Promise<boolean>;

  // --- Token usage (workspace-scoped) ------------------------------------
  /**
   * Aggregated per-turn usage ledger for the Token Usage dashboard. Reads this
   * engine's workspace ledger and rolls it up by bucket/party/member/trigger —
   * engine-scoped so a WSL workspace's turns (recorded on the distro) are
   * queried on their own host.
   */
  getTokenUsage(query: TokenUsageQuery): Promise<TokenUsageAggregate>;
  getTokenUsageTurns(query: TokenUsageTurnsQuery): Promise<TurnUsageRecord[]>;

  // --- MCP (external servers a member connects to; by session id) ---------
  listSessionMcpServers(sessionId: string): Promise<McpServerSnapshot>;
  reconnectSessionMcpServer(sessionId: string, server: string): Promise<void>;
  setSessionMcpServerEnabled(sessionId: string, server: string, enabled: boolean): Promise<void>;
  authenticateSessionMcpServer(sessionId: string, server: string): Promise<McpAuthResult>;

  // --- QA (test-only, workspace-scoped) ----------------------------------
  qaSeed(input: { party?: string; members?: QaMemberSpec[] }): Promise<{ created: string[]; listing: PartyListing }>;
  qaCreateMockMember(spec: QaMemberSpec): Promise<{ sessionId?: string; listing: PartyListing }>;
  qaEmit(name: string, body: QaEmitInput): Promise<void>;
  /** Injects a named subagent scenario (mock-driven subagent-UI design/QA). */
  qaEmitSubagents(name: string, scenario: string): Promise<{ scenario: string; count: number }>;
  /** Mocks an interactive prompt (e.g. AskUserQuestion) into a mock member. */
  qaInteraction(name: string, body: QaInteractionInput): Promise<{ requestId: string }>;
  /**
   * Builds the card design gallery — one MOCK member per transcript-card case.
   * Nothing in it reaches a harness, so the cards can be looked at without a
   * model turn (or a command being run to produce an approval).
   */
  qaDesignGallery(): Promise<{ party: string; members: string[] }>;
  qaReset(): Promise<PartyListing>;
}
