import type { ClaudeSessionSnapshot } from "../core/events";

export type PermissionModeSetting = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

/**
 * The default creation profile, *derived* from the single runtime defaults (see
 * {@link defaultMemberProfileOf}). `main` is created from it and the member
 * wizard is prefilled from it — so a member is creatable with just
 * "next, next, next". Not stored separately: the one source of truth is the
 * runtime defaults on AppSettings.
 */
export interface DefaultMemberProfile {
  harness: "claude-code" | "codex";
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Reasoning/thinking mode (adaptive | enabled | disabled). */
  reasoning?: string;
  reasoningBudget?: number;
  permissionMode: PermissionModeSetting;
}

export interface AppSettings {
  workspacePath: string;
  claudeExecutablePath: string;
  selectedHarnessId: "claude-code" | "codex";
  selectedProviderId: "anthropic" | "openrouter" | "openai" | "custom";
  claudeModel: string;
  claudeEffort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Default reasoning/thinking mode for new members (adaptive | enabled | disabled). */
  claudeReasoning?: string;
  claudeReasoningBudget?: number;
  claudePermissionMode: PermissionModeSetting;
  claudeSafeMode: boolean;
  debugEnabled: boolean;
  routerBaseUrl: string;
  routerAuthToken: string;
  openRouterApiKey: string;
  automationApiPort: number;
}

/** Derives the single member-creation default from the runtime defaults. */
export function defaultMemberProfileOf(settings: AppSettings): DefaultMemberProfile {
  return {
    harness: settings.selectedHarnessId,
    model: settings.claudeModel,
    effort: settings.claudeEffort,
    reasoning: settings.claudeReasoning,
    reasoningBudget: settings.claudeReasoningBudget,
    permissionMode: settings.claudePermissionMode,
  };
}

export interface AuthProviderState {
  id: string;
  label: string;
  kind: "subscription" | "apiKey";
  status: "available" | "configured" | "missing" | "valid" | "invalid" | "network_error";
  description: string;
  source?: string;
  maskedValue?: string;
  detail?: string;
}

export interface PartyMember {
  partyId?: string;
  name: string;
  status: "idle" | "opened" | "running" | "closed" | "missing_session";
  runtime?: "codex" | "claude" | "claude-code";
  role?: string;
  sessionId?: string;
  model?: string;
  effort?: string;
  /** Reasoning/thinking mode (adaptive | enabled | disabled); persisted for resume. */
  reasoning?: string;
  /** Thinking token budget when applicable. */
  reasoningBudget?: number;
  permissionMode?: PermissionModeSetting;
  createdAt?: string;
  updatedAt?: string;
}

export interface PartyDefinition {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface PartyMessage {
  partyId?: string;
  id: string;
  from: string;
  to: string;
  content: string;
  createdAt: string;
  delivered: boolean;
  targetSessionId?: string;
  error?: string;
}

export interface PartyCommandResult {
  ok: boolean;
  message: string;
  parties?: PartyDefinition[];
  currentPartyId?: string;
  members?: PartyMember[];
  messages?: PartyMessage[];
  member?: PartyMember;
  partyMessage?: PartyMessage;
  session?: SessionView;
}

export interface CreatePartyInput {
  name: string;
}

export interface CreateMemberInput {
  partyId?: string;
  name: string;
  requirement: string;
  role?: string;
  initialTask?: string;
  runtime?: "codex" | "claude" | "claude-code";
  model?: string;
  effort?: string;
  reasoning?: string;
  reasoningBudget?: number;
  permissionMode?: PermissionModeSetting;
}

export interface StartPartyMemberInput {
  model?: string;
  effort?: AppSettings["claudeEffort"];
  permissionMode?: AppSettings["claudePermissionMode"];
  selectedProviderId?: AppSettings["selectedProviderId"];
}

export interface SessionView {
  id: string;
  title: string;
  workspace: string;
  snapshot: ClaudeSessionSnapshot;
}

export interface CreateSessionInput {
  workspacePath?: string;
  selectedHarnessId?: AppSettings["selectedHarnessId"];
  selectedProviderId?: AppSettings["selectedProviderId"];
  model?: string;
  effort?: AppSettings["claudeEffort"];
  /** Thinking mode (adaptive | enabled | disabled); falls back to the model's catalog default. */
  thinking?: string;
  thinkingBudget?: number;
  permissionMode?: AppSettings["claudePermissionMode"];
}

export interface WindowInfo {
  id: string;
  workspacePath: string;
  focused: boolean;
}

/** The targeted window's workspace, parsed for display (badge + host-native path). */
export interface WorkspaceDisplay {
  /** Serialized location: a raw path for local, `wsl+<distro>:/path` for WSL. */
  uri: string;
  kind: "local" | "wsl";
  distro?: string;
  /** Host-native path (a Linux path for WSL). */
  path: string;
}

export interface InitialAppState {
  ok: true;
  settings: AppSettings;
  workspace?: WorkspaceDisplay;
  auth: AuthProviderState[];
  sessions: SessionView[];
  modelRoutes: unknown[];
  harnesses: unknown[];
  router: { baseUrl: string };
  automationApi?: { baseUrl: string; spec: string };
  logs?: { logFilePath: string };
  party: { parties?: PartyDefinition[]; currentPartyId?: string; members: PartyMember[]; messages?: PartyMessage[]; error?: string };
  windows?: WindowInfo[];
  resumableSessions?: ResumableSessionInfo[];
  resumableSessionsError?: string;
}

export interface ResumableSessionInfo {
  sessionId: string;
  customTitle?: string;
  summary?: string;
  firstPrompt?: string;
  lastModified?: string;
  gitBranch?: string;
}
