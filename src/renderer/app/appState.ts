import type { InitialAppState } from "../../shared/types";
import { MODEL_PROVIDERS } from "../../shared/modelProviders";
import type { CursorPolicy } from "../../shared/cursorPolicy";
import { DEFAULT_COMPOSER_SETTINGS } from "../../shared/composerSettings";
import { DEFAULT_FONT_SETTINGS } from "../../shared/appFonts";
import { DEFAULT_IDLE_SLEEP } from "../../shared/idleSleep";
import { DEFAULT_MEMBER_MESSAGING_SETTINGS } from "../../shared/memberMessaging";
import { DEFAULT_APP_LOCALE } from "../../shared/appLocale";
import type { MessageKey } from "../i18n/messages";

export type ViewId = "workbench" | "guide" | "sessions" | "usage" | "auth" | "runtime" | "automation";

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
    locale: DEFAULT_APP_LOCALE,
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
    fonts: { ...DEFAULT_FONT_SETTINGS },
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

export function viewTitle(view: ViewId, t: (key: MessageKey) => string): string {
  const titles: Record<ViewId, MessageKey> = {
    workbench: "view.workbench.title",
    guide: "view.guide.title",
    sessions: "view.sessions.title",
    usage: "view.usage.title",
    auth: "view.auth.title",
    runtime: "view.runtime.title",
    automation: "view.automation.title",
  };
  return t(titles[view]);
}

export function viewSubtitle(view: ViewId, t: (key: MessageKey) => string): string {
  // Description only — the workspace path is surfaced as its own chip in the
  // screen header (matching the runtime design mockup), not crammed inline here.
  const subtitles: Record<ViewId, MessageKey> = {
    workbench: "view.workbench.subtitle",
    guide: "view.guide.subtitle",
    sessions: "view.sessions.subtitle",
    usage: "view.usage.subtitle",
    auth: "view.auth.subtitle",
    runtime: "view.runtime.subtitle",
    automation: "view.automation.subtitle",
  };
  return t(subtitles[view]);
}

export function displayPath(value: string | undefined): string {
  return (value || "").replace(/\\/g, "/");
}

export function isViewId(value: string): value is ViewId {
  return ["workbench", "guide", "sessions", "usage", "auth", "runtime", "automation"].includes(value);
}
