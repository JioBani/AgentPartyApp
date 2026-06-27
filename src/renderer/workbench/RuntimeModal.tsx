import { useEffect, useMemo, useState } from "react";
import { Check, Lightbulb, SlidersHorizontal, X } from "lucide-react";
import type { MemberView } from "./types";
import type { WorkbenchActions } from "./actions";
import { RouteLike, routeKey } from "./routes";
import { MODEL_CATALOG, ModelMeta, PROVIDER_DOTS, PROVIDER_LABELS, ProviderId, modelMeta } from "./modelCatalog";

interface RuntimeModalProps {
  view: MemberView;
  routes: RouteLike[];
  debugEnabled: boolean;
  actions: WorkbenchActions;
  onClose: () => void;
}

interface RouteEntry {
  route: RouteLike;
  meta: ModelMeta;
}

/**
 * Per-member model settings. Changes are staged and only committed on Apply,
 * which restarts the member's session (hence the dirty note in the footer).
 */
export function RuntimeModal({ view, routes, debugEnabled, actions, onClose }: RuntimeModalProps) {
  const entries = useMemo<RouteEntry[]>(
    () => routes.map((route) => ({ route, meta: modelMeta(route.model, (route.providerId as ProviderId) || undefined) })),
    [routes],
  );

  const currentKey = useMemo(() => {
    const match = routes.find((route) => route.model === view.model || route.runtimeModel === view.model);
    return match ? routeKey(match) : entries[0] ? routeKey(entries[0].route) : "";
  }, [routes, entries, view.model]);

  const [selectedKey, setSelectedKey] = useState(currentKey);
  const [effort, setEffort] = useState(view.effort || "medium");
  const [thinking, setThinking] = useState(false);
  const [debug, setDebug] = useState(debugEnabled);

  useEffect(() => {
    setSelectedKey(currentKey);
    setEffort(view.effort || "medium");
    setDebug(debugEnabled);
  }, [currentKey, view.effort, debugEnabled]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selected = entries.find((entry) => routeKey(entry.route) === selectedKey) || entries[0];
  const selectedMeta = selected?.meta;
  const effortOptions = selectedMeta?.efforts || ["low", "medium", "high"];

  const dirty = selectedKey !== currentKey || effort !== (view.effort || "medium") || debug !== debugEnabled || thinking;

  const grouped = useMemo(() => groupByProvider(entries), [entries]);

  function apply() {
    actions.applyRuntime(view.name, { route: selected?.route, effort, thinking, debug });
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
                        <small>{entry.meta.tier}</small>
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
                    <div className="wb-stat-row"><PerfMeter value={selectedMeta.perf} /><strong>{selectedMeta.tier}</strong></div>
                  </div>
                  <div className="wb-stat-card">
                    <div className="wb-modal-label">Cost · per 1M</div>
                    <div className="wb-stat-row wb-mono"><strong>{selectedMeta.inPerM}</strong> in <strong>{selectedMeta.outPerM}</strong> out</div>
                    <CostMeter value={selectedMeta.cost} />
                  </div>
                  <div className="wb-stat-card">
                    <div className="wb-modal-label">Context</div>
                    <div className="wb-stat-row wb-mono"><strong>{selectedMeta.context}</strong></div>
                  </div>
                </div>

                <div className="wb-detail-section">
                  <div className="wb-detail-section-head"><strong>Effort</strong> <span>모델에 따라 선택지가 달라집니다</span></div>
                  <div className="wb-segmented">
                    {effortOptions.map((option) => (
                      <button
                        type="button"
                        key={option}
                        className={"wb-segment" + (option === effort ? " is-active" : "")}
                        onClick={() => setEffort(option)}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>

                {selectedMeta.thinking && (
                  <label className="wb-toggle-card">
                    <span className="wb-toggle-text">
                      <Lightbulb size={15} />
                      <span><strong>Extended thinking</strong><small>응답하기 전에 모델이 먼저 추론하도록 합니다.</small></span>
                    </span>
                    <input type="checkbox" className="wb-switch" checked={thinking} onChange={(event) => setThinking(event.target.checked)} />
                  </label>
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

function PerfMeter({ value }: { value: number }) {
  return (
    <span className={"wb-meter wb-perf" + (value >= 4 ? " is-high" : "")} title={`Performance ${value}/4`}>
      {[1, 2, 3, 4].map((bar) => (
        <i key={bar} className={bar <= value ? "is-on" : ""} style={{ height: `${4 + bar * 2}px` }} />
      ))}
    </span>
  );
}

function CostMeter({ value }: { value: number }) {
  return (
    <span className="wb-meter wb-cost wb-mono" title={`Cost ${value}/5`}>
      {[1, 2, 3, 4, 5].map((bar) => (
        <span key={bar} className={bar <= value ? "is-on" : "is-off"}>$</span>
      ))}
    </span>
  );
}

function groupByProvider(entries: RouteEntry[]): Array<{ provider: ProviderId; entries: RouteEntry[] }> {
  const order: ProviderId[] = ["anthropic", "openai", "openrouter", "custom"];
  const buckets = new Map<ProviderId, RouteEntry[]>();
  for (const entry of entries) {
    const provider = entry.meta.provider;
    if (!buckets.has(provider)) {
      buckets.set(provider, []);
    }
    buckets.get(provider)!.push(entry);
  }
  return order
    .filter((provider) => buckets.has(provider))
    .map((provider) => ({ provider, entries: buckets.get(provider)! }));
}

export { MODEL_CATALOG };
