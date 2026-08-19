import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Check, ChevronDown, ClipboardList, Copy, FileText, FlaskConical, FolderOpen, FoldVertical, Info as InfoIcon, KeyRound, LogOut, MonitorSmartphone, Moon, PackageCheck, RefreshCw, Settings2, ShieldCheck, SlidersHorizontal, Smartphone, SquareTerminal, Trash2, X } from "lucide-react";
import { formatDiagnosticsReport, type DiagnosticsReport } from "../../shared/diagnostics";
import type { EnvironmentCheck, EnvironmentReport, EnvironmentStatus } from "../../shared/environment";
import { EnvironmentProbeSteps, EnvironmentRawDetail, EnvironmentRemedyButtons, EnvironmentRepairNote } from "../workbench/EnvironmentRemedies";
import { ipcErrorMessage } from "./ipcError";
import { openUpdateDialog } from "./updateDialog";
import { UPDATE_FEED, type ReleaseSummary, type UpdateChannel, type UpdateStatus } from "../../shared/appUpdate";
import type { HarnessDefaults, HarnessId, InitialAppState, PermissionModeSetting, SessionView } from "../../shared/types";
import {
  cursorPolicyOf,
  type CursorAgentMode,
  type CursorApprovalMode,
  type CursorPolicy,
} from "../../shared/cursorPolicy";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import type { GateReviewer } from "../../shared/messageGate";
import type { RuntimeTabId } from "../../shared/runtimeTabs";
import { HARNESS_IDS } from "../../shared/types";
import { MessageGateIcon } from "../workbench/MessageGateIcon";
import { MobileLinkCard } from "./MobileLinkTab";
import { HarnessIcon } from "../workbench/HarnessIcon";
import { Markdown } from "../workbench/Markdown";
import { HarnessPermissionControl } from "../workbench/HarnessPermissionControl";
import { GateReviewerControl } from "../workbench/GateReviewerControl";
import { PartyPrimerSettings, type PartyPrimerSectionPatch } from "../workbench/PartyPrimerSettings";
import type { PartyPrimerSectionId } from "../../shared/partyPrimer";
import { Segmented } from "../workbench/Segmented";
import { SubtreeVisibility } from "../workbench/SubtreeVisibility";
import { DEFAULT_CODEX_POLICY, type CodexPolicy } from "../../shared/codexPolicy";
import { AUTO_COMPACT_CEIL, AUTO_COMPACT_FLOOR, AUTO_COMPACT_GAUGE_MAX, AUTO_COMPACT_GAUGE_MIN, AUTO_COMPACT_STEP, clampAutoCompactAt, type AutoCompactSetting } from "../../shared/autoCompact";
import { IDLE_SLEEP_MAX_MINUTES, IDLE_SLEEP_MIN_MINUTES, sanitizeIdleSleep, type IdleSleepSettings } from "../../shared/idleSleep";
import { COMPOSER_SEND_KEYS, type ComposerSendKey, type ComposerSettings } from "../../shared/composerSettings";
import { normalizeFontSettings, RECOMMENDED_FONTS, type FontSettings, type LocalFontFamily } from "../../shared/appFonts";
import { enumerateLocalFonts, probeFonts } from "./fontProbe";
import { FontPicker } from "../workbench/FontPicker";
import { RouteLike } from "../workbench/routes";
import type { DiscordBridgeStatus } from "../../shared/discordBridge";
import { ModelCatalogModal } from "../workbench/ModelCatalogModal";

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

/**
 * Quiet periods offered as one click each. Presets rather than a slider because
 * the usable range (1분 – 24시간) is three orders of magnitude, so a linear track
 * would make every value under an hour indistinguishable.
 */
const IDLE_SLEEP_PRESET_MINUTES = [1, 5, 15, 30, 60, 180];

function idleSleepMinutesLabel(minutes: number): string {
  return minutes < 60 ? `${minutes}분` : `${minutes / 60}시간`;
}

/**
 * The global idle-sleep block on the Settings → Runtime screen: whether a quiet
 * member's harness process is released, and how long "quiet" has to be.
 *
 * The timeout is only a floor — a member with a turn in flight, an approval
 * waiting, a compaction, detached background work, or a queued message is never
 * released, and one pinned with 계속 켜두기 opts out entirely. The copy says so,
 * because a bare "5분 뒤 종료" would read as a promise the app deliberately breaks.
 */
function SettingsIdleSleep({ setting, onChange }: { setting: IdleSleepSettings; onChange: (setting: IdleSleepSettings) => void }) {
  const safe = sanitizeIdleSleep(setting);
  // A timeout set over HTTP need not be one of the presets. Show it as its own
  // chip instead of silently rounding — the screen must not misreport the value
  // the sweep actually uses.
  const choices = IDLE_SLEEP_PRESET_MINUTES.includes(safe.timeoutMinutes)
    ? IDLE_SLEEP_PRESET_MINUTES
    : [...IDLE_SLEEP_PRESET_MINUTES, safe.timeoutMinutes].sort((a, b) => a - b);
  return (
    <div className="set-compact">
      <label className="set-compact-toggle">
        <span className="set-compact-badge"><Moon size={18} /></span>
        <span className="set-compact-copy">
          <strong>유휴 멤버의 프로세스 내리기</strong>
          <small>대화는 그대로 두고 하네스 프로세스만 반납해 메모리를 되찾습니다. 다음 메시지가 오면 대화를 이어서 다시 깨웁니다.</small>
        </span>
        <input
          type="checkbox"
          className="set-compact-switch"
          checked={safe.enabled}
          onChange={(event) => onChange({ ...safe, enabled: event.target.checked })}
        />
      </label>
      {safe.enabled && (
        <div className="set-compact-slider">
          <div className="set-compact-readout">
            <span>이만큼 조용하면 내립니다</span>
            <strong className="wb-mono">{idleSleepMinutesLabel(safe.timeoutMinutes)}</strong>
          </div>
          <Segmented
            value={String(safe.timeoutMinutes)}
            options={choices.map((minutes) => ({ id: String(minutes), label: idleSleepMinutesLabel(minutes) }))}
            onChange={(id) => onChange({ ...safe, timeoutMinutes: Number(id) })}
          />
          <div className="set-compact-limit">
            턴이 진행 중이거나 승인 대기·압축 중이거나 백그라운드 작업·대기 메시지가 남아 있으면 내리지 않습니다.
            멤버별로 계속 켜두려면 사이드바에서 멤버를 우클릭하세요. ({IDLE_SLEEP_MIN_MINUTES}분 ~ {IDLE_SLEEP_MAX_MINUTES / 60}시간)
          </div>
        </div>
      )}
    </div>
  );
}

/** The subscription cards whose account the app can disconnect in place. */
type DisconnectableProvider = "codex" | "claude" | "cursor";

function disconnectableProviderOf(id: string): DisconnectableProvider | undefined {
  if (id === "codex-bridge") return "codex";
  return id === "claude" || id === "cursor" ? id : undefined;
}

/** Key-shape hints; an unlisted provider falls back to a generic label. */
const API_KEY_PLACEHOLDERS: Record<string, string> = {
  openrouter: "새 OpenRouter API 키 입력 (sk-or-…)",
  deepseek: "새 DeepSeek API 키 입력 (sk-…)",
};

