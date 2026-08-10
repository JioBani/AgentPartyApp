import { createPortal } from "react-dom";
import { useSubtreeVisible } from "./SubtreeVisibility";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Lightbulb, Search, SlidersHorizontal, Star, X } from "lucide-react";
import { findRoute, type RouteCapabilities, type RouteLike, routeKey } from "./routes";
import { AutoCompactEditor } from "./AutoCompactEditor";
import { DEFAULT_AUTO_COMPACT, type AutoCompactSetting } from "../../shared/autoCompact";
import { VisionTag } from "./VisionTag";
import { PROVIDER_DOTS, PROVIDER_LABELS, modelView, routeProvider } from "./modelCatalog";
import { CostMeter, PerfMeter, perfLabel, type RouteEntry } from "./modelMeters";
import { buildCatalogView, catalogCountLabel, initialProvOpen } from "./modelCatalogGroups";
import { toggleFavoriteModelId, useFavoriteModels } from "../app/favoriteModelPrefs";

/** Which optional sections a given usage of the catalog exposes. */
export interface ModelCatalogConfig {
  /** Harness segment (Claude Code / Codex) + filter the model list by harness. */
  harness?: boolean;
  effort?: boolean;
  serviceTier?: boolean;
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
  serviceTier?: string;
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
  { id: "cursor", label: "Cursor CLI" },
  { id: "grok", label: "Grok Build" },
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
  const currentKey = useMemo(() => {
    const match = findRoute(value.model, displayEntries.map((entry) => entry.route));
    return match ? routeKey(match) : displayEntries[0] ? routeKey(displayEntries[0].route) : "";
  }, [displayEntries, value.model]);

  const [selectedKey, setSelectedKey] = useState(currentKey);
  const selected = displayEntries.find((entry) => routeKey(entry.route) === selectedKey) || displayEntries[0];

  // --- Catalog list: search + provider collapse + favourites ---------------
  const favorites = useFavoriteModels();
  /** Never persisted: a stale query on reopen would hide most of the catalog. */
  const [query, setQuery] = useState("");
  const [provOpen, setProvOpen] = useState<Record<string, boolean>>(() => initialProvOpen(displayEntries, currentKey, favorites));
  /** Set once the user collapses/expands anything themselves. */
  const provTouched = useRef(false);
  const [favoriteError, setFavoriteError] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  const catalog = useMemo(
    () => buildCatalogView({ entries: displayEntries, query, favorites, provOpen, selectedKey }),
    [displayEntries, query, favorites, provOpen, selectedKey],
  );

