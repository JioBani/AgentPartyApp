/**
 * The model list the guide offers, and how a chosen model binds to a harness.
 *
 * The guide shows MODELS, not harness × model (design canon §6: the harness row
 * is removed). So the workbench's route list — one entry per harness per model —
 * is collapsed to one entry per model, bound to the harness that model belongs
 * to. Both the catalog modal and the composer pill read from here, so the label
 * on the pill and the row in the catalog can never disagree.
 */
import { useEffect, useState } from "react";
import type { RouteLike } from "../workbench/routes";
import type { HarnessId } from "../../shared/types";

/** Only harnesses the guide can actually run on are offered. */
export const GUIDE_HARNESSES: HarnessId[] = ["claude-code", "codex", "cursor", "grok"];

/** A model's HOME harness — the one whose vendor actually makes it. Picking a
 *  model should connect the harness it belongs to, not whichever sorts first. */
const HOME_BY_PROVIDER: Record<string, HarnessId> = {
  anthropic: "claude-code",
  openai: "codex",
  cursor: "cursor",
  xai: "grok",
};

/** Lower is better. A route on the model's home harness always wins; models with
 *  no home (OpenRouter, DeepSeek, …) fall back to the declared order. */
function rankOf(route: RouteLike): number {
  const harness = (route.harnessId || "claude-code") as HarnessId;
  const home = HOME_BY_PROVIDER[route.providerId || ""];
  return home && harness === home ? -1 : GUIDE_HARNESSES.indexOf(harness);
}

/** One row per model, each bound to its home harness. */
export function scopeGuideRoutes(routes: RouteLike[]): RouteLike[] {
  const best = new Map<string, RouteLike>();
  for (const route of routes) {
    if (!GUIDE_HARNESSES.includes((route.harnessId || "claude-code") as HarnessId)) {
      continue;
    }
    const key = route.label || route.model;
    const held = best.get(key);
    if (!held || rankOf(route) < rankOf(held)) {
      best.set(key, route);
    }
  }
  return [...best.values()];
}

/** The catalog's own name for a model id — never the raw id, which is what the
 *  composer pill used to print. */
export function guideModelLabel(routes: RouteLike[], model: string | undefined): string {
  if (!model) {
    return "모델 없음";
  }
  const hit = routes.find((route) => route.model === model);
  return hit?.label || model;
}

export function useGuideRoutes(): { routes: RouteLike[]; error: string } {
  const [routes, setRoutes] = useState<RouteLike[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    void window.agentPartyGuide
      .listRoutes()
      .then((next) => setRoutes(scopeGuideRoutes(next)))
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, []);
  return { routes, error };
}
