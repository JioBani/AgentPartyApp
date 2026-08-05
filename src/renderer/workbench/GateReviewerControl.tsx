import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { MessageGateIcon } from "./MessageGateIcon";
import { ModelCatalogModal } from "./ModelCatalogModal";
import { Segmented } from "./Segmented";
import type { RouteLike } from "./routes";
import type { GateReviewer } from "../../shared/messageGate";

/**
 * The models a gate reviewer can run on.
 *
 * The reviewer is HEADLESS — it is a raw completion with no harness — so the
 * same model reachable through two harnesses is one choice, not two. Preferring
 * the claude-code route on a tie is arbitrary but stable, which is what keeps
 * the list from reshuffling between renders.
 */
export function headlessReviewerRoutes(routes: RouteLike[]): RouteLike[] {
  const byModel = new Map<string, RouteLike>();
  for (const route of routes) {
    const existing = byModel.get(route.model);
    if (!existing || (route.harnessId || "claude-code") === "claude-code") {
      byModel.set(route.model, route);
    }
  }
  return Array.from(byModel.values());
}

/**
 * Picks the model + effort a Message Gate reviewer runs on.
 *
 * One control for all three places a reviewer is chosen — the Runtime settings
 * default, a member's own gate, and the party-wide gate — laid out the same way
 * as a harness card: browse models in the catalog modal (search, cost, context),
 * retune effort inline. Each of those screens used to carry its own copy of the
 * trigger AND of the headless de-duplication above, so they drifted apart.
 */
export function GateReviewerControl({
  routes,
  reviewer,
  onChange,
  modelLabel = "리뷰어 모델",
  effortLabel = "리뷰어 effort",
  badge,
}: {
  /** The full catalog; de-duplicated for headless use inside. */
  routes: RouteLike[];
  reviewer: GateReviewer;
  onChange: (reviewer: GateReviewer) => void;
  modelLabel?: string;
  effortLabel?: string;
  /** e.g. the settings screen's 권장 marker, shown beside the model label. */
  badge?: ReactNode;
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const models = useMemo(() => headlessReviewerRoutes(routes), [routes]);
  const selected = models.find((route) => route.model === reviewer.model);
  const effortOptions = selected?.capabilities?.effort?.supported ? (selected.capabilities.effort.options || []) : [];

  return (
    <>
      <div className="set-field">
        <span className="set-field-label">{modelLabel} {badge}</span>
        <button type="button" className="wb-model-picker-trigger set-model-trigger" onClick={() => setCatalogOpen(true)}>
          <span className="wb-mono">{selected?.label || reviewer.model}</span>
          <ChevronDown size={14} />
        </button>
      </div>
      {effortOptions.length > 0 && (
        <div className="set-field">
          <span className="set-field-label">{effortLabel}</span>
          <Segmented
            value={reviewer.effort}
            options={effortOptions.map((option) => ({ id: option.id, label: option.label }))}
            onChange={(effort) => onChange({ ...reviewer, effort })}
          />
        </div>
      )}
      {catalogOpen && (
        <ModelCatalogModal
          title="게이트 리뷰어 모델"
          icon={<MessageGateIcon size={16} />}
          subtitle={<span className="wb-mono wb-modal-sub">헤드리스 · 하네스 없음</span>}
          routes={models}
          value={{ model: reviewer.model, effort: reviewer.effort }}
          config={{ effort: true }}
          applyLabel="선택"
          onApply={(next) => onChange({ model: next.model, effort: next.effort || reviewer.effort })}
          onClose={() => setCatalogOpen(false)}
        />
      )}
    </>
  );
}
