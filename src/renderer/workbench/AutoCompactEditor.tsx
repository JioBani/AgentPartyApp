import { useEffect, useRef, useState } from "react";
import { ChevronsDownUp, X } from "lucide-react";
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

interface EditorProps {
  setting: AutoCompactSetting;
  /** Context window (tokens) for the "≈ NN K 토큰" estimate; omitted when unknown. */
  contextWindow?: number;
  onChange: (setting: AutoCompactSetting) => void;
}

/**
 * The auto-compact control body: a toggle ("자동 압축 사용") and — when on — a
 * threshold slider (50–95%, step 5) with a live readout and token estimate.
 * Controlled; reused by the threshold modal, the runtime modal, and settings.
 */
export function AutoCompactEditor({ setting, contextWindow, onChange }: EditorProps) {
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
          <ChevronsDownUp size={15} />
          <span><strong>임계치 초과 시 자동 압축</strong><small>끄면 수동 압축만 사용합니다.</small></span>
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
            <span>압축 임계치 · 컨텍스트 사용률</span>
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
            {tokens != null && <span className="wb-mono wb-compact-tokens">≈ {Math.round(tokens / 1000)}K 토큰</span>}
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
          <div className="wb-compact-limit">{AUTO_COMPACT_FLOOR}% 미만 · {AUTO_COMPACT_CEIL}% 초과는 설정할 수 없습니다.</div>
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
 * The per-member threshold-edit modal, opened from the toolbar compact pill's
 * number half. Local state keeps the slider snappy; the persist (through the
 * party-action path) is debounced so a drag isn't a write storm. Edits apply
 * live to the member — "완료" just closes.
 */
export function CompactModal({ view, actions, onClose }: ModalProps) {
  const [local, setLocal] = useState<AutoCompactSetting>(view.autoCompact);
  const persistTimer = useRef<ReturnType<typeof setTimeout>>();
  const contextWindow = view.context?.total || view.member.lastContextWindow;

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

  return (
    <div className="wb-modal-scrim" onMouseDown={onClose}>
      <div className="wb-modal wb-modal-sm" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <ChevronsDownUp size={16} />
            <strong>Auto-compact</strong>
            <span className="wb-modal-target" style={{ ["--member" as string]: view.color }}>
              <span className="wb-dot" /> {view.name}
            </span>
          </div>
          <button type="button" className="wb-icon-btn" title="Close" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="wb-modal-body wb-modal-body-col">
          <AutoCompactEditor setting={local} contextWindow={contextWindow} onChange={update} />
        </div>
        <footer className="wb-modal-foot wb-modal-foot-end">
          <button type="button" className="wb-btn wb-btn-accent" onClick={onClose}>완료</button>
        </footer>
      </div>
    </div>
  );
}
