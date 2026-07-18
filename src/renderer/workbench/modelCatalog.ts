/**
 * Display helpers for the Runtime modal. All real model data (perf, cost,
 * prices, context, reasoning controls) now comes from the main process on each
 * route (sourced from src/shared/modelCatalog.json); this file only maps a route
 * into the small view shape the modal renders, with neutral fallbacks so an
 * unknown route never disappears.
 */
import type { RouteLike } from "./routes";
import { modelProviderLabel } from "../../shared/modelProviders";

export type ProviderId = "anthropic" | "openai" | "openrouter" | "custom";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  // Internal catalog ids name API vendors; the product surface names the
  // credentials users actually connect in Authentication.
  anthropic: modelProviderLabel("anthropic"),
  openai: modelProviderLabel("openai"),
  openrouter: modelProviderLabel("openrouter"),
  custom: "Custom",
};

export const PROVIDER_DOTS: Record<ProviderId, string> = {
  anthropic: "#e0a14e",
  openai: "#54b585",
  openrouter: "#a07bff",
  custom: "#79808d",
};

export interface ModelView {
  id: string;
  name: string;
  provider: ProviderId;
  /** Performance tier 0-5 (leaderboard '칸'); undefined when not benchmarked. */
  perf?: number;
  /** Cost tier 1-5 (leaderboard '비용'). */
  cost?: number;
  inPerM?: string;
  outPerM?: string;
  ioPerM?: string;
  context: string;
}

const PROVIDERS: ProviderId[] = ["anthropic", "openai", "openrouter", "custom"];

export function routeProvider(route: RouteLike): ProviderId {
  const provider = route.providerId as ProviderId;
  return PROVIDERS.includes(provider) ? provider : "custom";
}

function price(value: number | undefined): string | undefined {
  return typeof value === "number" ? `$${value}` : undefined;
}

/** Normalizes a route's catalog metrics into the modal's display shape. */
export function modelView(route: RouteLike): ModelView {
  const meta = route.meta || {};
  return {
    id: route.model,
    name: route.label || route.model,
    provider: routeProvider(route),
    perf: meta.perf,
    cost: meta.costTier,
    inPerM: price(meta.inPerM),
    outPerM: price(meta.outPerM),
    ioPerM: price(meta.ioPerM),
    context: meta.context || "—",
  };
}
