import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Lightbulb, Sparkles, TerminalSquare, UserPlus, X } from "lucide-react";
import type { RouteLike } from "./routes";
import { routeKey } from "./routes";
import { modelView, PROVIDER_DOTS, PROVIDER_LABELS } from "./modelCatalog";
import { CostMeter, groupByProvider, PerfMeter, RouteEntry } from "./RuntimeModal";
import type { CreateMemberInput } from "./PartySidebar";
import type { DefaultMemberProfile } from "../../shared/types";

interface MemberWizardProps {
  routes: RouteLike[];
  /** Seed values so "next, next, next" creates a member with the saved defaults. */
  defaultProfile: DefaultMemberProfile;
  onCancel: () => void;
  onCreate: (input: CreateMemberInput) => void;
}

interface HarnessChoice {
  id: string;
  label: string;
  status: "available" | "planned";
  icon: JSX.Element;
  hint: string;
}

const HARNESSES: HarnessChoice[] = [
  { id: "claude-code", label: "Claude Code", status: "available", icon: <Sparkles size={16} />, hint: "Claude Code SDK 기반 로컬 하네스" },
  { id: "codex", label: "Codex", status: "planned", icon: <TerminalSquare size={16} />, hint: "아직 미구현 — 추후 지원 예정" },
];

const STEPS = ["이름", "하네스", "모델", "추론", "역할"] as const;
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Step wizard for creating a party member (name → harness → model → reasoning →
 * role/confirm), modelled after VS Code / Claude Code desktop. Reuses the
 * RuntimeModal model + reasoning controls so a member is configured exactly the
 * way its runtime is later tuned.
 */
