import { useState } from "react";
import { ChevronLeft, Clock, Pencil, Undo2, X } from "lucide-react";
import type { MemberView } from "./types";
import type { RouteLike } from "./routes";
import { GateReviewerInlineControl } from "./GateReviewerControl";
import { MessageGateIcon } from "./MessageGateIcon";
import {
  effectiveGate,
  type GateAxis,
  type GateMode,
  type GateReviewer,
  type MemberGateOverride,
  type MemberGateUpdate,
  type PartyGate,
} from "../../shared/messageGate";
import { LocalizedText, localized } from "../i18n/I18nProvider";
import { useModalEscape } from "./useModalEscape";

interface MessageGateModalProps {
  view: MemberView;
  routes: RouteLike[];
  partyGate?: PartyGate;
  gateDefaults: GateReviewer;
  onApply: (patch: MemberGateUpdate) => void;
  onBack?: () => void;
  onClose: () => void;
}

const MODE_OPTIONS: Array<{ id: GateMode; label: string }> = [
  { id: "inherit", label: localized("STR-3860") },
  { id: "on", label: "On" },
  { id: "off", label: "Off" },
];

const AXES: Array<{ id: GateAxis; label: "STR-3828" | "STR-3830"; hint: "STR-3829" | "STR-3831" }> = [
  { id: "send", label: "STR-3828", hint: "STR-3829" },
  { id: "recv", label: "STR-3830", hint: "STR-3831" },
];

interface AxisDraft { mode: GateMode; ruleSet: boolean; text: string; reviewerSet: boolean; reviewer: GateReviewer }

function draftOf(axis: GateAxis, gate: MemberGateOverride | undefined, party: PartyGate | undefined, defaults: GateReviewer): AxisDraft {
  const own = gate?.[axis];
  const partyAxis = party?.[axis] ?? { enabled: false, rule: "" };
  return {
    mode: own?.mode ?? "inherit",
    ruleSet: typeof own?.rule === "string",
    text: typeof own?.rule === "string" ? own.rule : partyAxis.rule,
    reviewerSet: Boolean(own?.reviewer),
    reviewer: own?.reviewer ?? partyAxis.reviewer ?? defaults,
  };
}

