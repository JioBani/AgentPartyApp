import { useState } from "react";
import { Check, Copy, KeyRound, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { HarnessDefaults, HarnessId, InitialAppState, PermissionModeSetting, SessionView } from "../../shared/types";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import { HARNESS_IDS } from "../../shared/types";
import { CODEX_PRESETS, CODEX_PRESET_LABELS, codexPresetOf, type CodexPolicy } from "../../shared/codexPolicy";
import { RouteLike, routeKey } from "../workbench/routes";

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

export function AuthView({ auth, draft, onDraft, onSave, onTest }: {
  auth: InitialAppState["auth"];
  draft: string;
  onDraft: (value: string) => void;
  onSave: () => void;
  onTest: () => void;
}) {
  return (
    <section className="legacy-view narrow">
      <section className="card">
        <div className="card-title">인증</div>
        {auth.map((provider) => (
          <div className="auth-row" key={provider.id}>
            <div className="auth-icon">{provider.kind === "apiKey" ? <KeyRound size={16} /> : <ShieldCheck size={16} />}</div>
            <div className="auth-body"><strong>{provider.label}</strong><small>{provider.detail || provider.description}</small>{provider.maskedValue && <code>{provider.maskedValue}</code>}</div>
            <span className={"tag " + provider.status}>{provider.status}</span>
          </div>
        ))}
        <div className="key-box">
          <input value={draft} onChange={(event) => onDraft(event.target.value)} placeholder="OpenRouter API 키" type="password" />
          <button onClick={onSave} type="button" className="accent-btn"><Check size={15} /></button>
          <button className="ghost-btn" type="button" onClick={onTest}>테스트</button>
        </div>
      </section>
    </section>
  );
}

const HARNESS_LABELS: Record<HarnessId, string> = { "claude-code": "Claude Code", codex: "Codex" };

export function RuntimeSettingsView({ routes, harnesses, router, settings, codexModels, onRefreshCodexModels, onSaveHarnessDefaults, onSetDefaultHarness, onToggleDebug }: {
  routes: RouteLike[];
  harnesses: any[];
  router: string;
  settings: InitialAppState["settings"];
  codexModels?: CodexModelDiscoveryState;
  onRefreshCodexModels?: () => void;
  onSaveHarnessDefaults: (harnessId: HarnessId, patch: Partial<HarnessDefaults>) => void;
  onSetDefaultHarness: (harnessId: HarnessId) => void;
  onToggleDebug: (enabled: boolean) => void;
}) {
  return (
    <section className="legacy-view">
      <section className="card">
        <div className="card-title">기본 하네스</div>
        <div className="notice">새 멤버는 각 하네스의 기본값으로 생성됩니다. 아래에서 하네스별 기본값을 지정하세요.</div>
        <Info label="Router" value={router} />
        <label className="field">새 멤버 기본 하네스
          <select value={settings.selectedHarnessId} onChange={(event) => onSetDefaultHarness(event.target.value as HarnessId)}>
            {HARNESS_IDS.map((id) => <option key={id} value={id}>{HARNESS_LABELS[id]}</option>)}
          </select>
        </label>
        <label className="toggle-line"><input type="checkbox" checked={settings.debugEnabled} onChange={(event) => onToggleDebug(event.target.checked)} />디버그 로그</label>
      </section>
      <div className="split-grid">
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
    </section>
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

  function save() {
    const patch: Partial<HarnessDefaults> = { model, effort: effort as HarnessDefaults["effort"], reasoning: reasoning || undefined };
    if (harnessId === "codex") {
      const axes = preset === "custom" ? (defaults.codexPolicy || { sandbox: "workspace-write", approval: "on-request" }) : CODEX_PRESETS[preset];
      patch.codexPolicy = { ...axes, guardian: defaults.codexPolicy?.guardian ?? false } as CodexPolicy;
    } else {
      patch.permissionMode = permissionMode as HarnessDefaults["permissionMode"];
    }
    onSave(patch);
  }

  return (
    <section className="card">
      <div className="card-title">{label} 기본값</div>
      <label className="field">모델
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          {routes.map((route) => <option key={routeKey(route)} value={route.model} disabled={route.enabled === false}>{route.label || route.model}</option>)}
        </select>
      </label>
      {harnessId === "codex" && codexModels?.status === "pending" && (
        <div className="notice">Codex 계정 모델 목록을 불러오는 중입니다… 지금은 기본 모델만 보이며, 완료되면 계정의 전체 모델(GPT-5.x 등)로 갱신됩니다.</div>
      )}
      {harnessId === "codex" && codexModels?.status === "error" && (
        <div className="soft-error">
          Codex 모델 목록을 불러오지 못해 기본 모델만 표시됩니다: {codexModels.error}
          {onRefreshCodexModels && <button type="button" className="ghost-btn" onClick={onRefreshCodexModels}><RefreshCw size={13} /> 다시 시도</button>}
        </div>
      )}
      <label className="field">추론 강도<select value={effort} onChange={(event) => setEffort(event.target.value as HarnessDefaults["effort"])}>{["low", "medium", "high", "xhigh", "max"].map((e) => <option key={e} value={e}>{e}</option>)}</select></label>
      <label className="field">추론 모드<select value={reasoning} onChange={(event) => setReasoning(event.target.value)}><option value="">모델 기본</option>{["adaptive", "enabled", "disabled"].map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label>
      {harnessId === "codex" ? (
        <label className="field">권한 (샌드박스 × 승인)
          <select value={preset} onChange={(event) => setPreset(event.target.value as typeof preset)}>
            {(Object.keys(CODEX_PRESET_LABELS) as Array<keyof typeof CODEX_PRESET_LABELS>).map((p) => <option key={p} value={p}>{CODEX_PRESET_LABELS[p]}</option>)}
            {preset === "custom" && <option value="custom">Custom</option>}
          </select>
        </label>
      ) : (
        <label className="field">권한 모드<select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as PermissionModeSetting)}>{permissionModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label>
      )}
      <div className="field-actions"><button type="button" className="accent-btn" onClick={save}>{label} 기본값 저장</button></div>
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
