import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Lightbulb, RefreshCw, Sparkles, TerminalSquare, UserPlus, X } from "lucide-react";
import type { RouteLike } from "./routes";
import { routeKey } from "./routes";
import { VisionTag } from "./VisionTag";
import { modelView, PROVIDER_DOTS, PROVIDER_LABELS } from "./modelCatalog";
import { CostMeter, groupByProvider, PerfMeter, RouteEntry } from "./modelMeters";
import type { CreateMemberInput } from "./PartySidebar";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import type { DefaultMemberProfile, HarnessDefaults } from "../../shared/types";
import type { PermissionModeSetting } from "../../shared/types";
import { DEFAULT_CODEX_POLICY, type CodexPolicy } from "../../shared/codexPolicy";
import { CodexPermissionControl } from "./CodexPermissionControl";
import { CursorPermissionControl } from "./CursorPermissionControl";
import { PERMISSION_OPTIONS } from "./controls";
import { cursorPolicyOf, type CursorPolicy } from "../../shared/cursorPolicy";

interface MemberWizardProps {
  routes: RouteLike[];
  /** Live Codex catalog discovery state — the model step must say when the
   *  codex list is still loading or failed (fallback-only), never silently. */
  codexModels?: CodexModelDiscoveryState;
  onRefreshCodexModels?: () => void;
  /** Seed values so "next, next, next" creates a member with the saved defaults. */
  defaultProfile: DefaultMemberProfile;
  /** Per-harness defaults — switching harness seeds THAT harness's default. */
  harnessDefaults: Record<string, HarnessDefaults>;
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
  { id: "codex", label: "Codex", status: "available", icon: <TerminalSquare size={16} />, hint: "Codex CLI exec 기반 로컬 하네스" },
];

const STEPS = ["이름", "하네스", "모델", "추론", "권한", "역할"] as const;
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const CURSOR_HARNESS: HarnessChoice = {
  id: "cursor",
  label: "Cursor CLI",
  status: "available",
  icon: <TerminalSquare size={16} />,
  hint: "Cursor Agent CLI · Auto / Grok 4.5",
};
const ALL_HARNESSES = [...HARNESSES, CURSOR_HARNESS];

/**
 * Step wizard for creating a party member (name → harness → model → reasoning →
 * role/confirm), modelled after VS Code / Claude Code desktop. Reuses the
 * RuntimeModal model + reasoning controls so a member is configured exactly the
 * way its runtime is later tuned.
 */
