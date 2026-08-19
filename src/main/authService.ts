import { getSettings, maskSecret, updateSettings } from "./settings";
import { AuthProviderState } from "../shared/types";
import type { SubscriptionProxyProvider, SubscriptionProxyStatus } from "../core/subscriptionProxy";
import { isE2E } from "./runtimeMode";
import { DEEPSEEK_API_KEY_ENV, DEEPSEEK_BASE_URL } from "../shared/deepseekDefaults";
import { cursorAgentAuthStatus, resolveCursorAgentCommand, type CursorAgentAuthStatus } from "../core/cursorAgentCli";
import { grokCliInstalledPath } from "../core/grokAgentCli";
import { grokSubscriptionAvailable } from "../core/grokSubscriptionAuth";
import { codexExecutable, resolveCodexExecutable } from "../core/codexExec";
import { isFile, probeCommand, resolveOnPath } from "../core/commandProbe";
import type { ClaudeNativeAuthState } from "../core/claudeNativeAuth";

const CURSOR_AUTH_TTL_MS = 30_000;
let cursorAuthCache: { at: number; value: CursorAgentAuthStatus } | undefined;
let codexAuthCache: { at: number; value: CodexCliAuthStatus } | undefined;

export interface CodexCliAuthStatus {
  /** Undefined when the CLI could not provide a recognizable login status. */
  authenticated?: boolean;
  status?: "authenticated" | "unauthenticated" | "missing" | "error";
  detail?: string;
}

/** Parses the stable human-readable output emitted by `codex login status`. */
export function codexCliAuthenticatedFrom(output: string): boolean | undefined {
  if (/not logged in|not authenticated|login required/i.test(output)) return false;
  if (/logged in using|authenticated/i.test(output)) return true;
  return undefined;
}

/** Read-only status from the native Codex CLI; Codex remains the token owner. */
export async function codexCliAuthState(force = false): Promise<CodexCliAuthStatus> {
  if (isE2E()) return {};
  if (!force && codexAuthCache && Date.now() - codexAuthCache.at < CURSOR_AUTH_TTL_MS) {
    return codexAuthCache.value;
  }
  const executable = codexExecutable(getSettings().codexExecutablePath);
  const resolved = resolveCodexExecutable(executable);
  const executableExists = isFile(resolved.command)
    || Boolean(resolveOnPath(resolved.command))
    || Boolean(resolved.argsPrefix[0] && isFile(resolved.argsPrefix[0]));
  if (!executableExists) {
    const value: CodexCliAuthStatus = {
      authenticated: false,
      status: "missing",
      detail: `Codex CLI 실행 파일을 찾지 못했습니다: ${executable}`,
    };
    codexAuthCache = { at: Date.now(), value };
    return value;
  }
  const result = await probeCommand(
    resolved.command,
    [...resolved.argsPrefix, "login", "status"],
    { shell: resolved.shell, timeoutMs: 30_000 },
  );
  const output = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n").trim();
  const authenticated = codexCliAuthenticatedFrom(output);
  const value: CodexCliAuthStatus = {
    authenticated,
    status: authenticated === true
      ? "authenticated"
      : authenticated === false
        ? "unauthenticated"
        : result.failureKind === "spawn" && result.failureCode === "ENOENT"
          ? "missing"
          : "error",
    ...(authenticated === undefined && output ? { detail: output } : {}),
  };
  codexAuthCache = { at: Date.now(), value };
  return value;
}

