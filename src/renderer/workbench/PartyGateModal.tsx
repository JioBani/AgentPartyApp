import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Undo2, X } from "lucide-react";
import type { MemberView } from "./types";
import type { PartyDefinition } from "../../shared/types";
import { MessageGateIcon } from "./MessageGateIcon";
import { GateReviewerInlineControl } from "./GateReviewerControl";
import type { RouteLike } from "./routes";
import {
  effectiveGate,
  type GateAxis,
  type GateMode,
  type GateReviewer,
  type PartyGate,
  type PartyGateAxis,
  type PartyGatePatch,
} from "../../shared/messageGate";
import { LocalizedText, localized } from "../i18n/I18nProvider";
import { useModalEscape } from "./useModalEscape";

interface PartyGateModalProps {
  party: PartyDefinition;
  members: MemberView[];
  routes: RouteLike[];
  gateDefaults: GateReviewer;
  defaultJevProvider: string;
  onSetPartyGate: (gate: PartyGatePatch) => void;
  onSetMemberGate: (name: string, axis: GateAxis, mode: GateMode) => void;
  onClearMemberRule: (name: string, axis: GateAxis) => void;
  onOpenMemberGate: (name: string) => void;
  onClose: () => void;
}

const MODE_OPTIONS: Array<{ id: GateMode; label: string }> = [
  { id: "inherit", label: localized("STR-3860") }, { id: "on", label: "On" }, { id: "off", label: "Off" },
];
const AXES: Array<{ id: GateAxis; label: "STR-3828" | "STR-3830"; hint: "STR-3845" | "STR-3846" }> = [
  { id: "send", label: "STR-3828", hint: "STR-3845" },
  { id: "recv", label: "STR-3830", hint: "STR-3846" },
];
const emptyAxis = (): PartyGateAxis => ({ enabled: false, rule: "" });

