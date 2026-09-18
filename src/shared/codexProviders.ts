import { catalogModelByClaudeSubscriptionModel, codexDirectBaiModel, codexDirectDeepseekModel, orRoutedModels } from "./modelCatalog";
import { BAI_API_KEY_ENV, BAI_BASE_URL } from "./baiDefaults";
import { DEEPSEEK_API_KEY_ENV, DEEPSEEK_BASE_URL } from "./deepseekDefaults";
import { DEFAULT_SUBSCRIPTION_PROXY_BASE_URL, SUBSCRIPTION_PROXY_KEY_ENV } from "./subscriptionProxyDefaults";
import { HARNESS_PROTOCOLS } from "./harnessProtocols";
import { backendFor } from "./modelIdentity";

/**
 * Codex custom model providers (Phase 2 — docs/codex-ux-research/07-model-routing.md).
 * The Codex account catalog (`model/list`) only knows OpenAI models; to run any
 * other model on the Codex harness we define an OpenAI-compatible provider that
 * `codex app-server` routes to. The provider is injected per-session via inline
 * `-c model_providers.<id>.*` overrides (NOT by editing the user's config.toml),
 * and selected per-thread with `thread/start.modelProvider`.
 *
 * Verified 2026-07-03 against real codex CLI 0.142.4 + a live OpenRouter key.
 */

export interface CodexCustomProvider {
  /** Provider id used for `model_provider` / `thread/start.modelProvider`. */
  id: string;
  name: string;
  baseUrl: string;
  /** MUST be "responses" — codex removed the chat/completions wire in 2026-02. */
  wireApi: "responses";
  /** Env var the provider API key is read from (set on the app-server process). */
  envKey: string;
  /** Extra top-level `-c key=value` overrides this provider needs (values are TOML literals). */
  extraConfig?: Record<string, string>;
}

export const CODEX_OPENROUTER_PROVIDER: CodexCustomProvider = {
  id: "openrouter",
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  wireApi: HARNESS_PROTOCOLS.codex.wireApi,
  envKey: "OPENROUTER_API_KEY",
};

export const CODEX_CLAUDE_SUBSCRIPTION_PROVIDER: CodexCustomProvider = {
  id: "claude-subscription",
  name: "Claude subscription (local CLIProxyAPI)",
  baseUrl: DEFAULT_SUBSCRIPTION_PROXY_BASE_URL,
  wireApi: HARNESS_PROTOCOLS.codex.wireApi,
  envKey: SUBSCRIPTION_PROXY_KEY_ENV,
};

/**
 * DeepSeek's own API. It serves the OpenAI Responses wire — the only one codex
 * speaks — for `deepseek-v4-flash` and, since the 0813 GA, `deepseek-v4-pro`
 * (verified 2026-08-13 with a real /responses call). Models are opted in one at
 * a time by the catalog's `deepseekResponsesApi` flag rather than assumed, so a
 * model that is not actually served never reaches a spawn.
 * https://api-docs.deepseek.com/guides/responses_api/
 */
export const CODEX_DEEPSEEK_PROVIDER: CodexCustomProvider = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: DEEPSEEK_BASE_URL,
  wireApi: HARNESS_PROTOCOLS.codex.wireApi,
  envKey: DEEPSEEK_API_KEY_ENV,
};

/**
 * B.AI's unified API. Its Responses surface serves the GPT and DeepSeek
 * families only; models opt in through the catalog's `baiResponsesApi` flag.
 *
 * Web search is disabled: Codex attaches its web_search tool by default and
 * B.AI rejects it for DeepSeek — measured 2026-09-14, every turn failed with
 * "The current model does not support web search". The integration guide
 * prescribes the same top-level `web_search = "disabled"`.
 * https://docs.b.ai/llmservice/codex/integration-guide/
 */