/** Overlays the native CLI login without reading or copying its OAuth tokens. */
export function withCodexCliAuth(states: AuthProviderState[], auth: CodexCliAuthStatus): AuthProviderState[] {
  return states.map((state) => {
    if (state.id !== "codex") return state;
    const status = auth.status || (auth.authenticated === true ? "authenticated" : auth.authenticated === false ? "unauthenticated" : undefined);
    if (!status) return state;
    if (status === "authenticated") {
      return {
        ...state,
        status: "available",
        authenticated: true,
        detail: "Windows의 Codex CLI 로그인은 유효합니다. 이 자격 증명은 Codex CLI가 직접 소유하고 갱신합니다.",
      };
    }
    if (status === "missing") {
      return { ...state, status: "missing", authenticated: false, detail: auth.detail || "Windows에서 Codex CLI를 찾지 못했습니다." };
    }
    return {
      ...state,
      status: "invalid",
      authenticated: false,
      detail: auth.detail || (status === "unauthenticated"
        ? "Windows의 Codex CLI가 로그인되어 있지 않습니다. `codex login`을 실행하세요."
        : "Windows의 Codex CLI 로그인 상태를 확인하지 못했습니다."),
    };
  });
}

/**
 * The desktop host's Cursor CLI login state, cached briefly — the read spawns
 * the CLI, and auth state is listed on every window load. E2E never spawns a
 * user-owned CLI; it reports an unknown (undefined) state instead.
 */
export async function cursorCliAuthState(force = false): Promise<CursorAgentAuthStatus> {
  if (isE2E()) {
    return {};
  }
  if (!force && cursorAuthCache && Date.now() - cursorAuthCache.at < CURSOR_AUTH_TTL_MS) {
    return cursorAuthCache.value;
  }
  const value = await cursorAgentAuthStatus(getSettings().cursorExecutablePath);
  cursorAuthCache = { at: Date.now(), value };
  return value;
}

/** Drops the cached login state (call after login/logout mutations). */
export function invalidateCursorAuthCache(): void {
  cursorAuthCache = undefined;
}

/**
 * Overlays the host CLI's real login state onto the Cursor auth card. The card
 * without this claimed "available" for a logged-out CLI whose every turn would
 * fail with "Authentication required".
 */
export function withCursorCliAuth(states: AuthProviderState[], auth: CursorAgentAuthStatus): AuthProviderState[] {
  return states.map((state) => {
    if (state.id !== "cursor" || state.status !== "available" || auth.authenticated === undefined) {
      return state;
    }
    if (auth.authenticated) {
      return {
        ...state,
        authenticated: true,
        detail: `Cursor CLI 로그인됨${auth.email ? ` (${auth.email})` : ""}. Auto는 플랜 호환이며 Grok 4.5는 플랜에 따라 사용 가능합니다.`,
      };
    }
    return {
      ...state,
      status: "invalid",
      authenticated: false,
      detail: "Cursor CLI가 설치되어 있지만 로그인되어 있지 않습니다. 터미널에서 `cursor-agent login`을 실행하세요.",
    };
  });
}

/** Keeps the native Claude runtime login separate from the subscription bridge. */
export function withClaudeNativeAuth(states: AuthProviderState[], auth: ClaudeNativeAuthState): AuthProviderState[] {
  return states.map((state) => state.id !== "claude-native" ? state : {
    ...state,
    status: auth.status === "authenticated" ? "available" : auth.status === "missing" ? "missing" : "invalid",
    authenticated: auth.authenticated,
    source: auth.executable,
    detail: auth.detail,
    host: auth.host.label,
    workspace: auth.workspace,
    command: auth.authenticated ? auth.command : auth.loginCommand,
  });
}

