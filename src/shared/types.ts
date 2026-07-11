import type { ClaudeSessionSnapshot } from "../core/events";
import type { CodexModelDiscoveryState } from "./codexModels";
import type { CodexPolicy } from "./codexPolicy";

export const PERMISSION_MODE_SETTINGS = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;
export type PermissionModeSetting = (typeof PERMISSION_MODE_SETTINGS)[number];
export function isPermissionModeSetting(value: unknown): value is PermissionModeSetting {
  return typeof value === "string" && (PERMISSION_MODE_SETTINGS as readonly string[]).includes(value);
}
export type EffortSetting = "low" | "medium" | "high" | "xhigh" | "max";
export type HarnessId = "claude-code" | "codex";
export type ProviderId = "anthropic" | "openrouter" | "openai" | "custom";

/**
 * The per-harness member-creation defaults. Each harness owns its own default
 * model/effort/reasoning and its harness-appropriate permission config
 * (single-mode `permissionMode` for Claude Code, two-axis `codexPolicy` for
 * Codex). This is the single source of truth for "what a new member of harness
 * X starts as" — adding a new harness is just a new entry in
 * {@link AppSettings.harnessDefaults}. See {@link harnessDefaultsOf}.
 */
export interface HarnessDefaults {
  model: string;
  effort: EffortSetting;
  /** Reasoning/thinking mode (adaptive | enabled | disabled). */
  reasoning?: string;
  reasoningBudget?: number;
  /** Single-mode permission (Claude Code and similar harnesses). */
  permissionMode?: PermissionModeSetting;
  /** Two-axis safety model (Codex and similar harnesses). */
  codexPolicy?: CodexPolicy;
}

/**
 * A resolved creation profile for one harness, derived from
 * {@link AppSettings.harnessDefaults}. `main` is created from the default
 * harness's profile and the member wizard is prefilled per selected harness —
 * so a member is creatable with just "next, next, next".
 */
export interface DefaultMemberProfile extends HarnessDefaults {
  harness: HarnessId;
}

export interface AppSettings {
  workspacePath: string;
  /** Claude Code executable override (Claude-harness infrastructure). */
  claudeExecutablePath: string;
  claudeSafeMode: boolean;
  /** The harness a brand-new member defaults to. */
  selectedHarnessId: HarnessId;
  /** Per-harness member-creation defaults — the single source of truth. */
  harnessDefaults: Record<HarnessId, HarnessDefaults>;
  debugEnabled: boolean;
  routerBaseUrl: string;
  routerAuthToken: string;
  openRouterApiKey: string;
  automationApiPort: number;
  /** Transcript text zoom (Ctrl+wheel over a session view). 1 = 100%; clamped 0.6–2.0. */
  transcriptFontScale: number;
}

/** All harnesses that have defaults, in a stable order. */
export const HARNESS_IDS: HarnessId[] = ["claude-code", "codex"];

/** The creation defaults for one harness (falls back to the default harness). */
export function harnessDefaultsOf(settings: AppSettings, harnessId?: HarnessId): HarnessDefaults {
  const id = harnessId || settings.selectedHarnessId;
  return settings.harnessDefaults[id] || settings.harnessDefaults[settings.selectedHarnessId];
}

/** Derives the member-creation default profile for a harness (default harness if omitted). */
export function defaultMemberProfileOf(settings: AppSettings, harnessId?: HarnessId): DefaultMemberProfile {
  const id = harnessId || settings.selectedHarnessId;
  return { harness: id, ...harnessDefaultsOf(settings, id) };
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
  /**
   * The harness's own resumable thread id (Claude SDK session / Codex thread),
   * distinct from the transient app `sessionId`. Persisted so reopening the
   * member — or reopening the app — resumes that thread and keeps model context.
   */
  harnessSessionId?: string;
  model?: string;
  effort?: string;
  /** Reasoning/thinking mode (adaptive | enabled | disabled); persisted for resume. */
  reasoning?: string;
  /** Thinking token budget when applicable. */
  reasoningBudget?: number;
  permissionMode?: PermissionModeSetting;
  /** Codex two-axis safety model (sandbox × approval + guardian); Codex members only. */
  codexPolicy?: CodexPolicy;
  /**
   * Context-window occupancy (tokens) captured from the member's last live turn,
   * persisted so a reopened member — or a reopened app — shows its context meter
   * IMMEDIATELY, before any new turn re-reports usage. Restored, never invented;
   * the meter marks it "last known" until a live session refreshes it. Paired
   * with {@link lastContextWindow} to drive the ratio.
   */
  lastContextTokens?: number;
  /** The model's window size (tokens) captured alongside {@link lastContextTokens}. */
  lastContextWindow?: number;
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
  effort?: EffortSetting;
  permissionMode?: PermissionModeSetting;
  selectedProviderId?: ProviderId;
  /**
   * Opportunistic start (renderer prewarm on panel open) — must NOT resurrect a
   * member that is closed by the time it executes. A deliberate start/resume
   * omits this and reopens a closed member as always.
   */
  auto?: boolean;
}

export interface SessionView {
  id: string;
  title: string;
  workspace: string;
  snapshot: ClaudeSessionSnapshot;
}

export interface CreateSessionInput {
  workspacePath?: string;
  selectedHarnessId?: HarnessId;
  selectedProviderId?: ProviderId;
  model?: string;
  effort?: EffortSetting;
  /** Thinking mode (adaptive | enabled | disabled); falls back to the model's catalog default. */
  thinking?: string;
  thinkingBudget?: number;
  permissionMode?: PermissionModeSetting;
  /** Codex two-axis safety model; used only when the harness is Codex. */
  codexPolicy?: CodexPolicy;
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
  /** Live Codex account-catalog discovery state (pending/ready/error). */
  codexModels?: CodexModelDiscoveryState;
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
