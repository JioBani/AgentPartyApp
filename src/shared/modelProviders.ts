/** The three credential/model providers exposed by Authentication and Workbench. */
export type ModelProviderId = "claude" | "codex" | "openrouter";
export type ModelRouteProviderId = "anthropic" | "openai" | "openrouter";

export interface ModelProviderDescriptor {
  /** Stable user-facing provider identity. */
  id: ModelProviderId;
  label: "Claude" | "Codex" | "OpenRouter";
  /** Existing internal route id retained at adapter/catalog boundaries. */
  routeProviderId: ModelRouteProviderId;
  /** Provider id returned by Authentication. */
  authProviderId: ModelProviderId;
  authKind: "subscription" | "apiKey";
}

export const MODEL_PROVIDERS: readonly ModelProviderDescriptor[] = [
  { id: "claude", label: "Claude", routeProviderId: "anthropic", authProviderId: "claude", authKind: "subscription" },
  { id: "codex", label: "Codex", routeProviderId: "openai", authProviderId: "codex", authKind: "subscription" },
  { id: "openrouter", label: "OpenRouter", routeProviderId: "openrouter", authProviderId: "openrouter", authKind: "apiKey" },
] as const;

export function modelProviderLabel(routeProviderId: string): string {
  return MODEL_PROVIDERS.find((provider) => provider.routeProviderId === routeProviderId)?.label || "Custom";
}