export const CODEX_BAI_PROVIDER: CodexCustomProvider = {
  id: "bai",
  name: "B.AI",
  baseUrl: BAI_BASE_URL,
  wireApi: HARNESS_PROTOCOLS.codex.wireApi,
  envKey: BAI_API_KEY_ENV,
  extraConfig: { web_search: JSON.stringify("disabled") },
};

const PROVIDERS: Record<string, CodexCustomProvider> = {
  [CODEX_OPENROUTER_PROVIDER.id]: CODEX_OPENROUTER_PROVIDER,
  [CODEX_CLAUDE_SUBSCRIPTION_PROVIDER.id]: CODEX_CLAUDE_SUBSCRIPTION_PROVIDER,
  [CODEX_DEEPSEEK_PROVIDER.id]: CODEX_DEEPSEEK_PROVIDER,
  [CODEX_BAI_PROVIDER.id]: CODEX_BAI_PROVIDER,
};

export function codexCustomProvider(id: string | undefined): CodexCustomProvider | undefined {
  return id ? PROVIDERS[id] : undefined;
}

/**
 * The custom provider a Codex model slug routes through, or undefined for the
 * built-in `openai` account catalog. Catalog-driven: any catalog `orModelId`
 * (e.g. "z-ai/glm-5.2", "anthropic/claude-opus-4.8") maps to the OpenRouter
 * provider; a bare account slug (e.g. "gpt-5.5") maps to nothing (built-in
 * openai).
 */
export function codexProviderForModel(model: string, routeProvider?: string): CodexCustomProvider | undefined {
  const explicit = codexCustomProvider(routeProvider);
  if (explicit) {
    return explicit;
  }
  const lower = model.toLowerCase();
  if (catalogModelByClaudeSubscriptionModel(model)) {
    return CODEX_CLAUDE_SUBSCRIPTION_PROVIDER;
  }
  if (codexDirectDeepseekModel(model)) {
    return CODEX_DEEPSEEK_PROVIDER;
  }
  if (codexDirectBaiModel(model)) {
    return CODEX_BAI_PROVIDER;
  }
  const isOpenRouterSlug = orRoutedModels().some((m) => (m.orModelId || "").toLowerCase() === lower);
  return isOpenRouterSlug ? CODEX_OPENROUTER_PROVIDER : undefined;
}

/** Resolve a picker route before its display id is replaced by the wire slug. */
export function codexProviderForRoute(model: string, routeProvider?: string): CodexCustomProvider | undefined {
  const explicit = codexCustomProvider(routeProvider);
  if (explicit) {
    return explicit;
  }
  switch (backendFor(model, "codex")?.kind) {
    case "codex-bai":
      return CODEX_BAI_PROVIDER;
    case "codex-deepseek":
      return CODEX_DEEPSEEK_PROVIDER;
    case "codex-openrouter":
      return CODEX_OPENROUTER_PROVIDER;
    case "codex-claude-subscription":
      return CODEX_CLAUDE_SUBSCRIPTION_PROVIDER;
    default:
      return undefined;
  }
}

/**
 * Inline `-c` args that define a custom provider for a `codex app-server` spawn.
 * Empty for the built-in openai provider (no override needed).
 */
export function codexProviderConfigArgs(provider: CodexCustomProvider | undefined): string[] {
  if (!provider) {
    return [];
  }
  const prefix = `model_providers.${provider.id}`;
  return [
    "-c", `${prefix}.name=${JSON.stringify(provider.name)}`,
    "-c", `${prefix}.base_url=${JSON.stringify(provider.baseUrl)}`,
    "-c", `${prefix}.wire_api=${JSON.stringify(provider.wireApi)}`,
    "-c", `${prefix}.env_key=${JSON.stringify(provider.envKey)}`,
    "-c", `${prefix}.requires_openai_auth=false`,
    ...Object.entries(provider.extraConfig || {}).flatMap(([key, value]) => ["-c", `${key}=${value}`]),
  ];
}
