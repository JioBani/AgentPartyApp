import { useEffect, useMemo, useState } from "react";
import { Undo2, X } from "lucide-react";
import type { MemberView } from "./types";
import type { PartyDefinition } from "../../shared/types";
import { MessageGateIcon } from "./MessageGateIcon";
import { GateReviewerControl } from "./GateReviewerControl";
import type { RouteLike } from "./routes";
import { effectiveGate, type GateMode, type GateReviewer, type PartyGate } from "../../shared/messageGate";
import { LocalizedText, localized } from "../i18n/I18nProvider";

interface PartyGateModalProps {
  party: PartyDefinition;
  members: MemberView[];
  routes: RouteLike[];
  gateDefaults: GateReviewer;
  onSetPartyGate: (gate: PartyGate) => void;
  onSetMemberGate: (name: string, mode: GateMode) => void;
  /** Drops a member's rule override so it follows the party rule again. */
  onClearMemberRule: (name: string) => void;
  onOpenMemberGate: (name: string) => void;
  onClose: () => void;
}

const MODE_OPTIONS: Array<{ id: GateMode; label: string }> = [
  { id: "inherit", label: "Inherit" },
  { id: "on", label: "On" },
  { id: "off", label: "Off" },
];

/**
 * Party-wide Message Gate manager: edits the party default (enablement + rule)
 * and shows every member's effective gate with an inline 3-state override. Party
 * rule edits + member mode toggles apply immediately (live); the footer just
 * closes. Closes ONLY via 완료/✕ — never an outside click.
 */
