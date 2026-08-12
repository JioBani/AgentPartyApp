import type { InitialAppState } from "../../shared/types";
import { MODEL_PROVIDERS } from "../../shared/modelProviders";
import type { CursorPolicy } from "../../shared/cursorPolicy";
import { DEFAULT_COMPOSER_SETTINGS } from "../../shared/composerSettings";
import { DEFAULT_IDLE_SLEEP } from "../../shared/idleSleep";
import { DEFAULT_MEMBER_MESSAGING_SETTINGS } from "../../shared/memberMessaging";

export type ViewId = "workbench" | "sessions" | "usage" | "auth" | "runtime" | "automation";

/** Staged per-member runtime values applied when a member's session starts. */
export interface MemberRuntimeDraft {
  model?: string;
  providerId?: string;
  runtimeModel?: string;
  effort?: string;
  serviceTier?: string;
  permissionMode?: string;
  cursorPolicy?: CursorPolicy;
  thinking?: boolean;
}

export const initialState: InitialAppState = {
  ok: true,
  settings: {
    workspacePath: "",
    claudeExecutablePath: "",
    cursorExecutablePath: "",
    claudeSafeMode: false,
    selectedHarnessId: "claude-code",
    harnessDefaults: {
      "claude-code": { model: "sonnet", effort: "medium", permissionMode: "default" },
      codex: { model: "gpt-5.4", effort: "medium", codexPolicy: { sandbox: "workspace-write", approval: "on-request", guardian: false } },
      cursor: { model: "Grok 4.5", effort: "high", cursorPolicy: { mode: "agent", approval: "allowlist" } },
      grok: { model: "grok-4.6", effort: "high", permissionMode: "default" },
    },
    debugEnabled: false,
    routerBaseUrl: "http://127.0.0.1:3455",
    routerAuthToken: "dummy",
    openRouterApiKey: "",
    deepseekApiKey: "",
    automationApiPort: 47831,
    transcriptFontScale: 1,
    compactDefault: { on: false, at: 80 },
    idleSleep: { ...DEFAULT_IDLE_SLEEP },
    gateDefaults: { model: "haiku", effort: "low" },
    composer: { ...DEFAULT_COMPOSER_SETTINGS },
    memberMessaging: { ...DEFAULT_MEMBER_MESSAGING_SETTINGS },
    favoriteModels: [],
  },
  auth: [],
  sessions: [],
  modelRoutes: [],
  modelProviders: [...MODEL_PROVIDERS],
  harnesses: [],
  router: { baseUrl: "" },
  automationApi: { baseUrl: "", spec: "" },
  logs: { logFilePath: "" },
  party: { members: [] },
  resumableSessions: [],
};

export function viewTitle(view: ViewId): string {
  const titles: Record<ViewId, string> = {
    workbench: "Workbench",
    sessions: "세션",
    usage: "Token Usage",
    auth: "인증",
    runtime: "런타임",
    automation: "자동화",
  };
  return titles[view];
}

export function viewSubtitle(view: ViewId): string {
  // Description only — the workspace path is surfaced as its own chip in the
  // screen header (matching the runtime design mockup), not crammed inline here.
  const subtitles: Record<ViewId, string> = {
    workbench: "패널과 탭으로 멤버 세션을 나누어 실행합니다.",
    sessions: "활성 세션을 열거나 이전 작업을 이어서 진행합니다.",
    usage: "어디서 얼마나 타는지 몇 초 안에 알아채고, 원인까지 한 화면에서 내려갑니다.",
    auth: "구독과 provider API 키를 관리합니다.",
    runtime: "하네스, provider, 모델, 디버깅 기본값을 관리합니다.",
    automation: "AI 자동화와 E2E 테스트용 로컬 API 및 로그를 확인합니다.",
  };
  return subtitles[view];
}

export function displayPath(value: string | undefined): string {
  return (value || "").replace(/\\/g, "/");
}

export function isViewId(value: string): value is ViewId {
  return ["workbench", "sessions", "usage", "auth", "runtime", "automation"].includes(value);
}
