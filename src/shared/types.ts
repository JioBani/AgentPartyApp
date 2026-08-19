import type { ClaudeSessionSnapshot } from "../core/events";
import type { CodexModelDiscoveryState } from "./codexModels";
import type { CodexPolicy } from "./codexPolicy";
import type { CursorPolicy } from "./cursorPolicy";
import type { AutoCompactSetting } from "./autoCompact";
import type { IdleSleepSettings } from "./idleSleep";
import type { ModelProviderDescriptor } from "./modelProviders";
import type { GateReviewer, MemberGateOverride, PartyGate } from "./messageGate";
import type { MemberQueueState } from "./messageQueue";
import type { MemberStatus } from "./memberDisplayStatus";
import type { PendingApproval } from "./approvals";
import type { DiscordBridgeSettings } from "./discordBridge";
import type { MobileSettings } from "./mobileProtocol";
import type { ComposerSettings } from "./composerSettings";
import type { FontSettings } from "./appFonts";
import type { FavoriteModels } from "./favoriteModels";
import type { MemberMessagingSettings } from "./memberMessaging";
import type { PartyPrimerSettings } from "./partyPrimer";
import type { AppLocale } from "./appLocale";

export const PERMISSION_MODE_SETTINGS = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;
export type PermissionModeSetting = (typeof PERMISSION_MODE_SETTINGS)[number];
export function isPermissionModeSetting(value: unknown): value is PermissionModeSetting {
  return typeof value === "string" && (PERMISSION_MODE_SETTINGS as readonly string[]).includes(value);
}
export type EffortSetting = "low" | "medium" | "high" | "xhigh" | "max";
export type HarnessId = "claude-code" | "codex" | "cursor" | "grok";
export type ProviderId = "anthropic" | "openrouter" | "openai" | "cursor" | "custom";

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
  /** Provider serving tier such as Cursor Grok `standard` or `fast`. */
  serviceTier?: string;
  /** Single-mode permission (Claude Code and similar harnesses). */
  permissionMode?: PermissionModeSetting;
  /** Two-axis safety model (Codex and similar harnesses). */
  codexPolicy?: CodexPolicy;
  /** Cursor's agent mode and approval mode. */
  cursorPolicy?: CursorPolicy;
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
  /** Language used by every user-facing app surface. */
  locale: AppLocale;
  workspacePath: string;
  /** Claude Code executable override (Claude-harness infrastructure). */
  claudeExecutablePath: string;
  /** Cursor Agent executable/bundle override. Empty = auto-discover official install. */
  cursorExecutablePath: string;
  /** Optional override for the official `grok` binary; resolved automatically when empty. */
  grokExecutablePath?: string;
  /** Optional override for the `codex` binary; empty = PATH lookup (a `.cmd` shim on Windows). */
  codexExecutablePath?: string;
  claudeSafeMode: boolean;
  /** The harness a brand-new member defaults to. */
  selectedHarnessId: HarnessId;
  /** Per-harness member-creation defaults — the single source of truth. */
  harnessDefaults: Record<HarnessId, HarnessDefaults>;
  debugEnabled: boolean;
  routerBaseUrl: string;
  routerAuthToken: string;
  openRouterApiKey: string;
  /** DeepSeek official API key (DEEPSEEK_API_KEY). Used by provider "deepseek" models. */
  deepseekApiKey: string;
  automationApiPort: number;
  /** Transcript text zoom (Ctrl+wheel over a session view). 1 = 100%; clamped 0.6–2.0. */
  transcriptFontScale: number;
  /**
   * The UI and code fonts, as catalog ids. Applied by writing the selected
   * stacks into `--font-sans` / `--font-mono`, which every surface already
   * reads. Edited in Settings → Runtime. See `shared/appFonts.ts`.
   */
  fonts: FontSettings;
  /**
   * Global auto-compaction default inherited by any member without its own
   * {@link PartyMember.autoCompact}. Edited in Settings → Runtime. See
   * `shared/autoCompact.ts`.
   */
  compactDefault: AutoCompactSetting;
  /**
   * When to release a quiet member's harness process to reclaim its memory. A
   * member with {@link PartyMember.keepAwake} opts out. See `shared/idleSleep.ts`.
   */
  idleSleep: IdleSleepSettings;
  /**
   * Default headless reviewer (model + effort, NO harness) for the Message Gate.
   * Used by any gate-on member that has not set its own reviewer. Edited in
   * Settings → Runtime. See `shared/messageGate.ts` / the Message Gate design.
   */
  gateDefaults: GateReviewer;
  /**
   * Message input preferences (send key, interrupt-on-send). Edited in
   * Settings → Runtime. See `shared/composerSettings.ts`.
   */
  composer: ComposerSettings;
  /** Default routing for member-to-member sends that omit `interrupt`. */
  memberMessaging: MemberMessagingSettings;
  /**
   * Catalog model ids the user has starred, pinned above the provider groups in
   * the model catalog. A user choice, so it lives here rather than in the
   * regenerated catalog file. Never auto-pruned — `shared/favoriteModels.ts`
   * explains why an unresolvable id is kept instead of dropped.
   */
  favoriteModels: FavoriteModels;
  /**
   * Discord bridge credentials and inbound whitelist. Edited in Settings →
   * Discord; the token is masked when read back. See `shared/discordBridge.ts`.
   */
  discord?: DiscordBridgeSettings;
  /**
   * Mobile link: master switch, signaling/push server URLs, and the name this
   * desktop shows on a paired phone. Edited in Settings → 모바일 연결. See
   * `shared/mobileProtocol.ts`.
   */
  mobile?: MobileSettings;
  /**
   * Per-section edits of the party-member primer — the system prompt every member
   * session starts with. Absent = the built-in text for every section. Edited in
   * Settings → 런타임 → 파티 프롬프트. See `shared/partyPrimer.ts`.
   */
  partyPrimer?: PartyPrimerSettings;
}