export function MessageGateModal({ view, routes, partyGate, gateDefaults, onApply, onBack, onClose }: MessageGateModalProps) {
  useModalEscape(onClose);
  const stored = view.member.gate;
  const [axis, setAxis] = useState<GateAxis>("send");
  const [drafts, setDrafts] = useState<Record<GateAxis, AxisDraft>>(() => ({
    send: draftOf("send", stored, partyGate, gateDefaults),
    recv: draftOf("recv", stored, partyGate, gateDefaults),
  }));

  const draft = drafts[axis];
  const partyAxis = partyGate?.[axis] ?? { enabled: false, rule: "" };
  const overridden = draft.ruleSet;
  const effectivelyOn = draft.mode === "on" || (draft.mode === "inherit" && partyAxis.enabled);
  const emptyWhileOn = effectivelyOn && draft.text.trim().length === 0;
  const rulePlaceholder = axis === "send" ? localized("STR-3836") : localized("STR-3837");

  function patch(next: Partial<AxisDraft>) {
    setDrafts((current) => ({ ...current, [axis]: { ...current[axis], ...next } }));
  }

  function changed(id: GateAxis): boolean {
    const value = drafts[id];
    const storedValue = stored?.[id];
    return value.mode !== (storedValue?.mode ?? "inherit")
      || value.ruleSet !== (typeof storedValue?.rule === "string")
      || (value.ruleSet && value.text !== (storedValue?.rule ?? ""))
      || value.reviewerSet !== Boolean(storedValue?.reviewer)
      || (value.reviewerSet && (
        value.reviewer.model !== storedValue?.reviewer?.model
        || value.reviewer.effort !== storedValue?.reviewer?.effort
        || value.reviewer.serviceTier !== storedValue?.reviewer?.serviceTier
      ));
  }

  const dirty = changed("send") || changed("recv");

  function apply() {
    const update: MemberGateOverride = {};
    for (const id of ["send", "recv"] as const) {
      const value = drafts[id];
      update[id] = {
        mode: value.mode,
        rule: value.ruleSet ? value.text : null,
        reviewer: value.reviewerSet ? value.reviewer : null,
      };
    }
    onApply(update);
    onClose();
  }

  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-gate-modal wb-gate-rule-first" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            {onBack && <button type="button" className="wb-icon-btn" title={localized("STR-3864")} aria-label={localized("STR-3864")} onClick={onBack}><ChevronLeft size={16} /></button>}
            <MessageGateIcon size={16} className="wb-gate-accent" />
            <strong><LocalizedText id="STR-1786" /></strong>
            <span className="wb-modal-target" style={{ ["--member" as string]: view.color }}>
              <span className="wb-dot" /> <span className="wb-mono">{view.name} <LocalizedText id="STR-3832" /></span>
            </span>
            {overridden && <span className="wb-gate-overridden"><Pencil size={11} /> Overridden</span>}
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-1788")} onClick={onClose}><X size={16} /></button>
        </header>

        <div className="wb-gate-axis-tabs" role="tablist" aria-label={localized("STR-3833")}>
          {AXES.map((item) => (
            <button type="button" role="tab" key={item.id} aria-selected={item.id === axis} className={"wb-gate-axis-tab" + (item.id === axis ? " is-on" : "")} onClick={() => setAxis(item.id)}>
              <LocalizedText id={item.label} /><small><LocalizedText id={item.hint} /></small>
            </button>
          ))}
        </div>

        <div className="wb-modal-body wb-gate-modal-body">
          <div className="wb-gate-mode-row">
            <div className="wb-segmented wb-gate-mode">
              {MODE_OPTIONS.map((option) => (
                <button type="button" key={option.id} className={"wb-segment" + (option.id === draft.mode ? " is-active" : "") + (option.id === "off" && draft.mode === "off" ? " is-off" : "")} onClick={() => patch({ mode: option.id })}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="wb-gate-block wb-gate-rule-block">
            <div className="wb-gate-block-head">
              <strong><LocalizedText id="STR-1793" /></strong>
              <span className="wb-flex-spacer" />
              {overridden && <button type="button" className="wb-gate-reset" onClick={() => patch({ ruleSet: false, text: partyAxis.rule })}><Undo2 size={12} /> <LocalizedText id="STR-3862" /></button>}
            </div>
            <textarea className="wb-gate-textarea" value={draft.text} disabled={draft.mode === "inherit"} placeholder={rulePlaceholder} onChange={(event) => patch({ text: event.target.value, ruleSet: true })} />
            {emptyWhileOn && <div className="wb-gate-warn"><LocalizedText id="STR-1798" /> <b><LocalizedText id="STR-1799" /></b>. <LocalizedText id="STR-3838" /></div>}
            {!effectivelyOn && <div className="wb-gate-note"><LocalizedText id={axis === "send" ? "STR-3839" : "STR-3840"} /></div>}
          </div>

          <GateReviewerInlineControl
            routes={routes}
            reviewer={draft.reviewer}
            defaultReviewer={partyAxis.reviewer ?? gateDefaults}
            inherited={!draft.reviewerSet}
            onChange={(reviewer) => patch({ reviewerSet: true, reviewer })}
            onInherit={() => patch({ reviewerSet: false, reviewer: partyAxis.reviewer ?? gateDefaults })}
          />
        </div>

        <footer className="wb-modal-foot">
          <span className={"wb-dirty-note" + (dirty ? " is-dirty" : "")}>{dirty ? <><Clock size={12} /> <LocalizedText id="STR-3844" /></> : <LocalizedText id="STR-1805" />}</span>
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-ghost" onClick={onClose}><LocalizedText id="STR-1807" /></button>
            <button type="button" className="wb-btn wb-btn-accent" disabled={!dirty} onClick={apply}><LocalizedText id="STR-1808" /></button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function memberGateSummary(axis: GateAxis, gate: MemberGateOverride | undefined, partyGate: PartyGate | undefined, gateDefaults: GateReviewer) {
  return effectiveGate(axis, gate, partyGate, gateDefaults);
}
