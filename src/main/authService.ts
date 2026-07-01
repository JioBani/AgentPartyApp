import { getSettings, maskSecret, updateSettings } from "./settings";
import { AuthProviderState } from "../shared/types";
import { isE2E } from "./runtimeMode";

export function getAuthState(): AuthProviderState[] {
  const settings = getSettings();
  const openRouterKey = settings.openRouterApiKey || process.env.OPENROUTER_API_KEY || "";
  return [
    {
      id: "claude-code",
      label: "Claude Code Subscription",
      kind: "subscription",
      status: "available",
      description: "Uses the Claude Code login and subscription managed by Claude Code.",
      source: "Claude Code CLI login",
      detail: "AgentParty delegates subscription auth to the local Claude Code harness.",
    },
    {
      id: "codex",
      label: "Codex Subscription",
      kind: "subscription",
      status: "available",
      description: "Uses the local Codex CLI login or CODEX_API_KEY for Codex app-server.",
      source: "Codex CLI login",
      detail: "AgentParty delegates Codex auth to the local codex CLI.",
    },
    {
      id: "openrouter",
      label: "OpenRouter API Key",
      kind: "apiKey",
      status: openRouterKey ? "configured" : "missing",
      description: "Used by router-backed models such as MiniMax and Qwen.",
      source: settings.openRouterApiKey ? "AgentParty app settings" : process.env.OPENROUTER_API_KEY ? "OPENROUTER_API_KEY" : undefined,
      maskedValue: maskSecret(openRouterKey),
      detail: openRouterKey ? "Configured. Use Test to verify provider access." : "Missing. Router-backed models need this key.",
    },
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
