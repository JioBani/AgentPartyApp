/** Credential/model providers exposed by Authentication and Workbench. */
export type ModelProviderId = "claude" | "codex" | "cursor" | "openrouter" | "deepseek" | "grok";
export type ModelRouteProviderId = "anthropic" | "openai" | "cursor" | "openrouter" | "deepseek" | "xai";

export interface ModelProviderDescriptor {
  /** Stable user-facing provider identity. */
  id: ModelProviderId;
  label: "Claude" | "Codex" | "Cursor" | "OpenRouter" | "DeepSeek" | "Grok";
  /** Existing internal route id retained at adapter/catalog boundaries. */
  routeProviderId: ModelRouteProviderId;
  /** Provider id returned by Authentication. */
  authProviderId: ModelProviderId;
  authKind: "subscription" | "apiKey";
}

export const MODEL_PROVIDERS: readonly ModelProviderDescriptor[] = [
  { id: "claude", label: "Claude", routeProviderId: "anthropic", authProviderId: "claude", authKind: "subscription" },
  { id: "codex", label: "Codex", routeProviderId: "openai", authProviderId: "codex", authKind: "subscription" },
  { id: "cursor", label: "Cursor", routeProviderId: "cursor", authProviderId: "cursor", authKind: "subscription" },
  { id: "openrouter", label: "OpenRouter", routeProviderId: "openrouter", authProviderId: "openrouter", authKind: "apiKey" },
  { id: "deepseek", label: "DeepSeek", routeProviderId: "deepseek", authProviderId: "deepseek", authKind: "apiKey" },
  // Credentials come from the official `grok login` the user already ran, so
  // this is a subscription provider with nothing to paste into Authentication.
  { id: "grok", label: "Grok", routeProviderId: "xai", authProviderId: "grok", authKind: "subscription" },
] as const;

export function modelProviderLabel(routeProviderId: string): string {
  return MODEL_PROVIDERS.find((provider) => provider.routeProviderId === routeProviderId)?.label || "Custom";
}
