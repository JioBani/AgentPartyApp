import type {
  CreateMemberInput,
  CreatePartyInput,
  CreateSessionInput,
  ResumableSessionInfo,
  SessionView,
  StartPartyMemberInput,
} from "../../shared/types";
import type { HarnessCommand } from "../../core/events";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import type { CodexPolicy } from "../../shared/codexPolicy";
import type { ImageAttachment } from "../../shared/attachments";
import type { McpAuthResult, McpServerSnapshot } from "../../shared/mcp";
import type { PartyApplicationService } from "../application/partyApplicationService";

/**
 * The engine surface — everything addressed by **workspace**. For a local
 * workspace this is served in-process (`LocalEngine`); for a WSL workspace it
 * will be served by an engine running inside the distro, reached over RPC
 * (`RemoteEngineClient`, later stages). See docs/WSL_REMOTE.md §6.
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
  options: QaQuestionOption[];
}

/**
 * Drives a model-style interaction (e.g. an AskUserQuestion prompt) into a mock
 * member without a real model, so the interactive UI can be exercised over the
 * automation API. Extend the `type` union as more interactions are mocked.
 */
export interface QaInteractionInput {
  type: "askUserQuestion";
  requestId?: string;
  questions?: QaQuestion[];
}

/**
 * Every method is async: the engine may be in another host (a WSL distro)
 * reached over a transport, and a remote boundary cannot be synchronous. The
 * in-process {@link LocalEngine} satisfies it by wrapping its synchronous work
 * in promises; `RemoteEngineClient` satisfies it over the wire. See
 * docs/WSL_REMOTE.md §6/§7.
 */
export interface EngineConnection {
  readonly workspacePath: string;

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
  /** User turn to a member (auto-starts its session); the shared UI+API send path. */
  sendUserMessage(name: string, text: string, attachments?: ImageAttachment[], partyId?: string): Promise<ReturnType<PartyApplicationService["sendUserMessage"]>>;
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
  /** The member's persisted transcript (assembled UI blocks), restored on load. */
  getMemberTranscript(name: string, partyId?: string): Promise<ReturnType<PartyApplicationService["getMemberTranscript"]>>;
  /** Persists the member's transcript (renderer-driven, debounced) + captures its resumable thread id. */
  saveMemberTranscript(name: string, blocks: unknown[], partyId?: string): Promise<void>;

  // --- Models (engine-scoped) ----------------------------------------------
  /**
   * Snapshot of the Codex account catalog discovered from the engine host's
   * `codex app-server` (`model/list`). `refresh` re-runs discovery and awaits
   * the fresh settle; otherwise the current snapshot returns immediately
   * (kicking a background discovery on first call).
   */
  listCodexModels(refresh?: boolean): Promise<CodexModelDiscoveryState>;

  // --- Sessions (workspace-scoped) ---------------------------------------
  createSession(input?: CreateSessionInput | string): Promise<SessionView>;
  listResumableSessions(): Promise<{ sessions: ResumableSessionInfo[]; error?: string }>;
  resumeSession(sessionId: string): Promise<SessionView>;
  listWorkspaceSessions(): Promise<SessionView[]>;

  // --- Session control (by id, within this engine's workspace) -----------
  sendUserTurn(sessionId: string, text: string, attachments?: ImageAttachment[]): Promise<void>;
  interruptSession(sessionId: string): Promise<void>;
  restartSession(sessionId: string): Promise<void>;
  compactSession(sessionId: string): Promise<void>;
  setSessionModel(sessionId: string, model: string, providerId?: string, runtimeModel?: string): Promise<void>;
  setSessionEffort(sessionId: string, effort: string): Promise<void>;
  setSessionThinking(sessionId: string, mode: string, budget?: number): Promise<void>;
  setSessionPermissionMode(sessionId: string, permissionMode: string): Promise<void>;
  setSessionCodexPolicy(sessionId: string, policy: CodexPolicy): Promise<void>;
  approveSession(sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): Promise<void>;
  closeSession(sessionId: string): Promise<boolean>;

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
  qaReset(): Promise<PartyListing>;
}
