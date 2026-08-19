/**
 * Shared fake world for the deck. One workspace, one party, three members and
 * one real job (rate-limiting a login endpoint), reused across every slide so
 * the story does not keep renaming people or restarting the task.
 */
import { DEFAULT_COMPOSER_SETTINGS } from "../../shared/composerSettings";
import { DEFAULT_FONT_SETTINGS } from "../../shared/appFonts";
import { DEFAULT_IDLE_SLEEP } from "../../shared/idleSleep";
import { DEFAULT_MEMBER_MESSAGING_SETTINGS } from "../../shared/memberMessaging";
import { MODEL_PROVIDERS } from "../../shared/modelProviders";
import type { GuideSnapshot } from "../../shared/guide";
import type { AuthProviderState, HarnessId, InitialAppState, PartyMember, SessionView } from "../../shared/types";
import type { McpServerSnapshot } from "../../shared/mcp";
import type { MemberQueueState } from "../../shared/messageQueue";
import type { PartyGate } from "../../shared/messageGate";
import type { TranscriptBlock } from "../../shared/transcript";
import type { WorkbenchLayout } from "../../shared/workbenchLayout";
import type { ClaudeSessionSnapshot } from "../../core/events";


export const WORKSPACE = "C:\\work\\todo-api";
export const PARTY_ID = "guide-demo";
export const PARTY_NAME = "todo-api";
export const CREATED = "2026-08-01T00:00:00.000Z";

/** Enough of a catalog that the model picker looks like the real one rather
 *  than a list of three. Same shape the app's route list uses. */