/** All harnesses that have defaults, in a stable order. */
export const HARNESS_IDS: HarnessId[] = ["claude-code", "codex", "cursor", "grok"];

/**
 * What a member's `runtime` field may say. `claude` is the legacy spelling of
 * `claude-code` kept for parties written before the rename.
 */
export type MemberRuntime = "codex" | "claude" | "claude-code" | "cursor" | "grok";

/**
 * The harness that runs a given member runtime.
 *
 * This lookup exists because the mapping used to be a hand-written
 * `runtime === "codex" ? … : runtime === "cursor" ? … : "claude-code"` ternary
 * repeated across the renderer and the main process. When the Grok Build
 * harness was added, every one of those copies kept falling through to
 * `claude-code`, so a Grok member was shown Claude Code's model catalog and
 * started with Claude Code's defaults. `satisfies Record<MemberRuntime, …>`
 * turns the next such omission into a compile error instead.
 */
const HARNESS_BY_RUNTIME = {
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  claude: "claude-code",
  "claude-code": "claude-code",
} as const satisfies Record<MemberRuntime, HarnessId>;

/** The harness for a member's runtime; defaults to Claude Code when unset. */
export function harnessForRuntime(runtime: MemberRuntime | undefined): HarnessId {
  return runtime ? HARNESS_BY_RUNTIME[runtime] : "claude-code";
}

/** What each harness is called in the UI. Exhaustive for the same reason. */
export const HARNESS_LABELS = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor CLI",
  grok: "Grok Build",
} as const satisfies Record<HarnessId, string>;

export function harnessLabel(harnessId: HarnessId): string {
  return HARNESS_LABELS[harnessId];
}

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
  status: "available" | "configured" | "missing" | "pending" | "valid" | "invalid" | "network_error";
  description: string;
  source?: string;
  maskedValue?: string;
  detail?: string;
  /**
   * The pending OAuth URL, while a subscription login is waiting on the browser.
   * The bridge opens the SYSTEM DEFAULT browser, so this is what lets a user
   * finish the flow in a different browser or profile instead of being stuck at
   * "인증 대기 중" with nothing to click.
   */
  authUrl?: string;
  /** Optional action rendered by Authentication and exposed over automation. */
  action?: {
    type: "subscriptionOAuth";
    provider: "codex" | "claude";
    label: string;
  };
}