  /**
   * Keeps the opening expansion ("show the current model's group, unless it is
   * starred and therefore already pinned on top") correct as its inputs land.
   *
   * It cannot be computed once at mount: favourites arrive over a subscription
   * and can still be empty on the first render, and the current model changes
   * identity when the harness switches. Re-derived while the user has not
   * collapsed or expanded anything themselves — after that their choice wins.
   *
   * A harness switch is the exception: the list becomes an entirely different
   * set of models, so previous toggles no longer refer to anything.
   */
  const lastHarness = useRef(harness);
  useEffect(() => {
    if (lastHarness.current !== harness) {
      lastHarness.current = harness;
      provTouched.current = false;
    }
    if (!provTouched.current) {
      setProvOpen(initialProvOpen(displayEntries, currentKey, favorites));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favorites, currentKey, harness]);

  function setProviderOpen(provider: string, open: boolean) {
    provTouched.current = true;
    setProvOpen((current) => ({ ...current, [provider]: open }));
  }

  function clearQuery() {
    setQuery("");
    searchRef.current?.focus();
  }

  /**
   * Stars/unstars without disturbing the selection (the click must not fall
   * through to the row). Unstarring the CURRENT model sends it back to its
   * provider group, so that group is expanded — otherwise a collapsed header
   * would make the model the user is using look like it vanished.
   */
  async function toggleFavorite(entry: RouteEntry) {
    const id = entry.route.model;
    const unstarring = favorites.includes(id);
    if (unstarring && routeKey(entry.route) === selectedKey) {
      setProviderOpen(routeProvider(entry.route), true);
    }
    try {
      setFavoriteError("");
      await toggleFavoriteModelId(id);
    } catch {
      // A star that quietly fails to save is worse than one that refuses: the
      // user believes the list is tidied and finds it reverted next launch.
      setFavoriteError("즐겨찾기를 저장하지 못했습니다.");
    }
  }
  const visible = useSubtreeVisible();
  const capabilities: RouteCapabilities = selected?.route.capabilities || {};
  const effortCap = capabilities.effort;
  const thinkingCap = capabilities.thinking;
  const serviceTierCap = capabilities.serviceTier;

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
  const [serviceTier, setServiceTier] = useState(value.serviceTier || serviceTierCap?.defaultValue || "");
  const [thinkingMode, setThinkingMode] = useState<string>(() => baselineThinking(currentKey));
  const [budget, setBudget] = useState<number>(() => baselineBudget(currentKey));
  const [debug, setDebug] = useState(Boolean(value.debug));
  const initialCompact = value.autoCompact ?? DEFAULT_AUTO_COMPACT;
  const [compact, setCompact] = useState<AutoCompactSetting>(initialCompact);

  // Re-stage reasoning when the selected model (and thus its caps) changes.
  useEffect(() => {
    setEffort(baselineEffort(selectedKey));
    setServiceTier(value.serviceTier || serviceTierCap?.defaultValue || "");
    setThinkingMode(baselineThinking(selectedKey));
    setBudget(baselineBudget(selectedKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  useEffect(() => {
    setSelectedKey(currentKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  // Switching harness moves the selection into that harness's list. The group
  // that opens with it is handled by the expansion effect above, which keys off
  // the resulting current model rather than off this comparison.
  useEffect(() => {
    if (config.harness && selected && (selected.route.harnessId || "claude-code") !== harness && displayEntries[0]) {
      setSelectedKey(routeKey(displayEntries[0].route));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harness]);

  // Escape closes the modal — unless a search is active, in which case it only
  // clears the query. Losing a half-built search AND the whole modal to one
  // keystroke costs the user far more than it saves. Handled here rather than on
  // the input alone so it works wherever focus sits in the modal; with the query
  // already empty it falls through and closes, as before.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (query) {
        event.stopPropagation();
        clearQuery();
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, query]);

  const selectedMeta = selected?.meta;
  const thinkingOn = Boolean(thinkingMode) && thinkingMode !== "disabled";
  const showBudget = Boolean(thinkingCap?.budget) && thinkingOn;

  const dirty =
    selectedKey !== currentKey ||
    (config.harness && harness !== (value.harness || currentHarness)) ||
    (config.effort && effortCap?.supported && effort !== baselineEffort(selectedKey)) ||
    (config.serviceTier && serviceTierCap?.supported && serviceTier !== (value.serviceTier || serviceTierCap.defaultValue || "")) ||
    (config.thinking && thinkingCap?.supported && thinkingMode !== baselineThinking(selectedKey)) ||
    (config.debug && debug !== Boolean(value.debug)) ||
    (config.autoCompact && (compact.on !== initialCompact.on || compact.at !== initialCompact.at));

  function apply() {
    onApply({
      model: selected?.route.model || value.model,
      route: selected?.route,
      harness: config.harness ? harness : value.harness,
      effort: config.effort && effortCap?.supported ? effort : undefined,
      serviceTier: config.serviceTier && serviceTierCap?.supported ? serviceTier : undefined,
      thinkingMode: config.thinking && thinkingCap?.supported ? thinkingMode : undefined,
      thinkingBudget: config.thinking && showBudget ? budget : undefined,
      debug: config.debug ? debug : undefined,
      autoCompact: config.autoCompact ? compact : undefined,
    });
    onClose();
  }

  // A portal escapes an ancestor's `display:none`, so a modal opened inside a
  // hidden region (e.g. an inactive settings tab that stays mounted) would keep
  // drawing over whatever is on screen now.
  if (!visible) {
    return null;
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
              <div className="wb-model-list-harness">
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
              </div>
            )}

            <div className="wb-modal-label wb-model-list-head">
              Model <span className="wb-mono">{catalogCountLabel(catalog)}</span>
            </div>

            {/* Outside the scroll area on purpose: the search box stays put
                while a long catalog scrolls under it. */}
            <div className="wb-model-search-row">
              <div className="wb-model-search">
                <Search size={13} className="wb-model-search-icon" aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="text"
                  className="wb-model-search-input"
                  value={query}
                  aria-label="모델 검색"
                  placeholder="모델·제공자 검색"
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query && (
                  <button type="button" className="wb-model-search-clear" title="검색 지우기" aria-label="검색 지우기" onClick={clearQuery}>
                    <X size={10} />
                  </button>
                )}
              </div>
            </div>

            {favoriteError && <p className="wb-model-fav-error" role="alert">{favoriteError}</p>}

            <div className="wb-model-scroll" aria-live="polite">
              {catalog.groups.length === 0 && (
                <div className="wb-model-empty">
                  <Search size={20} className="wb-model-empty-icon" aria-hidden="true" />
                  <p>&quot;{query.trim()}&quot;와 일치하는 모델이 없습니다</p>
                  <button type="button" className="wb-model-empty-btn" onClick={clearQuery}>검색 지우기</button>
                </div>
              )}

              {catalog.groups.map((group) => (
                <div className={"wb-model-group" + (group.kind === "favorites" ? " is-favorites" : "")} key={group.id}>
                  {group.kind === "favorites" ? (
                    <div className="wb-model-fav-head">
                      <Star size={12} className="wb-model-fav-icon" aria-hidden="true" />
                      <span className="wb-model-fav-label">즐겨찾기</span>
                      <span className="wb-mono">{group.entries.length}</span>
                      <span className="wb-model-fav-rule" />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="wb-model-provider-btn"
                      aria-expanded={group.open}
                      onClick={() => setProviderOpen(group.id, !group.open)}
                    >
                      <ChevronRight size={10} className={"wb-model-caret" + (group.open ? " is-open" : "")} aria-hidden="true" />
                      <span className="wb-provider-dot" style={{ background: PROVIDER_DOTS[group.provider!] }} />
                      <span className="wb-model-provider-name">{group.label}</span>
                      <span className="wb-mono">{group.entries.length}</span>
                      {!group.open && group.hasSelected && <span className="wb-model-inuse">사용 중</span>}
                      {!group.open && <span className="wb-model-preview wb-mono">{group.preview}</span>}
                    </button>
                  )}

                  {group.open && group.entries.map((entry) => {
                    const key = routeKey(entry.route);
                    const starred = favorites.includes(entry.route.model);
                    const unavailable = entry.route.enabled === false;
                    // "미지원" and "베타 잠금" are not the same news: the first
                    // never works, the second works and we closed it for now.
                    // Reading one as the other sends the user off to look for a
                    // different model they did not need to change.
                    const locked = unavailable && entry.route.locked === true;
                    // The row is a container, not a button: it also holds the
                    // star, and a button cannot nest inside a button. It still
                    // selects on click so the whole row stays the target — for a
                    // pointer, and for anything driving `.wb-model-row`.
                    return (
                      <div
                        className={"wb-model-row" + (key === selectedKey ? " is-selected" : "") + (unavailable ? " is-unavailable" : "")}
                        key={key}
                        data-model={entry.route.model}
                        onClick={() => { if (!unavailable) { setSelectedKey(key); } }}
                      >
                        <button
                          type="button"
                          className="wb-model-pick"
                          disabled={unavailable}
                          // The full reason stays reachable on hover. It is a
                          // sentence or two of provider detail — useful when you
                          // go looking for it, noise on every row of the list.
                          title={unavailable ? entry.route.unavailableReason : entry.route.description}
                          onClick={() => setSelectedKey(key)}
                        >
                          <span className="wb-model-name">
                            <span className="wb-mono">{entry.route.label || entry.meta.name}</span>
                            {/* A starred model is also pinned at the top, so the
                                row says which provider it belongs to. */}
                            <small className="wb-model-origin">
                              <span className="wb-provider-dot" style={{ background: PROVIDER_DOTS[entry.meta.provider] }} />
                              {PROVIDER_LABELS[entry.meta.provider]}
                            </small>
                          </span>
                          {unavailable && <span className={"wb-model-off" + (locked ? " is-locked" : "")}>{locked ? "베타 잠금" : "미지원"}</span>}
                          <PerfMeter value={entry.meta.perf} />
                          <CostMeter value={entry.meta.cost} />
                        </button>
                        <button
                          type="button"
                          className={"wb-model-star" + (starred ? " is-on" : "")}
                          title={starred ? "즐겨찾기 해제" : "즐겨찾기에 추가"}
                          aria-label={starred ? "즐겨찾기 해제" : "즐겨찾기에 추가"}
                          aria-pressed={starred}
                          onClick={(event) => { event.stopPropagation(); void toggleFavorite(entry); }}
                        >
                          <Star size={14} />
                        </button>
                        {key === selectedKey && <Check size={14} className="wb-model-check" />}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
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

                {config.serviceTier && serviceTierCap?.supported && serviceTierCap.options.length > 0 && (
                  <div className="wb-detail-section">
                    <div className="wb-detail-section-head"><strong>Service mode</strong> <span>Cursor Grok serving speed</span></div>
                    <div className="wb-segmented">
                      {serviceTierCap.options.map((option) => (
                        <button type="button" key={option.id} className={"wb-segment" + (option.id === serviceTier ? " is-active" : "")} onClick={() => setServiceTier(option.id)}>
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
