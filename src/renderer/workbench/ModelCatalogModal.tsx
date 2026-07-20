import { createPortal } from "react-dom";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Lightbulb, SlidersHorizontal, X } from "lucide-react";
import { findRoute, type RouteCapabilities, type RouteLike, routeKey } from "./routes";
import { AutoCompactEditor } from "./AutoCompactEditor";
import { DEFAULT_AUTO_COMPACT, type AutoCompactSetting } from "../../shared/autoCompact";
import { VisionTag } from "./VisionTag";
import { PROVIDER_DOTS, PROVIDER_LABELS, modelView } from "./modelCatalog";
import { CostMeter, PerfMeter, groupByProvider, perfLabel, type RouteEntry } from "./modelMeters";

/** Which optional sections a given usage of the catalog exposes. */
export interface ModelCatalogConfig {
  /** Harness segment (Claude Code / Codex) + filter the model list by harness. */
  harness?: boolean;
  effort?: boolean;
  thinking?: boolean;
  /** Debug-logging toggle (Workbench-only). */
  debug?: boolean;
  /** Auto-compact editor (Workbench-only). */
  autoCompact?: boolean;
}

/** Selection carried in/out of the catalog. Only config-enabled fields matter. */
export interface ModelCatalogValue {
  /** Catalog id of the selected route. */
  model: string;
  /** Resolved selected route (callers that restart a session need it). */
  route?: RouteLike;
  harness?: string;
  effort?: string;
  thinkingMode?: string;
  thinkingBudget?: number;
  debug?: boolean;
  autoCompact?: AutoCompactSetting;
}

interface ModelCatalogModalProps {
  title: string;
  icon?: ReactNode;
  /** Extra header content after the title (e.g. a member dot + name). */
  subtitle?: ReactNode;
  /** Pre-scoped routes: harness-filtered by the caller unless `config.harness`
   *  manages the harness itself; deduped-by-model for a headless picker. */
  routes: RouteLike[];
  value: ModelCatalogValue;
  config?: ModelCatalogConfig;
  /** With `config.harness`: the harness is locked after the member's first turn. */
  harnessLocked?: boolean;
  currentHarness?: string;
  /** Context window (tokens) for the auto-compact editor's ratio. */
  contextWindow?: number;
  applyLabel?: string;
  onApply: (next: ModelCatalogValue) => void;
  onClose: () => void;
  /** Dim the backdrop. Default false — a clean floating popup (no dim). */
  dim?: boolean;
}

const HARNESS_CHOICES = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

/**
 * The single reusable model-catalog modal (the Runtime picker's UI, extracted).
 * Each usage turns sections on/off via `config` — harness / effort / thinking are
 * shown where relevant; debug + auto-compact are Workbench-only. Rendered through
 * a portal so it never clips inside another modal and never inherits a wrapping
 * `<label>`'s click behaviour. Closes via ✕ / Cancel / Escape only (not an
 * outside click), matching the app's other overlays.
 */