export function MemberWizard({ routes, codexModels, onRefreshCodexModels, defaultProfile, harnessDefaults, onCancel, onCreate }: MemberWizardProps) {
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
  const serviceTierCap = capabilities.serviceTier;
  const thinkingCap = capabilities.thinking;

  const [effort, setEffort] = useState("");
  const [serviceTier, setServiceTier] = useState("");
  const [thinkingMode, setThinkingMode] = useState("");
  const [budget, setBudget] = useState(0);
  const [permissionMode, setPermissionMode] = useState<PermissionModeSetting>(
    harnessDefaults["claude-code"]?.permissionMode || "default",
  );
  const [codexPolicy, setCodexPolicy] = useState<CodexPolicy>(
    harnessDefaults.codex?.codexPolicy || DEFAULT_CODEX_POLICY,
  );
  const [cursorPolicy, setCursorPolicy] = useState<CursorPolicy>(
    cursorPolicyOf(harnessDefaults.cursor?.cursorPolicy, harnessDefaults.cursor?.permissionMode),
  );

  // When the chosen harness changes, seed the model to THAT harness's default
  // (so switching to Codex prefills the Codex default model, not just the first
  // one). Falls back to the harness's first model.
  useEffect(() => {
    if (!harnessEntries.some((entry) => routeKey(entry.route) === selectedKey)) {
      const defModel = harnessDefaults[harness]?.model;
      const defEntry = defModel ? harnessEntries.find((entry) => entry.route.model === defModel) : undefined;
      const seed = defEntry || harnessEntries[0];
      setSelectedKey(seed ? routeKey(seed.route) : "");
    }
  }, [harnessEntries, selectedKey, harness, harnessDefaults]);

  // Reset staged reasoning whenever the selected model changes. Prefer the
  // member's harness default effort/reasoning where set (so "next, next, next"
  // honors that harness's saved default), else the model's own default.
  useEffect(() => {
    const hDefaults = harnessDefaults[harness];
    const effDefault = effortCap?.supported ? effortCap.defaultValue || "medium" : "";
    const thinkDefault = thinkingCap?.supported ? thinkingCap.defaultValue || "" : "";
    const budgetDefault = thinkingCap?.budget?.default ?? 0;
    setEffort(effortCap?.supported && hDefaults?.effort ? hDefaults.effort : effDefault);
    setServiceTier(serviceTierCap?.supported ? hDefaults?.serviceTier || serviceTierCap.defaultValue || "standard" : "");
    setThinkingMode(thinkingCap?.supported && hDefaults?.reasoning ? hDefaults.reasoning : thinkDefault);
    setBudget(hDefaults?.reasoningBudget ? hDefaults.reasoningBudget : budgetDefault);
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
  const selectedHarness = ALL_HARNESSES.find((item) => item.id === harness);
  const executionHarness = harness === "codex" ? "codex" : harness === "cursor" ? "cursor" : "claude-code";

  useEffect(() => {
    if (executionHarness === "codex") {
      setCodexPolicy({ ...(harnessDefaults.codex?.codexPolicy || DEFAULT_CODEX_POLICY) });
    } else if (executionHarness === "cursor") {
      setCursorPolicy(cursorPolicyOf(harnessDefaults.cursor?.cursorPolicy, harnessDefaults.cursor?.permissionMode));
    } else {
      setPermissionMode(harnessDefaults["claude-code"]?.permissionMode || "default");
    }
  }, [executionHarness, harnessDefaults]);

  const stepValid = [
    NAME_PATTERN.test(name.trim()),
    selectedHarness?.status === "available",
    Boolean(selected),
    true,
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
        serviceTier: serviceTierCap?.supported ? serviceTier : undefined,
        reasoning: thinkingCap?.supported ? thinkingMode : undefined,
        reasoningBudget: showBudget ? budget : undefined,
        permissionMode: executionHarness === "claude-code" ? permissionMode : undefined,
        codexPolicy: executionHarness === "codex" ? codexPolicy : undefined,
        cursorPolicy: executionHarness === "cursor" ? cursorPolicy : undefined,
      });
      return;
    }
    setStep((value) => Math.min(STEPS.length - 1, value + 1));
  }

  const selectedMeta = selected?.meta;

  // The scrim does not dismiss: a stray click outside would throw away a
  // half-filled wizard. Closing is explicit (취소 / ✕) — the same contract as
  // every other modal in the app.
  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-wizard" role="dialog" aria-modal="true">
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
                {ALL_HARNESSES.map((item) => (
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
              <div className="wb-modal-label">모델 <span className="wb-mono">{harnessEntries.length} catalogued</span></div>
              {harness === "codex" && codexModels?.status === "pending" && (
                <p className="wb-wizard-hint">Codex 계정 모델 목록을 불러오는 중입니다… 완료되면 목록이 갱신됩니다.</p>
              )}
              {harness === "codex" && codexModels?.status === "error" && (
                <p className="wb-wizard-error">
                  Codex 모델 목록을 불러오지 못했습니다: {codexModels.error}
                  {onRefreshCodexModels && (
                    <button type="button" className="wb-btn wb-btn-ghost" onClick={onRefreshCodexModels}>
                      <RefreshCw size={13} /> 다시 시도
                    </button>
                  )}
                </p>
              )}
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
                          disabled={entry.route.enabled === false}
                          title={entry.route.enabled === false ? entry.route.unavailableReason : entry.route.description}
                          onClick={() => setSelectedKey(key)}
                        >
                          <span className="wb-model-name"><span className="wb-mono">{entry.route.label || entry.meta.name}</span>{entry.route.enabled === false && <small>Unavailable · {entry.route.unavailableReason}</small>}</span>
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
                    <div className="wb-stat-card">
                      <div className="wb-modal-label">이미지 입력</div>
                      <div className="wb-stat-row wb-mono"><VisionTag image={capabilities.vision?.image} /></div>
                    </div>
                  </div>
                  {selected?.route.modelProvider === "openrouter" && (
                    <p className="wb-wizard-hint wb-codex-or-note">
                      이 모델은 Codex 하네스에서 OpenRouter로 라우팅됩니다. Codex 구독이 아니라 <strong>OpenRouter API 키</strong>로 과금되며, 키가 설정돼 있어야 시작됩니다.
                    </p>
                  )}
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
              {serviceTierCap?.supported && serviceTierCap.options.length > 0 && (
                <div className="wb-detail-section">
                  <div className="wb-detail-section-head"><strong>Service mode</strong> <span>Cursor Grok serving speed</span></div>
                  <div className="wb-segmented">
                    {serviceTierCap.options.map((option) => (
                      <button type="button" key={option.id} className={"wb-segment" + (option.id === serviceTier ? " is-active" : "")} onClick={() => setServiceTier(option.id)}>{option.label}</button>
                    ))}
                  </div>
                </div>
              )}
              {!effortCap?.supported && !thinkingCap?.supported && (
                <p className="wb-wizard-hint">이 모델은 노출된 추론 제어가 없습니다. 다음 단계로 진행하세요.</p>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="wb-wizard-pane">
              <div className="wb-modal-label">초기 권한 <span className="wb-mono">{executionHarness === "codex" ? "Codex" : executionHarness === "cursor" ? "Cursor CLI" : "Claude Code"}</span></div>
              {executionHarness === "codex" ? (
                <>
                  <CodexPermissionControl policy={codexPolicy} onChange={setCodexPolicy} variant="inline" />
                  <p className="wb-wizard-hint">Codex 하니스에서 사용할 Sandbox와 승인 정책, Guardian을 지정합니다. 선택한 모델 공급자와 관계없이 이 권한 정책이 유지됩니다.</p>
                </>
              ) : executionHarness === "cursor" ? (
                <>
                  <CursorPermissionControl policy={cursorPolicy} onChange={setCursorPolicy} variant="inline" />
                  <p className="wb-wizard-hint">Cursor CLI의 작업 모드와 승인 모드를 그대로 설정합니다.</p>
                </>
              ) : (
                <>
                  <select
                    className="wb-wizard-input"
                    value={permissionMode}
                    onChange={(event) => setPermissionMode(event.target.value as PermissionModeSetting)}
                  >
                    {PERMISSION_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                  <p className="wb-wizard-hint">새 멤버가 첫 작업부터 사용할 Claude Code 권한 모드입니다.</p>
                </>
              )}
            </div>
          )}

          {step === 5 && (
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
                  <div><dt>권한</dt><dd className="wb-mono">{executionHarness === "codex" ? `${codexPolicy.sandbox} / ${codexPolicy.approval}${codexPolicy.guardian ? " / guardian" : ""}` : executionHarness === "cursor" ? `${cursorPolicy.mode} / ${cursorPolicy.approval}` : permissionMode}</dd></div>
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
