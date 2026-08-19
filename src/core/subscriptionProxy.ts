import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_SUBSCRIPTION_PROXY_API_KEY,
  DEFAULT_SUBSCRIPTION_PROXY_BASE_URL,
  SUBSCRIPTION_PROXY_KEY_ENV,
  SUBSCRIPTION_PROXY_URL_ENV,
} from "../shared/subscriptionProxyDefaults";

export interface SubscriptionProxyConfig {
  baseUrl: string;
  apiKey: string;
}

export interface SubscriptionProxyProviderStatus {
  available: boolean;
  models: string[];
  loginCommand: string;
  /** OAuth credential health, verified separately from model discovery. */
  credential?: {
    status: "ready" | "missing" | "invalid" | "unknown";
    detail: string;
  };
}

export type SubscriptionProxyProvider = "codex" | "claude";

export interface SubscriptionProxyServiceStatus {
  status: "ready" | "starting" | "error";
  managed: boolean;
  detail?: string;
}

export interface SubscriptionProxyAuthenticationStatus {
  status: "pending" | "error";
  detail?: string;
  /**
   * The provider's OAuth URL, as printed by the bridge's login command.
   *
   * The bridge opens the SYSTEM DEFAULT browser itself, which is the wrong one
   * whenever the user's provider account lives in another browser or profile.
   * Surfacing the URL is the only way out of that: without it the login sits at
   * "인증 대기" forever with no way to retarget it. Absent until the command
   * prints it (and for a flow that never prints one).
   */
  authUrl?: string;
}

export interface SubscriptionProxyStatus {
  ok: boolean;
  baseUrl: string;
  detail?: string;
  codex: SubscriptionProxyProviderStatus;
  claude: SubscriptionProxyProviderStatus;
  /** Present when the desktop app owns the proxy lifecycle. */
  service?: SubscriptionProxyServiceStatus;
  /** In-progress/failed OAuth launched from AgentParty Authentication. */
  authentication?: Partial<Record<SubscriptionProxyProvider, SubscriptionProxyAuthenticationStatus>>;
}

export function subscriptionProxyConfig(overrides: Partial<SubscriptionProxyConfig> = {}): SubscriptionProxyConfig {
  return {
    baseUrl: normalizeSubscriptionProxyBaseUrl(
      overrides.baseUrl || process.env[SUBSCRIPTION_PROXY_URL_ENV] || DEFAULT_SUBSCRIPTION_PROXY_BASE_URL,
    ),
    apiKey: overrides.apiKey || process.env[SUBSCRIPTION_PROXY_KEY_ENV] || DEFAULT_SUBSCRIPTION_PROXY_API_KEY,
  };
}

export function normalizeSubscriptionProxyBaseUrl(value: string): string {
  const trimmed = String(value || DEFAULT_SUBSCRIPTION_PROXY_BASE_URL).trim().replace(/\/+$/, "");
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Reads the proxy's authoritative routing/model surface. Credential metadata
 * is intentionally a separate application-service concern: model discovery
 * alone must never be presented as proof of a usable OAuth session.
 */
export async function getSubscriptionProxyStatus(
  overrides: Partial<SubscriptionProxyConfig> = {},
): Promise<SubscriptionProxyStatus> {
  const config = subscriptionProxyConfig(overrides);
  const codexLogin = loginCommand("codex");
  const claudeLogin = loginCommand("claude");
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(2500),
    });
    const text = await response.text();
    let payload: any;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) {
      return unavailableStatus(config.baseUrl, `CLIProxyAPI model discovery failed (${response.status}): ${payload?.error?.message || text || response.statusText}`, codexLogin, claudeLogin);
    }
    const models = Array.isArray(payload?.data)
      ? payload.data.map((item: any) => String(item?.id || "")).filter(Boolean)
      : [];
    const codexModels = models.filter((model: string) => model.toLowerCase().startsWith("gpt-"));
    const claudeModels = models.filter((model: string) => model.toLowerCase().startsWith("claude-"));
    return {
      ok: true,
      baseUrl: config.baseUrl,
      codex: { available: codexModels.length > 0, models: codexModels, loginCommand: codexLogin },
      claude: { available: claudeModels.length > 0, models: claudeModels, loginCommand: claudeLogin },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return unavailableStatus(
      config.baseUrl,
      `CLIProxyAPI is not reachable at ${config.baseUrl}: ${detail}. Start the local proxy; no OpenRouter fallback was attempted.`,
      codexLogin,
      claudeLogin,
    );
  }
}

export async function assertSubscriptionModelAvailable(
  model: string,
  provider: "codex" | "claude",
  overrides: Partial<SubscriptionProxyConfig> = {},
): Promise<void> {
  const status = await getSubscriptionProxyStatus(overrides);
  if (!status.ok) {
    throw new Error(status.detail || `CLIProxyAPI is unavailable at ${status.baseUrl}.`);
  }
  const providerStatus = status[provider];
  if (!providerStatus.models.some((candidate) => candidate.toLowerCase() === model.toLowerCase())) {
    throw new Error(
      `Model '${model}' is not available from the local ${provider === "codex" ? "Codex/ChatGPT" : "Claude"} subscription proxy. ` +
        `Open AgentParty Authentication, connect the ${provider === "codex" ? "ChatGPT/Codex" : "Claude"} subscription once, and retry. ` +
        `Available ${provider} models: ${providerStatus.models.join(", ") || "none"}. ` +
        "No OpenRouter fallback was attempted.",
    );
  }
}

function unavailableStatus(
  baseUrl: string,
  detail: string,
  codexLogin: string,
  claudeLogin: string,
): SubscriptionProxyStatus {
  return {
    ok: false,
    baseUrl,
    detail,
    codex: { available: false, models: [], loginCommand: codexLogin },
    claude: { available: false, models: [], loginCommand: claudeLogin },
  };
}

function loginCommand(provider: "codex" | "claude"): string {
  const executable = path.join(os.homedir(), "cliproxyapi", "cli-proxy-api.exe");
  return `& '${executable}' -${provider}-login`;
}
