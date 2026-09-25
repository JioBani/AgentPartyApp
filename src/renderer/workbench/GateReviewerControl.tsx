import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Undo2 } from "lucide-react";
import { MessageGateIcon } from "./MessageGateIcon";
import { ModelCatalogModal } from "./ModelCatalogModal";
import { Segmented } from "./Segmented";
import { Dropdown } from "./Dropdown";
import { findRoute, type RouteLike } from "./routes";
import type { GateReviewer } from "../../shared/messageGate";
import { JEV_PROVIDER_IDS, JEV_PROVIDER_LABELS } from "../../shared/jev";
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
    if (key === "jev") continue; // Decisions transport, never a chat route.
    const existing = byModel.get(key);
    const routeAvailable = route.enabled !== false;
    const existingAvailable = existing?.enabled !== false;
    if (
      !existing ||
      (routeAvailable && !existingAvailable) ||
      (routeAvailable === existingAvailable && (route.harnessId || "claude-code") === "claude-code")
    ) {
      const tier = route.capabilities?.serviceTier;
      const concreteTiers = tier?.supported
        ? (tier.options || []).filter((option) => option.id !== "inherit")
        : [];
      byModel.set(key, concreteTiers.length > 0 ? {
        ...route,
        capabilities: {
          ...route.capabilities,
          serviceTier: {
            ...tier!,
            defaultValue: concreteTiers.find((option) => option.id === "standard")?.id || concreteTiers[0].id,
            options: concreteTiers,
          },
        },
      } : route);
    }
  }
  return Array.from(byModel.values());
}

function standardReviewer(models: RouteLike[]): GateReviewer {
  const route = models.find((item) => item.model === "GPT-5.6 Terra" && item.enabled !== false)
    ?? models.find((item) => item.enabled !== false)
    ?? models[0];
  const efforts = route?.capabilities?.effort?.supported ? route.capabilities.effort.options || [] : [];
  return {
    model: route?.model ?? "GPT-5.6 Terra",
    effort: efforts.find((item) => item.id === "low")?.id ?? efforts[0]?.id ?? "none",
  };
}

function JevGateMode({ enabled, provider, onToggle, onProvider }: {
  enabled: boolean;
  provider: string;
  onToggle: (enabled: boolean) => void;
  onProvider: (provider: string) => void;
}) {
  return <div className="wb-gate-jev-mode">
    <label className="wb-gate-jev-toggle">
      <span>메시지 게이트에 Jev 사용하기</span>
      <input type="checkbox" className="wb-switch" checked={enabled} onChange={(event) => onToggle(event.target.checked)} />
    </label>
    {enabled && <>
      <p className="wb-gate-jev-note">Jev는 메시지가 규칙을 지키는지 통과·반려·판정 불가로 분류합니다. 판정 불가이면 전송합니다. 메시지마다 Jev API 호출 비용이 발생합니다.</p>
      <label className="wb-gate-jev-provider">
        <span>Jev 제공자</span>
        <select className="set-select" value={provider} onChange={(event) => onProvider(event.target.value)}>
          {!JEV_PROVIDER_IDS.some((id) => id === provider) && <option value={provider}>{provider} (이 버전에서 지원하지 않음)</option>}
          {JEV_PROVIDER_IDS.map((id) => <option key={id} value={id}>{JEV_PROVIDER_LABELS[id]}</option>)}
        </select>
      </label>
    </>}
  </div>;
}

/**
 * Picks an ordinary model + effort or the separate Jev Decisions mode.
 *
 * One control for all three places a reviewer is chosen — the Runtime settings
 * default, a member's own gate, and the party-wide gate. Ordinary models use
 * the headless catalog; Jev uses an explicit switch and provider selector.
 */