export function getAuthState(): AuthProviderState[] {
  const settings = getSettings();
  const openRouterKey = settings.openRouterApiKey || process.env.OPENROUTER_API_KEY || "";
  const deepseekKey = settings.deepseekApiKey || process.env[DEEPSEEK_API_KEY_ENV] || "";
  let cursorSource: string | undefined;
  let cursorError: string | undefined;
  try {
    cursorSource = resolveCursorAgentCommand(settings.cursorExecutablePath).source;
  } catch (error) {
    cursorError = error instanceof Error ? error.message : String(error);
  }
  const grokCli = grokCliInstalledPath(settings.grokExecutablePath);
  const grokLogin = grokSubscriptionAvailable();
  return [
    {
      id: "claude-native",
      label: "Claude",
      kind: "subscription",
      status: "missing",
      authenticated: false,
      surface: "native-cli",
      description: "Windows에서 Claude CLI를 실행하고 로그인 상태를 확인합니다.",
      source: undefined,
      detail: "Windows의 Claude CLI 로그인 상태를 확인 중입니다.",
      host: "Windows",
      command: "claude auth status",
      action: { type: "nativeCliTest", provider: "claude", host: "windows", label: "연결 테스트" },
    },
    {
      id: "claude-native-wsl",
      label: "Claude - WSL",
      kind: "subscription",
      status: "unknown",
      authenticated: false,
      surface: "native-cli",
      description: "기본 WSL 배포판에서 Claude CLI를 실행하고 로그인 상태를 확인합니다.",
      detail: "연결 테스트를 누르면 기본 WSL 배포판을 시작해 실제 CLI와 로그인을 확인합니다.",
      host: "WSL · 기본 배포판",
      action: { type: "nativeCliTest", provider: "claude", host: "wsl", label: "연결 테스트" },
    },
    {
      id: "codex",
      label: "Codex",
      kind: "subscription",
      status: "missing",
      authenticated: false,
      surface: "native-cli",
      description: "Windows에서 Codex CLI를 실행하고 로그인 상태를 확인합니다.",
      source: "Codex CLI",
      detail: "Windows의 Codex CLI 로그인 상태를 확인 중입니다.",
      host: "Windows",
      command: "codex login status",
      action: { type: "nativeCliTest", provider: "codex", host: "windows", label: "연결 테스트" },
    },
    {
      id: "codex-wsl",
      label: "Codex - WSL",
      kind: "subscription",
      status: "unknown",
      authenticated: false,
      surface: "native-cli",
      description: "기본 WSL 배포판에서 Codex CLI를 실행하고 로그인 상태를 확인합니다.",
      detail: "연결 테스트를 누르면 기본 WSL 배포판을 시작해 실제 CLI와 로그인을 확인합니다.",
      host: "WSL · 기본 배포판",
      action: { type: "nativeCliTest", provider: "codex", host: "wsl", label: "연결 테스트" },
    },
    {
      id: "cursor",
      label: "Cursor",
      kind: "subscription",
      surface: "native-cli",
      status: cursorSource ? "available" : "missing",
      authenticated: cursorSource ? undefined : false,
      description: "Uses the account signed in to Cursor Agent CLI.",
      source: cursorSource,
      host: "Windows",
      command: "cursor-agent status --format json",
      action: { type: "nativeCliTest", provider: "cursor", host: "windows", label: "연결 테스트" },
      detail: cursorSource
        ? "Cursor CLI is installed. Auto is plan-compatible; named-model access (Grok 4.5) depends on the signed-in Cursor plan."
        : cursorError,
    },
    {
      id: "cursor-wsl",
      label: "Cursor - WSL",
      kind: "subscription",
      surface: "native-cli",
      status: "unknown",
      authenticated: false,
      description: "기본 WSL 배포판에서 Cursor Agent CLI를 실행하고 로그인 상태를 확인합니다.",
      detail: "연결 테스트를 누르면 기본 WSL 배포판을 시작해 실제 CLI와 로그인을 확인합니다.",
      host: "WSL · 기본 배포판",
      action: { type: "nativeCliTest", provider: "cursor", host: "wsl", label: "연결 테스트" },
    },
    {
      // One credential, two consumers: the Grok Build harness runs the CLI with
      // it, and Claude Code/Codex members running Grok models reuse the same
      // token. So the status has to distinguish "not installed" from "installed
      // but not signed in" — only the second is fixed by `grok login`.
      id: "grok",
      label: "Grok",
      kind: "subscription",
      surface: "native-cli",
      status: grokLogin.ok ? "available" : "missing",
      authenticated: grokLogin.ok,
      description: "Uses the account signed in to the Grok Build CLI, for both the Grok Build harness and Grok models on other harnesses.",
      source: grokLogin.ok ? (grokCli ? `Grok Build CLI (${grokCli})` : "Grok Build CLI login") : undefined,
      host: "Windows",
      command: "grok models",
      action: { type: "nativeCliTest", provider: "grok", host: "windows", label: "연결 테스트" },
      detail: grokLogin.ok
        ? `Signed in${grokLogin.email ? ` as ${grokLogin.email}` : ""}. AgentParty reads this credential and never refreshes it — the CLI owns that.`
        : grokCli
          ? `Grok Build is installed at ${grokCli} but not signed in. Run \`grok login\`.`
          : "Grok Build is not installed. Install it with `irm https://x.ai/cli/install.ps1 | iex`, then run `grok login`.",
    },
    {
      id: "grok-wsl",
      label: "Grok - WSL",
      kind: "subscription",
      surface: "native-cli",
      status: "unknown",
      authenticated: false,
      description: "기본 WSL 배포판에서 Grok Build CLI를 실행하고 로그인 상태를 확인합니다.",
      detail: "연결 테스트를 누르면 기본 WSL 배포판을 시작해 실제 CLI와 로그인을 확인합니다.",
      host: "WSL · 기본 배포판",
      action: { type: "nativeCliTest", provider: "grok", host: "wsl", label: "연결 테스트" },
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      kind: "apiKey",
      status: openRouterKey ? "configured" : "missing",
      description: "Used by router-backed models such as MiniMax and Qwen.",
      source: settings.openRouterApiKey ? "AgentParty app settings" : process.env.OPENROUTER_API_KEY ? "OPENROUTER_API_KEY" : undefined,
      maskedValue: maskSecret(openRouterKey),
      detail: openRouterKey ? "Configured. Use Test to verify provider access." : "Missing. Router-backed models need this key.",
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      kind: "apiKey",
      status: deepseekKey ? "configured" : "missing",
      description: "Used by DeepSeek V4 models on DeepSeek's own API.",
      source: settings.deepseekApiKey ? "AgentParty app settings" : process.env[DEEPSEEK_API_KEY_ENV] ? DEEPSEEK_API_KEY_ENV : undefined,
      maskedValue: maskSecret(deepseekKey),
      detail: deepseekKey ? "Configured. Use Test to verify provider access." : "Missing. DeepSeek V4 models need this key.",
    },
  ];
}

