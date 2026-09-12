import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { MessageGateIcon } from "./MessageGateIcon";
import { ModelCatalogModal } from "./ModelCatalogModal";
import { Segmented } from "./Segmented";
import { Dropdown } from "./Dropdown";
import { findRoute, type RouteLike } from "./routes";
import type { GateReviewer } from "../../shared/messageGate";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * The models a gate reviewer can run on.
 *
 * The reviewer is HEADLESS — it is a raw completion with no harness — so the
 * same model reachable through two harnesses is one choice, not two. Prefer an
 * available route over a locked alias, then the claude-code route on a true tie;
 * this keeps the list useful and stable without exposing headless-irrelevant
 * harness duplicates.
 */
export function headlessReviewerRoutes(routes: RouteLike[]): RouteLike[] {
  const byModel = new Map<string, RouteLike>();
  for (const route of routes) {
    const key = route.model.trim().toLowerCase().replace(/[\s_-]+/g, "-");
    const existing = byModel.get(key);
    const routeAvailable = route.enabled !== false;
    const existingAvailable = existing?.enabled !== false;
    if (
      !existing ||
      (routeAvailable && !existingAvailable) ||
      (routeAvailable === existingAvailable && (route.harnessId || "claude-code") === "claude-code")
    ) {
      byModel.set(key, route);
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
  const selected = findRoute(reviewer.model, models);
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
          title={localized("STR-1671")}
          icon={<MessageGateIcon size={16} />}
          subtitle={<span className="wb-mono wb-modal-sub"><LocalizedText id="STR-1672" /></span>}
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

/**
 * The compact gate-modal picker. Model inheritance is a model-menu choice,
 * rather than a separate switch, so the whole reviewer control remains one
 * row while still exposing the effective model and effort.
 */
export function GateReviewerInlineControl({
  routes,
  reviewer,
  defaultReviewer,
  inherited,
  onChange,
  onInherit,
}: {
  routes: RouteLike[];
  reviewer: GateReviewer;
  defaultReviewer: GateReviewer;
  inherited: boolean;
  onChange: (reviewer: GateReviewer) => void;
  onInherit: () => void;
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const models = useMemo(() => headlessReviewerRoutes(routes), [routes]);
  const effective = inherited ? defaultReviewer : reviewer;
  const selected = findRoute(effective.model, models);
  const defaultSelected = findRoute(defaultReviewer.model, models);
  const defaultEffortOptions = defaultSelected?.capabilities?.effort?.supported
    ? (defaultSelected.capabilities.effort.options || [])
    : [];
  const defaultEffortLabel = defaultEffortOptions.find((option) => option.id === defaultReviewer.effort)?.label
    || defaultReviewer.effort;
  const effortOptions = selected?.capabilities?.effort?.supported
    ? (selected.capabilities.effort.options || [])
    : [];
  const displayedEfforts = effortOptions.length > 0
    ? effortOptions.map((option) => ({ id: option.id, label: option.label }))
    : [{ id: effective.effort, label: effective.effort }];

  return (
    <>
      <div className="wb-gate-reviewer-row">
        <strong><LocalizedText id="STR-3866" /></strong>
        <button
          type="button"
          className="wb-pill wb-dd-trigger"
          title={`${localized("STR-1669")}: ${selected?.label || effective.model}`}
          onClick={() => setCatalogOpen(true)}
        >
          <span className="wb-dd-label">{selected?.label || effective.model}</span>
          <ChevronDown size={11} className="wb-pill-caret" />
        </button>
        <Dropdown
          value={effective.effort}
          options={displayedEfforts}
          title={localized("STR-1670")}
          disabled={inherited}
          onChange={(effort) => onChange({ ...effective, effort })}
        />
      </div>
      {catalogOpen && (
        <ModelCatalogModal
          title={localized("STR-1671")}
          icon={<MessageGateIcon size={16} />}
          routes={models}
          value={{ model: effective.model, effort: effective.effort, useDefault: inherited }}
          config={{ effort: true }}
          defaultChoice={{
            label: localized("STR-3865"),
            hint: `${defaultSelected?.label || defaultReviewer.model} · ${defaultEffortLabel}`,
            selected: inherited,
          }}
          applyLabel="선택"
          onApply={(next) => {
            if (next.useDefault) {
              onInherit();
              return;
            }
            onChange({ model: next.model, effort: next.effort || effective.effort });
          }}
          onClose={() => setCatalogOpen(false)}
        />
      )}
    </>
  );
}