export function GateReviewerControl({
  routes,
  reviewer,
  onChange,
  defaultJevProvider,
  modelLabel = "리뷰어 모델",
  effortLabel = "리뷰어 effort",
  badge,
}: {
  /** The full catalog; de-duplicated for headless use inside. */
  routes: RouteLike[];
  reviewer: GateReviewer;
  onChange: (reviewer: GateReviewer) => void;
  defaultJevProvider: string;
  modelLabel?: string;
  effortLabel?: string;
  /** e.g. the settings screen's 권장 marker, shown beside the model label. */
  badge?: ReactNode;
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [previousStandard, setPreviousStandard] = useState<GateReviewer | null>(reviewer.model.toLowerCase() === "jev" ? null : reviewer);
  const models = useMemo(() => headlessReviewerRoutes(routes), [routes]);
  const jevEnabled = reviewer.model.toLowerCase() === "jev";
  const selected = findRoute(reviewer.model, models);
  const effortOptions = selected?.capabilities?.effort?.supported ? (selected.capabilities.effort.options || []) : [];

  return (
    <>
      <JevGateMode
        enabled={jevEnabled}
        provider={reviewer.provider || defaultJevProvider}
        onToggle={(enabled) => {
          if (enabled) {
            setPreviousStandard(reviewer);
            onChange({ model: "jev", effort: "none", provider: defaultJevProvider });
          } else {
            onChange(previousStandard ?? standardReviewer(models));
          }
        }}
        onProvider={(provider) => onChange({ model: "jev", effort: "none", provider })}
      />
      {!jevEnabled && <>
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
      </>}
      {catalogOpen && (
        <ModelCatalogModal
          title={localized("STR-1671")}
          icon={<MessageGateIcon size={16} />}
          subtitle={<span className="wb-mono wb-modal-sub"><LocalizedText id="STR-1672" /></span>}
          routes={models}
          value={{ model: reviewer.model, effort: reviewer.effort, serviceTier: reviewer.serviceTier }}
          config={{ effort: true, serviceTier: true }}
          applyLabel="선택"
          onApply={(next) => {
            const selectedReviewer = { model: next.model, effort: next.effort || reviewer.effort, ...(next.serviceTier ? { serviceTier: next.serviceTier } : {}) };
            setPreviousStandard(selectedReviewer);
            onChange(selectedReviewer);
          }}
          onClose={() => setCatalogOpen(false)}
        />
      )}
    </>
  );
}

/** The compact gate-modal picker keeps one stable control layout in every state. */
export function GateReviewerInlineControl({
  routes,
  reviewer,
  defaultReviewer,
  defaultJevProvider,
  inherited,
  onChange,
  onInherit,
}: {
  routes: RouteLike[];
  reviewer: GateReviewer;
  defaultReviewer: GateReviewer;
  defaultJevProvider: string;
  inherited: boolean;
  onChange: (reviewer: GateReviewer) => void;
  onInherit: () => void;
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const models = useMemo(() => headlessReviewerRoutes(routes), [routes]);
  const effective = inherited ? defaultReviewer : reviewer;
  const [previousStandard, setPreviousStandard] = useState<GateReviewer | null>(effective.model.toLowerCase() === "jev" ? null : effective);
  const jevEnabled = effective.model.toLowerCase() === "jev";
  const selected = findRoute(effective.model, models);
  const effortOptions = selected?.capabilities?.effort?.supported
    ? (selected.capabilities.effort.options || [])
    : [];
  const tierOptions = selected?.capabilities?.serviceTier?.supported
    ? (selected.capabilities.serviceTier.options || [])
    : [];
  const displayedEfforts = effortOptions.length > 0
    ? effortOptions.map((option) => ({ id: option.id, label: option.label }))
    : [{ id: effective.effort, label: effective.effort }];
  const concreteTier = effective.serviceTier
    || tierOptions.find((option) => option.id === "standard")?.id
    || tierOptions[0]?.id;
  const displayedTiers = tierOptions.map((option) => ({ id: option.id, label: option.label }));

  return (
    <>
      <div className="wb-gate-reviewer-setting">
        <JevGateMode
          enabled={jevEnabled}
          provider={effective.provider || defaultJevProvider}
          onToggle={(enabled) => {
            if (enabled) {
              setPreviousStandard(effective);
              onChange({ model: "jev", effort: "none", provider: defaultJevProvider });
            } else {
              onChange(previousStandard ?? standardReviewer(models));
            }
          }}
          onProvider={(provider) => onChange({ model: "jev", effort: "none", provider })}
        />
        {!jevEnabled && <div className="wb-gate-reviewer-row">
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
            onChange={(effort) => onChange({
              model: effective.model,
              effort,
              ...(concreteTier ? { serviceTier: concreteTier } : {}),
            })}
          />
          {displayedTiers.length > 0 && concreteTier && (
            <Dropdown
              value={concreteTier}
              options={displayedTiers}
              title="Fast"
              onChange={(serviceTier) => onChange({
                model: effective.model,
                effort: effective.effort,
                serviceTier,
              })}
            />
          )}
          {!inherited && (
            <button type="button" className="wb-gate-reset" onClick={onInherit}>
              <Undo2 size={12} /> <LocalizedText id="STR-3868" />
            </button>
          )}
        </div>}
        {jevEnabled && !inherited && (
          <button type="button" className="wb-gate-reset" onClick={onInherit}>
            <Undo2 size={12} /> <LocalizedText id="STR-3868" />
          </button>
        )}
      </div>
      {catalogOpen && (
        <ModelCatalogModal
          title={localized("STR-1671")}
          icon={<MessageGateIcon size={16} />}
          routes={models}
          value={{ model: effective.model, effort: effective.effort, serviceTier: concreteTier }}
          config={{ effort: true, serviceTier: true }}
          applyLabel="선택"
          onApply={(next) => {
            const selectedReviewer = { model: next.model, effort: next.effort || effective.effort, ...(next.serviceTier ? { serviceTier: next.serviceTier } : {}) };
            setPreviousStandard(selectedReviewer);
            onChange(selectedReviewer);
          }}
          onClose={() => setCatalogOpen(false)}
        />
      )}
    </>
  );
}
