import { resolveCatalogModel } from "../../shared/modelCatalog";

export interface RouteOption {
  id: string;
  label: string;
  /** Registry-provided detail shown where the option is chosen (e.g. the Fast
   *  tier's credit-consumption note). */
  description?: string;
}

/** Multimodal input support surfaced from the catalog. `image` tri-state:
 *  true = supported, false = text-only, undefined = unknown. */
export interface RouteVision {
  image?: boolean;
  video?: boolean;
  maxImages?: number;
  maxBytesPerImage?: number;
}

/** Per-model reasoning capability surfaced from the catalog (main process). */
export interface RouteCapabilities {
  effort?: { supported: boolean; defaultValue?: string; options: RouteOption[] };
  serviceTier?: { supported: boolean; defaultValue?: string; options: RouteOption[] };
  thinking?: {
    supported: boolean;
    defaultValue?: string;
    modes?: RouteOption[];
    budget?: { default: number; min?: number; max?: number };
  };
  vision?: RouteVision;
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
  unavailableReason?: string;
  /** Disabled by the beta cross-harness lock, not by a permanent gap (B-12). */
  locked?: boolean;
  meta?: RouteMeta;
  capabilities?: RouteCapabilities;
};

export function routeKey(route: RouteLike): string {
  return [route.harnessId || "claude-code", route.providerId || "anthropic", route.model].join("::");
}

/**
 * Finds a route by a model string, tolerantly. The string may be a route id
 * ("claude-opus-5[1m]"), a runtime id ("claude-gpt-5.5"), or — because a live
 * snapshot reports the adapter's DISPLAY value — a label ("Opus 5"), in any casing.
 * Exact case-sensitive id matching silently missed the route (losing the
 * context window, vision info, and the modal's current selection) for every
 * native Anthropic model. As a last resort the string is resolved through the
 * catalog's canonical-spelling resolver: a session echoing the harness id
 * "claude-opus-5[1m]" matched NO route, which silently dropped the Runtime
 * modal's thinking (Adaptive) control and the context-meter denominator.
 */
export function findRoute(model: string | undefined, routes: RouteLike[]): RouteLike | undefined {
  if (!model) {
    return undefined;
  }
  const lower = model.toLowerCase();
  const raw =
    routes.find((item) => item.model.toLowerCase() === lower || item.runtimeModel?.toLowerCase() === lower) ||
    routes.find((item) => item.label?.toLowerCase() === lower);
  if (raw) {
    return raw;
  }
  const entry = resolveCatalogModel(model);
  if (!entry) {
    return undefined;
  }
  const id = entry.id.toLowerCase();
  const runtime = (entry.runtimeModel || entry.id).toLowerCase();
  return routes.find((item) => item.model.toLowerCase() === id || item.runtimeModel?.toLowerCase() === runtime);
}