export function AuthView({ auth, drafts, onDraft, onSave, onTest, onClear, onConnectSubscription, onDisconnectSubscription }: {
  auth: InitialAppState["auth"];
  /** Per-provider key drafts. One shared draft would let a second API-key card
   *  overwrite the first provider's credential. */
  drafts: Record<string, string>;
  onDraft: (providerId: string, value: string) => void;
  onSave: (providerId: string) => void;
  onTest: (providerId: string) => void;
  /** Clears a stored API key. Required for OpenRouter (R-25); DeepSeek uses the same path. */
  onClear: (providerId: string) => void | Promise<void>;
  onConnectSubscription: (provider: "codex" | "claude") => void;
  onDisconnectSubscription: (provider: DisconnectableProvider) => Promise<void>;
}) {
  const subscriptions = auth.filter((provider) => provider.kind === "subscription");
  const apiKeys = auth.filter((provider) => provider.kind === "apiKey");
  const [disconnectArmed, setDisconnectArmed] = useState<DisconnectableProvider | undefined>();
  const [disconnecting, setDisconnecting] = useState<DisconnectableProvider | undefined>();
  const [clearing, setClearing] = useState<string | undefined>();

  async function confirmDisconnect(provider: DisconnectableProvider): Promise<void> {
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
          {subscriptions.map((provider) => {
            const disconnectable = provider.status === "available" ? disconnectableProviderOf(provider.id) : undefined;
            return (
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
                {disconnectable && (
                  <button
                    type="button"
                    className={`set-btn-soft set-btn-disconnect${disconnectArmed === disconnectable ? " is-armed" : ""}`}
                    disabled={disconnecting === disconnectable}
                    onClick={() => {
                      if (disconnectArmed !== disconnectable) {
                        setDisconnectArmed(disconnectable);
                        return;
                      }
                      void confirmDisconnect(disconnectable);
                    }}
                    onBlur={() => setDisconnectArmed(undefined)}
                  >
                    {disconnecting === disconnectable
                      ? <RefreshCw size={14} className="wb-spin" />
                      : <LogOut size={14} />}
                    {disconnecting === disconnectable ? "연결 끊는 중…" : disconnectArmed === disconnectable ? "정말 연결 끊기" : "연결 끊기"}
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
            );
          })}
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
                <input
                  value={drafts[provider.id] || ""}
                  onChange={(event) => onDraft(provider.id, event.target.value)}
                  placeholder={API_KEY_PLACEHOLDERS[provider.id] || `새 ${provider.label} API 키 입력`}
                  type="password"
                />
              </div>
              <button
                type="button"
                className="set-btn-accent"
                disabled={!(drafts[provider.id] || "").trim()}
                onClick={() => onSave(provider.id)}
              ><Check size={14} /> 저장</button>
              <button type="button" className="set-btn-soft" onClick={() => onTest(provider.id)}><FlaskConical size={14} /> 테스트</button>
              {provider.maskedValue && (
                <button
                  type="button"
                  className="set-btn-soft set-btn-disconnect"
                  disabled={clearing === provider.id}
                  data-auth-clear={provider.id}
                  onClick={() => {
                    setClearing(provider.id);
                    void Promise.resolve(onClear(provider.id)).finally(() => setClearing(undefined));
                  }}
                >
                  {clearing === provider.id
                    ? <RefreshCw size={14} className="wb-spin" />
                    : <Trash2 size={14} />}
                  {clearing === provider.id ? "지우는 중…" : "키 지우기"}
                </button>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

/**
 * Settings → Discord. Credentials plus the inbound whitelist for the member
 * bridge (docs/기획 노트.md §11). The token is write-only here: the app returns a
 * mask, so an empty field means "keep the stored one", never "clear it".
 */
function DiscordBridgeCard({ status, onSave, onDirtyChange }: { status?: DiscordBridgeStatus; onSave: (patch: { desktopName?: string; botToken?: string; guildId?: string; allowedUserIds?: string[] }) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const [desktopName, setDesktopName] = useState(status?.desktopName || "");
  const [token, setToken] = useState("");
  const [guildId, setGuildId] = useState(status?.guildId || "");
  const [allowed, setAllowed] = useState((status?.allowedUserIds || []).join(", "));
  const [saved, setSaved] = useState(false);

  const dirty = desktopName !== (status?.desktopName || "")
    || token.trim() !== ""
    || guildId !== (status?.guildId || "")
    || allowed !== (status?.allowedUserIds || []).join(", ");
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const connection = status?.connection || "off";
  const dotClass = connection === "connected" ? "is-success" : connection === "error" ? "is-error" : "is-idle";
  const connectionLabel = connection === "connected" ? "연결됨"
    : connection === "connecting" ? "연결 중…"
    : connection === "error" ? "오류"
    : status?.configured ? "대기 중" : "미설정";
  // The right-hand side answers "what is it bound to", not "what is the token" —
  // the mask already lives on the token field's own label.
  const connectionDetail = status?.botUser
    ? `${status.botUser.username} · 채널 ${status.bindings.length}개`
    : status?.configured ? "연결된 멤버 없음" : "봇 토큰을 입력하세요";

  function save() {
    const patch: { desktopName?: string; botToken?: string; guildId?: string; allowedUserIds?: string[] } = {
      desktopName: desktopName.trim(),
      guildId: guildId.trim(),
      allowedUserIds: allowed.split(/[,\s]+/).map((id) => id.trim()).filter(Boolean),
    };
    // Only send the token when the user actually typed a new one.
    if (token.trim()) {
      patch.botToken = token.trim();
    }
    onSave(patch);
    setToken("");
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <>
      <div className="set-inline-note">
        <InfoIcon size={14} />
        <span>멤버가 디스코드 채널로 보고하고, 그 채널에서 받은 지시를 이어받습니다. 멤버에게 “디스코드 연결해”라고 말하면 채널이 만들어집니다.</span>
      </div>
      <div className="set-router-row">
        <span className="set-router-id"><span className={"set-dot " + dotClass} /> {connectionLabel}</span>
        <span className="set-router-end">
          <span className="wb-mono">{connectionDetail}</span>
        </span>
      </div>
      {status?.error && <div className="set-inline-note" role="alert"><InfoIcon size={14} /><span>{status.error}</span></div>}
      <div className="set-card-fields">
      <label className="set-field">
        <span className="set-field-label">이 PC 이름</span>
        <div className="set-input">
          <MonitorSmartphone size={14} />
          <input placeholder="디스코드에서 이 PC의 카테고리 이름이 됩니다" value={desktopName} onChange={(event) => setDesktopName(event.target.value)} />
        </div>
      </label>
      <label className="set-field">
        <span className="set-field-label">봇 토큰{status?.tokenMask ? ` (저장됨: ${status.tokenMask})` : ""}</span>
        <div className="set-input">
          <KeyRound size={14} />
          <input
            type="password"
            placeholder={status?.tokenMask ? "변경할 때만 입력" : "Discord 개발자 포털 → Bot → Reset Token"}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
      </label>
      <label className="set-field">
        <span className="set-field-label">서버(길드) ID</span>
        <div className="set-input">
          <input placeholder="비워두면 자동 감지 (봇이 서버 1개일 때)" value={guildId} onChange={(event) => setGuildId(event.target.value)} />
        </div>
      </label>
      <label className="set-field">
        <span className="set-field-label">허용 사용자 ID</span>
        <div className="set-input">
          <ShieldCheck size={14} />
          <input placeholder="쉼표로 구분 · 비우면 아무도 멤버에게 말을 걸 수 없음" value={allowed} onChange={(event) => setAllowed(event.target.value)} />
        </div>
      </label>
      </div>
      <div className="set-inline-note is-warn">
        <ShieldCheck size={14} />
        <span>여기 적힌 사용자만 멤버에게 지시할 수 있습니다. 멤버는 이 PC에서 파일을 고치고 명령을 실행하므로, 비워두면 인바운드는 전부 차단됩니다.</span>
      </div>
      <div className="set-harness-pick">
        <button type="button" className={"set-btn-accent" + (saved ? " is-saved" : "")} onClick={save}><Check size={14} /> {saved ? "저장됨" : "저장"}</button>
        <span className="set-save-hint">저장하면 봇이 재연결됩니다.</span>
      </div>
    </>
  );
}

const HARNESS_LABELS: Record<HarnessId, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor CLI", grok: "Grok Build" };

/** Discord's wordmark glyph — lucide has no Discord icon and a generic speech
 *  bubble would read as "chat", not "the Discord bridge". */
function DiscordGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6.5c3-1 5-1 8 0M8 17.5c3 1 5 1 8 0" />
      <path d="M8 6.5C5.5 9 4.8 13.5 5.5 17.5c1 .8 2 1.4 2.5 1.5l1-2M16 6.5c2.5 2.5 3.2 7 2.5 11-1 .8-2 1.4-2.5 1.5l-1-2" />
    </svg>
  );
}

const RUNTIME_TABS: Array<{ id: RuntimeTabId; label: string; icon: ReactNode }> = [
  { id: "general", label: "일반", icon: <Settings2 size={14} /> },
  { id: "harness", label: "하네스 기본값", icon: <SquareTerminal size={14} /> },
  { id: "environment", label: "환경", icon: <ShieldCheck size={14} /> },
  { id: "primer", label: "파티 프롬프트", icon: <FileText size={14} /> },
  { id: "gate", label: "Message Gate", icon: <MessageGateIcon size={14} /> },
  { id: "discord", label: "Discord", icon: <DiscordGlyph size={14} /> },
  { id: "mobile", label: "모바일 연결", icon: <Smartphone size={14} /> },
  { id: "versions", label: "버전", icon: <PackageCheck size={14} /> },
  { id: "diagnostics", label: "진단", icon: <ClipboardList size={14} /> },
];

export function RuntimeSettingsView({ routes, harnesses, router, settings, codexModels, discord, onRefreshCodexModels, onSaveHarnessDefaults, onSetDefaultHarness, onToggleDebug, onSaveCompactDefault, onSaveIdleSleep, onSaveGateDefault, onSavePartyPrimer, onTranslatePartyPrimer, onSaveComposer, onSaveMemberMessaging, onSaveDiscord, onSaveExecutablePaths, tabRequest }: {
  routes: RouteLike[];
  harnesses: any[];
  router: string;
  settings: InitialAppState["settings"];
  codexModels?: CodexModelDiscoveryState;
  discord?: DiscordBridgeStatus;
  onRefreshCodexModels?: () => void;
  onSaveHarnessDefaults: (harnessId: HarnessId, patch: Partial<HarnessDefaults>) => void;
  onSetDefaultHarness: (harnessId: HarnessId) => void;
  onToggleDebug: (enabled: boolean) => void;
  onSaveCompactDefault: (setting: AutoCompactSetting) => void;
  onSaveIdleSleep: (setting: IdleSleepSettings) => void;
  onSaveGateDefault: (reviewer: GateReviewer) => void;
  /** One primer section at a time — text override and/or on-off. */
  onSavePartyPrimer: (patch: PartyPrimerSectionPatch) => void;
  /** Translates one primer section into Korean (or clears that translation). */
  onTranslatePartyPrimer: (patch: { section: PartyPrimerSectionId; clear?: boolean }) => Promise<void>;
  onSaveComposer: (patch: Partial<ComposerSettings>) => void;
  onSaveMemberMessaging: (patch: { interruptOnSend: boolean }) => void;
  onSaveDiscord: (patch: { botToken?: string; guildId?: string; allowedUserIds?: string[] }) => void;
  /** Executable overrides for the environment tab — one patch per field. */
  onSaveExecutablePaths: (patch: Partial<InitialAppState["settings"]>) => void;
  /** `POST /api/navigation {view:"runtime", tab}` — `seq` re-applies a repeat. */
  tabRequest?: { tab: RuntimeTabId; harness?: HarnessId; seq: number };
}) {
  const [tab, setTab] = useState<RuntimeTabId>("general");
  const mobileEnabled = settings.mobile?.enabled === true;
  const visibleTabs = mobileEnabled ? RUNTIME_TABS : RUNTIME_TABS.filter((entry) => entry.id !== "mobile");
  // Which harness the 하네스 기본값 tab is showing. Starts on the harness new
  // members are created with, since that is the one whose defaults matter.
  const [harnessTab, setHarnessTab] = useState<HarnessId>(settings.selectedHarnessId);
  useEffect(() => {
    if (tabRequest && tabRequest.seq > 0) {
      setTab(tabRequest.tab === "mobile" && !mobileEnabled ? "general" : tabRequest.tab);
      if (tabRequest.harness) setHarnessTab(tabRequest.harness);
    }
  }, [tabRequest?.seq, mobileEnabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!mobileEnabled && tab === "mobile") setTab("general");
  }, [mobileEnabled, tab]);
  const [copied, setCopied] = useState(false);
  // Which staged-save cards currently hold edits the user has not committed. Only
  // the staged cards (per-harness, Discord) can be dirty — every other control on
  // this screen applies on change, so it is never "unsaved".
  const [dirtyCards, setDirtyCards] = useState<Record<string, boolean>>({});
  const markDirty = useCallback((id: string, value: boolean) => {
    setDirtyCards((current) => (Boolean(current[id]) === value ? current : { ...current, [id]: value }));
  }, []);
  const dirty = Object.values(dirtyCards).some(Boolean);
  const bindingCount = discord?.bindings?.length || 0;

  function copyRouter() {
    void navigator.clipboard?.writeText(router);
    setCopied(true);
    setTimeout(() => setCopied(false), 1300);
  }

  const badges: Partial<Record<RuntimeTabId, number>> = { harness: HARNESS_IDS.length, discord: bindingCount };

  return (
    <>
      <div className="set-tabs" role="tablist" aria-label="런타임 설정">
        {visibleTabs.map((entry) => {
          const active = entry.id === tab;
          const badge = badges[entry.id];
          return (
            <button
              type="button"
              key={entry.id}
              role="tab"
              aria-selected={active}
              className={"set-tab" + (active ? " is-active" : "")}
              onClick={() => setTab(entry.id)}
            >
              <span className="set-tab-icon">{entry.icon}</span>
              {entry.label}
              {Boolean(badge) && <span className="set-tab-badge wb-mono">{badge}</span>}
            </button>
          );
        })}
        <span className="set-tabs-gap" />
        {dirty && (
          <span className="set-dirty-pill" role="status"><span className="set-dirty-dot" />저장되지 않은 변경</span>
        )}
      </div>

      {/* Every tab is one column now — the harness tab picks a harness rather than
          laying its cards out side by side — so they all read at the standard
          settings measure. */}
      <div className="set-page set-page-tabbed">
        {/* Every panel stays MOUNTED and is hidden instead: unmounting would throw
            away a staged (unsaved) edit the moment the user checked another tab —
            silently, right after the strip told them there were unsaved changes. */}
        <div className="set-tab-panel" hidden={tab !== "general"}>
        <SubtreeVisibility visible={tab === "general"}>
            {/* base harness */}
            <section className="set-card">
              <div className="set-card-label">기본 하네스</div>
              <div className="set-inline-note">
                <InfoIcon size={14} />
                <span>새 멤버는 각 하네스의 기본값으로 생성됩니다. <b>하네스 기본값</b> 탭에서 하네스별 기본값을 지정하세요.</span>
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

            {/* global auto-compact default (inherited by members without their own) */}
            <section className="set-card">
              <div className="set-card-label">Auto-compact</div>
              <SettingsAutoCompact setting={settings.compactDefault} onChange={onSaveCompactDefault} />
            </section>

            {/* idle sleep — release a quiet member's process, keep its conversation */}
            <section className="set-card">
              <div className="set-card-label">유휴 슬립</div>
              <SettingsIdleSleep setting={settings.idleSleep} onChange={onSaveIdleSleep} />
            </section>

            {/* message input preferences (send key) */}
            <section className="set-card">
              <div className="set-card-label">입력창</div>
              <ComposerSettingsCard settings={settings.composer} onSave={onSaveComposer} />
            </section>

            <section className="set-card">
              <div className="set-card-label">멤버 간 메시지</div>
              <button type="button" className="set-toggle" onClick={() => onSaveMemberMessaging({ interruptOnSend: !settings.memberMessaging?.interruptOnSend })}>
                <span className={"set-switch" + (settings.memberMessaging?.interruptOnSend ? " is-on" : "")}><span className="set-switch-knob" /></span>
                <span className="set-toggle-label">기본으로 진행 중인 턴 인터럽트</span>
              </button>
              <div className="set-inline-note">
                <InfoIcon size={14} />
                <span>멤버가 다른 멤버에게 보낼 때 <code>interrupt</code>를 생략하면 적용됩니다. 멤버별 설정과 호출에 직접 지정한 값이 이 기본값보다 우선합니다.</span>
              </div>
            </section>
        </SubtreeVisibility>
        </div>

        <div className="set-tab-panel" hidden={tab !== "harness"}>
        <SubtreeVisibility visible={tab === "harness"}>
            <div className="set-tab-note">
              <InfoIcon size={14} />
              <span>여기서 정한 값은 해당 하네스로 만드는 새 멤버의 시작값입니다. 멤버별로 언제든 덮어쓸 수 있습니다.</span>
            </div>
            {/* One harness at a time. Side by side, the cards were a wall of
                controls whose rows never lined up — each harness has different
                axes (Codex sandbox × approval, Cursor mode × approval), so the
                columns were the same width but never the same shape. */}
            <div className="set-subtabs" role="tablist" aria-label="하네스">
              {HARNESS_IDS.map((id) => (
                <button
                  type="button"
                  key={id}
                  role="tab"
                  aria-selected={id === harnessTab}
                  className={"set-subtab" + (id === harnessTab ? " is-active" : "")}
                  onClick={() => setHarnessTab(id)}
                >
                  <span className={"set-harness-icon is-" + id}><HarnessIcon harness={id} size={14} /></span>
                  {HARNESS_LABELS[id]}
                  {dirtyCards[id] && <span className="set-subtab-dot" title="저장되지 않은 변경" />}
                </button>
              ))}
            </div>
            {/* Mounted, not remounted per selection: the card stages its edits and
                switching harness must not throw an unsaved one away. */}
            {HARNESS_IDS.map((id) => (
              <div className="set-subtab-panel" key={id} hidden={id !== harnessTab}>
                <SubtreeVisibility visible={tab === "harness" && id === harnessTab}>
                  <HarnessDefaultsCard
                    harnessId={id}
                    label={HARNESS_LABELS[id]}
                    defaults={settings.harnessDefaults[id]}
                    routes={routes.filter((route) => (route.harnessId || "claude-code") === id)}
                    codexModels={id === "codex" ? codexModels : undefined}
                    onRefreshCodexModels={onRefreshCodexModels}
                    onSave={(patch) => onSaveHarnessDefaults(id, patch)}
                    onDirtyChange={(value) => markDirty(id, value)}
                  />
                </SubtreeVisibility>
              </div>
            ))}
        </SubtreeVisibility>
        </div>

        {/* The member primer — what every member session is told at start. */}
        <div className="set-tab-panel" hidden={tab !== "primer"}>
        <SubtreeVisibility visible={tab === "primer"}>
          <section className="set-card">
            <div className="set-card-label">파티 프롬프트<span className="set-card-sub wb-mono">멤버 세션 시스템 프롬프트</span></div>
            <PartyPrimerSettings
              settings={settings.partyPrimer}
              onSave={onSavePartyPrimer}
              onTranslate={onTranslatePartyPrimer}
              onDirtyChange={(value) => markDirty("primer", value)}
            />
          </section>
        </SubtreeVisibility>
        </div>

        {/* Message Gate reviewer default (model + effort, no harness — headless) */}
        <div className="set-tab-panel" hidden={tab !== "gate"}>
        <SubtreeVisibility visible={tab === "gate"}>
          <section className="set-card">
            <div className="set-card-label">Message Gate<span className="set-card-sub wb-mono">메시지 검문 · 리뷰어 기본값</span></div>
            <GateDefaultsCard routes={routes} reviewer={settings.gateDefaults} onSave={onSaveGateDefault} />
          </section>
        </SubtreeVisibility>
        </div>

        {/* Discord bridge — credentials + inbound whitelist */}
        <div className="set-tab-panel" hidden={tab !== "discord"}>
        <SubtreeVisibility visible={tab === "discord"}>
            <section className="set-card">
              <div className="set-card-label">Discord</div>
              <DiscordBridgeCard status={discord} onSave={onSaveDiscord} onDirtyChange={(value) => markDirty("discord", value)} />
            </section>
            {bindingCount > 0 && (
              <section className="set-card">
                <div className="set-card-label">연결된 멤버</div>
                <div className="set-link-list">
                  {discord!.bindings.map((binding) => (
                    <div className="set-link-row" key={`${binding.member}:${binding.channelName}`}>
                      <span className="set-link-member">{binding.member}</span>
                      <ArrowRight size={14} />
                      <span className="set-link-channel wb-mono">#{binding.channelName}</span>
                      <span className="set-link-meta wb-mono">{binding.threadName}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
        </SubtreeVisibility>
        </div>

        {/* Mobile link — pairing a phone to this desktop, and why it may not connect. */}
        {mobileEnabled && (
          <div className="set-tab-panel" hidden={tab !== "mobile"}>
          <SubtreeVisibility visible={tab === "mobile"}>
            <MobileLinkCard active={tab === "mobile"} />
          </SubtreeVisibility>
          </div>
        )}

        {/* Environment — readiness, not build facts: what still needs doing. */}
        <div className="set-tab-panel" hidden={tab !== "environment"}>
        <SubtreeVisibility visible={tab === "environment"}>
          <EnvironmentCard active={tab === "environment"} settings={settings} onSaveExecutablePaths={onSaveExecutablePaths} />
        </SubtreeVisibility>
        </div>

        {/* Versions — what is installed, what is newest, and what shipped before. */}
        <div className="set-tab-panel" hidden={tab !== "versions"}>
        <SubtreeVisibility visible={tab === "versions"}>
          <VersionsCard active={tab === "versions"} />
        </SubtreeVisibility>
        </div>

        {/* Diagnostics — what a bug report needs: build, host, log folder. */}
        <div className="set-tab-panel" hidden={tab !== "diagnostics"}>
        <SubtreeVisibility visible={tab === "diagnostics"}>
          <DiagnosticsCard active={tab === "diagnostics"} />
        </SubtreeVisibility>
        </div>
      </div>
    </>
  );
}

const ENVIRONMENT_STATUS_LABEL: Record<EnvironmentStatus, string> = {
  ok: "준비됨",
  warn: "주의",
  missing: "필요",
  error: "오류",
  unknown: "미확인",
};

/** The executable overrides the environment tab exposes, in harness order. */
type ExecutableField = "claudeExecutablePath" | "codexExecutablePath" | "cursorExecutablePath" | "grokExecutablePath";
const EXECUTABLE_FIELDS: Array<{ field: ExecutableField; label: string }> = [
  { field: "claudeExecutablePath", label: "Claude Code 실행 파일" },
  { field: "codexExecutablePath", label: "Codex 실행 파일" },
  { field: "cursorExecutablePath", label: "Cursor Agent 실행 파일" },
  { field: "grokExecutablePath", label: "Grok Build 실행 파일" },
];

/**
 * "Can this machine run a member, and if not, what do I press?"
 *
 * Sibling of {@link DiagnosticsCard} and deliberately a different screen: that
 * one is a snapshot to paste into a bug report, this one is a to-do list with
 * buttons. Loaded on FIRST reveal for the same reason — probing spawns CLIs.
 *
 * WSL is behind its own button because probing a distro STARTS it, which is far
 * too rude to do just because someone opened a settings tab.
 */
function EnvironmentCard({ active, settings, onSaveExecutablePaths }: {
  active: boolean;
  settings: InitialAppState["settings"];
  onSaveExecutablePaths: (patch: Partial<InitialAppState["settings"]>) => void;
}) {
  const [report, setReport] = useState<EnvironmentReport | undefined>();
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [wslLoading, setWslLoading] = useState(false);
  const [repairNote, setRepairNote] = useState<{ ok: boolean; detail: string; output?: string } | undefined>();

  const load = useCallback(async (options: { refresh?: boolean; includeWsl?: boolean } = {}) => {
    const wsl = Boolean(options.includeWsl);
    if (wsl) setWslLoading(true); else setLoading(true);
    setLoadError("");
    try {
      setReport(await window.agentParty.getEnvironment(options));
    } catch (error) {
      setLoadError(ipcErrorMessage(error));
    } finally {
      if (wsl) setWslLoading(false); else setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active && !report && !loading && !loadError) void load();
  }, [active, report, loading, loadError, load]);

  const groups: Array<{ id: EnvironmentCheck["group"]; label: string; hint: string }> = [
    { id: "harness", label: "하네스", hint: "멤버를 실행하는 CLI" },
    { id: "runtime", label: "기본 도구", hint: "하네스가 함께 쓰는 도구" },
    { id: "wsl", label: "WSL", hint: "배포판 안에서 실행할 때만 필요" },
  ];
  const wslChecked = (report?.checks || []).some((check) => check.group === "wsl");

  return (
    <>
      <div className="set-tab-note">
        <InfoIcon size={14} />
        <span>멤버를 만들기 전에 <b>이 PC가 준비됐는지</b> 확인합니다. 문제가 있으면 그 자리에서 해결할 수 있습니다.</span>
      </div>

      {loadError && (
        <div className="set-inline-note is-error">
          <AlertTriangle size={14} />
          <span>환경을 점검하지 못했습니다: {loadError}</span>
          <button type="button" className="set-link-btn" onClick={() => void load({ refresh: true })}><RefreshCw size={12} /> 다시 시도</button>
        </div>
      )}

      {repairNote && <EnvironmentRepairNote note={repairNote} />}

      {groups.map((group) => {
        const checks = (report?.checks || []).filter((check) => check.group === group.id);
        if (group.id === "wsl" && !checks.length && !wslChecked) {
          return (
            <section className="set-card" key={group.id}>
              <div className="set-card-label">{group.label}<span className="set-card-sub wb-mono">{group.hint}</span></div>
              <div className="set-inline-note">
                <InfoIcon size={14} />
                <span>배포판을 점검하면 <b>해당 배포판이 시작됩니다</b>. 그래서 자동으로 하지 않습니다.</span>
              </div>
              <div className="set-diag-actions">
                <button type="button" className="set-btn-soft" data-env="check-wsl" disabled={wslLoading} onClick={() => void load({ refresh: true, includeWsl: true })}>
                  <RefreshCw size={14} /> {wslLoading ? "점검 중…" : "WSL 점검"}
                </button>
              </div>
            </section>
          );
        }
        if (!checks.length) {
          return null;
        }
        return (
          <section className="set-card" key={group.id}>
            <div className="set-card-label">{group.label}<span className="set-card-sub wb-mono">{group.hint}</span></div>
            {checks.map((check) => (
              <EnvironmentCheckRow
                key={check.id}
                check={check}
                onRepaired={(result) => { setRepairNote(result); void load({ refresh: true, includeWsl: wslChecked }); }}
                onOpenExecutable={(field) => {
                  const input = document.querySelector<HTMLInputElement>(`[data-env-field="${field}"]`);
                  input?.scrollIntoView({ behavior: "smooth", block: "center" });
                  input?.focus({ preventScroll: true });
                }}
              />
            ))}
            {group.id === "wsl" && (
              <div className="set-diag-actions">
                <button type="button" className="set-btn-soft" data-env="check-wsl" disabled={wslLoading} onClick={() => void load({ refresh: true, includeWsl: true })}>
                  <RefreshCw size={14} /> {wslLoading ? "점검 중…" : "WSL 다시 점검"}
                </button>
              </div>
            )}
          </section>
        );
      })}

      <section className="set-card">
        <div className="set-card-label">실행 파일 경로<span className="set-card-sub wb-mono">비워두면 자동으로 찾습니다</span></div>
        <div className="set-inline-note">
          <InfoIcon size={14} />
          <span>이미 설치했는데 위에서 <b>찾지 못했다고</b> 나오면, 실행 파일 경로를 직접 지정하세요.</span>
        </div>
        {EXECUTABLE_FIELDS.map((entry) => (
          <ExecutablePathField
            key={entry.field}
            field={entry.field}
            label={entry.label}
            value={settings[entry.field] || ""}
            onSave={(value) => {
              onSaveExecutablePaths({ [entry.field]: value });
              void load({ refresh: true });
            }}
          />
        ))}
      </section>

      <div className="set-env-footer">
        <button type="button" className="set-btn-accent" data-env="refresh" disabled={loading} onClick={() => void load({ refresh: true })}>
          <RefreshCw size={14} /> {loading ? "점검 중…" : "다시 점검"}
        </button>
        {report?.expectedClaudeCli && <span className="set-save-hint">이 빌드가 기대하는 Claude Code: {report.expectedClaudeCli}</span>}
      </div>
    </>
  );
}

/** One check: status, what was found, why, and the ways out. */
function EnvironmentCheckRow({ check, onRepaired, onOpenExecutable }: {
  check: EnvironmentCheck;
  onRepaired: (result: { ok: boolean; detail: string; output?: string }) => void;
  onOpenExecutable: (settingsField: string) => void;
}) {
  return (
    <div className="set-env-row" data-env-check={check.id} data-status={check.status}>
      <div className="set-env-head">
        <span className={"set-env-chip is-" + check.status}>{ENVIRONMENT_STATUS_LABEL[check.status]}</span>
        <span className="set-env-label">{check.label}</span>
        {check.version && <span className="set-env-version wb-mono">{check.version}</span>}
      </div>
      <div className="set-env-detail">{check.detail}</div>
      {check.path && <div className="set-env-path wb-mono">{check.path}</div>}
      {Boolean(check.steps?.length) && <EnvironmentProbeSteps steps={check.steps || []} />}
      {Boolean(check.remedies?.length) && (
        <div className="set-env-actions">
          {/* Same component the in-transcript blocker card uses, so a fix
              offered in one place behaves identically in the other. */}
          <EnvironmentRemedyButtons
            remedies={check.remedies || []}
            onRepaired={onRepaired}
            onOpenEnvironment={(field) => { if (field) onOpenExecutable(field); }}
          />
        </div>
      )}
      {check.raw && !check.steps?.some((step) => Boolean(step.raw)) && <EnvironmentRawDetail raw={check.raw} />}
    </div>
  );
}

/**
 * Staged rather than applied-on-keystroke: a half-typed path would otherwise be
 * saved and immediately re-probed as "not found" on every character.
 */
function ExecutablePathField({ field, label, value, onSave }: {
  field: string;
  label: string;
  value: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const dirty = draft.trim() !== value.trim();
  return (
    <label className="set-field set-env-field">
      <span className="set-field-label">{label}</span>
      <span className="set-env-field-row">
        <span className="set-input">
          <input
            data-env-field={field}
            value={draft}
            placeholder="자동으로 찾기"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
        </span>
        <button type="button" className="set-btn-soft" disabled={!dirty} onClick={() => onSave(draft.trim())}>
          <Check size={14} /> 적용
        </button>
      </span>
    </label>
  );
}

/**
 * Version + log access + a one-paste diagnostic report.
 *
 * Loaded on FIRST reveal rather than on mount: the report reads live auth state,
 * which spawns the Cursor CLI, and every settings tab stays mounted — so an
 * eager fetch would put that cost on every window that opens this screen for an
 * unrelated tab.
 */
function DiagnosticsCard({ active }: { active: boolean }) {
  const [report, setReport] = useState<DiagnosticsReport | undefined>();
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [openError, setOpenError] = useState("");
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setReport(await window.agentParty.getDiagnostics());
    } catch (error) {
      setReport(undefined);
      setLoadError(ipcErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active && !report && !loading && !loadError) void load();
  }, [active, report, loading, loadError, load]);

  function copy(id: string, value: string) {
    void navigator.clipboard?.writeText(value);
    setCopied(id);
    setTimeout(() => setCopied((current) => (current === id ? "" : current)), 1300);
  }

  async function openLogFolder() {
    setOpenError("");
    try {
      await window.agentParty.openLogFolder();
    } catch (error) {
      // The folder did not open. Saying so is the whole point — a button that
      // reports nothing leaves the user believing the app is broken elsewhere.
      setOpenError(ipcErrorMessage(error));
    }
  }

  const versionText = report
    ? (report.version ? `v${report.version}` : "버전 불명") + (report.packaged ? "" : " (개발 빌드)")
    : "";
  const reportText = report ? formatDiagnosticsReport(report) : "";

  return (
    <>
      <div className="set-tab-note">
        <InfoIcon size={14} />
        <span>문제가 생겼을 때 <b>버전과 로그</b>를 함께 전달하면 원인을 훨씬 빨리 찾을 수 있습니다.</span>
      </div>

      {loadError && (
        <div className="set-inline-note is-error">
          <AlertTriangle size={14} />
          <span>진단 정보를 읽지 못했습니다: {loadError}</span>
          <button type="button" className="set-link-btn" onClick={() => void load()}><RefreshCw size={12} /> 다시 시도</button>
        </div>
      )}

      <section className="set-card">
        <div className="set-card-label">버전<span className="set-card-sub wb-mono">제보할 때 이 값을 함께 알려주세요</span></div>
        <DiagnosticsRow label="AgentParty" value={versionText} loading={loading} copiedId={copied} copyId="version" onCopy={copy} />
        {report?.versionError && (
          <div className="set-inline-note is-warn">
            <AlertTriangle size={14} />
            <span>{report.versionError}</span>
          </div>
        )}
        <DiagnosticsRow label="OS" value={report ? `${report.os.platform} ${report.os.release} (${report.os.arch})` : ""} loading={loading} />
        <DiagnosticsRow label="작업공간" value={report ? `${report.workspace.kind === "wsl" ? `WSL(${report.workspace.distro || "?"})` : "로컬"} · ${report.workspace.path}` : ""} loading={loading} />
        <DiagnosticsRow label="앱 경로" value={report?.appRoot || ""} loading={loading} />
      </section>

      <section className="set-card">
        <div className="set-card-label">로그<span className="set-card-sub wb-mono">NDJSON · 실행할 때마다 새 파일</span></div>
        <DiagnosticsRow label="파일" value={report?.logs.filePath || ""} loading={loading} copiedId={copied} copyId="logFile" onCopy={copy} />
        <div className="set-diag-actions">
          <button type="button" className="set-btn-soft" data-diag="open-logs" disabled={!report} onClick={() => void openLogFolder()}><FolderOpen size={14} /> 로그 폴더 열기</button>
          <button type="button" className="set-btn-soft" data-diag="copy-log-folder" disabled={!report} onClick={() => copy("logFolder", report?.logs.folderPath || "")}>
            {copied === "logFolder" ? <Check size={14} /> : <Copy size={14} />} 폴더 경로 복사
          </button>
        </div>
        {openError && (
          <div className="set-inline-note is-error">
            <AlertTriangle size={14} />
            <span>{openError}</span>
          </div>
        )}
      </section>

      <section className="set-card">
        <div className="set-card-label">진단 정보<span className="set-card-sub wb-mono">한 번에 복사해서 붙여넣기</span></div>
        <div className="set-inline-note">
          <InfoIcon size={14} />
          <span>버전·OS·작업공간·로그 위치·인증 상태를 한 덩어리로 모은 것입니다. <b>비밀 키는 담기지 않습니다</b> — 그대로 붙여넣어도 안전합니다.</span>
        </div>
        <pre className="set-diag-report wb-mono">{reportText || (loading ? "읽는 중…" : "—")}</pre>
        <div className="set-diag-actions">
          <button type="button" className="set-btn-accent" data-diag="copy-report" disabled={!report} onClick={() => copy("report", reportText)}>
            {copied === "report" ? <Check size={14} /> : <Copy size={14} />} 진단 정보 복사
          </button>
          <button type="button" className="set-btn-soft" data-diag="refresh" disabled={loading} onClick={() => void load()}><RefreshCw size={14} /> 새로고침</button>
        </div>
      </section>
    </>
  );
}

/**
 * 설정 → 버전 탭.
 *
 * Three questions, in the order a user asks them: what am I running, what is
 * the newest release and what changed in it, and — folded away until asked —
 * what shipped before that.
 *
 * The history comes from the public releases API (updateService.listReleases),
 * so it renders even on a build where self-update is unavailable: knowing what
 * exists is useful precisely when the app cannot fetch it for you.
 */
/** The release title, unless it just repeats the tag (`v0.2.0` for 0.2.0). */
function releaseTitle(release: ReleaseSummary): string {
  const name = release.name.trim();
  return name === release.version || name === `v${release.version}` ? "" : name;
}

function VersionsCard({ active }: { active: boolean }) {
  const [status, setStatus] = useState<UpdateStatus | undefined>();
  const [releases, setReleases] = useState<ReleaseSummary[] | undefined>();
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [changingChannel, setChangingChannel] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  /** Versions whose notes are expanded, by version string. */
  const [openNotes, setOpenNotes] = useState<Set<string>>(new Set());

  const loadReleases = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setListError("");
    try {
      const res = await window.agentParty.listUpdateVersions({ refresh });
      setReleases(res.releases);
    } catch (error) {
      setReleases(undefined);
      setListError(ipcErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }
    void window.agentParty.getUpdateStatus?.().then((res) => setStatus(res?.update)).catch(() => undefined);
    void loadReleases(false);
    // Same push the titlebar listens to, so this tab cannot go stale while open.
    const off = window.agentParty.onUpdateStatus?.((payload) => setStatus(payload));
    return () => { off?.(); };
  }, [active, loadReleases]);

  async function check() {
    setChecking(true);
    try {
      const res = await window.agentParty.checkForUpdate();
      setStatus(res.update);
      // A check that found something new means the list is stale too.
      await loadReleases(true);
    } catch (error) {
      setListError(ipcErrorMessage(error));
    } finally {
      setChecking(false);
    }
  }

  async function changeChannel(channel: UpdateChannel) {
    if (channel === (status?.channel || "stable")) {
      return;
    }
    setChangingChannel(true);
    setListError("");
    try {
      const res = await window.agentParty.setUpdateChannel(channel);
      setStatus(res.update);
      await loadReleases(true);
    } catch (error) {
      setListError(ipcErrorMessage(error));
    } finally {
      setChangingChannel(false);
    }
  }

  function toggleNotes(version: string) {
    setOpenNotes((current) => {
      const next = new Set(current);
      if (next.has(version)) {
        next.delete(version);
      } else {
        next.add(version);
      }
      return next;
    });
  }

  const current = status?.currentVersion || "";
  const channel = status?.channel || "stable";
  // "설치됨" is derived from the version this window reports, not only from the
  // flag the list carries — the two cards must never disagree on screen.
  const isCurrent = (release: ReleaseSummary) => (current ? release.version === current : Boolean(release.current));
  const latest = releases?.[0];
  const history = (releases || []).slice(1);
  const upToDate = Boolean(latest && current && latest.version === current);

  return (
    <>
      <div className="set-tab-note">
        <InfoIcon size={14} />
        <span>설치된 버전과 <b>배포된 모든 버전의 변경 내역</b>을 봅니다. 새 버전 설치는 제목 표시줄의 업데이트 배지에서도 할 수 있습니다.</span>
      </div>

      <section className="set-card set-update-channel-card" data-ver="channel-card">
        <div className="set-card-label">업데이트 채널<span className="set-card-sub">이 PC에 저장됩니다</span></div>
        <div className="set-update-channel-options" role="radiogroup" aria-label="업데이트 채널">
          <button
            type="button"
            role="radio"
            aria-checked={channel === "stable"}
            className={`set-update-channel-option${channel === "stable" ? " is-active" : ""}`}
            data-ver="channel-stable"
            disabled={changingChannel}
            onClick={() => void changeChannel("stable")}
          >
            <span>안정 채널</span>
            <small>검증을 마친 정식 릴리스만 받습니다.</small>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={channel === "beta"}
            className={`set-update-channel-option${channel === "beta" ? " is-active" : ""}`}
            data-ver="channel-beta"
            disabled={changingChannel}
            onClick={() => void changeChannel("beta")}
          >
            <span><FlaskConical size={13} /> 베타 채널</span>
            <small>시험 기능이 포함된 prerelease와 이후 정식 릴리스를 받습니다.</small>
          </button>
        </div>
        <div className="set-update-channel-note">
          {changingChannel ? <><RefreshCw size={12} className="wb-spin" /> 채널을 저장하고 업데이트를 확인하는 중…</> :
            channel === "beta" ? <><FlaskConical size={12} /> 베타 빌드는 예상하지 못한 문제가 있을 수 있습니다.</> :
              <><ShieldCheck size={12} /> 안정 채널이 기본값입니다.</>}
        </div>
      </section>

      <section className="set-card">
        <div className="set-card-label">설치된 버전<span className="set-card-sub wb-mono">{UPDATE_FEED.owner}/{UPDATE_FEED.repo}</span></div>
        <div className="set-ver-current">
          <span className="wb-mono set-ver-badge">v{current || "?"}</span>
          {upToDate && <span className="set-ver-tag is-ok">최신</span>}
          {status?.state === "available" && (
            <span className={status.downgrade ? "set-ver-tag is-warn" : "set-ver-tag is-new"}>
              v{status.latestVersion} {status.downgrade ? "로 되돌리기 가능" : "사용 가능"}
            </span>
          )}
          {status?.state === "downloaded" && <span className="set-ver-tag is-new">v{status.latestVersion} 설치 준비됨</span>}
          {status?.state === "disabled" && <span className="set-ver-note">{status.disabledReason}</span>}
          {status?.state === "error" && <span className="set-ver-note is-error">{status.error}</span>}
        </div>
        <div className="set-diag-actions">
          <button type="button" className="set-btn-soft" data-ver="check" disabled={checking} onClick={() => void check()}>
            <RefreshCw size={14} className={checking ? "wb-spin" : undefined} /> 업데이트 확인
          </button>
          <button type="button" className="set-btn-soft" data-ver="open-dialog" onClick={openUpdateDialog}>업데이트 창 열기</button>
        </div>
      </section>

      {listError && (
        <div className="set-inline-note is-error">
          <AlertTriangle size={14} />
          <span>{listError}</span>
          <button type="button" className="set-link-btn" onClick={() => void loadReleases(true)}><RefreshCw size={12} /> 다시 시도</button>
        </div>
      )}

      <section className="set-card">
        <div className="set-card-label">최신 버전<span className="set-card-sub wb-mono">{latest?.publishedAt ? new Date(latest.publishedAt).toLocaleDateString() : ""}</span></div>
        {!latest ? (
          <div className="set-ver-empty">{loading ? "불러오는 중…" : listError ? "목록을 불러오지 못했습니다." : "게시된 릴리스가 없습니다."}</div>
        ) : (
          <div className="set-ver-latest">
            <div className="set-ver-head">
              <span className="wb-mono set-ver-badge is-latest">v{latest.version}</span>
              {releaseTitle(latest) && <span className="set-ver-name">{releaseTitle(latest)}</span>}
              {latest.prerelease && <span className="set-ver-tag">프리릴리스</span>}
              {isCurrent(latest) && <span className="set-ver-tag is-ok">설치됨</span>}
              <button type="button" className="set-link-btn set-ver-link" onClick={() => void window.agentParty.openExternal(latest.url)}>
                <ArrowRight size={12} /> 릴리스 페이지
              </button>
            </div>
            <div className="set-ver-notes">
              {latest.notes ? <Markdown text={latest.notes} /> : <span className="set-ver-empty">변경 내역이 작성되지 않았습니다.</span>}
            </div>
          </div>
        )}
      </section>

      <section className="set-card">
        <button type="button" className="set-ver-toggle" data-ver="history-toggle" onClick={() => setShowHistory((v) => !v)}>
          <ChevronDown size={14} className={showHistory ? "set-ver-chev is-open" : "set-ver-chev"} />
          <span>이전 버전 보기</span>
          <span className="set-card-sub wb-mono">{history.length}개</span>
        </button>
        {showHistory && (
          history.length === 0 ? (
            <div className="set-ver-empty">이전 버전이 없습니다. 지금이 첫 릴리스입니다.</div>
          ) : (
            <ul className="set-ver-list">
              {history.map((release) => (
                <li key={release.version} className="set-ver-item">
                  <button type="button" className="set-ver-item-head" data-ver={`item-${release.version}`} onClick={() => toggleNotes(release.version)}>
                    <ChevronDown size={13} className={openNotes.has(release.version) ? "set-ver-chev is-open" : "set-ver-chev"} />
                    <span className="wb-mono set-ver-badge">v{release.version}</span>
                    {releaseTitle(release) && <span className="set-ver-name">{releaseTitle(release)}</span>}
                    {release.prerelease && <span className="set-ver-tag">프리릴리스</span>}
                    {isCurrent(release) && <span className="set-ver-tag is-ok">설치됨</span>}
                    <span className="set-ver-date wb-mono">{release.publishedAt ? new Date(release.publishedAt).toLocaleDateString() : ""}</span>
                  </button>
                  {openNotes.has(release.version) && (
                    <div className="set-ver-notes">
                      {release.notes ? <Markdown text={release.notes} /> : <span className="set-ver-empty">변경 내역이 작성되지 않았습니다.</span>}
                      <button type="button" className="set-link-btn set-ver-link" onClick={() => void window.agentParty.openExternal(release.url)}>
                        <ArrowRight size={12} /> 릴리스 페이지
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )
        )}
      </section>
    </>
  );
}

/** One `label — value [copy]` line. Wraps rather than truncating: a log path is
 *  the value most likely to be long AND the one most likely to be read by eye. */
function DiagnosticsRow({ label, value, loading, copyId, copiedId, onCopy }: {
  label: string;
  value: string;
  loading: boolean;
  copyId?: string;
  copiedId?: string;
  onCopy?: (id: string, value: string) => void;
}) {
  return (
    <div className="set-diag-row">
      <span className="set-diag-key">{label}</span>
      <span className="set-diag-value wb-mono">{value || (loading ? "읽는 중…" : "—")}</span>
      {copyId && onCopy && (
        <button type="button" className="set-icon-btn" data-diag={`copy-${copyId}`} title="복사" disabled={!value} onClick={() => onCopy(copyId, value)}>
          {copiedId === copyId ? <Check size={14} /> : <Copy size={13} />}
        </button>
      )}
    </div>
  );
}

/**
 * UI/code font family pickers (설정 → 글꼴).
 *
 * Applies on change rather than behind a save button — the whole window
 * repaints in the chosen font, so staging the change would hide the only thing
 * worth previewing.
 *
 * Owns the two things both pickers share: the enumerated font list, and the
 * width-probe fallback for recommended families that enumeration did not cover.
 * Enumerating once here rather than per picker halves the work and guarantees
 * the two lists cannot disagree.
 */
function FontSettingsCard({ settings, onSave }: { settings: FontSettings | undefined; onSave: (patch: Partial<FontSettings>) => void }) {
  const selection = normalizeFontSettings(settings);
  const [families, setFamilies] = useState<LocalFontFamily[]>([]);
  const [available, setAvailable] = useState<Record<string, boolean | null>>({});
  const [enumerationError, setEnumerationError] = useState<string>();
  const [loading, setLoading] = useState(true);

  // Wait for the bundled webfonts before measuring — probing earlier reports
  // Maplestory itself as missing, because it has not been applied yet.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const listing = await enumerateLocalFonts();
      if (cancelled) {
        return;
      }
      setFamilies(listing.families);
      setEnumerationError(listing.error);
      // Only the recommended families need the width probe; everything else
      // came from the enumeration and is installed by definition.
      setAvailable(probeFonts(RECOMMENDED_FONTS.map((font) => font.family)));
      setLoading(false);
    };
    void (document.fonts?.ready ? document.fonts.ready.then(run) : run());
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <div className="set-inline-note">
        <InfoIcon size={14} />
        <span>앱 전체에 즉시 적용됩니다. <b>UI 글꼴</b>은 화면 텍스트에, <b>코드 글꼴</b>은 코드·도구 출력·모노스페이스 표기에 쓰입니다. 글씨 <b>크기</b>는 대화 위에서 Ctrl+휠로 조절합니다.</span>
      </div>
      <FontPicker
        role="sans"
        label="UI 글꼴"
        value={selection.sans}
        families={families}
        available={available}
        enumerationError={enumerationError}
        loading={loading}
        onChange={(family) => onSave({ sans: family })}
      />
      <FontPicker
        role="mono"
        label="코드 글꼴"
        value={selection.mono}
        families={families}
        available={available}
        enumerationError={enumerationError}
        loading={loading}
        onChange={(family) => onSave({ mono: family })}
      />
    </>
  );
}

const SEND_KEY_LABELS: Record<ComposerSendKey, string> = {
  "ctrl-enter": "Ctrl+Enter 로 전송 (Enter 는 줄바꿈)",
  enter: "Enter 로 전송 (Shift+Enter 는 줄바꿈)",
};

/**
 * Message input preferences (send key, interrupt-on-send). Applies immediately
 * (no save button) — each control is a single switch whose effect is visible in
 * the composer on the next keystroke, so a staged "save" would only add a step.
 */
function ComposerSettingsCard({ settings, onSave }: { settings: ComposerSettings | undefined; onSave: (patch: Partial<ComposerSettings>) => void }) {
  const sendKey = settings?.sendKey || "ctrl-enter";
  const interruptOnSend = settings?.interruptOnSend === true;
  return (
    <>
      <div className="set-inline-note">
        <InfoIcon size={14} />
        <span>멤버에게 메시지를 보낼 때 쓰는 키입니다. 패널 폭과 관계없이 동일하게 동작합니다.</span>
      </div>
      <div className="set-harness-pick">
        <label className="set-field">
          <span className="set-field-label">전송 키</span>
          <select className="set-select" value={sendKey} onChange={(event) => onSave({ sendKey: event.target.value as ComposerSendKey })}>
            {COMPOSER_SEND_KEYS.map((id) => <option key={id} value={id}>{SEND_KEY_LABELS[id]}</option>)}
          </select>
        </label>
        <button type="button" className="set-toggle" onClick={() => onSave({ interruptOnSend: !interruptOnSend })}>
          <span className={"set-switch" + (interruptOnSend ? " is-on" : "")}><span className="set-switch-knob" /></span>
          <span className="set-toggle-label">전송 시 진행 중인 턴 중단</span>
        </button>
      </div>
      <div className="set-inline-note">
        <InfoIcon size={14} />
        <span>켜면 멤버가 작업 중이어도 즉시 중단하고 새 메시지를 처리합니다. 끄면(기본) 진행 중인 턴이 끝난 뒤에 처리됩니다. 압축 중에는 어느 쪽이든 중단하지 않습니다. 이 설정은 <b>이 입력창에만</b> 적용됩니다 — HTTP API 로 보내는 쪽은 호출할 때마다 직접 지정합니다.</span>
      </div>
    </>
  );
}

/**
 * The Message Gate reviewer default — model + effort only (NO harness; it runs
 * headless as a raw completion). Any gate-on member without its own reviewer
 * uses this. Recommends a cheap/fast model (Haiku).
 */
function GateDefaultsCard({ routes, reviewer, onSave }: { routes: RouteLike[]; reviewer: GateReviewer; onSave: (reviewer: GateReviewer) => void }) {
  const recommended = reviewer.model === "haiku";

  return (
    <div className="set-gate-defaults">
      <div className="set-inline-note">
        <MessageGateIcon size={14} />
        <span>게이트가 켜진 멤버가 자체 리뷰어를 지정하지 않으면 이 기본 리뷰어로 메시지를 심사합니다. <b>저렴하고 빠른 모델(Haiku)</b>을 권장합니다. 하네스 없이 헤드리스로 실행됩니다.</span>
      </div>
      <GateReviewerControl
        routes={routes}
        reviewer={reviewer}
        onChange={onSave}
        badge={recommended ? <span className="set-reco-badge">권장</span> : undefined}
      />
    </div>
  );
}

/** One harness's editable creation defaults (model/effort/reasoning + permission). */
function HarnessDefaultsCard({ harnessId, label, defaults, routes, codexModels, onRefreshCodexModels, onSave, onDirtyChange }: {
  harnessId: HarnessId;
  label: string;
  defaults: HarnessDefaults;
  routes: RouteLike[];
  /** Codex-only: live account-catalog discovery state, so a still-loading or
   *  failed list is stated (never silently shows just the static fallback). */
  codexModels?: CodexModelDiscoveryState;
  onRefreshCodexModels?: () => void;
  onSave: (patch: Partial<HarnessDefaults>) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [model, setModel] = useState(defaults.model);
  const [effort, setEffort] = useState(defaults.effort);
  const [reasoning, setReasoning] = useState(defaults.reasoning || "");
  const [reasoningBudget, setReasoningBudget] = useState<number | undefined>(defaults.reasoningBudget);
  const [serviceTier, setServiceTier] = useState(defaults.serviceTier || "");
  const [permissionMode, setPermissionMode] = useState<PermissionModeSetting>(defaults.permissionMode || "default");
  const [cursorPolicy, setCursorPolicy] = useState<CursorPolicy>(() => cursorPolicyOf(defaults.cursorPolicy, defaults.permissionMode));
  const [codexPolicy, setCodexPolicy] = useState<CodexPolicy>(() => defaults.codexPolicy || DEFAULT_CODEX_POLICY);
  const [saved, setSaved] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const isCodex = harnessId === "codex";
  const isCursor = harnessId === "cursor";
  const selectedRoute = routes.find((route) => route.model === model);
  // The catalog modal stays the place to *browse* models (search, cost, context);
  // effort and thinking are also surfaced inline because they are the two knobs
  // users retune without wanting to change model at all.
  const effortOptions = selectedRoute?.capabilities?.effort?.supported ? (selectedRoute.capabilities.effort.options || []) : [];
  const thinkingOptions = selectedRoute?.capabilities?.thinking?.supported ? (selectedRoute.capabilities.thinking.modes || []) : [];
  const runtimeSummary = [
    typeof reasoningBudget === "number" ? `budget ${reasoningBudget.toLocaleString()}` : "",
    serviceTier ? `speed ${serviceTier}` : "",
  ].filter(Boolean).join(" · ");

  const baseCursor = cursorPolicyOf(defaults.cursorPolicy, defaults.permissionMode);
  const baseCodex = defaults.codexPolicy || DEFAULT_CODEX_POLICY;
  const dirty = model !== defaults.model
    || effort !== defaults.effort
    || reasoning !== (defaults.reasoning || "")
    || reasoningBudget !== defaults.reasoningBudget
    || serviceTier !== (defaults.serviceTier || "")
    || (isCodex
      ? codexPolicy.sandbox !== baseCodex.sandbox || codexPolicy.approval !== baseCodex.approval || Boolean(codexPolicy.guardian) !== Boolean(baseCodex.guardian)
      : isCursor
        ? cursorPolicy.mode !== baseCursor.mode || cursorPolicy.approval !== baseCursor.approval
        : permissionMode !== (defaults.permissionMode || "default"));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  function save() {
    const patch: Partial<HarnessDefaults> = {
      model,
      effort: effort as HarnessDefaults["effort"],
      reasoning: reasoning || undefined,
      reasoningBudget,
      serviceTier: serviceTier || undefined,
    };
    if (isCodex) {
      patch.codexPolicy = codexPolicy;
    } else if (isCursor) {
      patch.cursorPolicy = cursorPolicy;
      patch.permissionMode = undefined;
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
        <span className={"set-harness-icon is-" + harnessId}><HarnessIcon harness={harnessId} size={15} /></span>
        <span className="set-harness-title">{label} 기본값</span>
      </div>

      <div className="set-field">
        <span className="set-field-label">모델</span>
        <button type="button" className="wb-model-picker-trigger set-model-trigger" onClick={() => setCatalogOpen(true)}>
          <span className="wb-mono">{selectedRoute?.label || model}</span>
          <ChevronDown size={14} />
        </button>
        {runtimeSummary && <span className="set-row-desc wb-mono">{runtimeSummary}</span>}
      </div>
      {effortOptions.length > 0 && (
        <div className="set-field">
          <span className="set-field-label">추론 강도</span>
          <Segmented value={effort || ""} options={effortOptions.map((option) => ({ id: option.id, label: option.label }))} onChange={(id) => setEffort(id as HarnessDefaults["effort"])} />
        </div>
      )}
      {thinkingOptions.length > 0 && (
        <div className="set-field">
          <span className="set-field-label">추론 모드</span>
          {/* An unset value still has to point at the mode the model will actually
              use — the same resolution the catalog modal shows — or the control
              renders with nothing selected and reads as broken. */}
          <Segmented
            value={reasoning || selectedRoute?.capabilities?.thinking?.defaultValue || ""}
            options={thinkingOptions.map((mode) => ({ id: mode.id, label: mode.label }))}
            onChange={setReasoning}
          />
        </div>
      )}
      {catalogOpen && (
        <ModelCatalogModal
          title={`${label} 기본 실행 구성`}
          icon={<SquareTerminal size={16} />}
          routes={routes}
          value={{
            model,
            effort,
            thinkingMode: reasoning || undefined,
            thinkingBudget: reasoningBudget,
            serviceTier: serviceTier || undefined,
          }}
          config={{ effort: true, thinking: true, serviceTier: true }}
          applyLabel="선택"
          onApply={(next) => {
            setModel(next.model);
            if (next.effort) setEffort(next.effort as HarnessDefaults["effort"]);
            setReasoning(next.thinkingMode || "");
            setReasoningBudget(next.thinkingBudget);
            setServiceTier(next.serviceTier || "");
          }}
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

      {/* The SAME control the member-create wizard uses, so what you set as a
          default and what you pick per member are one interface — including the
          axes a settings-only preset dropdown used to hide (Codex sandbox ×
          approval + Guardian, Cursor mode × approval). */}
      <div className="set-field">
        <span className="set-field-label">초기 권한</span>
        <HarnessPermissionControl
          harnessId={harnessId}
          variant="inline"
          selectClassName="set-select"
          value={{ permissionMode, codexPolicy, cursorPolicy }}
          onChange={(patch) => {
            if (patch.permissionMode) setPermissionMode(patch.permissionMode);
            if (patch.codexPolicy) setCodexPolicy(patch.codexPolicy);
            if (patch.cursorPolicy) setCursorPolicy(patch.cursorPolicy);
          }}
        />
      </div>
      <button type="button" className={"set-harness-save" + (saved ? " is-saved" : "")} onClick={save}>
        {saved ? <Check size={14} /> : <SlidersHorizontal size={13} />}
        {saved ? "저장됨" : `${label} 기본값 저장`}
      </button>
    </section>
  );
}

/**
 * The 설정 screen — app-shell preferences plus the automation API/log handles.
 *
 * The font pickers live HERE rather than under 런타임 on purpose: 런타임 owns the
 * defaults a new MEMBER inherits (harness, model, send key), while a font is a
 * property of the app window itself and applies no matter which members exist.
 */
export function AutomationView({ automationApi, logs, debugEnabled, fonts, onToggleDebug, onSaveFonts }: {
  automationApi: InitialAppState["automationApi"];
  logs: InitialAppState["logs"];
  debugEnabled: boolean;
  fonts: FontSettings | undefined;
  onToggleDebug: (enabled: boolean) => void;
  onSaveFonts: (patch: Partial<FontSettings>) => void;
}) {
  return (
    <section className="legacy-view narrow set-stack">
      <section className="card">
        <div className="card-title">글꼴</div>
        <FontSettingsCard settings={fonts} onSave={onSaveFonts} />
      </section>
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
