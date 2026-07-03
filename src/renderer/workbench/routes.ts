export interface RouteOption {
  id: string;
  label: string;
}

/** Per-model reasoning capability surfaced from the catalog (main process). */
export interface RouteCapabilities {
  effort?: { supported: boolean; defaultValue?: string; options: RouteOption[] };
  thinking?: {
    supported: boolean;
    defaultValue?: string;
    modes?: RouteOption[];
    budget?: { default: number; min?: number; max?: number };
  };
}

/** Leaderboard metrics surfaced from the catalog. */
export interface RouteMeta {
  perf?: number;
  costTier?: number;
  inPerM?: number;
  outPerM?: number;
  ioPerM?: number;
  context?: string;
}

/** Shared shape for a model route surfaced from the main process. */
export type RouteLike = {
  harnessId?: string;
  providerId?: string;
  /** Codex custom provider id (e.g. "openrouter"); absent = built-in account. */
  modelProvider?: string;
  model: string;
  runtimeModel?: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  meta?: RouteMeta;
  capabilities?: RouteCapabilities;
};

export function routeKey(route: RouteLike): string {
  return [route.harnessId || "claude-code", route.providerId || "anthropic", route.model].join("::");
}

export function routeKeyForModel(model: string, routes: RouteLike[]): string {
  const route = routes.find((item) => item.model === model || item.runtimeModel === model) || routes[0];
  return route ? routeKey(route) : "";
}
