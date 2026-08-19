import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { ModelCatalogModal, type ModelCatalogValue } from "../workbench/ModelCatalogModal";
import type { RouteLike } from "../workbench/routes";
import type { GuideChatSettings } from "../../shared/guideChat";
import type { EffortSetting, HarnessId } from "../../shared/types";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * Model settings for the guide — the WORKBENCH catalog with the harness row
 * removed (design canon §6). Everything else (provider groups, search, meters,
 * favourites, effort) must stay identical: a simplified copy would teach the
 * user two different things about the same catalog.
 *
 * The guide does not ask which harness to run on — the caller has already
 * collapsed the list to one row per model, each bound to its home harness
 * (see `guideRoutes.ts`).
 */

export function GuideModelModal({
  routes,
  settings,
  onApply,
  onClose,
}: {
  routes: RouteLike[];
  settings: GuideChatSettings;
  onApply: (next: GuideChatSettings) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState("");

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
          <div className="wb-modal-head"><div className="wb-modal-title"><strong><LocalizedText id="STR-1295" /></strong></div></div>
          <div className="wb-modal-body-col"><div className="wb-inline-note is-warning">{error}</div></div>
          <div className="wb-modal-foot wb-modal-foot-end">
            <div className="wb-modal-actions"><button type="button" className="ghost-btn" onClick={onClose}><LocalizedText id="STR-1296" /></button></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ModelCatalogModal
      title={localized("STR-1297")}
      icon={<SlidersHorizontal size={16} />}
      subtitle={
        <span className="wb-modal-target" style={{ ["--member" as string]: "var(--accent)" }}>
          <span className="wb-dot" />  <LocalizedText id="STR-1298" />
        </span>
      }
      routes={routes}
      value={value}
      config={{ effort: true, serviceTier: true, thinking: true }}
      dim
      onApply={(next) => void apply(next)}
      onClose={onClose}
    />
  );
}
