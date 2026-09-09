import { useState } from "react";
import { Clock, Pencil, Undo2, X } from "lucide-react";
import type { MemberView } from "./types";
import type { RouteLike } from "./routes";
import { GateReviewerControl } from "./GateReviewerControl";
import { MessageGateIcon } from "./MessageGateIcon";
import { effectiveGate, type GateMode, type GateReviewer, type MemberGateOverride, type PartyGate } from "../../shared/messageGate";
import { LocalizedText, localized } from "../i18n/I18nProvider";
import { useModalEscape } from "./useModalEscape";

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
  useModalEscape(onClose);
  const partyRule = partyGate?.rule ?? "";
  const partyOn = Boolean(partyGate?.enabled);
  const gate = view.member.gate;

  const [mode, setMode] = useState<GateMode>(gate?.mode ?? "inherit");
  // Prefilled with the party rule unless the member overrides it.
  const initialText = typeof gate?.rule === "string" ? gate.rule : partyRule;
  const [text, setText] = useState(initialText);
  const [reviewerSet, setReviewerSet] = useState(Boolean(gate?.reviewer));
  const [reviewer, setReviewer] = useState<GateReviewer>(gate?.reviewer ?? gateDefaults);

  // One route per catalog model (a model is reachable from both harnesses; the
  // reviewer is headless so harness is irrelevant — dedupe, prefer claude-code).

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
            <strong><LocalizedText id="STR-1786" /></strong>
            <span className="wb-modal-target" style={{ ["--member" as string]: view.color }}>
              <span className="wb-dot" /> <span className="wb-mono">{view.name}  <LocalizedText id="STR-1787" /></span>
            </span>
            {overridden && <span className="wb-gate-overridden"><Pencil size={11} /> Overridden</span>}
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-1788")} onClick={onClose}><X size={16} /></button>
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
            <div className="wb-gate-caption"><LocalizedText id="STR-1790" /> <b className={partyOn ? "wb-gate-accent" : ""}>{partyOn ? "On" : "Off"}</b></div>
          )}

          <div className="wb-gate-block">
            <div className="wb-gate-block-head">
              <strong><LocalizedText id="STR-1793" /></strong>
              <span className="wb-gate-hint"><LocalizedText id="STR-1794" /></span>
              <span className="wb-flex-spacer" />
              {overridden && (
                <button type="button" className="wb-gate-reset" onClick={resetToParty} title={localized("STR-1795")}>
                  <Undo2 size={12} />  <LocalizedText id="STR-1796" />
                </button>
              )}
            </div>
            <textarea
              className="wb-gate-textarea"
              rows={4}
              value={text}
              placeholder={localized("STR-1797")}
              onChange={(event) => setText(event.target.value)}
            />
            {emptyWhileOn && (
              <div className="wb-gate-warn"><LocalizedText id="STR-1798" /> <b><LocalizedText id="STR-1799" /></b>. 게이트는 켜져 있지만 모든 메시지가 그대로 전송됩니다.</div>
            )}
            {effectivelyOff && (
              <div className="wb-gate-note"><LocalizedText id="STR-1800" /></div>
            )}
          </div>

          <div className="wb-gate-block">
            <label className="wb-gate-toggle-row">
              <span className="wb-gate-toggle-text">
                <strong><LocalizedText id="STR-1801" /></strong>
                <small><LocalizedText id="STR-1802" /></small>
              </span>
              <input type="checkbox" className="wb-switch" checked={reviewerSet} onChange={(event) => setReviewerSet(event.target.checked)} />
            </label>
            {!reviewerSet ? (
              <div className="wb-gate-default-chip wb-mono"><LocalizedText id="STR-1803" /> {gateDefaults.model} · {gateDefaults.effort}</div>
            ) : (
              <GateReviewerControl routes={routes} reviewer={reviewer} onChange={setReviewer} modelLabel="모델" effortLabel="effort" />
            )}
          </div>
        </div>

        <footer className="wb-modal-foot">
          <span className={"wb-dirty-note" + (dirty ? " is-dirty" : "")}>
            {dirty ? <><Clock size={12} />  <LocalizedText id="STR-1806" /></> : "변경 사항 없음"}
          </span>
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-ghost" onClick={onClose}><LocalizedText id="STR-1807" /></button>
            <button type="button" className="wb-btn wb-btn-accent" disabled={!dirty} onClick={apply}><LocalizedText id="STR-1808" /></button>
          </div>
        </footer>
      </div>

    </div>
  );
}

/** Effective gate summary for read-only surfaces (party manager rows). */
export function memberGateSummary(gate: MemberGateOverride | undefined, partyGate: PartyGate | undefined, gateDefaults: GateReviewer) {
  return effectiveGate(gate, partyGate, gateDefaults);
}
