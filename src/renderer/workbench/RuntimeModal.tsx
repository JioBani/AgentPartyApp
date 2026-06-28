import { useEffect, useMemo, useState } from "react";
import { Check, Lightbulb, SlidersHorizontal, X } from "lucide-react";
import type { MemberView } from "./types";
import type { WorkbenchActions } from "./actions";
import { RouteCapabilities, RouteLike, routeKey } from "./routes";
import { ModelView, PROVIDER_DOTS, PROVIDER_LABELS, ProviderId, modelView, routeProvider } from "./modelCatalog";

interface RuntimeModalProps {
  view: MemberView;
  routes: RouteLike[];
  debugEnabled: boolean;
  actions: WorkbenchActions;
  onClose: () => void;
}

interface RouteEntry {
  route: RouteLike;
  meta: ModelView;
}

/**
 * Per-member model settings. Changes are staged and only committed on Apply,
 * which restarts the member's session (hence the dirty note in the footer).
 */
export function RuntimeModal({ view, routes, debugEnabled, actions, onClose }: RuntimeModalProps) {
  const entries = useMemo<RouteEntry[]>(() => routes.map((route) => ({ route, meta: modelView(route) })), [routes]);

  const currentKey = useMemo(() => {
    const match = routes.find((route) => route.model === view.model || route.runtimeModel === view.model);
    return match ? routeKey(match) : entries[0] ? routeKey(entries[0].route) : "";
  }, [routes, entries, view.model]);

  const [selectedKey, setSelectedKey] = useState(currentKey);
  const selected = entries.find((entry) => routeKey(entry.route) === selectedKey) || entries[0];
  const capabilities: RouteCapabilities = selected?.route.capabilities || {};
  const effortCap = capabilities.effort;
  const thinkingCap = capabilities.thinking;

  const [effort, setEffort] = useState(view.effort || effortCap?.defaultValue || "medium");
  const [thinkingMode, setThinkingMode] = useState<string>(thinkingCap?.defaultValue || "");
  const [budget, setBudget] = useState<number>(thinkingCap?.budget?.default ?? 0);
  const [debug, setDebug] = useState(debugEnabled);

  // Reset staged reasoning values when the selected model (and thus its
  // capabilities) changes, so controls always reflect that model's spec.
  useEffect(() => {
    setEffort(effortCap?.supported ? effortCap.defaultValue || "medium" : "medium");
    setThinkingMode(thinkingCap?.supported ? thinkingCap.defaultValue || "" : "");
    setBudget(thinkingCap?.budget?.default ?? 0);
  }, [selectedKey]);

  useEffect(() => {
    setSelectedKey(currentKey);
    setDebug(debugEnabled);
  }, [currentKey, debugEnabled]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectedMeta = selected?.meta;
  const thinkingOn = Boolean(thinkingMode) && thinkingMode !== "disabled";
  const showBudget = Boolean(thinkingCap?.budget) && thinkingOn;

  const dirty =
    selectedKey !== currentKey ||
    (effortCap?.supported && effort !== (effortCap.defaultValue || "medium")) ||
    (thinkingCap?.supported && thinkingMode !== (thinkingCap.defaultValue || "")) ||
    debug !== debugEnabled;

  const grouped = useMemo(() => groupByProvider(entries), [entries]);

  function apply() {
    actions.applyRuntime(view.name, {
      route: selected?.route,
      effort: effortCap?.supported ? effort : undefined,
      thinkingMode: thinkingCap?.supported ? thinkingMode : undefined,
      thinkingBudget: showBudget ? budget : undefined,
      debug,
    });
    onClose();
  }

  return (
    <div className="wb-modal-scrim" onMouseDown={onClose}>
      <div className="wb-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <SlidersHorizontal size={16} />
            <strong>Runtime</strong>
            <span className="wb-modal-target" style={{ ["--member" as string]: view.color }}>
              <span className="wb-dot" /> {view.name}
            </span>
            <span className="wb-mono wb-modal-sub">Claude Code</span>
          </div>
          <button type="button" className="wb-icon-btn" title="Close" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="wb-modal-body">
          <section className="wb-model-list">
            <div className="wb-modal-label">Model <span className="wb-mono">{entries.length} available</span></div>
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
                      onClick={() => setSelectedKey(key)}
                    >
                      <span className="wb-model-name">
                        <span className="wb-mono">{entry.route.label || entry.meta.name}</span>
                      </span>
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
                </div>

                {effortCap?.supported && effortCap.options.length > 0 && (
                  <div className="wb-detail-section">
                    <div className="wb-detail-section-head"><strong>Effort</strong> <span>모델별 추론 강도</span></div>
                    <div className="wb-segmented">
                      {effortCap.options.map((option) => (
                        <button
                          type="button"
                          key={option.id}
                          className={"wb-segment" + (option.id === effort ? " is-active" : "")}
                          onClick={() => setEffort(option.id)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {thinkingCap?.supported && thinkingCap.modes && thinkingCap.modes.length > 0 && (
                  <div className="wb-detail-section">
                    <div className="wb-detail-section-head"><strong><Lightbulb size={13} /> Thinking</strong> <span>모델별 추론 모드</span></div>
                    <div className="wb-segmented">
                      {thinkingCap.modes.map((mode) => (
                        <button
                          type="button"
                          key={mode.id}
                          className={"wb-segment" + (mode.id === thinkingMode ? " is-active" : "")}
                          onClick={() => setThinkingMode(mode.id)}
                        >
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

                <label className="wb-toggle-card">
                  <span className="wb-toggle-text">
                    <SlidersHorizontal size={15} />
                    <span><strong>Debug logging</strong><small>원시 하니스 이벤트를 로그로 남깁니다.</small></span>
                  </span>
                  <input type="checkbox" className="wb-switch" checked={debug} onChange={(event) => setDebug(event.target.checked)} />
                </label>
              </>
            )}
          </section>
        </div>

        <footer className="wb-modal-foot">
          <span className={"wb-dirty-note" + (dirty ? " is-dirty" : "")}>{dirty ? "변경됨 — Apply 시 이 멤버에 적용됩니다" : "변경 사항 없음"}</span>
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="wb-btn wb-btn-accent" disabled={!dirty} onClick={apply}>Apply</button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function perfLabel(value: number | undefined): string {
  if (value == null) {
    return "—";
  }
  return `${value} / 5`;
}

function PerfMeter({ value }: { value: number | undefined }) {
  const v = value ?? 0;
  return (
    <span className={"wb-meter wb-perf" + (v >= 4 ? " is-high" : "")} title={value == null ? "Performance n/a" : `Performance ${v}/5`}>
      {[1, 2, 3, 4, 5].map((bar) => (
        <i key={bar} className={bar <= v ? "is-on" : ""} style={{ height: `${3 + bar * 2}px` }} />
      ))}
    </span>
  );
}

function CostMeter({ value }: { value: number | undefined }) {
  const v = value ?? 0;
  return (
    <span className="wb-meter wb-cost wb-mono" title={value == null ? "Cost n/a" : `Cost ${v}/5`}>
      {[1, 2, 3, 4, 5].map((bar) => (
        <span key={bar} className={bar <= v ? "is-on" : "is-off"}>$</span>
      ))}
    </span>
  );
}

function groupByProvider(entries: RouteEntry[]): Array<{ provider: ProviderId; entries: RouteEntry[] }> {
  const order: ProviderId[] = ["anthropic", "openai", "openrouter", "custom"];
  const buckets = new Map<ProviderId, RouteEntry[]>();
  for (const entry of entries) {
    const provider = routeProvider(entry.route);
    if (!buckets.has(provider)) {
      buckets.set(provider, []);
    }
    buckets.get(provider)!.push(entry);
  }
  return order
    .filter((provider) => buckets.has(provider))
    .map((provider) => ({ provider, entries: buckets.get(provider)! }));
}
