import { useEffect, useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { ModelCatalogModal, type ModelCatalogValue } from "../workbench/ModelCatalogModal";
import type { RouteLike } from "../workbench/routes";
import type { GuideChatSettings } from "../../shared/guideChat";
import type { EffortSetting, HarnessId } from "../../shared/types";

/**
 * Model settings for the guide — the WORKBENCH catalog with the harness row
 * removed (design canon §6). Everything else (provider groups, search, meters,
 * favourites, effort) must stay identical: a simplified copy would teach the
 * user two different things about the same catalog.
 *
 * The guide does not ask which harness to run on. Picking a model connects that
 * model's own default harness, resolved by {@link HARNESS_PREFERENCE}.
 */

/** Only harnesses the guide can actually run on are offered. */
const GUIDE_HARNESSES: HarnessId[] = ["claude-code", "codex", "cursor", "grok"];

/** A model's HOME harness — the one whose vendor actually makes it. The same
 *  model is often offered by several harnesses; picking one in the guide should
 *  connect the harness it belongs to, not whichever happens to sort first. */
const HOME_BY_PROVIDER: Record<string, HarnessId> = {
  anthropic: "claude-code",
  openai: "codex",
  cursor: "cursor",
  xai: "grok",
};

/** Fallback order for models with no home harness (OpenRouter, DeepSeek, …). */
const HARNESS_PREFERENCE = GUIDE_HARNESSES;

/** Lower is better. A route on the model's home harness always wins. */
function rankOf(route: RouteLike): number {
  const harness = (route.harnessId || "claude-code") as HarnessId;
  const home = HOME_BY_PROVIDER[route.providerId || ""];
  if (home && harness === home) {
    return -1;
  }
  return HARNESS_PREFERENCE.indexOf(harness);
}

/** One row per model: the same model offered by several harnesses collapses to
 *  its preferred one, because the guide shows models, not harness × model. */
function dedupeByModel(routes: RouteLike[]): RouteLike[] {
  const best = new Map<string, RouteLike>();
  for (const route of routes) {
    const key = route.label || route.model;
    if (!HARNESS_PREFERENCE.includes((route.harnessId || "claude-code") as HarnessId)) {
      continue;
    }
    const rank = rankOf(route);
    const held = best.get(key);
    const heldRank = held ? rankOf(held) : Number.MAX_SAFE_INTEGER;
    if (!held || rank < heldRank) {
      best.set(key, route);
    }
  }
  return [...best.values()];
}

export function GuideModelModal({
  settings,
  onApply,
  onClose,
}: {
  settings: GuideChatSettings;
  onApply: (next: GuideChatSettings) => void;
  onClose: () => void;
}) {
  const [routes, setRoutes] = useState<RouteLike[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.agentPartyGuide
      .listRoutes()
      .then(setRoutes)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, []);

  const scoped = useMemo(
    () => dedupeByModel(routes.filter((route) => GUIDE_HARNESSES.includes((route.harnessId || "claude-code") as HarnessId))),
    [routes],
  );

  const value: ModelCatalogValue = {
    model: settings.model || "",
    effort: settings.effort,
  };

  async function apply(next: ModelCatalogValue) {
    const harnessId = (next.route?.harnessId || "claude-code") as HarnessId;
    try {
      const saved = await window.agentPartyGuide.updateChatSettings({
        harnessId,
        model: next.route?.model || next.model,
        effort: next.effort as EffortSetting | undefined,
      });
      onApply(saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  if (error) {
    // A catalog we could not load must say so — never a silently empty list.
    return (
      <div className="wb-modal-scrim is-dim" onClick={onClose}>
        <div className="wb-modal wb-modal-sm" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
          <div className="wb-modal-head"><div className="wb-modal-title"><strong>모델 설정</strong></div></div>
          <div className="wb-modal-body-col"><div className="wb-inline-note is-warning">{error}</div></div>
          <div className="wb-modal-foot wb-modal-foot-end">
            <div className="wb-modal-actions"><button type="button" className="ghost-btn" onClick={onClose}>닫기</button></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ModelCatalogModal
      title="모델 설정"
      icon={<SlidersHorizontal size={16} />}
      subtitle={
        <span className="wb-modal-target" style={{ ["--member" as string]: "var(--accent)" }}>
          <span className="wb-dot" /> 가이드
        </span>
      }
      routes={scoped}
      value={value}
      config={{ effort: true, serviceTier: true, thinking: true }}
      dim
      onApply={(next) => void apply(next)}
      onClose={onClose}
    />
  );
}
