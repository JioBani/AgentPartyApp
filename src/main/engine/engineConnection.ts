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

export interface EngineConnection {
  readonly workspacePath: string;

  // --- Party (workspace-scoped) ------------------------------------------
  listParty(): PartyListing;
  createParty(input: CreatePartyInput): ReturnType<PartyApplicationService["createParty"]>;
  selectParty(partyId: string): ReturnType<PartyApplicationService["selectParty"]>;
  createMember(input: CreateMemberInput): ReturnType<PartyApplicationService["createMember"]>;
  sendPartyMessage(name: string, content: string, from?: string): PartyMutationResult;
  closeMember(name: string): ReturnType<PartyApplicationService["closeMember"]>;
  resumeMember(name: string): ReturnType<PartyApplicationService["resumeMember"]>;
  openMember(name: string): ReturnType<PartyApplicationService["openMember"]>;
  startMember(name: string, input?: StartPartyMemberInput): ReturnType<PartyApplicationService["startMember"]>;
  bindMember(name: string, sessionId: string): ReturnType<PartyApplicationService["bindMember"]>;
  removeMember(name: string): ReturnType<PartyApplicationService["removeMember"]>;
  /** Dispatches one of the named party actions (HTTP `/api/party/members/:name/:action`). */
  partyAction(name: string, action: string, body: any): PartyMutationResult;

  // --- Sessions (workspace-scoped) ---------------------------------------
  createSession(input?: CreateSessionInput | string): SessionView;
  listResumableSessions(): Promise<{ sessions: ResumableSessionInfo[]; error?: string }>;
  resumeSession(sessionId: string): SessionView;
  listWorkspaceSessions(): SessionView[];

  // --- QA (test-only, workspace-scoped) ----------------------------------
  qaSeed(input: { party?: string; members?: QaMemberSpec[] }): { created: string[]; listing: PartyListing };
  qaCreateMockMember(spec: QaMemberSpec): { sessionId?: string; listing: PartyListing };
  qaEmit(name: string, body: QaEmitInput): void;
  qaReset(): PartyListing;
}

/**
 * The same surface as {@link EngineConnection} with every method returning a
 * Promise — the shape a caller sees when the engine is across a transport
 * (a WSL distro). Derived from `EngineConnection` so there is one source of
 * truth: `RemoteEngineClient` implements this, and an over-the-wire server
 * dispatches to a (synchronous) `LocalEngine`. See docs/WSL_REMOTE.md §7.
 */
export type AsyncEngineConnection = {
  [K in keyof EngineConnection]: EngineConnection[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : EngineConnection[K];
};
