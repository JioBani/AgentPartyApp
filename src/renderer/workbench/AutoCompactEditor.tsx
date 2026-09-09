import { useEffect, useRef, useState } from "react";
import { ChevronsDownUp, FoldVertical, X } from "lucide-react";
import {
  AUTO_COMPACT_CEIL,
  AUTO_COMPACT_FLOOR,
  AUTO_COMPACT_GAUGE_MAX,
  AUTO_COMPACT_GAUGE_MIN,
  AUTO_COMPACT_MAX,
  AUTO_COMPACT_MIN,
  AUTO_COMPACT_STEP,
  clampAutoCompactAt,
  thresholdTokens,
  type AutoCompactSetting,
} from "../../shared/autoCompact";
import type { MemberView } from "./types";
import type { WorkbenchActions } from "./actions";
import { thresholdWindowFor } from "./memberStatus";
import { LocalizedText, localized } from "../i18n/I18nProvider";
import { useModalEscape } from "./useModalEscape";

// The Auto-compact dialog's threshold slider band — the SAME settable range as the
// Runtime modal's editor (10–95, step 1), so the two entry points never disagree.
const DIALOG_MIN = AUTO_COMPACT_MIN;
const DIALOG_MAX = AUTO_COMPACT_MAX;
const DIALOG_STEP = AUTO_COMPACT_STEP;

/** Compact token count for the dialog readouts: 128000 → "128K". */
function toK(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
}

interface EditorProps {
  setting: AutoCompactSetting;
  /** Context window (tokens) for the "≈ NN K 토큰" estimate; omitted when unknown. */
  contextWindow?: number;
  /**
   * Card title. Callers that already sit under an "Auto-compact" heading take
   * the default; the model catalog names the feature here because the card is
   * the only place it appears there.
   */
  title?: string;
  onChange: (setting: AutoCompactSetting) => void;
}

/**
 * The auto-compact control body: a toggle ("자동 압축 사용") and — when on — a
 * threshold slider (50–95%, step 5) with a live readout and token estimate.
 * Controlled; reused by the threshold modal, the runtime modal, and settings.
 */
