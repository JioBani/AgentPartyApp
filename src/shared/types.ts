import type { ClaudeSessionSnapshot } from "../core/events";

export type PermissionModeSetting = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

export interface AppSettings {
  workspacePath: string;
  claudeExecutablePath: string;
  selectedHarnessId: "claude-code" | "codex";
  selectedProviderId: "anthropic" | "openrouter" | "openai" | "custom";
  claudeModel: string;
  claudeEffort: "low" | "medium" | "high" | "xhigh" | "max";
  claudePermissionMode: PermissionModeSetting;
  claudeSafeMode: boolean;
  debugEnabled: boolean;
  routerBaseUrl: string;
  routerAuthToken: string;
  openRouterApiKey: string;
  automationApiPort: number;
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
  permissionMode?: AppSettings["claudePermissionMode"];
}

export interface WindowInfo {
  id: string;
  workspacePath: string;
  focused: boolean;
}

export interface InitialAppState {
  ok: true;
  settings: AppSettings;
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
