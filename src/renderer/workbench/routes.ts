/** Shared shape for a model route surfaced from the main process. */
export type RouteLike = {
  harnessId?: string;
  providerId?: string;
  model: string;
  runtimeModel?: string;
  label?: string;
  enabled?: boolean;
};

export function routeKey(route: RouteLike): string {
  return [route.harnessId || "claude-code", route.providerId || "anthropic", route.model].join("::");
}

export function routeKeyForModel(model: string, routes: RouteLike[]): string {
  const route = routes.find((item) => item.model === model || item.runtimeModel === model) || routes[0];
  return route ? routeKey(route) : "";
}