export function PartyGateModal({ party, members, routes, gateDefaults, onSetPartyGate, onSetMemberGate, onClearMemberRule, onOpenMemberGate, onClose }: PartyGateModalProps) {
  const partyGate: PartyGate = party.gate ?? { enabled: false, rule: "" };
  const [enabled, setEnabled] = useState(partyGate.enabled);
  const [rule, setRule] = useState(partyGate.rule);
  const [reviewer, setReviewer] = useState<GateReviewer | undefined>(partyGate.reviewer);

  // Reflect external updates (another window/agent edited the party gate).
  useEffect(() => {
    setEnabled(party.gate?.enabled ?? false);
    setRule(party.gate?.rule ?? "");
    setReviewer(party.gate?.reviewer);
  }, [party.gate?.enabled, party.gate?.rule, party.gate?.reviewer?.model, party.gate?.reviewer?.effort]);

  // One route per catalog model — the reviewer is headless, so harness is
  // irrelevant; dedupe and prefer claude-code (mirrors the member modal).

  const effectiveParty: PartyGate = reviewer ? { enabled, rule, reviewer } : { enabled, rule };
  const onCount = members.filter((view) => effectiveGate(view.member.gate, effectiveParty, gateDefaults).enabled).length;

  /** Every commit sends the WHOLE gate, so one axis never drops another. */
  function commit(next: Partial<PartyGate>) {
    const merged: PartyGate = { enabled, rule, ...(reviewer ? { reviewer } : {}), ...next };
    onSetPartyGate(merged.reviewer ? merged : { enabled: merged.enabled, rule: merged.rule });
  }
  function toggleEnabled(next: boolean) {
    setEnabled(next);
    commit({ enabled: next });
  }
  function commitRule() {
    if (rule !== (party.gate?.rule ?? "")) {
      commit({ rule });
    }
  }
  function applyReviewer(next: GateReviewer | undefined) {
    setReviewer(next);
    const merged: PartyGate = { enabled, rule, ...(next ? { reviewer: next } : {}) };
    onSetPartyGate(merged);
  }

  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-gate-modal wb-party-gate-modal" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <MessageGateIcon size={16} className="wb-gate-accent" />
            <strong><LocalizedText id="STR-1984" /></strong>
            <span className="wb-mono wb-modal-sub"><LocalizedText id="STR-1985" /> {party.name}</span>
            <span className="wb-flex-spacer" />
            <span className="wb-gate-status-chip">{onCount} / {members.length}<LocalizedText id="STR-1986" /></span>
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-1987")} onClick={onClose}><X size={16} /></button>
        </header>

        <div className="wb-modal-body wb-gate-modal-body">
          <div className="wb-gate-block">
            <label className="wb-gate-toggle-row">
              <span className="wb-gate-toggle-text">
                <span className="wb-gate-tile"><MessageGateIcon size={17} /></span>
                <span>
                  <strong><LocalizedText id="STR-1988" /></strong>
                  <small><LocalizedText id="STR-1989" /></small>
                </span>
              </span>
              <input type="checkbox" className="wb-switch" checked={enabled} onChange={(event) => toggleEnabled(event.target.checked)} />
            </label>
            {enabled && (
              <>
                <div className="wb-modal-label"><LocalizedText id="STR-1990" /></div>
                <textarea
                  className="wb-gate-textarea"
                  rows={4}
                  value={rule}
                  placeholder={localized("STR-1991")}
                  onChange={(event) => setRule(event.target.value)}
                  onBlur={commitRule}
                />
              </>
            )}
          </div>

          {enabled && (
            <div className="wb-gate-block">
              <label className="wb-gate-toggle-row">
                <span className="wb-gate-toggle-text">
                  <strong><LocalizedText id="STR-1992" /></strong>
                  <small><LocalizedText id="STR-1993" /></small>
                </span>
                <input
                  type="checkbox"
                  className="wb-switch"
                  checked={Boolean(reviewer)}
                  onChange={(event) => applyReviewer(event.target.checked ? (reviewer ?? gateDefaults) : undefined)}
                />
              </label>
              {!reviewer ? (
                <div className="wb-gate-default-chip wb-mono"><LocalizedText id="STR-1994" /> {gateDefaults.model} · {gateDefaults.effort}</div>
              ) : (
                <GateReviewerControl routes={routes} reviewer={reviewer} onChange={applyReviewer} modelLabel="모델" effortLabel="effort" />
              )}
            </div>
          )}

          <div className="wb-gate-block">
            <div className="wb-gate-block-head">
              <strong><LocalizedText id="STR-1996" /></strong>
              <span className="wb-gate-hint wb-mono"><LocalizedText id="STR-1997" /></span>
            </div>
            <div className="wb-gate-member-list">
              {members.map((view) => {
                const eff = effectiveGate(view.member.gate, effectiveParty, gateDefaults);
                const mode: GateMode = view.member.gate?.mode ?? "inherit";
                return (
                  <div className="wb-gate-member-row" key={view.name} style={{ ["--member" as string]: view.color }}>
                    <span className="wb-dot" />
                    <span className="wb-gate-member-name">{view.name}</span>
                    <div className="wb-segmented wb-gate-inline-mode">
                      {MODE_OPTIONS.map((option) => (
                        <button
                          type="button"
                          key={option.id}
                          className={"wb-segment" + (option.id === mode ? " is-active" : "")}
                          onClick={() => onSetMemberGate(view.name, option.id)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <span className={"wb-gate-member-chip" + (eff.enabled ? " is-on" : "")}>{eff.enabled ? "심사함" : "심사 안 함"}</span>
                    <span className="wb-gate-member-meta wb-mono">
                      {eff.overridden ? (
                        // The mode buttons change enablement only, so a rule
                        // override outlives an Inherit click and the badge looks
                        // stuck. This is the way to actually drop it.
                        <button
                          type="button"
                          className="wb-gate-accent-live wb-gate-clear-override"
                          title={localized("STR-2001")}
                          onClick={() => onClearMemberRule(view.name)}
                        >
                          <Undo2 size={10} />  <LocalizedText id="STR-2002" />
                        </button>
                      ) : (
                        <span><LocalizedText id="STR-2003" /></span>
                      )}
                      <span className="wb-gate-member-reviewer">
                        {view.member.gate?.reviewer
                          ? view.member.gate.reviewer.model
                          : reviewer
                            ? `파티 · ${reviewer.model}`
                            : `기본값 · ${gateDefaults.model}`}
                      </span>
                    </span>
                    <button type="button" className="wb-btn wb-btn-ghost wb-gate-edit-btn" onClick={() => onOpenMemberGate(view.name)}><LocalizedText id="STR-2006" /></button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <footer className="wb-modal-foot">
          <span className="wb-flex-spacer" />
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-accent" onClick={onClose}><LocalizedText id="STR-2007" /></button>
          </div>
        </footer>
      </div>
    </div>
  );
}
