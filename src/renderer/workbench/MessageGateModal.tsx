import { useMemo, useState } from "react";
import { ChevronDown, Clock, Pencil, Undo2, X } from "lucide-react";
import type { MemberView } from "./types";
import type { RouteLike } from "./routes";
import { ModelCatalogModal } from "./ModelCatalogModal";
import { MessageGateIcon } from "./MessageGateIcon";
import { effectiveGate, type GateMode, type GateReviewer, type MemberGateOverride, type PartyGate } from "../../shared/messageGate";

interface MessageGateModalProps {
  view: MemberView;
  routes: RouteLike[];
  /** The party gate this member inherits (undefined = off, no rule). */
  partyGate?: PartyGate;
  /** Settings reviewer default used when the member sets no reviewer. */
  gateDefaults: GateReviewer;
  onApply: (patch: MemberGateOverride) => void;
  onClose: () => void;
}

const MODE_OPTIONS: Array<{ id: GateMode; label: string }> = [
  { id: "inherit", label: "Inherit" },
  { id: "on", label: "On" },
  { id: "off", label: "Off" },
];

/**
 * Per-member Message Gate editor (separate modal from Runtime). Staged: changes
 * apply on Apply; Cancel/✕ discards. Closes ONLY via Cancel/✕ — never on an
 * outside/scrim click (staged edits must not be lost). The reviewer is headless
 * (model + effort only, no harness).
 */