export function PartyGateModal({ party, members, routes, gateDefaults, defaultJevProvider, onSetPartyGate, onSetMemberGate, onClearMemberRule, onOpenMemberGate, onClose }: PartyGateModalProps) {
  useModalEscape(onClose);
  const [axis, setAxis] = useState<GateAxis>("send");
  const [draft, setDraft] = useState<PartyGate>(() => party.gate ?? { send: emptyAxis(), recv: emptyAxis() });
  const [listOpen, setListOpen] = useState(true);

  useEffect(() => {
    setDraft(party.gate ?? { send: emptyAxis(), recv: emptyAxis() });
  }, [party.gate]);

  const current = draft[axis];
  const onCount = members.filter((view) => effectiveGate(axis, view.member.gate, draft, gateDefaults).enabled).length;
  const rulePlaceholder = axis === "send" ? localized("STR-3852") : localized("STR-3853");

  function patchLocal(next: Partial<PartyGateAxis>) {
    setDraft((value) => ({ ...value, [axis]: { ...value[axis], ...next } }));
  }
  function commit(next: PartyGatePatch) {
    const { axis: _ignored, ...axisPatch } = next;
    patchLocal({ ...axisPatch, reviewer: axisPatch.reviewer === null ? undefined : axisPatch.reviewer });
    onSetPartyGate({ axis, ...next });
  }

  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-gate-modal wb-party-gate-modal wb-gate-rule-first" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <MessageGateIcon size={16} className="wb-gate-accent" /><strong><LocalizedText id="STR-1984" /></strong>
            <span className="wb-mono wb-modal-sub"><LocalizedText id="STR-1985" /> {party.name}</span><span className="wb-flex-spacer" />
            <span className="wb-gate-status-chip">{onCount} / {members.length}<LocalizedText id="STR-1986" /></span>
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-1987")} onClick={onClose}><X size={16} /></button>
        </header>

        <div className="wb-gate-axis-tabs" role="tablist" aria-label={localized("STR-3833")}>
          {AXES.map((item) => <button type="button" role="tab" key={item.id} aria-selected={item.id === axis} className={"wb-gate-axis-tab" + (item.id === axis ? " is-on" : "")} onClick={() => setAxis(item.id)}><LocalizedText id={item.label} /><small><LocalizedText id={item.hint} /></small></button>)}
        </div>

        <div className="wb-modal-body wb-gate-modal-body">
          <div className={"wb-gate-block" + (current.enabled ? " wb-gate-rule-block" : "")}>
            <label className="wb-gate-toggle-row">
              <span className="wb-gate-toggle-text"><span className="wb-gate-tile"><MessageGateIcon size={17} /></span><span><strong><LocalizedText id={axis === "send" ? "STR-3847" : "STR-3848"} /></strong><small><LocalizedText id="STR-3849" /></small></span></span>
              <input type="checkbox" className="wb-switch" checked={current.enabled} onChange={(event) => commit({ enabled: event.target.checked })} />
            </label>
            {current.enabled && <>
              <textarea className="wb-gate-textarea" value={current.rule} placeholder={rulePlaceholder} onChange={(event) => patchLocal({ rule: event.target.value })} onBlur={() => onSetPartyGate({ axis, rule: current.rule })} />
              <GateReviewerInlineControl
                key={axis}
                routes={routes}
                reviewer={current.reviewer ?? gateDefaults}
                defaultReviewer={gateDefaults}
                defaultJevProvider={defaultJevProvider}
                inherited={!current.reviewer}
                onChange={(reviewer) => commit({ reviewer })}
                onInherit={() => commit({ reviewer: null })}
              />
            </>}
          </div>

          <div className={"wb-gate-block wb-gate-list-block" + (listOpen ? " is-open" : "")}>
            <button type="button" className="wb-gate-block-head wb-gate-list-toggle" aria-expanded={listOpen} onClick={() => setListOpen((value) => !value)}>
              {listOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <strong><LocalizedText id="STR-1996" /></strong>
              <span className="wb-gate-hint wb-mono">{onCount} / {members.length}</span>
              <span className="wb-flex-spacer" />
              <span className="wb-gate-hint wb-mono"><LocalizedText id="STR-1997" /></span>
            </button>
            {listOpen && <div className="wb-gate-member-list">
              {members.map((view) => {
                const eff = effectiveGate(axis, view.member.gate, draft, gateDefaults);
                const own = view.member.gate?.[axis];
                const mode = own?.mode ?? "inherit";
                return <div className="wb-gate-member-row" key={view.name} style={{ ["--member" as string]: view.color }}>
                  <span className="wb-dot" /><span className="wb-gate-member-name">{view.name}</span>
                  <div className="wb-segmented wb-gate-inline-mode">{MODE_OPTIONS.map((option) => <button type="button" key={option.id} className={"wb-segment" + (option.id === mode ? " is-active" : "")} onClick={() => onSetMemberGate(view.name, axis, option.id)}>{option.label}</button>)}</div>
                  <span className={"wb-gate-member-chip" + (eff.enabled ? " is-on" : "")}><LocalizedText id={eff.enabled ? "STR-2000" : "STR-1999"} /></span>
                  <span className="wb-gate-member-meta wb-mono">
                    {eff.overridden ? <button type="button" className="wb-gate-accent-live wb-gate-clear-override" title={localized("STR-1795")} onClick={() => onClearMemberRule(view.name, axis)}><Undo2 size={10} /> <LocalizedText id="STR-2002" /></button> : <span><LocalizedText id="STR-2003" /></span>}
                    <span className="wb-gate-member-reviewer">{own?.reviewer ? own.reviewer.model : current.reviewer ? localized("STR-2004", [current.reviewer.model]) : localized("STR-2005", [gateDefaults.model])}</span>
                  </span>
                  <button type="button" className="wb-btn wb-btn-ghost wb-gate-edit-btn" onClick={() => onOpenMemberGate(view.name)}><LocalizedText id="STR-2006" /></button>
                </div>;
              })}
            </div>}
          </div>
        </div>
        <footer className="wb-modal-foot"><span className="wb-flex-spacer" /><div className="wb-modal-actions"><button type="button" className="wb-btn wb-btn-accent" onClick={onClose}><LocalizedText id="STR-2007" /></button></div></footer>
      </div>
    </div>
  );
}