export interface PartyMember {
  partyId?: string;
  name: string;
  /**
   * `sleeping` is the app's own doing, and that is what separates it from every
   * other non-running value: the member was idle long enough that its harness
   * process was released to reclaim memory, while the conversation itself is
   * intact behind {@link harnessSessionId}. It is therefore MESSAGEABLE — a send
   * wakes it — which `closed` (an explicit "do not wake me") is not, and which
   * `missing_session` (something died unexpectedly) cannot promise.
   */
  status: "idle" | "opened" | "running" | "closed" | "missing_session" | "sleeping" | "external_cli";
  /**
   * The status the member LIST shows, derived from {@link status} plus the live
   * session (`shared/memberDisplayStatus`). View-only: attached on read and
   * never persisted, so it is absent from anything loaded off disk.
   *
   * Present so a client without a transcript — a paired phone — is told the
   * answer rather than guessing at `approval` and `stalled`.
   */
  displayStatus?: MemberStatus;
  runtime?: MemberRuntime;
  role?: string;
  sessionId?: string;
  /**
   * Identity of the engine process boot that owns `sessionId` (a per-process
   * `boot-<pid>-<nonce>` stamp). An app session id is only meaningful inside
   * the process that created it, but the party store is shared on disk — after
   * a quit/crash (or from a sibling process on the same cwd) the persisted
   * `sessionId` used to read as a live binding forever ("tab open but session
   * closed"). On load, a binding whose owner boot is gone is cleared instead
   * of being reported as missing_session.
   */
  sessionBootId?: string;
  /**
   * The harness's own resumable thread id (Claude SDK session / Codex thread),
   * distinct from the transient app `sessionId`. Persisted so reopening the
   * member — or reopening the app — resumes that thread and keeps model context.
   */
  harnessSessionId?: string;
  /**
   * The native conversation is temporarily owned by an interactive CLI.
   * Kept independently from `status` so closing the tab can remain an explicit
   * closed state without letting a message start a competing writer.
   */
  externalCli?: {
    handoffId: string;
    startedAt: string;
    host?: "local" | "wsl";
    distro?: string;
    terminalPid?: number;
  };
  model?: string;
  effort?: string;
  /** Reasoning/thinking mode (adaptive | enabled | disabled); persisted for resume. */
  reasoning?: string;
  /** Thinking token budget when applicable. */
  reasoningBudget?: number;
  /** Provider serving tier such as Cursor Grok `standard` or `fast`. */
  serviceTier?: string;
  permissionMode?: PermissionModeSetting;
  /** Codex two-axis safety model (sandbox × approval + guardian); Codex members only. */
  codexPolicy?: CodexPolicy;
  /** Cursor agent mode + approval mode; Cursor members only. */
  cursorPolicy?: CursorPolicy;
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
  /**
   * Per-member auto-compaction threshold. Undefined = inherit
   * {@link AppSettings.compactDefault}. When on, the session auto-compacts once
   * context crosses `at`% of the window. See `shared/autoCompact.ts`.
   */
  autoCompact?: AutoCompactSetting;
  /** Per-sender interrupt default. Undefined inherits AppSettings.memberMessaging. */
  outboundInterrupt?: boolean;
  /**
   * Never release this member's harness process, however long it stays quiet.
   * For a member doing work the app cannot see — watching something, waiting on
   * an external event — where a wake-up would not restore what was lost.
   * Undefined = follow {@link AppSettings.idleSleep}.
   */
  keepAwake?: boolean;
  /**
   * When the app released this member's process (ISO). Set with
   * `status: "sleeping"`, cleared on wake — so the UI can say how long it has
   * been asleep instead of only that it is.
   */
  sleptAt?: string;
  /**
   * Per-member Message Gate override. Undefined = fully inherit the party gate
   * ({@link PartyDefinition.gate}) + settings reviewer default. See
   * `shared/messageGate.ts`.
   */
  gate?: MemberGateOverride;
  /**
   * Messages addressed to this member that it has NOT been handed yet, because
   * it was busy when they arrived. Owned by the app rather than the harness so
   * they can be shown, cancelled and edited before delivery; see
   * `shared/messageQueue.ts`. Persisted, so a queue survives a restart instead
   * of evaporating with the process.
   */
  queue?: MemberQueueState;
  createdAt?: string;
  updatedAt?: string;
}

export interface PartyDefinition {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Party-wide Message Gate default (enablement + rule text). Undefined = off
   * with no rule. Members inherit this unless they override. See
   * `shared/messageGate.ts`.
   */
  gate?: PartyGate;
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
  /**
   * True when the message was parked in the member's queue instead of being
   * delivered, because the member was busy. The caller MUST distinguish the two:
   * the renderer echoes a delivered message into the transcript, but a queued one
   * belongs in the queue list until it is actually handed over. See
   * `shared/messageQueue.ts`.
   */
  queued?: boolean;
  /**
   * Id of the row this send parked, set whenever {@link queued} is true.
   *
   * The caller must never re-derive it from {@link queue}: an interrupt / "지금
   * 바로 처리" send parks at the FRONT, so "the last item" is somebody else's
   * waiting message — Ctrl+Enter used to pick that one and send it instead,
   * leaving the message the user just typed sitting in the queue.
   */
  queuedItemId?: string;
  /** Queue snapshot after the command, so a queue mutation needs no follow-up read. */
  queue?: MemberQueueState;
}

export interface CreatePartyInput {
  name: string;
  /** Optional initial Message Gate for the new party (default: off, no rule). */
  gate?: PartyGate;
}