export function MessageGateModal({ view, routes, partyGate, gateDefaults, onApply, onClose }: MessageGateModalProps) {
  const partyRule = partyGate?.rule ?? "";
  const partyOn = Boolean(partyGate?.enabled);
  const gate = view.member.gate;

  const [mode, setMode] = useState<GateMode>(gate?.mode ?? "inherit");
  // Prefilled with the party rule unless the member overrides it.
  const initialText = typeof gate?.rule === "string" ? gate.rule : partyRule;
  const [text, setText] = useState(initialText);
  const [reviewerSet, setReviewerSet] = useState(Boolean(gate?.reviewer));
  const [reviewer, setReviewer] = useState<GateReviewer>(gate?.reviewer ?? gateDefaults);
  const [catalogOpen, setCatalogOpen] = useState(false);

  // One route per catalog model (a model is reachable from both harnesses; the
  // reviewer is headless so harness is irrelevant — dedupe, prefer claude-code).
  const uniqueRoutes = useMemo<RouteLike[]>(() => {
    const byModel = new Map<string, RouteLike>();
    for (const route of routes) {
      const existing = byModel.get(route.model);
      if (!existing || (route.harnessId || "claude-code") === "claude-code") {
        byModel.set(route.model, route);
      }
    }
    return Array.from(byModel.values());
  }, [routes]);

  const overridden = text !== partyRule;
  const effectivelyOn = mode === "on" || (mode === "inherit" && partyOn);
  const effectivelyOff = !effectivelyOn;
  const emptyWhileOn = effectivelyOn && text.trim().length === 0;

  const dirty =
    mode !== (gate?.mode ?? "inherit") ||
    overridden !== (typeof gate?.rule === "string") ||
    (overridden && text !== (gate?.rule ?? "")) ||
    reviewerSet !== Boolean(gate?.reviewer) ||
    (reviewerSet && (reviewer.model !== (gate?.reviewer?.model ?? gateDefaults.model) || reviewer.effort !== (gate?.reviewer?.effort ?? gateDefaults.effort)));

  function resetToParty() {
    setText(partyRule);
  }

  function apply() {
    onApply({
      mode,
      // Not-overridden (equals the party rule) → inherit (null).
      rule: overridden ? text : null,
      reviewer: reviewerSet ? reviewer : null,
    });
    onClose();
  }


  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-gate-modal" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <MessageGateIcon size={16} className="wb-gate-accent" />
            <strong>Message Gate</strong>
            <span className="wb-modal-target" style={{ ["--member" as string]: view.color }}>
              <span className="wb-dot" /> <span className="wb-mono">{view.name} · 메시지 전달 전 심사</span>
            </span>
            {overridden && <span className="wb-gate-overridden"><Pencil size={11} /> Overridden</span>}
          </div>
          <button type="button" className="wb-icon-btn" title="Close" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="wb-modal-body wb-gate-modal-body">
          <div className="wb-modal-label">on / off</div>
          <div className="wb-segmented wb-gate-mode">
            {MODE_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.id}
                className={"wb-segment" + (option.id === mode ? " is-active" : "") + (option.id === "off" && mode === "off" ? " is-off" : "")}
                onClick={() => setMode(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {mode === "inherit" && (
            <div className="wb-gate-caption">파티 기본값을 따릅니다 · 현재 <b className={partyOn ? "wb-gate-accent" : ""}>{partyOn ? "On" : "Off"}</b></div>
          )}

          <div className="wb-gate-block">
            <div className="wb-gate-block-head">
              <strong>통신 규칙</strong>
              <span className="wb-gate-hint">리뷰어가 이 규칙으로 심사합니다</span>
              <span className="wb-flex-spacer" />
              {overridden && (
                <button type="button" className="wb-gate-reset" onClick={resetToParty} title="파티 전역 규칙으로 되돌립니다">
                  <Undo2 size={12} /> 전역 규칙으로 되돌리기
                </button>
              )}
            </div>
            <textarea
              className="wb-gate-textarea"
              rows={4}
              value={text}
              placeholder="예: 간결하게 보내세요. 오케스트레이터를 거치지 말고 담당 멤버에게 직접 소통하세요."
              onChange={(event) => setText(event.target.value)}
            />
            {emptyWhileOn && (
              <div className="wb-gate-warn">규칙이 비어 있어 <b>심사가 실행되지 않습니다</b>. 게이트는 켜져 있지만 모든 메시지가 그대로 배달됩니다.</div>
            )}
            {effectivelyOff && (
              <div className="wb-gate-note">게이트가 꺼져 있어 이 멤버의 메시지는 심사 없이 배달됩니다.</div>
            )}
          </div>

          <div className="wb-gate-block">
            <label className="wb-gate-toggle-row">
              <span className="wb-gate-toggle-text">
                <strong>리뷰어 모델 지정</strong>
                <small>끄면 설정 → Runtime의 게이트 기본 모델을 사용합니다.</small>
              </span>
              <input type="checkbox" className="wb-switch" checked={reviewerSet} onChange={(event) => setReviewerSet(event.target.checked)} />
            </label>
            {!reviewerSet ? (
              <div className="wb-gate-default-chip wb-mono">설정 기본값 사용 · {gateDefaults.model} · {gateDefaults.effort}</div>
            ) : (
              <button type="button" className="wb-model-picker-trigger" onClick={() => setCatalogOpen(true)}>
                <span className="wb-mono">{reviewer.model} · {reviewer.effort}</span>
                <ChevronDown size={14} />
              </button>
            )}
          </div>
        </div>

        <footer className="wb-modal-foot">
          <span className={"wb-dirty-note" + (dirty ? " is-dirty" : "")}>
            {dirty ? <><Clock size={12} /> 변경됨 — Apply 시 적용됩니다</> : "변경 사항 없음"}
          </span>
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="wb-btn wb-btn-accent" disabled={!dirty} onClick={apply}>Apply</button>
          </div>
        </footer>
      </div>

      {catalogOpen && (
        <ModelCatalogModal
          title="리뷰어 모델"
          icon={<MessageGateIcon size={16} className="wb-gate-accent" />}
          subtitle={<span className="wb-mono wb-modal-sub">헤드리스 · {view.name}</span>}
          routes={uniqueRoutes}
          value={{ model: reviewer.model, effort: reviewer.effort }}
          config={{ effort: true }}
          applyLabel="선택"
          onApply={(next) => setReviewer({ model: next.model, effort: next.effort || reviewer.effort })}
          onClose={() => setCatalogOpen(false)}
        />
      )}
    </div>
  );
}

/** Effective gate summary for read-only surfaces (party manager rows). */
export function memberGateSummary(gate: MemberGateOverride | undefined, partyGate: PartyGate | undefined, gateDefaults: GateReviewer) {
  return effectiveGate(gate, partyGate, gateDefaults);
}