/**
 * Presents bridge accounts separately from native CLI accounts. OAuth refresh
 * tokens rotate and have a single owner, so a bridge Codex login must never be
 * copied into the native Codex CLI's auth.json (or into another WSL host).
 */
export function withSubscriptionProxyAuth(
  states: AuthProviderState[],
  subscriptions: SubscriptionProxyStatus,
): AuthProviderState[] {
  const subscriptionProviders: Array<{ provider: SubscriptionProxyProvider; id: string; label: string; description: string }> = [
    {
      provider: "claude",
      id: "claude",
      label: "Claude",
      description: "다른 하네스에서 Claude 구독 모델을 사용할 때 연결하는 로컬 프록시입니다.",
    },
    {
      provider: "codex",
      id: "codex-bridge",
      label: "Codex",
      description: "다른 하네스에서 Codex 구독 GPT 모델을 사용할 때 연결하는 로컬 프록시입니다.",
    },
  ];
  return [
    ...states.filter((state) => state.id !== "claude" && state.id !== "claude-code" && !state.id.startsWith("cross-")),
    ...subscriptionProviders.map(({ provider, id, label, description }): AuthProviderState => {
      const providerStatus = subscriptions[provider];
      const authentication = subscriptions.authentication?.[provider];
      const credentialReady = providerStatus.credential?.status === "ready";
      const status: AuthProviderState["status"] = providerStatus.available && credentialReady
        ? "available"
        : authentication?.status === "pending"
          ? "pending"
          : authentication?.status === "error"
            ? "invalid"
            : providerStatus.credential?.status === "invalid"
              ? "invalid"
            : subscriptions.service?.status === "error" || !subscriptions.ok
              ? "network_error"
              : "missing";
      const detail = providerStatus.available && credentialReady
        ? provider === "codex"
          ? description
          : "Claude 구독 프록시가 연결되었습니다."
        : authentication?.detail
          || ((subscriptions.service?.status === "error" || !subscriptions.ok) ? subscriptions.service?.detail || subscriptions.detail : undefined)
          || providerStatus.credential?.detail
          || (provider === "codex"
            ? description
            : "Connect the Claude Code subscription bridge.");
      return {
        id,
        label,
        kind: "subscription",
        surface: "cross-harness",
        status,
        authenticated: providerStatus.available && credentialReady,
        description,
        source: provider === "codex" ? "Codex subscription" : "Claude Code subscription",
        detail,
        ...(authentication?.authUrl ? { authUrl: authentication.authUrl } : {}),
        action: {
          type: "subscriptionOAuth" as const,
          provider,
          label: authentication?.status === "pending" ? "인증 대기 중" : providerStatus.available && credentialReady ? "다시 연결" : "구독 연결",
        },
      };
    }),
  ];
}