// Model ids are the REAL catalog's ids (`shared/modelCatalog.json`). A made-up
// id renders as a row with no performance, cost or context — the picker looks
// broken rather than demonstrated.
const MODEL_ROUTES = [
  { harnessId: "claude-code", providerId: "anthropic", model: "sonnet", label: "sonnet", meta: { perf: 3, costTier: 5, inPerM: 3, outPerM: 15, ioPerM: 6, context: "1M" } },
  { harnessId: "claude-code", providerId: "anthropic", model: "claude-opus-5[1m]", label: "claude-opus-5[1m]", meta: { perf: 5, costTier: 5, inPerM: 5, outPerM: 25, ioPerM: 10, context: "1M" } },
  { harnessId: "claude-code", providerId: "anthropic", model: "haiku", label: "haiku", meta: { perf: 0, costTier: 3, inPerM: 1, outPerM: 5, ioPerM: 2, context: "200K" } },
  { harnessId: "codex", providerId: "openai", model: "GPT-5.4", label: "GPT-5.4", meta: { perf: 4, costTier: 4, inPerM: 2.5, outPerM: 15, ioPerM: 5.63, context: "1M" } },
  { harnessId: "codex", providerId: "openai", model: "GPT-5.4 mini", label: "GPT-5.4 mini", meta: { perf: 1, costTier: 3, inPerM: 0.75, outPerM: 4.5, ioPerM: 1.69, context: "400K" } },
  { harnessId: "cursor", providerId: "cursor", model: "Grok 4.5 Cursor", label: "Grok 4.5 Cursor", meta: { perf: 3, costTier: 5, inPerM: 0, outPerM: 0, ioPerM: 0, context: "500K" } },
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
  queue?: MemberQueueState;
}): PartyMember {
  return {
    partyId: PARTY_ID,
    name: input.name,
    status: input.status,
    runtime: input.runtime,
    role: input.role,
    model: input.model,
    sessionId: input.sessionId,
    queue: input.queue,
    lastContextTokens: input.lastContextTokens,
    lastContextWindow: input.lastContextTokens ? 200000 : undefined,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

export const MAIN = member({ name: "main", status: "idle", runtime: "claude-code", role: "진행", model: "sonnet", sessionId: "s-main" });
export const REVIEWER = member({ name: "reviewer", status: "idle", runtime: "codex", role: "변경 리뷰", model: "GPT-5.4", sessionId: "s-reviewer" });
export const IMPL = member({ name: "impl", status: "idle", runtime: "claude-code", role: "구현 전담", model: "sonnet", sessionId: "s-impl" });

// --- accounts ---------------------------------------------------------------
//
// The three states scene 1 walks through. Same fields the real Authentication
// screen reads, so the cards render exactly as they do in the app.

const API_KEY_PROVIDERS: AuthProviderState[] = [
  { id: "openrouter", label: "OpenRouter", kind: "apiKey", status: "missing", description: "MiniMax·Qwen 등 라우터 경유 모델에 사용합니다." },
  { id: "deepseek", label: "DeepSeek", kind: "apiKey", status: "missing", description: "DeepSeek 자체 API 의 V4 모델에 사용합니다." },
];

function subscription(input: {
  id: string;
  label: string;
  provider: "claude" | "codex";
  status: AuthProviderState["status"];
  detail: string;
  actionLabel?: string;
  authUrl?: string;
}): AuthProviderState {
  return {
    id: input.id,
    label: input.label,
    kind: "subscription",
    status: input.status,
    description: input.provider === "claude"
      ? "Claude 구독을 연결하면 Claude 모델을 그대로 씁니다."
      : "GPT 모델을 Claude Code 하네스에서 쓸 때 연결합니다.",
    source: input.provider === "claude" ? "Claude Code subscription" : "Codex subscription",
    detail: input.detail,
    ...(input.authUrl ? { authUrl: input.authUrl } : {}),
    ...(input.actionLabel ? { action: { type: "subscriptionOAuth" as const, provider: input.provider, label: input.actionLabel } } : {}),
  };
}

/** Nothing connected yet — both cards offer 구독 연결. */
export const AUTH_NONE: AuthProviderState[] = [
  subscription({ id: "claude", label: "Claude", provider: "claude", status: "missing", detail: "Claude Code 구독 브리지를 연결하세요.", actionLabel: "구독 연결" }),
  subscription({ id: "codex-bridge", label: "Claude Code용 GPT 연결", provider: "codex", status: "missing", detail: "Claude Code 하네스에서 GPT 모델을 사용할 때만 필요합니다. Codex 하네스의 로그인과는 별도입니다.", actionLabel: "구독 연결" }),
  ...API_KEY_PROVIDERS,
];

/** Claude 연결을 눌러 브라우저가 열린 직후. */
export const AUTH_PENDING: AuthProviderState[] = [
  subscription({
    id: "claude", label: "Claude", provider: "claude", status: "pending",
    detail: "브라우저에서 로그인을 마치면 자동으로 연결됩니다.",
    actionLabel: "인증 대기 중",
    authUrl: "https://claude.ai/oauth/authorize?client_id=agentparty&code_challenge=8f2c…",
  }),
  subscription({ id: "codex-bridge", label: "Claude Code용 GPT 연결", provider: "codex", status: "missing", detail: "Claude Code 하네스에서 GPT 모델을 사용할 때만 필요합니다. Codex 하네스의 로그인과는 별도입니다.", actionLabel: "구독 연결" }),
  ...API_KEY_PROVIDERS,
];

/** 승인 후. Claude 는 연결됨, Codex 는 네이티브 로그인으로 이미 사용 가능. */
export const AUTH_READY: AuthProviderState[] = [
  subscription({ id: "claude", label: "Claude", provider: "claude", status: "available", detail: "Claude Code 구독 브리지가 연결되었습니다." }),
  subscription({ id: "codex-bridge", label: "Claude Code용 GPT 연결", provider: "codex", status: "available", detail: "Claude Code 하네스에서 GPT 모델을 사용할 때만 필요합니다. Codex 하네스의 로그인과는 별도입니다." }),
  { ...API_KEY_PROVIDERS[0], status: "configured", maskedValue: "sk-or-v1-…7d21" },
  API_KEY_PROVIDERS[1],
];

// --- MCP --------------------------------------------------------------------

/** What `main` 의 MCP 서버 목록이 보여 주는 것: 붙은 서버, 붙다 만 서버, 도구 수. */
export const MCP_SERVERS: McpServerSnapshot = {
  supported: true,
  harness: "claude-code",
  servers: [
    {
      name: "agentparty-app", state: "connected", transport: "stdio", scope: "app", version: "1.0.0",
      tools: [
        { name: "send", description: "파티 멤버에게 메시지를 보냅니다" },
        { name: "member-create", description: "새 멤버를 만들고 세션을 시작합니다" },
        { name: "list", description: "파티 멤버와 상태를 나열합니다" },
      ],
      canReconnect: true, canToggle: true, canAuthenticate: false,
    },
    {
      name: "playwright", state: "connected", transport: "stdio", scope: "project", version: "0.7.2",
      tools: [
        { name: "browser_navigate", description: "브라우저를 특정 주소로 이동합니다" },
        { name: "browser_snapshot", description: "현재 페이지의 접근성 트리를 읽습니다" },
      ],
      canReconnect: true, canToggle: true, canAuthenticate: false,
    },
    {
      name: "github", state: "needs-auth", transport: "http", scope: "user",
      url: "https://api.githubcopilot.com/mcp/",
      error: "토큰이 만료되었습니다. 다시 인증하세요.",
      tools: [],
      canReconnect: true, canToggle: false, canAuthenticate: true,
    },
  ],
};

// --- message queue ----------------------------------------------------------

/** 멤버가 도는 동안 쌓인 대기 메시지 — 내가 친 것 하나, reviewer 가 보낸 것 하나. */
export const QUEUE: MemberQueueState = {
  items: [
    { id: "q1", from: null, at: "10:21", text: "테스트도 함께 수정해 주세요. login.spec.ts의 실패 사례가 아직 상태 코드 200을 기대하고 있습니다." },
    { id: "q2", from: "reviewer", at: "10:22", text: "429 응답에 Retry-After 헤더도 추가해 주세요. 현재 클라이언트에서 재시도 간격을 결정할 수 없습니다." },
  ],
};

export function layout(panels: Array<{ id: string; tabs: string[]; active: string }>, focused: string): WorkbenchLayout {
  return {
    panels: panels.map((panel) => ({ ...panel, weight: 1 })),
    focusedPanelId: focused,
  };
}

export function partyOf(members: PartyMember[], gate?: PartyGate): InitialAppState["party"] {
  return {
    parties: [{ id: PARTY_ID, name: PARTY_NAME, createdAt: CREATED, updatedAt: CREATED, gate }],
    currentPartyId: PARTY_ID,
    members,
    messages: [],
  };
}

export function baseState(party: InitialAppState["party"], sessions: SessionView[], auth: AuthProviderState[] = AUTH_READY, selectedHarnessId: HarnessId = "claude-code"): InitialAppState {
  return {
    ok: true,
    settings: {
      locale: "ko",
      workspacePath: WORKSPACE,
      updateChannel: "stable",
      claudeExecutablePath: "",
      cursorExecutablePath: "",
      claudeSafeMode: false,
      selectedHarnessId,
      harnessDefaults: {
        "claude-code": { model: "sonnet", effort: "medium", permissionMode: "default" },
        codex: { model: "GPT-5.4", effort: "medium", codexPolicy: { sandbox: "workspace-write", approval: "on-request", guardian: false } },
        cursor: { model: "Grok 4.5 Cursor", effort: "high", cursorPolicy: { mode: "agent", approval: "allowlist" } },
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
    auth,
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
  auth?: AuthProviderState[];
  /** Harness a new member starts on — what the member wizard opens with. */
  harness?: HarnessId;
  extras?: Partial<GuideSnapshot>;
}): GuideSnapshot {
  const panels = input.panels || [{ id: "p1", tabs: input.members.map((item) => item.name), active: input.members[0]?.name || "" }];
  return {
    state: baseState(partyOf(input.members, input.gate), input.sessions, input.auth, input.harness),
    transcripts: input.transcripts || {},
    layout: input.members.length ? layout(panels, input.focused || panels[0]?.id || "") : undefined,
    ...input.extras,
  };
}

export function emptyPartySnapshot(auth?: AuthProviderState[], extras?: Partial<GuideSnapshot>): GuideSnapshot {
  return {
    state: baseState({ parties: [], members: [], currentPartyId: undefined }, [], auth),
    transcripts: {},
    ...extras,
  };
}
