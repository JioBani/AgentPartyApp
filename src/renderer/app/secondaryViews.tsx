import { useMemo, useState } from "react";
import { Check, ChevronDown, Copy, FlaskConical, FoldVertical, Info as InfoIcon, KeyRound, LogOut, RefreshCw, ShieldCheck, SlidersHorizontal, SquareTerminal, X } from "lucide-react";
import type { HarnessDefaults, HarnessId, InitialAppState, PermissionModeSetting, SessionView } from "../../shared/types";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import type { GateReviewer } from "../../shared/messageGate";
import { HARNESS_IDS } from "../../shared/types";
import { MessageGateIcon } from "../workbench/MessageGateIcon";
import { CODEX_PRESETS, CODEX_PRESET_LABELS, codexPresetOf, type CodexPolicy } from "../../shared/codexPolicy";
import { AUTO_COMPACT_CEIL, AUTO_COMPACT_FLOOR, AUTO_COMPACT_GAUGE_MAX, AUTO_COMPACT_GAUGE_MIN, AUTO_COMPACT_STEP, clampAutoCompactAt, type AutoCompactSetting } from "../../shared/autoCompact";
import { RouteLike } from "../workbench/routes";
import { ModelCatalogModal } from "../workbench/ModelCatalogModal";

const permissionModes = [
  { id: "default", label: "기본" },
  { id: "acceptEdits", label: "수정 허용" },
  { id: "plan", label: "계획" },
  { id: "auto", label: "자동" },
  { id: "dontAsk", label: "묻지 않음" },
  { id: "bypassPermissions", label: "권한 확인 생략" },
];

