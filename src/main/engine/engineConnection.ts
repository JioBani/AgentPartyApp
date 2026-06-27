import type {
  CreateMemberInput,
  CreatePartyInput,
  CreateSessionInput,
  ResumableSessionInfo,
  SessionView,
  StartPartyMemberInput,
} from "../../shared/types";
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
}

export interface QaEmitInput {
  events?: unknown[];
  status?: "working" | "idle" | "approval";
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

  // --- Party (workspace-scoped) ------------------------------------------
  listParty(): Promise<PartyListing>;
  createParty(input: CreatePartyInput): Promise<ReturnType<PartyApplicationService["createParty"]>>;
  selectParty(partyId: string): Promise<ReturnType<PartyApplicationService["selectParty"]>>;
  createMember(input: CreateMemberInput): Promise<ReturnType<PartyApplicationService["createMember"]>>;
  sendPartyMessage(name: string, content: string, from?: string): Promise<PartyMutationResult>;
  closeMember(name: string): Promise<ReturnType<PartyApplicationService["closeMember"]>>;
  resumeMember(name: string): Promise<ReturnType<PartyApplicationService["resumeMember"]>>;
  openMember(name: string): Promise<ReturnType<PartyApplicationService["openMember"]>>;
  startMember(name: string, input?: StartPartyMemberInput): Promise<ReturnType<PartyApplicationService["startMember"]>>;
  bindMember(name: string, sessionId: string): Promise<ReturnType<PartyApplicationService["bindMember"]>>;
  removeMember(name: string): Promise<ReturnType<PartyApplicationService["removeMember"]>>;
  /** Dispatches one of the named party actions (HTTP `/api/party/members/:name/:action`). */
  partyAction(name: string, action: string, body: any): Promise<PartyMutationResult>;

  // --- Sessions (workspace-scoped) ---------------------------------------
  createSession(input?: CreateSessionInput | string): Promise<SessionView>;
  listResumableSessions(): Promise<{ sessions: ResumableSessionInfo[]; error?: string }>;
  resumeSession(sessionId: string): Promise<SessionView>;
  listWorkspaceSessions(): Promise<SessionView[]>;

  // --- QA (test-only, workspace-scoped) ----------------------------------
  qaSeed(input: { party?: string; members?: QaMemberSpec[] }): Promise<{ created: string[]; listing: PartyListing }>;
  qaCreateMockMember(spec: QaMemberSpec): Promise<{ sessionId?: string; listing: PartyListing }>;
  qaEmit(name: string, body: QaEmitInput): Promise<void>;
  qaReset(): Promise<PartyListing>;
}
