import { getSettings, maskSecret, updateSettings } from "./settings";
import { AuthProviderState } from "../shared/types";
import type { SubscriptionProxyProvider, SubscriptionProxyStatus } from "../core/subscriptionProxy";
import { isE2E } from "./runtimeMode";
import { DEEPSEEK_API_KEY_ENV, DEEPSEEK_BASE_URL } from "../shared/deepseekDefaults";
import { cursorAgentAuthStatus, resolveCursorAgentCommand, type CursorAgentAuthStatus } from "../core/cursorAgentCli";
import { grokCliInstalledPath } from "../core/grokAgentCli";
import { grokSubscriptionAvailable } from "../core/grokSubscriptionAuth";

const CURSOR_AUTH_TTL_MS = 30_000;
let cursorAuthCache: { at: number; value: CursorAgentAuthStatus } | undefined;

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
        detail: `Cursor CLI 로그인됨${auth.email ? ` (${auth.email})` : ""}. Auto는 플랜 호환이며 Grok 4.5는 플랜에 따라 사용 가능합니다.`,
      };
    }
    return {
      ...state,
      status: "invalid",
      detail: "Cursor CLI가 설치되어 있지만 로그인되어 있지 않습니다. 터미널에서 `cursor-agent login`을 실행하세요.",
    };
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
      id: "claude",
      label: "Claude",
      kind: "subscription",
      status: "available",
      description: "Uses the Claude Code login and subscription managed by Claude Code.",
      source: "Claude Code CLI login",
      detail: "AgentParty delegates subscription auth to the local Claude Code harness.",
    },
    {
      id: "codex",
      label: "Codex",
      kind: "subscription",
      status: "available",
      description: "Uses the local Codex CLI login or CODEX_API_KEY for Codex app-server.",
      source: "Codex CLI login",
      detail: "AgentParty delegates Codex auth to the local codex CLI.",
    },
    {
      id: "cursor",
      label: "Cursor",
      kind: "subscription",
      status: cursorSource ? "available" : "missing",
      description: "Uses the account signed in to Cursor Agent CLI.",
      source: cursorSource,
      detail: cursorSource
        ? "Cursor CLI is installed. Auto is plan-compatible; named-model access (Grok 4.5) depends on the signed-in Cursor plan."
        : cursorError,
    },
    {
      // One credential, two consumers: the Grok Build harness runs the CLI with
      // it, and Claude Code/Codex members running Grok models reuse the same
      // token. So the status has to distinguish "not installed" from "installed
      // but not signed in" — only the second is fixed by `grok login`.
      id: "grok",
      label: "Grok",
      kind: "subscription",
      status: grokLogin.ok ? "available" : "missing",
      description: "Uses the account signed in to the Grok Build CLI, for both the Grok Build harness and Grok models on other harnesses.",
      source: grokLogin.ok ? (grokCli ? `Grok Build CLI (${grokCli})` : "Grok Build CLI login") : undefined,
      detail: grokLogin.ok
        ? `Signed in${grokLogin.email ? ` as ${grokLogin.email}` : ""}. AgentParty reads this credential and never refreshes it — the CLI owns that.`
        : grokCli
          ? `Grok Build is installed at ${grokCli} but not signed in. Run \`grok login\`.`
          : "Grok Build is not installed. Install it with `irm https://x.ai/cli/install.ps1 | iex`, then run `grok login`.",
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
 * Presents one user-facing account per subscription. The local bridge and its
 * cross-harness OAuth are implementation details: connecting Claude Code makes
 * Claude usable from both harnesses; connecting Codex does the same for GPT.
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
      description: "Connect once to use Claude models from both Claude Code and Codex harnesses.",
    },
    {
      provider: "codex",
      id: "codex",
      label: "Codex",
      description: "Connect once to use GPT models from both Codex and Claude Code harnesses.",
    },
  ];
  return [
    ...subscriptionProviders.map(({ provider, id, label, description }): AuthProviderState => {
      const providerStatus = subscriptions[provider];
      const authentication = subscriptions.authentication?.[provider];
      const status: AuthProviderState["status"] = providerStatus.available
        ? "available"
        : authentication?.status === "pending"
          ? "pending"
          : authentication?.status === "error"
            ? "invalid"
            : subscriptions.service?.status === "error" || !subscriptions.ok
              ? "network_error"
              : "missing";
      const detail = providerStatus.available
        ? `${provider === "codex" ? "Codex" : "Claude Code"} subscription is connected for both harnesses.`
        : authentication?.detail
          || ((subscriptions.service?.status === "error" || !subscriptions.ok) ? subscriptions.service?.detail || subscriptions.detail : undefined)
          || `Connect ${provider === "codex" ? "Codex" : "Claude Code"} once to enable it in both harnesses.`;
      return {
        id,
        label,
        kind: "subscription",
        status,
        description,
        source: provider === "codex" ? "Codex subscription" : "Claude Code subscription",
        detail,
        ...(authentication?.authUrl ? { authUrl: authentication.authUrl } : {}),
        ...(providerStatus.available ? {} : {
          action: {
            type: "subscriptionOAuth" as const,
            provider,
            label: authentication?.status === "pending" ? "인증 대기 중" : "구독 연결",
          },
        }),
      };
    }),
    ...states.filter((state) => state.id !== "claude" && state.id !== "claude-code" && state.id !== "codex" && !state.id.startsWith("cross-")),
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