export function setOpenRouterKey(value: string): AuthProviderState[] {
  updateSettings({ openRouterApiKey: value.trim() });
  return getAuthState();
}

export function clearOpenRouterKey(): AuthProviderState[] {
  updateSettings({ openRouterApiKey: "" });
  return getAuthState();
}

export function setDeepseekKey(value: string): AuthProviderState[] {
  updateSettings({ deepseekApiKey: value.trim() });
  return getAuthState();
}

export function clearDeepseekKey(): AuthProviderState[] {
  updateSettings({ deepseekApiKey: "" });
  return getAuthState();
}

/**
 * Verifies the key against DeepSeek's model list — the cheapest authenticated
 * call, and it doubles as a check that the account can see the V4 models the
 * catalog routes to.
 */
export async function testDeepseekKey(): Promise<AuthProviderState[]> {
  const settings = getSettings();
  const key = settings.deepseekApiKey || process.env[DEEPSEEK_API_KEY_ENV] || "";
  if (isE2E()) {
    return withProviderResult("deepseek", "valid", "Mocked by AGENTPARTY_E2E; no provider network call was made.");
  }
  if (!key) {
    return getAuthState();
  }
  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` } });
    return withProviderResult(
      "deepseek",
      response.ok ? "valid" : "invalid",
      response.ok ? "DeepSeek accepted the key." : `DeepSeek rejected the key (${response.status}).`,
    );
  } catch (error) {
    return withProviderResult("deepseek", "network_error", error instanceof Error ? error.message : String(error));
  }
}

function withProviderResult(id: string, status: AuthProviderState["status"], detail: string): AuthProviderState[] {
  const states = getAuthState();
  const provider = states.find((item) => item.id === id);
  if (provider) {
    provider.status = status;
    provider.detail = detail;
  }
  return states;
}

export async function testOpenRouterKey(): Promise<AuthProviderState[]> {
  const settings = getSettings();
  const key = settings.openRouterApiKey || process.env.OPENROUTER_API_KEY || "";
  if (isE2E()) {
    const states = getAuthState();
    const provider = states.find((item) => item.id === "openrouter");
    if (provider) {
      provider.status = "valid";
      provider.detail = "Mocked by AGENTPARTY_E2E; no provider network call was made.";
    }
    return states;
  }
  if (!key) {
    return getAuthState();
  }
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const states = getAuthState();
    const provider = states.find((item) => item.id === "openrouter");
    if (provider) {
      provider.status = response.ok ? "valid" : "invalid";
      provider.detail = response.ok ? "OpenRouter accepted the key." : `OpenRouter rejected the key (${response.status}).`;
    }
    return states;
  } catch (error) {
    const states = getAuthState();
    const provider = states.find((item) => item.id === "openrouter");
    if (provider) {
      provider.status = "network_error";
      provider.detail = error instanceof Error ? error.message : String(error);
    }
    return states;
  }
}