export function SessionsView({ sessions, resumable, resumableError, onOpen, onClose, onRefresh, onResume }: {
  sessions: SessionView[];
  resumable: NonNullable<InitialAppState["resumableSessions"]>;
  resumableError?: string;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
  onRefresh: () => void;
  onResume: (id: string) => void;
}) {
  return (
    <section className="legacy-view">
      <div className="view-toolbar"><button className="ghost-btn" onClick={onRefresh}><RefreshCw size={15} /> 기록 새로고침</button></div>
      <div className="split-grid">
        <section className="card">
          <div className="card-title">활성 세션</div>
          <div className="row-list">
            {sessions.length === 0 && <div className="empty">활성 세션이 없습니다</div>}
            {sessions.map((session) => (
              <button key={session.id} className="list-row" onClick={() => onOpen(session.id)}>
                <span><strong>{session.title || "Claude Code"}</strong><small>{session.snapshot.status || "idle"}</small></span>
                <button type="button" className="row-x" title="닫기" onClick={(event) => { event.stopPropagation(); onClose(session.id); }}><X size={13} /></button>
              </button>
            ))}
          </div>
        </section>
        <section className="card">
          <div className="card-title">이전 세션</div>
          <div className="row-list">
            {resumableError && <div className="soft-error">{resumableError}</div>}
            {!resumableError && resumable.length === 0 && <div className="empty">이어갈 수 있는 세션이 없습니다</div>}
            {resumable.map((session) => (
              <button className="list-row" key={session.sessionId} onClick={() => onResume(session.sessionId)}>
                <span><strong>{session.customTitle || session.summary || session.firstPrompt || session.sessionId}</strong><small>{[session.lastModified ? new Date(session.lastModified).toLocaleString() : "", session.gitBranch].filter(Boolean).join(" - ")}</small></span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

/** Maps an auth provider status to a badge (label + tone + whether it's a check). */
function authBadge(status: InitialAppState["auth"][number]["status"]): { label: string; tone: "success" | "muted" | "danger"; ok: boolean } {
  switch (status) {
    case "available": return { label: "사용 가능", tone: "success", ok: true };
    case "configured": return { label: "설정됨", tone: "success", ok: true };
    case "valid": return { label: "정상", tone: "success", ok: true };
    case "pending": return { label: "인증 대기", tone: "muted", ok: false };
    case "missing": return { label: "미설정", tone: "muted", ok: false };
    case "invalid": return { label: "유효하지 않음", tone: "danger", ok: false };
    case "network_error": return { label: "네트워크 오류", tone: "danger", ok: false };
    default: return { label: status, tone: "muted", ok: false };
  }
}

function SetBadge({ status }: { status: InitialAppState["auth"][number]["status"] }) {
  const badge = authBadge(status);
  return (
    <span className={"set-badge is-" + badge.tone}>
      {badge.ok && <Check size={12} />}
      {badge.label}
    </span>
  );
}

/**
 * The pending OAuth link, shown while a subscription login waits on the browser.
 *
 * Read-only and selectable rather than a plain anchor: clicking would reopen the
 * SAME default browser that already failed the user. Copying is the action that
 * actually unblocks them — paste into whichever browser or profile holds the
 * provider account.
 */
function AuthUrlRow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="set-auth-url">
      <span className="set-auth-url-hint">
        다른 브라우저에서 열려면 이 주소를 복사하세요
      </span>
      <div className="set-auth-url-body">
        <input className="set-auth-url-input" value={url} readOnly onFocus={(event) => event.target.select()} />
        <button
          type="button"
          className="set-btn-soft"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(
              () => setCopied(true),
              // Never claim a copy that did not happen — the URL stays selectable.
              () => setCopied(false),
            );
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "복사됨" : "복사"}
        </button>
      </div>
    </div>
  );
}

function SetSectionHead({ label }: { label: string }) {
  return (
    <div className="set-section-head">
      <span className="set-section-label">{label}</span>
      <span className="set-section-rule" />
    </div>
  );
}

/**
 * A segmented single-choice control — the same design language as the Runtime
 * modal's Effort/Thinking pickers, so settings and the modal read as one system
 * instead of the modal being polished and settings falling back to raw selects.
 */
function SetSegmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (id: T) => void;
}) {
  return (
    <div className="wb-segmented set-segmented">
      {options.map((option) => (
        <button
          type="button"
          key={option.id || "_default"}
          className={"wb-segment" + (option.id === value ? " is-active" : "")}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The global-default Auto-compact block on the Settings → Runtime screen. This is
 * a settings-tuned presentation (amber badge, "inherited default" copy, a clean
 * NN% readout) — distinct from the per-member `AutoCompactEditor` used in the
 * workbench, which carries member-scoped copy and the editable token estimate.
 * The slider matches the shared editor's gauge exactly: a full 0–100% track with
 * the un-settable ends (≤10% / ≥95%) painted as blocked zones.
 */
function SettingsAutoCompact({ setting, onChange }: { setting: AutoCompactSetting; onChange: (setting: AutoCompactSetting) => void }) {
  const track = `linear-gradient(90deg,
    var(--danger-dim) 0 ${AUTO_COMPACT_FLOOR}%,
    var(--live) ${AUTO_COMPACT_FLOOR}% ${setting.at}%,
    var(--bg-4) ${setting.at}% ${AUTO_COMPACT_CEIL}%,
    var(--danger-dim) ${AUTO_COMPACT_CEIL}% 100%)`;
  return (
    <div className="set-compact">
      <label className="set-compact-toggle">
        <span className="set-compact-badge"><FoldVertical size={18} /></span>
        <span className="set-compact-copy">
          <strong>컨텍스트 임계치 초과 시 자동 압축</strong>
          <small>새 멤버는 이 기본값으로 생성됩니다. 멤버별로 런타임에서 개별 조정할 수 있습니다.</small>
        </span>
        <input
          type="checkbox"
          className="set-compact-switch"
          checked={setting.on}
          onChange={(event) => onChange({ ...setting, on: event.target.checked })}
        />
      </label>
      {setting.on && (
        <div className="set-compact-slider">
          <div className="set-compact-readout">
            <span>기본 압축 임계치 · 컨텍스트 사용률</span>
            <strong className="wb-mono">{setting.at}%</strong>
          </div>
          <input
            type="range"
            className="wb-compact-range"
            min={AUTO_COMPACT_GAUGE_MIN}
            max={AUTO_COMPACT_GAUGE_MAX}
            step={AUTO_COMPACT_STEP}
            value={setting.at}
            style={{ background: track }}
            onChange={(event) => onChange({ ...setting, at: clampAutoCompactAt(event.target.value) })}
          />
          <div className="set-compact-ends">
            <span>{AUTO_COMPACT_GAUGE_MIN}%</span>
            <span>{AUTO_COMPACT_GAUGE_MAX}%</span>
          </div>
          <div className="set-compact-limit">{AUTO_COMPACT_FLOOR}% 미만 · {AUTO_COMPACT_CEIL}% 초과는 설정할 수 없습니다.</div>
        </div>
      )}
    </div>
  );
}

export function AuthView({ auth, draft, onDraft, onSave, onTest, onConnectSubscription, onDisconnectSubscription }: {
  auth: InitialAppState["auth"];
  draft: string;
  onDraft: (value: string) => void;
  onSave: () => void;
  onTest: () => void;
  onConnectSubscription: (provider: "codex" | "claude") => void;
  onDisconnectSubscription: (provider: "codex" | "claude") => Promise<void>;
}) {
  const subscriptions = auth.filter((provider) => provider.kind === "subscription");
  const apiKeys = auth.filter((provider) => provider.kind === "apiKey");
  const canSave = draft.trim().length > 0;
  const [disconnectArmed, setDisconnectArmed] = useState<"codex" | "claude" | undefined>();
  const [disconnecting, setDisconnecting] = useState<"codex" | "claude" | undefined>();

  async function confirmDisconnect(provider: "codex" | "claude"): Promise<void> {
    setDisconnectArmed(undefined);
    setDisconnecting(provider);
    try {
      await onDisconnectSubscription(provider);
    } finally {
      setDisconnecting(undefined);
    }
  }

  return (
    <div className="set-page">
      {subscriptions.length > 0 && (
        <section className="set-section">
          <SetSectionHead label="구독" />
          {subscriptions.map((provider) => (
            <div className="set-row-stack" key={provider.id}>
              <div className="set-row">
                <span className="set-row-icon"><ShieldCheck size={19} /></span>
                <div className="set-row-body">
                  <span className="set-row-name">{provider.label}</span>
                  <span className="set-row-desc">{provider.detail || provider.description}</span>
                </div>
                {provider.action?.type === "subscriptionOAuth" && (
                  <button
                    type="button"
                    className="set-btn-soft"
                    disabled={provider.status === "pending"}
                    onClick={() => onConnectSubscription(provider.action!.provider)}
                  >
                    <RefreshCw size={14} className={provider.status === "pending" ? "wb-spin" : ""} />
                    {provider.action.label}
                  </button>
                )}
                {provider.id === "codex" && provider.status === "available" && (
                  <button
                    type="button"
                    className={`set-btn-soft set-btn-disconnect${disconnectArmed === "codex" ? " is-armed" : ""}`}
                    disabled={disconnecting === "codex"}
                    onClick={() => {
                      if (disconnectArmed !== "codex") {
                        setDisconnectArmed("codex");
                        return;
                      }
                      void confirmDisconnect("codex");
                    }}
                    onBlur={() => setDisconnectArmed(undefined)}
                  >
                    {disconnecting === "codex"
                      ? <RefreshCw size={14} className="wb-spin" />
                      : <LogOut size={14} />}
                    {disconnecting === "codex" ? "연결 끊는 중…" : disconnectArmed === "codex" ? "정말 연결 끊기" : "연결 끊기"}
                  </button>
                )}
                <SetBadge status={provider.status} />
              </div>
              {/* The bridge opened the SYSTEM DEFAULT browser. When the account
                  lives in another browser or profile that flow can never finish,
                  so the link must be reachable by hand — otherwise the row just
                  sits at "인증 대기 중" forever. */}
              {provider.authUrl && <AuthUrlRow url={provider.authUrl} />}
            </div>
          ))}
        </section>
      )}

      <section className="set-section">
        <SetSectionHead label="Provider API 키" />
        {apiKeys.map((provider) => (
          <div className="set-card" key={provider.id}>
            <div className="set-row set-row-flush">
              <span className="set-row-icon is-accent"><KeyRound size={18} /></span>
              <div className="set-row-body">
                <span className="set-row-name">{provider.label}</span>
                <span className="set-row-desc">{provider.description}</span>
              </div>
              <SetBadge status={provider.status} />
            </div>
            {provider.maskedValue && (
              <div className="set-key-current">
                <span>현재 키</span>
                <code className="wb-mono">{provider.maskedValue}</code>
              </div>
            )}
            <div className="set-key-input">
              <div className="set-input">
                <KeyRound size={14} />
                <input value={draft} onChange={(event) => onDraft(event.target.value)} placeholder="새 OpenRouter API 키 입력 (sk-or-…)" type="password" />
              </div>
              <button type="button" className="set-btn-accent" disabled={!canSave} onClick={onSave}><Check size={14} /> 저장</button>
              <button type="button" className="set-btn-soft" onClick={onTest}><FlaskConical size={14} /> 테스트</button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

const HARNESS_LABELS: Record<HarnessId, string> = { "claude-code": "Claude Code", codex: "Codex" };

export function RuntimeSettingsView({ routes, harnesses, router, settings, codexModels, onRefreshCodexModels, onSaveHarnessDefaults, onSetDefaultHarness, onToggleDebug, onSaveCompactDefault, onSaveGateDefault }: {
  routes: RouteLike[];
  harnesses: any[];
  router: string;
  settings: InitialAppState["settings"];
  codexModels?: CodexModelDiscoveryState;
  onRefreshCodexModels?: () => void;
  onSaveHarnessDefaults: (harnessId: HarnessId, patch: Partial<HarnessDefaults>) => void;
  onSetDefaultHarness: (harnessId: HarnessId) => void;
  onToggleDebug: (enabled: boolean) => void;
  onSaveCompactDefault: (setting: AutoCompactSetting) => void;
  onSaveGateDefault: (reviewer: GateReviewer) => void;
}) {
  const [copied, setCopied] = useState(false);
  function copyRouter() {
    void navigator.clipboard?.writeText(router);
    setCopied(true);
    setTimeout(() => setCopied(false), 1300);
  }

  return (
    <div className="set-page set-page-wide">
      {/* base harness */}
      <section className="set-card">
        <div className="set-card-label">기본 하네스</div>
        <div className="set-inline-note">
          <InfoIcon size={14} />
          <span>새 멤버는 각 하네스의 기본값으로 생성됩니다. 아래에서 하네스별 기본값을 지정하세요.</span>
        </div>
        <div className="set-router-row">
          <span className="set-router-id"><span className="set-dot is-success" /> Router</span>
          <span className="set-router-end">
            <span className="wb-mono">{router || "시작 중…"}</span>
            <button type="button" className="set-icon-btn" title="복사" onClick={copyRouter}>{copied ? <Check size={14} /> : <Copy size={13} />}</button>
          </span>
        </div>
        <div className="set-harness-pick">
          <label className="set-field">
            <span className="set-field-label">새 멤버 기본 하네스</span>
            <select className="set-select" value={settings.selectedHarnessId} onChange={(event) => onSetDefaultHarness(event.target.value as HarnessId)}>
              {HARNESS_IDS.map((id) => <option key={id} value={id}>{HARNESS_LABELS[id]}</option>)}
            </select>
          </label>
          <button type="button" className="set-toggle" onClick={() => onToggleDebug(!settings.debugEnabled)}>
            <span className={"set-switch" + (settings.debugEnabled ? " is-on" : "")}><span className="set-switch-knob" /></span>
            <span className="set-toggle-label">디버그 로그</span>
          </button>
        </div>
      </section>

      {/* Message Gate reviewer default (model + effort, no harness — headless) */}
      <section className="set-card">
        <div className="set-card-label">Message Gate</div>
        <GateDefaultsCard routes={routes} reviewer={settings.gateDefaults} onSave={onSaveGateDefault} />
      </section>

      {/* global auto-compact default (inherited by members without their own) */}
      <section className="set-card">
        <div className="set-card-label">Auto-compact</div>
        <SettingsAutoCompact setting={settings.compactDefault} onChange={onSaveCompactDefault} />
      </section>

      {/* per-harness defaults */}
      <div className="set-harness-grid">
        {HARNESS_IDS.map((id) => (
          <HarnessDefaultsCard
            key={id}
            harnessId={id}
            label={HARNESS_LABELS[id]}
            defaults={settings.harnessDefaults[id]}
            routes={routes.filter((route) => (route.harnessId || "claude-code") === id)}
            codexModels={id === "codex" ? codexModels : undefined}
            onRefreshCodexModels={onRefreshCodexModels}
            onSave={(patch) => onSaveHarnessDefaults(id, patch)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The Message Gate reviewer default — model + effort only (NO harness; it runs
 * headless as a raw completion). Any gate-on member without its own reviewer
 * uses this. Recommends a cheap/fast model (Haiku).
 */
function GateDefaultsCard({ routes, reviewer, onSave }: { routes: RouteLike[]; reviewer: GateReviewer; onSave: (reviewer: GateReviewer) => void }) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  // One entry per catalog model (headless → harness irrelevant; prefer claude-code).
  const models = useMemo(() => {
    const byModel = new Map<string, RouteLike>();
    for (const route of routes) {
      const existing = byModel.get(route.model);
      if (!existing || (route.harnessId || "claude-code") === "claude-code") {
        byModel.set(route.model, route);
      }
    }
    return Array.from(byModel.values());
  }, [routes]);
  const recommended = reviewer.model === "haiku";

  return (
    <div className="set-gate-defaults">
      <div className="set-inline-note">
        <MessageGateIcon size={14} />
        <span>게이트가 켜진 멤버가 자체 리뷰어를 지정하지 않으면 이 기본 리뷰어로 메시지를 심사합니다. <b>저렴하고 빠른 모델(Haiku)</b>을 권장합니다. 하네스 없이 헤드리스로 실행됩니다.</span>
      </div>
      <div className="set-field">
        <span className="set-field-label">리뷰어 모델 · effort {recommended && <span className="set-reco-badge">권장</span>}</span>
        <button type="button" className="wb-model-picker-trigger set-model-trigger" onClick={() => setCatalogOpen(true)}>
          <span className="wb-mono">{reviewer.model} · {reviewer.effort}</span>
          <ChevronDown size={14} />
        </button>
      </div>
      {catalogOpen && (
        <ModelCatalogModal
          title="게이트 리뷰어 모델"
          icon={<MessageGateIcon size={16} />}
          subtitle={<span className="wb-mono wb-modal-sub">헤드리스 기본값</span>}
          routes={models}
          value={{ model: reviewer.model, effort: reviewer.effort }}
          config={{ effort: true }}
          applyLabel="선택"
          onApply={(next) => onSave({ model: next.model, effort: next.effort || reviewer.effort })}
          onClose={() => setCatalogOpen(false)}
        />
      )}
    </div>
  );
}

/** One harness's editable creation defaults (model/effort/reasoning + permission). */
function HarnessDefaultsCard({ harnessId, label, defaults, routes, codexModels, onRefreshCodexModels, onSave }: {
  harnessId: HarnessId;
  label: string;
  defaults: HarnessDefaults;
  routes: RouteLike[];
  /** Codex-only: live account-catalog discovery state, so a still-loading or
   *  failed list is stated (never silently shows just the static fallback). */
  codexModels?: CodexModelDiscoveryState;
  onRefreshCodexModels?: () => void;
  onSave: (patch: Partial<HarnessDefaults>) => void;
}) {
  const [model, setModel] = useState(defaults.model);
  const [effort, setEffort] = useState(defaults.effort);
  const [reasoning, setReasoning] = useState(defaults.reasoning || "");
  const [permissionMode, setPermissionMode] = useState<PermissionModeSetting>(defaults.permissionMode || "default");
  const [preset, setPreset] = useState(() => codexPresetOf(defaults.codexPolicy || { sandbox: "workspace-write", approval: "on-request" }));
  const [saved, setSaved] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const isCodex = harnessId === "codex";
  const selectedRoute = routes.find((route) => route.model === model);

  function save() {
    const patch: Partial<HarnessDefaults> = { model, effort: effort as HarnessDefaults["effort"], reasoning: reasoning || undefined };
    if (isCodex) {
      const axes = preset === "custom" ? (defaults.codexPolicy || { sandbox: "workspace-write", approval: "on-request" }) : CODEX_PRESETS[preset];
      patch.codexPolicy = { ...axes, guardian: defaults.codexPolicy?.guardian ?? false } as CodexPolicy;
    } else {
      patch.permissionMode = permissionMode as HarnessDefaults["permissionMode"];
    }
    onSave(patch);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <section className="set-harness-card">
      <div className="set-harness-head">
        <span className={"set-harness-icon is-" + harnessId}><SquareTerminal size={15} /></span>
        <span className="set-harness-title">{label} 기본값</span>
      </div>

      <div className="set-field">
        <span className="set-field-label">모델</span>
        <button type="button" className="wb-model-picker-trigger set-model-trigger" onClick={() => setCatalogOpen(true)}>
          <span className="wb-mono">{selectedRoute?.label || model}</span>
          <ChevronDown size={14} />
        </button>
      </div>
      {catalogOpen && (
        <ModelCatalogModal
          title={`${label} 기본 모델`}
          icon={<SquareTerminal size={16} />}
          routes={routes}
          value={{ model }}
          config={{}}
          applyLabel="선택"
          onApply={(next) => setModel(next.model)}
          onClose={() => setCatalogOpen(false)}
        />
      )}
      {isCodex && codexModels?.status === "pending" && (
        <div className="set-inline-note is-soft">Codex 계정 모델 목록을 불러오는 중입니다… 완료되면 계정의 전체 모델로 갱신됩니다.</div>
      )}
      {isCodex && codexModels?.status === "error" && (
        <div className="set-inline-note is-error">
          Codex 모델 목록을 불러오지 못해 기본 모델만 표시됩니다: {codexModels.error}
          {onRefreshCodexModels && <button type="button" className="set-link-btn" onClick={onRefreshCodexModels}><RefreshCw size={12} /> 다시 시도</button>}
        </div>
      )}

      <div className="set-field">
        <span className="set-field-label">추론 강도</span>
        <SetSegmented
          value={effort as string}
          options={["low", "medium", "high", "xhigh", "max"].map((e) => ({ id: e, label: e }))}
          onChange={(id) => setEffort(id as HarnessDefaults["effort"])}
        />
      </div>
      <div className="set-field">
        <span className="set-field-label">추론 모드</span>
        <SetSegmented
          value={reasoning}
          options={[{ id: "", label: "모델 기본" }, { id: "adaptive", label: "adaptive" }, { id: "enabled", label: "enabled" }, { id: "disabled", label: "disabled" }]}
          onChange={(id) => setReasoning(id)}
        />
      </div>
      {isCodex ? (
        <label className="set-field">
          <span className="set-field-label">권한 (샌드박스 × 승인)</span>
          <select className="set-select" value={preset} onChange={(event) => setPreset(event.target.value as typeof preset)}>
            {(Object.keys(CODEX_PRESET_LABELS) as Array<keyof typeof CODEX_PRESET_LABELS>).map((p) => <option key={p} value={p}>{CODEX_PRESET_LABELS[p]}</option>)}
            {preset === "custom" && <option value="custom">Custom</option>}
          </select>
        </label>
      ) : (
        <label className="set-field">
          <span className="set-field-label">권한 모드</span>
          <select className="set-select" value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as PermissionModeSetting)}>
            {permissionModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
          </select>
        </label>
      )}
      <button type="button" className={"set-harness-save" + (saved ? " is-saved" : "")} onClick={save}>
        {saved ? <Check size={14} /> : <SlidersHorizontal size={13} />}
        {saved ? "저장됨" : `${label} 기본값 저장`}
      </button>
    </section>
  );
}

export function AutomationView({ automationApi, logs, debugEnabled, onToggleDebug }: {
  automationApi: InitialAppState["automationApi"];
  logs: InitialAppState["logs"];
  debugEnabled: boolean;
  onToggleDebug: (enabled: boolean) => void;
}) {
  return (
    <section className="legacy-view narrow">
      <section className="card">
        <div className="card-title">자동화 API</div>
        <Info label="API" value={automationApi?.baseUrl || ""} />
        <Info label="Spec" value={automationApi?.spec || ""} />
        <Info label="Logs" value={logs?.logFilePath || ""} />
        <label className="toggle-line"><input type="checkbox" checked={debugEnabled} onChange={(event) => onToggleDebug(event.target.checked)} />디버그 로그</label>
        <button className="ghost-btn" type="button" onClick={() => navigator.clipboard?.writeText(automationApi?.spec || "")}><Copy size={15} /> API 스펙 URL 복사</button>
        <div className="api-hint wb-mono">{automationApi?.spec || "API 시작 중..."}</div>
      </section>
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="info-line"><span>{label}</span><strong className="wb-mono">{value || "없음"}</strong></div>;
}
