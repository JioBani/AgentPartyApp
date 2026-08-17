/**
 * Shared fake world for the §2-5 journey. One party, three members, reused
 * across slides so the story does not keep renaming people.
 */
import { DEFAULT_COMPOSER_SETTINGS } from "../../shared/composerSettings";
import { DEFAULT_FONT_SETTINGS } from "../../shared/appFonts";
import { DEFAULT_IDLE_SLEEP } from "../../shared/idleSleep";
import { DEFAULT_MEMBER_MESSAGING_SETTINGS } from "../../shared/memberMessaging";
import { MODEL_PROVIDERS } from "../../shared/modelProviders";
import type { GuideSnapshot } from "../../shared/guide";
import type { InitialAppState, PartyMember, SessionView } from "../../shared/types";
import type { PartyGate } from "../../shared/messageGate";
import type { TranscriptBlock } from "../../shared/transcript";
import type { WorkbenchLayout } from "../../shared/workbenchLayout";
import type { ClaudeSessionSnapshot } from "../../core/events";


export const WORKSPACE = "C:\\Guide\\demo-workspace";
export const PARTY_ID = "guide-demo";
export const CREATED = "2026-08-01T00:00:00.000Z";

const MODEL_ROUTES = [
  { harnessId: "claude-code", providerId: "anthropic", model: "claude-sonnet-4.5", label: "claude-sonnet-4.5" },
  { harnessId: "claude-code", providerId: "anthropic", model: "claude-opus-4.1", label: "claude-opus-4.1" },
  { harnessId: "codex", providerId: "openai", model: "gpt-5.4", label: "gpt-5.4" },
];

function sessionSnapshot(input: {
  id: string;
  model: string;
  status: string;
  contextTokens?: number;
  pendingApprovalCount?: number;
}): ClaudeSessionSnapshot {
  return {
    id: input.id,
    cwd: WORKSPACE,
    model: input.model,
    effort: "medium",
    permissionMode: "default",
    status: input.status,
    harnessAlive: true,
    startedAt: CREATED,
    debugMode: false,
    turnCount: 1,
    queuedTurnCount: 0,
    pendingApprovalCount: input.pendingApprovalCount ?? 0,
    contextTokens: input.contextTokens,
    contextWindow: 200000,
  };
}

export function sessionView(id: string, model: string, status: string, contextTokens?: number, pendingApprovalCount?: number): SessionView {
  return {
    id,
    title: model,
    workspace: WORKSPACE,
    snapshot: sessionSnapshot({ id, model, status, contextTokens, pendingApprovalCount }),
  };
}

export function member(input: {
  name: string;
  status: PartyMember["status"];
  runtime: PartyMember["runtime"];
  role: string;
  model: string;
  sessionId?: string;
  lastContextTokens?: number;
}): PartyMember {
  return {
    partyId: PARTY_ID,
    name: input.name,
    status: input.status,
    runtime: input.runtime,
    role: input.role,
    model: input.model,
    sessionId: input.sessionId,
    lastContextTokens: input.lastContextTokens,
    lastContextWindow: input.lastContextTokens ? 200000 : undefined,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

export const MAIN = member({ name: "main", status: "idle", runtime: "claude-code", role: "진행", model: "claude-sonnet-4.5", sessionId: "s-main" });
export const REVIEWER = member({ name: "reviewer", status: "idle", runtime: "codex", role: "검토", model: "gpt-5.4", sessionId: "s-reviewer" });
export const IMPL = member({ name: "impl", status: "sleeping", runtime: "claude-code", role: "구현", model: "claude-sonnet-4.5", lastContextTokens: 42000 });

export function layout(panels: Array<{ id: string; tabs: string[]; active: string }>, focused: string): WorkbenchLayout {
  return {
    panels: panels.map((panel) => ({ ...panel, weight: 1 })),
    focusedPanelId: focused,
  };
}

export function partyOf(members: PartyMember[], gate?: PartyGate): InitialAppState["party"] {
  return {
    parties: [{ id: PARTY_ID, name: "가이드 데모", createdAt: CREATED, updatedAt: CREATED, gate }],
    currentPartyId: PARTY_ID,
    members,
    messages: [],
  };
}

export function baseState(party: InitialAppState["party"], sessions: SessionView[]): InitialAppState {
  return {
    ok: true,
    settings: {
      workspacePath: WORKSPACE,
      claudeExecutablePath: "",
      cursorExecutablePath: "",
      claudeSafeMode: false,
      selectedHarnessId: "claude-code",
      harnessDefaults: {
        "claude-code": { model: "claude-sonnet-4.5", effort: "medium", permissionMode: "default" },
        codex: { model: "gpt-5.4", effort: "medium", codexPolicy: { sandbox: "workspace-write", approval: "on-request", guardian: false } },
        cursor: { model: "Grok 4.5", effort: "high", cursorPolicy: { mode: "agent", approval: "allowlist" } },
        grok: { model: "grok-4.6", effort: "high", permissionMode: "default" },
      },
      debugEnabled: false,
      routerBaseUrl: "http://127.0.0.1:3455",
      routerAuthToken: "",
      openRouterApiKey: "",
      deepseekApiKey: "",
      automationApiPort: 47831,
      transcriptFontScale: 1,
      fonts: { ...DEFAULT_FONT_SETTINGS },
      compactDefault: { on: false, at: 80 },
      idleSleep: { ...DEFAULT_IDLE_SLEEP },
      gateDefaults: { model: "haiku", effort: "low" },
      composer: { ...DEFAULT_COMPOSER_SETTINGS },
      memberMessaging: { ...DEFAULT_MEMBER_MESSAGING_SETTINGS },
      favoriteModels: [],
    },
    workspace: { uri: WORKSPACE, kind: "local", path: WORKSPACE },
    auth: [],
    sessions,
    modelRoutes: MODEL_ROUTES,
    modelProviders: [...MODEL_PROVIDERS],
    harnesses: [],
    router: { baseUrl: "http://127.0.0.1:3455" },
    automationApi: { baseUrl: "", spec: "" },
    logs: { logFilePath: "" },
    runtime: { appRoot: "guide" },
    party,
    windows: [],
    resumableSessions: [],
    guideOffer: { pending: false, shown: true },
  };
}

export function snap(input: {
  members: PartyMember[];
  sessions: SessionView[];
  transcripts?: Record<string, TranscriptBlock[]>;
  panels?: Array<{ id: string; tabs: string[]; active: string }>;
  focused?: string;
  gate?: PartyGate;
  extras?: Partial<GuideSnapshot>;
}): GuideSnapshot {
  const panels = input.panels || [{ id: "p1", tabs: input.members.map((item) => item.name), active: input.members[0]?.name || "" }];
  return {
    state: baseState(partyOf(input.members, input.gate), input.sessions),
    transcripts: input.transcripts || {},
    layout: input.members.length ? layout(panels, input.focused || panels[0]?.id || "") : undefined,
    ...input.extras,
  };
}

export function emptyPartySnapshot(extras?: Partial<GuideSnapshot>): GuideSnapshot {
  return {
    state: baseState({ parties: [], members: [], currentPartyId: undefined }, []),
    transcripts: {},
    ...extras,
  };
}