export function AutoCompactEditor({ setting, contextWindow, title = "임계치 초과 시 자동 압축", onChange }: EditorProps) {
  const tokens = thresholdTokens(setting.at, contextWindow);
  // The number field keeps its own raw text while typing, committing (clamped
  // into the settable band) on blur / Enter — so a partial value like "1" isn't
  // snapped to the minimum mid-keystroke.
  const [atText, setAtText] = useState(String(setting.at));
  useEffect(() => setAtText(String(setting.at)), [setting.at]);
  const commitAt = (raw: string | number) => {
    const clamped = clampAutoCompactAt(raw);
    setAtText(String(clamped));
    onChange({ ...setting, at: clamped });
  };

  // Full 0–100% gauge: the fill (10 → value) is live-tinted; the two ends
  // (0–10, 95–100) are painted as blocked zones so it's visible WHY the thumb
  // won't go there.
  const track = `linear-gradient(90deg,
    var(--danger-dim) 0 ${AUTO_COMPACT_FLOOR}%,
    var(--live) ${AUTO_COMPACT_FLOOR}% ${setting.at}%,
    var(--bg-4) ${setting.at}% ${AUTO_COMPACT_CEIL}%,
    var(--danger-dim) ${AUTO_COMPACT_CEIL}% 100%)`;

  return (
    <div className="wb-compact-editor">
      <label className="wb-toggle-card">
        <span className="wb-toggle-text">
          <ChevronsDownUp size={17} />
          <span><strong>{title}</strong><small><LocalizedText id="STR-1529" /></small></span>
        </span>
        <input
          type="checkbox"
          className="wb-switch"
          checked={setting.on}
          onChange={(event) => onChange({ ...setting, on: event.target.checked })}
        />
      </label>
      {setting.on && (
        <div className="wb-compact-slider">
          <div className="wb-compact-readout">
            <span><LocalizedText id="STR-1530" /></span>
            <span className="wb-compact-num">
              <input
                type="number"
                className="wb-compact-input wb-mono"
                min={AUTO_COMPACT_MIN}
                max={AUTO_COMPACT_MAX}
                step={AUTO_COMPACT_STEP}
                value={atText}
                onChange={(event) => setAtText(event.target.value)}
                onBlur={(event) => commitAt(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              />
              <span className="wb-mono">%</span>
            </span>
            {tokens != null && <span className="wb-mono wb-compact-tokens">≈ {Math.round(tokens / 1000)}<LocalizedText id="STR-1531" /></span>}
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
          <div className="wb-compact-ends wb-mono">
            <span>{AUTO_COMPACT_GAUGE_MIN}%</span>
            <span>{AUTO_COMPACT_GAUGE_MAX}%</span>
          </div>
          <div className="wb-compact-limit">{AUTO_COMPACT_FLOOR}<LocalizedText id="STR-1532" /> {AUTO_COMPACT_CEIL}<LocalizedText id="STR-1533" /></div>
        </div>
      )}
    </div>
  );
}

interface ModalProps {
  view: MemberView;
  actions: WorkbenchActions;
  onClose: () => void;
}

/**
 * The Auto-compact dialog — the single entry point for compaction, opened by
 * clicking a member's context donut. It shows the live usage against the window,
 * an enable toggle, the threshold slider (only when enabled), and — in the footer
 * — "지금 압축 실행" (run a manual compaction now) beside "완료".
 *
 * Local state keeps the slider snappy; the persist (through the shared
 * party-action path) is debounced so a drag isn't a write storm. Edits apply live
 * to the member — "완료" just closes.
 */
export function CompactModal({ view, actions, onClose }: ModalProps) {
  useModalEscape(onClose);
  const [local, setLocal] = useState<AutoCompactSetting>(view.autoCompact);
  const persistTimer = useRef<ReturnType<typeof setTimeout>>();
  const contextWindow = thresholdWindowFor(view);

  // Reflect an out-of-band change (e.g. runtime modal) while this is open.
  useEffect(() => {
    setLocal(view.autoCompact);
  }, [view.autoCompact.on, view.autoCompact.at]);

  useEffect(() => () => { if (persistTimer.current) clearTimeout(persistTimer.current); }, []);

  function update(next: AutoCompactSetting) {
    setLocal(next);
    if (persistTimer.current) clearTimeout(persistTimer.current);
    // Toggles persist immediately (discrete); slider drags debounce.
    const delay = next.on === local.on ? 200 : 0;
    persistTimer.current = setTimeout(() => actions.setAutoCompact(view.name, next), delay);
  }

  // Live occupancy for the usage card. Unknown window → no ratio/bar (never a
  // fabricated denominator); the threshold token estimate falls back too.
  const used = view.context?.used ?? 0;
  const total = view.context?.total;
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : undefined;
  const usedCol = pct != null && pct >= 90 ? "var(--danger)" : pct != null && pct >= 75 ? "var(--live)" : view.color;
  const atTokens = thresholdTokens(local.at, contextWindow);

  function commitAt(value: number) {
    update({ ...local, at: Math.min(DIALOG_MAX, Math.max(DIALOG_MIN, value)) });
  }

  // Filled-left track: live up to the thumb, neutral after, over the 50–95 band.
  const atInBand = Math.min(DIALOG_MAX, Math.max(DIALOG_MIN, local.at));
  const fillPct = ((atInBand - DIALOG_MIN) / (DIALOG_MAX - DIALOG_MIN)) * 100;
  const dialogTrack = `linear-gradient(90deg, var(--live) 0 ${fillPct}%, var(--bg-4) ${fillPct}% 100%)`;

  // The scrim does not dismiss — closing is explicit (완료 / ✕), as in every
  // other modal in the app. A slider drag that ends outside the dialog used to
  // close it mid-adjustment.
  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-compact-dialog" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <FoldVertical size={16} className="wb-compact-glyph" />
            <strong>Auto-compact</strong>
            <span className="wb-modal-target" style={{ ["--member" as string]: view.color }}>
              <span className="wb-dot" /> {view.name}
            </span>
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-1534")} onClick={onClose}><X size={16} /></button>
        </header>

        <div className="wb-compact-body">
          {/* Current-usage card */}
          <div className="wb-compact-usage">
            <div className="wb-compact-usage-row">
              <span><LocalizedText id="STR-1535" /></span>
              <span className="wb-mono wb-compact-usage-val" style={{ color: usedCol }}>
                {total ? <>{toK(used)} / {toK(total)}<span className="wb-compact-usage-pct"> · {pct}%</span></> : <>{toK(used)}  <LocalizedText id="STR-1536" /></>}
              </span>
            </div>
            {total != null && pct != null && (
              <div className="wb-compact-usage-track">
                <span className="wb-compact-usage-fill" style={{ width: `${Math.max(2, pct)}%`, background: usedCol }} />
                {local.on && <span className="wb-compact-usage-th" style={{ left: `${local.at}%` }} />}
              </div>
            )}
            {local.on && total != null && (
              <div className="wb-mono wb-compact-usage-cap"><LocalizedText id="STR-1537" /></div>
            )}
          </div>

          {/* Enable toggle */}
          <label className="wb-toggle-card">
            <span className="wb-toggle-text">
              <ChevronsDownUp size={15} />
              <span><strong><LocalizedText id="STR-1539" /></strong><small><LocalizedText id="STR-1538" /></small></span>
            </span>
            <input
              type="checkbox"
              className="wb-switch"
              checked={local.on}
              onChange={(event) => update({ ...local, on: event.target.checked })}
            />
          </label>

          {/* Threshold slider (only when enabled) */}
          {local.on && (
            <div className="wb-compact-thcard">
              <div className="wb-compact-readout">
                <span><LocalizedText id="STR-1540" /></span>
                <strong className="wb-mono wb-compact-thval">
                  {local.at}%{atTokens != null && <span className="wb-compact-thtokens"> · ≈ {toK(atTokens)}  <LocalizedText id="STR-1541" /></span>}
                </strong>
              </div>
              <input
                type="range"
                className="wb-compact-range"
                min={DIALOG_MIN}
                max={DIALOG_MAX}
                step={DIALOG_STEP}
                value={atInBand}
                style={{ background: dialogTrack }}
                onChange={(event) => commitAt(Number(event.target.value))}
              />
              <div className="wb-compact-ends wb-mono">
                <span>{DIALOG_MIN}%</span>
                <span>{DIALOG_MAX}%</span>
              </div>
            </div>
          )}
        </div>

        <footer className="wb-compact-foot">
          <button
            type="button"
            className="wb-btn wb-compact-run-now"
            disabled={!view.session || view.compacting}
            onClick={() => { actions.compact(view.name); onClose(); }}
          >
            <FoldVertical size={14} className={"wb-compact-glyph" + (view.compacting ? " wb-spin" : "")} />  <LocalizedText id="STR-1542" />
          </button>
          <button type="button" className="wb-btn wb-btn-accent" onClick={onClose}><LocalizedText id="STR-1543" /></button>
        </footer>
      </div>
    </div>
  );
}