export function MemberWizard({ routes, defaultProfile, onCancel, onCreate }: MemberWizardProps) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [harness, setHarness] = useState<string>(defaultProfile.harness || "claude-code");
  const [role, setRole] = useState("");

  const entries = useMemo<RouteEntry[]>(() => routes.map((route) => ({ route, meta: modelView(route) })), [routes]);
  const harnessEntries = useMemo(
    () => entries.filter((entry) => (entry.route.harnessId || "claude-code") === harness),
    [entries, harness],
  );
  const grouped = useMemo(() => groupByProvider(harnessEntries), [harnessEntries]);

  // Seed the model from the default profile so "next, next, next" works.
  const [selectedKey, setSelectedKey] = useState(() => {
    const match = routes.find((route) => route.model === defaultProfile.model && (route.harnessId || "claude-code") === (defaultProfile.harness || "claude-code"));
    return match ? routeKey(match) : "";
  });
  const selected = harnessEntries.find((entry) => routeKey(entry.route) === selectedKey) || harnessEntries[0];
  const capabilities = selected?.route.capabilities || {};
  const effortCap = capabilities.effort;
  const thinkingCap = capabilities.thinking;

  const [effort, setEffort] = useState("");
  const [thinkingMode, setThinkingMode] = useState("");
  const [budget, setBudget] = useState(0);

  // Default the model selection to the first one of the chosen harness.
  useEffect(() => {
    if (!harnessEntries.some((entry) => routeKey(entry.route) === selectedKey)) {
      setSelectedKey(harnessEntries[0] ? routeKey(harnessEntries[0].route) : "");
    }
  }, [harnessEntries, selectedKey]);

  // Reset staged reasoning to the selected model's defaults whenever it changes.
  // On the FIRST run, prefer the default profile's reasoning where it specifies
  // one (so "next, next, next" honors the saved default); fall back to the
  // model's own default otherwise.
  const firstReasoning = useRef(true);
  useEffect(() => {
    const first = firstReasoning.current;
    firstReasoning.current = false;
    const effDefault = effortCap?.supported ? effortCap.defaultValue || "medium" : "";
    const thinkDefault = thinkingCap?.supported ? thinkingCap.defaultValue || "" : "";
    const budgetDefault = thinkingCap?.budget?.default ?? 0;
    setEffort(first && defaultProfile.effort ? defaultProfile.effort : effDefault);
    setThinkingMode(first && defaultProfile.reasoning ? defaultProfile.reasoning : thinkDefault);
    setBudget(first && defaultProfile.reasoningBudget ? defaultProfile.reasoningBudget : budgetDefault);
  }, [selectedKey]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const thinkingOn = Boolean(thinkingMode) && thinkingMode !== "disabled";
  const showBudget = Boolean(thinkingCap?.budget) && thinkingOn;
  const selectedHarness = HARNESSES.find((item) => item.id === harness);

  const stepValid = [
    NAME_PATTERN.test(name.trim()),
    selectedHarness?.status === "available",
    Boolean(selected),
    true,
    role.trim().length > 0,
  ];
  const canNext = stepValid[step];
  const isLast = step === STEPS.length - 1;

  function next() {
    if (!canNext) return;
    if (isLast) {
      onCreate({
        name: name.trim(),
        requirement: role.trim(),
        runtime: harness,
        model: selected?.route.model,
        effort: effortCap?.supported ? effort : undefined,
        reasoning: thinkingCap?.supported ? thinkingMode : undefined,
        reasoningBudget: showBudget ? budget : undefined,
      });
      return;
    }
    setStep((value) => Math.min(STEPS.length - 1, value + 1));
  }

  const selectedMeta = selected?.meta;

  return (
    <div className="wb-modal-scrim" onMouseDown={onCancel}>
      <div className="wb-modal wb-wizard" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <UserPlus size={16} />
            <strong>새 멤버</strong>
          </div>
          <button type="button" className="wb-icon-btn" title="취소" onClick={onCancel}><X size={16} /></button>
        </header>

        <div className="wb-wizard-steps">
          {STEPS.map((label, index) => (
            <div key={label} className={"wb-wizard-step" + (index === step ? " is-active" : "") + (index < step ? " is-done" : "")}>
              <span className="wb-wizard-step-num">{index < step ? <Check size={12} /> : index + 1}</span>
              <span className="wb-wizard-step-label">{label}</span>
            </div>
          ))}
        </div>

        <div className="wb-modal-body wb-wizard-body">
          {step === 0 && (
            <div className="wb-wizard-pane">
              <div className="wb-modal-label">멤버 이름</div>
              <input
                className="wb-wizard-input"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && canNext) next(); }}
                placeholder="예: reviewer"
              />
              <p className="wb-wizard-hint">영문으로 시작, 영문·숫자·_·- 만 사용. 파티 안에서 이 이름으로 메시지를 받습니다.</p>
              {name.trim() && !NAME_PATTERN.test(name.trim()) && <p className="wb-wizard-error">이름 형식이 올바르지 않습니다.</p>}
            </div>
          )}

          {step === 1 && (
            <div className="wb-wizard-pane">
              <div className="wb-modal-label">하네스</div>
              <div className="wb-wizard-cards">
                {HARNESSES.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={"wb-wizard-card" + (harness === item.id ? " is-selected" : "") + (item.status === "planned" ? " is-disabled" : "")}
                    onClick={() => item.status === "available" && setHarness(item.id)}
                    disabled={item.status === "planned"}
                  >
                    <span className="wb-wizard-card-icon">{item.icon}</span>
                    <span className="wb-wizard-card-body">
                      <span className="wb-wizard-card-title">{item.label}{item.status === "planned" && <span className="wb-chip wb-chip-muted">준비 중</span>}</span>
                      <span className="wb-wizard-card-hint">{item.hint}</span>
                    </span>
                    {harness === item.id && item.status === "available" && <Check size={15} className="wb-wizard-card-check" />}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="wb-wizard-pane wb-wizard-models">
              <div className="wb-modal-label">모델 <span className="wb-mono">{harnessEntries.length} available</span></div>
              <div className="wb-wizard-model-list">
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
                          <span className="wb-model-name"><span className="wb-mono">{entry.route.label || entry.meta.name}</span></span>
                          <PerfMeter value={entry.meta.perf} />
                          <CostMeter value={entry.meta.cost} />
                          {key === selectedKey && <Check size={14} className="wb-model-check" />}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              {selectedMeta && (
                <div className="wb-wizard-model-detail">
                  <div className="wb-detail-head">
                    <span className="wb-provider-dot" style={{ background: PROVIDER_DOTS[selectedMeta.provider] }} />
                    <strong className="wb-mono">{selectedMeta.name}</strong>
                    <span className="wb-chip">{PROVIDER_LABELS[selectedMeta.provider]}</span>
                  </div>
                  <div className="wb-stat-cards">
                    <div className="wb-stat-card">
                      <div className="wb-modal-label">Performance</div>
                      <div className="wb-stat-row"><PerfMeter value={selectedMeta.perf} /><strong>{selectedMeta.perf != null ? `${selectedMeta.perf} / 5` : "—"}</strong></div>
                    </div>
                    <div className="wb-stat-card">
                      <div className="wb-modal-label">Cost · per 1M</div>
                      <div className="wb-stat-row wb-mono wb-cost-prices">
                        {selectedMeta.inPerM ? <span><b>{selectedMeta.inPerM}</b> in</span> : null}
                        {selectedMeta.outPerM ? <span><b>{selectedMeta.outPerM}</b> out</span> : null}
                        {selectedMeta.ioPerM ? <span><b>{selectedMeta.ioPerM}</b> io</span> : null}
                      </div>
                      <CostMeter value={selectedMeta.cost} />
                    </div>
                    <div className="wb-stat-card">
                      <div className="wb-modal-label">Context</div>
                      <div className="wb-stat-row wb-mono"><strong>{selectedMeta.context || "—"}</strong></div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="wb-wizard-pane">
              <div className="wb-modal-label">추론 설정 <span className="wb-mono">{selectedMeta?.name}</span></div>
              {effortCap?.supported && effortCap.options.length > 0 && (
                <div className="wb-detail-section">
                  <div className="wb-detail-section-head"><strong>Effort</strong> <span>추론 강도</span></div>
                  <div className="wb-segmented">
                    {effortCap.options.map((option) => (
                      <button type="button" key={option.id} className={"wb-segment" + (option.id === effort ? " is-active" : "")} onClick={() => setEffort(option.id)}>{option.label}</button>
                    ))}
                  </div>
                </div>
              )}
              {thinkingCap?.supported && thinkingCap.modes && thinkingCap.modes.length > 0 && (
                <div className="wb-detail-section">
                  <div className="wb-detail-section-head"><strong><Lightbulb size={13} /> Thinking</strong> <span>추론 모드</span></div>
                  <div className="wb-segmented">
                    {thinkingCap.modes.map((mode) => (
                      <button type="button" key={mode.id} className={"wb-segment" + (mode.id === thinkingMode ? " is-active" : "")} onClick={() => setThinkingMode(mode.id)}>{mode.label}</button>
                    ))}
                  </div>
                  {showBudget && thinkingCap.budget && (
                    <label className="wb-budget">
                      <span className="wb-budget-head">Thinking budget <span className="wb-mono">{budget.toLocaleString()} tok</span></span>
                      <input type="range" min={thinkingCap.budget.min ?? 1024} max={thinkingCap.budget.max ?? 81920} step={1024} value={budget} onChange={(event) => setBudget(Number(event.target.value))} />
                    </label>
                  )}
                </div>
              )}
              {!effortCap?.supported && !thinkingCap?.supported && (
                <p className="wb-wizard-hint">이 모델은 노출된 추론 제어가 없습니다. 다음 단계로 진행하세요.</p>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="wb-wizard-pane">
              <div className="wb-modal-label">역할</div>
              <textarea
                className="wb-wizard-input wb-wizard-textarea"
                autoFocus
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="예: 백엔드 API를 리뷰하고 이슈를 보고하는 담당자"
                rows={3}
              />
              <div className="wb-wizard-summary">
                <div className="wb-modal-label">확인</div>
                <dl className="wb-wizard-review">
                  <div><dt>이름</dt><dd className="wb-mono">{name.trim() || "—"}</dd></div>
                  <div><dt>하네스</dt><dd>{selectedHarness?.label}</dd></div>
                  <div><dt>모델</dt><dd className="wb-mono">{selected?.route.label || selectedMeta?.name || "—"}</dd></div>
                  <div><dt>추론</dt><dd className="wb-mono">{reasoningSummary(effortCap?.supported ? effort : "", thinkingCap?.supported ? thinkingMode : "", showBudget ? budget : undefined)}</dd></div>
                </dl>
              </div>
            </div>
          )}
        </div>

        <footer className="wb-modal-foot wb-wizard-foot">
          <button type="button" className="wb-btn wb-btn-ghost" onClick={() => (step === 0 ? onCancel() : setStep((value) => value - 1))}>
            {step === 0 ? "취소" : <><ArrowLeft size={14} /> 이전</>}
          </button>
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-accent" disabled={!canNext} onClick={next}>
              {isLast ? <><UserPlus size={14} /> 멤버 생성</> : <>다음 <ArrowRight size={14} /></>}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function reasoningSummary(effort: string, thinking: string, budget?: number): string {
  const parts: string[] = [];
  if (effort) parts.push(`effort ${effort}`);
  if (thinking) parts.push(`thinking ${thinking}`);
  if (budget) parts.push(`${budget.toLocaleString()} tok`);
  return parts.length ? parts.join(" · ") : "기본값";
}