export interface CreateMemberInput {
  partyId?: string;
  name: string;
  requirement: string;
  role?: string;
  initialTask?: string;
  runtime?: MemberRuntime;
  model?: string;
  effort?: string;
  reasoning?: string;
  reasoningBudget?: number;
  serviceTier?: string;
  permissionMode?: PermissionModeSetting;
  /** Explicit initial Codex safety policy for members using the Codex harness. */
  codexPolicy?: CodexPolicy;
  cursorPolicy?: CursorPolicy;
}

export interface StartPartyMemberInput {
  selectedHarnessId?: HarnessId;
  model?: string;
  effort?: EffortSetting;
  thinking?: string;
  thinkingBudget?: number;
  serviceTier?: string;
  permissionMode?: PermissionModeSetting;
  /** Explicit Codex safety policy for members using the Codex harness. */
  codexPolicy?: CodexPolicy;
  cursorPolicy?: CursorPolicy;
  selectedProviderId?: ProviderId;
  /**
   * Opportunistic start (renderer prewarm on panel open) — must NOT resurrect a
   * member that is closed by the time it executes. A deliberate start/resume
   * omits this and reopens a closed member as always.
   */
  auto?: boolean;
}

/** Party-member permission mutation used by UI, HTTP, and member tools. */
export interface MemberPermissionInput {
  permissionMode?: PermissionModeSetting;
  codexPolicy?: CodexPolicy;
  cursorPolicy?: CursorPolicy;
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
  serviceTier?: string;
  permissionMode?: PermissionModeSetting;
  /** Codex two-axis safety model; used only when the harness is Codex. */
  codexPolicy?: CodexPolicy;
  cursorPolicy?: CursorPolicy;
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
  /** Provider groups used to partition modelRoutes in Workbench. */
  modelProviders: ModelProviderDescriptor[];
  /** Live Codex account-catalog discovery state (pending/ready/error). */
  codexModels?: CodexModelDiscoveryState;
  harnesses: unknown[];
  router: { baseUrl: string };
  automationApi?: { baseUrl: string; spec: string };
  logs?: { logFilePath: string };
  /**
   * Where the RUNNING code was loaded from (the compiled main directory),
   * derived from the running module's own location.
   *
   * Deliberately distinct from every other path in this payload:
   * `settings.workspacePath` and `logs.logFilePath` are values a caller handed
   * in, so a test asserting on them is asserting on its own input. This is the
   * app stating a fact about itself, which is what lets an e2e prove it is
   * driving the build it just produced rather than another checkout's — the
   * failure that made parallel worktrees silently test the wrong code.
   */
  runtime?: { appRoot: string };
  party: { parties?: PartyDefinition[]; currentPartyId?: string; members: PartyMember[]; messages?: PartyMessage[]; error?: string };
  windows?: WindowInfo[];
  /**
   * Approvals still waiting on an answer in this workspace.
   *
   * Present so a phone whose `resume` fell outside the event ring buffer gets
   * them back with the snapshot rather than having to know to ask. Absent — not
   * empty — from a process that keeps no approval index, because an empty list
   * would assert that nothing is waiting.
   */
  pendingApprovals?: PendingApproval[];
  resumableSessions?: ResumableSessionInfo[];
  resumableSessionsError?: string;
  /** §8 first-install offer. Absent on the guide stage (never offer there). */
  guideOffer?: { pending: boolean; shown: boolean };
}

export interface ResumableSessionInfo {
  sessionId: string;
  customTitle?: string;
  summary?: string;
  firstPrompt?: string;
  lastModified?: string;
  gitBranch?: string;
}

/**
 * A member-transcript persist request.
 *
 * The renderer re-derives a member's whole transcript on every event, but the
 * blocks it already persisted are unchanged — so shipping the full array each
 * time pushed tens of MB per save through the engine RPC pipe (a single stdio
 * channel shared with `sendUserTurn`, which then waited behind it: a user turn
 * measured 33 s late). `afterId` turns the save into an append.
 */
export interface TranscriptSave {
  /**
   * When set, `blocks` REPLACE everything stored after the block with this id —
   * the renderer's last known-persisted block. When absent, `blocks` replace the
   * whole transcript (a full save).
   */
  afterId?: string;
  blocks: unknown[];
}

/**
 * Outcome of a {@link TranscriptSave}. An append whose `afterId` is not in the
 * stored transcript CANNOT be applied (the two sides disagree about history);
 * `applied: false` tells the caller to resend in full rather than let the two
 * silently diverge.
 */
export interface TranscriptSaveResult {
  applied: boolean;
  reason?: string;
}