export function ModelCatalogModal({
  title,
  icon,
  subtitle,
  routes,
  value,
  config = {},
  harnessLocked = false,
  currentHarness = "claude-code",
  contextWindow,
  applyLabel = "Apply",
  onApply,
  onClose,
  dim = false,
}: ModelCatalogModalProps) {
  const entries = useMemo<RouteEntry[]>(() => routes.map((route) => ({ route, meta: modelView(route) })), [routes]);

  const [harness, setHarness] = useState(value.harness || currentHarness);
  const displayEntries = useMemo(
    () => (config.harness ? entries.filter((entry) => (entry.route.harnessId || "claude-code") === harness) : entries),
    [entries, config.harness, harness],
  );
  const grouped = useMemo(() => groupByProvider(displayEntries), [displayEntries]);

  const currentKey = useMemo(() => {
    const match = findRoute(value.model, displayEntries.map((entry) => entry.route));
    return match ? routeKey(match) : displayEntries[0] ? routeKey(displayEntries[0].route) : "";
  }, [displayEntries, value.model]);

  const [selectedKey, setSelectedKey] = useState(currentKey);
  const selected = displayEntries.find((entry) => routeKey(entry.route) === selectedKey) || displayEntries[0];
  const capabilities: RouteCapabilities = selected?.route.capabilities || {};
  const effortCap = capabilities.effort;
  const thinkingCap = capabilities.thinking;

  const baselineEffort = (key: string): string => {
    if (!effortCap?.supported) {
      return value.effort || "medium";
    }
    const current = key === currentKey && effortCap.options.some((option) => option.id === value.effort) ? value.effort : "";
    return current || effortCap.defaultValue || "medium";
  };
  const baselineThinking = (key: string): string => {
    if (!thinkingCap?.supported) {
      return "";
    }
    const current = key === currentKey && (thinkingCap.modes || []).some((option) => option.id === value.thinkingMode) ? value.thinkingMode || "" : "";
    return current || thinkingCap.defaultValue || "";
  };
  const baselineBudget = (key: string): number => {
    const current = key === currentKey && typeof value.thinkingBudget === "number" ? value.thinkingBudget : undefined;
    return current ?? thinkingCap?.budget?.default ?? 0;
  };

  const [effort, setEffort] = useState(() => baselineEffort(currentKey));
  const [thinkingMode, setThinkingMode] = useState<string>(() => baselineThinking(currentKey));
  const [budget, setBudget] = useState<number>(() => baselineBudget(currentKey));
  const [debug, setDebug] = useState(Boolean(value.debug));
  const initialCompact = value.autoCompact ?? DEFAULT_AUTO_COMPACT;
  const [compact, setCompact] = useState<AutoCompactSetting>(initialCompact);

  // Re-stage reasoning when the selected model (and thus its caps) changes.
  useEffect(() => {
    setEffort(baselineEffort(selectedKey));
    setThinkingMode(baselineThinking(selectedKey));
    setBudget(baselineBudget(selectedKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  useEffect(() => {
    setSelectedKey(currentKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  // Switching harness moves the selection into that harness's list.
  useEffect(() => {
    if (config.harness && selected && (selected.route.harnessId || "claude-code") !== harness && displayEntries[0]) {
      setSelectedKey(routeKey(displayEntries[0].route));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harness]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectedMeta = selected?.meta;
  const thinkingOn = Boolean(thinkingMode) && thinkingMode !== "disabled";
  const showBudget = Boolean(thinkingCap?.budget) && thinkingOn;

  const dirty =
    selectedKey !== currentKey ||
    (config.harness && harness !== (value.harness || currentHarness)) ||
    (config.effort && effortCap?.supported && effort !== baselineEffort(selectedKey)) ||
    (config.thinking && thinkingCap?.supported && thinkingMode !== baselineThinking(selectedKey)) ||
    (config.debug && debug !== Boolean(value.debug)) ||
    (config.autoCompact && (compact.on !== initialCompact.on || compact.at !== initialCompact.at));

  function apply() {
    onApply({
      model: selected?.route.model || value.model,
      route: selected?.route,
      harness: config.harness ? harness : value.harness,
      effort: config.effort && effortCap?.supported ? effort : undefined,
      thinkingMode: config.thinking && thinkingCap?.supported ? thinkingMode : undefined,
      thinkingBudget: config.thinking && showBudget ? budget : undefined,
      debug: config.debug ? debug : undefined,
      autoCompact: config.autoCompact ? compact : undefined,
    });
    onClose();
  }

  return createPortal(
    <div className={"wb-modal-scrim wb-catalog-scrim" + (dim ? " is-dim" : "")}>
      <div className="wb-modal" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            {icon ?? <SlidersHorizontal size={16} />}
            <strong>{title}</strong>
            {subtitle}
          </div>
          <button type="button" className="wb-icon-btn" title="Close" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="wb-modal-body">
          <section className="wb-model-list">
            {config.harness && (
              <>
                <div className="wb-modal-label">Harness{harnessLocked && <span className="wb-mono wb-modal-note"> · 잠금 (턴 시작됨)</span>}</div>
                <div className="wb-segmented">
                  {HARNESS_CHOICES.map((choice) => {
                    const locked = harnessLocked && choice.id !== currentHarness;
                    return (
                      <button
                        type="button"
                        key={choice.id}
                        disabled={locked}
                        title={locked ? "턴이 시작된 뒤에는 하네스를 바꿀 수 없습니다 (새 세션 필요)" : undefined}
                        className={"wb-segment" + (choice.id === harness ? " is-active" : "") + (locked ? " is-locked" : "")}
                        onClick={() => { if (!locked) setHarness(choice.id); }}
                      >
                        {choice.label}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <div className="wb-modal-label">Model <span className="wb-mono">{displayEntries.length} available</span></div>
            {grouped.map((group) => (
              <div className="wb-model-group" key={group.provider}>
                <div className="wb-model-provider">
                  <span className="wb-provider-dot" style={{ background: PROVIDER_DOTS[group.provider] }} />
                  {PROVIDER_LABELS[group.provider]}
                  <span className="wb-mono">{group.entries.length}</span>
                </div>
                {group.entries.map((entry) => {
                  const key = routeKey(entry.route);
                  return (
                    <button
                      type="button"
                      key={key}
                      className={"wb-model-row" + (key === selectedKey ? " is-selected" : "")}
                      disabled={entry.route.enabled === false}
                      onClick={() => setSelectedKey(key)}
                    >
                      <span className="wb-model-name"><span className="wb-mono">{entry.route.label || entry.meta.name}</span></span>
                      <PerfMeter value={entry.meta.perf} />
                      <CostMeter value={entry.meta.cost} />
                      {key === selectedKey && <Check size={14} className="wb-model-check" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </section>

          <section className="wb-model-detail">
            {selectedMeta && (
              <>
                <div className="wb-detail-head">
                  <span className="wb-provider-dot" style={{ background: PROVIDER_DOTS[selectedMeta.provider] }} />
                  <strong className="wb-mono">{selectedMeta.name}</strong>
                  <span className="wb-chip">{PROVIDER_LABELS[selectedMeta.provider]}</span>
                </div>

                <div className="wb-stat-cards">
                  <div className="wb-stat-card">
                    <div className="wb-modal-label">Performance</div>
                    <div className="wb-stat-row"><PerfMeter value={selectedMeta.perf} /><strong>{perfLabel(selectedMeta.perf)}</strong></div>
                  </div>
                  <div className="wb-stat-card">
                    <div className="wb-modal-label">Cost · per 1M</div>
                    <div className="wb-stat-row wb-mono wb-cost-prices">
                      {selectedMeta.inPerM && <span><b>{selectedMeta.inPerM}</b> in</span>}
                      {selectedMeta.outPerM && <span><b>{selectedMeta.outPerM}</b> out</span>}
                      {selectedMeta.ioPerM && <span><b>{selectedMeta.ioPerM}</b> io</span>}
                    </div>
                    <CostMeter value={selectedMeta.cost} />
                  </div>
                  <div className="wb-stat-card">
                    <div className="wb-modal-label">Context</div>
                    <div className="wb-stat-row wb-mono"><strong>{selectedMeta.context}</strong></div>
                  </div>
                  <div className="wb-stat-card">
                    <div className="wb-modal-label">이미지 입력</div>
                    <div className="wb-stat-row wb-mono"><VisionTag image={capabilities.vision?.image} /></div>
                  </div>
                </div>

                {config.effort && effortCap?.supported && effortCap.options.length > 0 && (
                  <div className="wb-detail-section">
                    <div className="wb-detail-section-head"><strong>Effort</strong> <span>모델별 추론 강도</span></div>
                    <div className="wb-segmented">
                      {effortCap.options.map((option) => (
                        <button type="button" key={option.id} className={"wb-segment" + (option.id === effort ? " is-active" : "")} onClick={() => setEffort(option.id)}>
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {config.thinking && thinkingCap?.supported && thinkingCap.modes && thinkingCap.modes.length > 0 && (
                  <div className="wb-detail-section">
                    <div className="wb-detail-section-head"><strong><Lightbulb size={13} /> Thinking</strong> <span>모델별 추론 모드</span></div>
                    <div className="wb-segmented">
                      {thinkingCap.modes.map((mode) => (
                        <button type="button" key={mode.id} className={"wb-segment" + (mode.id === thinkingMode ? " is-active" : "")} onClick={() => setThinkingMode(mode.id)}>
                          {mode.label}
                        </button>
                      ))}
                    </div>
                    {showBudget && thinkingCap.budget && (
                      <label className="wb-budget">
                        <span className="wb-budget-head">Thinking budget <span className="wb-mono">{budget.toLocaleString()} tok</span></span>
                        <input
                          type="range"
                          min={thinkingCap.budget.min ?? 1024}
                          max={thinkingCap.budget.max ?? 81920}
                          step={1024}
                          value={budget}
                          onChange={(event) => setBudget(Number(event.target.value))}
                        />
                      </label>
                    )}
                  </div>
                )}

                {config.debug && (
                  <label className="wb-toggle-card">
                    <span className="wb-toggle-text">
                      <SlidersHorizontal size={15} />
                      <span><strong>Debug logging</strong><small>원시 하니스 이벤트를 로그로 남깁니다.</small></span>
                    </span>
                    <input type="checkbox" className="wb-switch" checked={debug} onChange={(event) => setDebug(event.target.checked)} />
                  </label>
                )}

                {config.autoCompact && (
                  <div className="wb-detail-section">
                    <div className="wb-detail-section-head"><strong>Auto-compact</strong> <span>컨텍스트 자동 압축</span></div>
                    <AutoCompactEditor setting={compact} contextWindow={contextWindow} onChange={setCompact} />
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        <footer className="wb-modal-foot">
          <span className={"wb-dirty-note" + (dirty ? " is-dirty" : "")}>{dirty ? "변경됨 — Apply 시 적용됩니다" : "변경 사항 없음"}</span>
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="wb-btn wb-btn-accent" disabled={!dirty} onClick={apply}>{applyLabel}</button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
