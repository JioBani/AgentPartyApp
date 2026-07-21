import { getSettings, maskSecret, updateSettings } from "./settings";
import { AuthProviderState } from "../shared/types";
import type { SubscriptionProxyProvider, SubscriptionProxyStatus } from "../core/subscriptionProxy";
import { isE2E } from "./runtimeMode";

export function getAuthState(): AuthProviderState[] {
  const settings = getSettings();
  const openRouterKey = settings.openRouterApiKey || process.env.OPENROUTER_API_KEY || "";
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
      id: "openrouter",
      label: "OpenRouter",
      kind: "apiKey",
      status: openRouterKey ? "configured" : "missing",
      description: "Used by router-backed models such as MiniMax and Qwen.",
      source: settings.openRouterApiKey ? "AgentParty app settings" : process.env.OPENROUTER_API_KEY ? "OPENROUTER_API_KEY" : undefined,
      maskedValue: maskSecret(openRouterKey),
      detail: openRouterKey ? "Configured. Use Test to verify provider access." : "Missing. Router-backed models need this key.",
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
