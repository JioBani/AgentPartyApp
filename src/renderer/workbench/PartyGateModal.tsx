import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { MemberView } from "./types";
import type { PartyDefinition } from "../../shared/types";
import { MessageGateIcon } from "./MessageGateIcon";
import { effectiveGate, type GateMode, type GateReviewer, type PartyGate } from "../../shared/messageGate";

interface PartyGateModalProps {
  party: PartyDefinition;
  members: MemberView[];
  gateDefaults: GateReviewer;
  onSetPartyGate: (gate: PartyGate) => void;
  onSetMemberGate: (name: string, mode: GateMode) => void;
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
export function PartyGateModal({ party, members, gateDefaults, onSetPartyGate, onSetMemberGate, onOpenMemberGate, onClose }: PartyGateModalProps) {
  const partyGate: PartyGate = party.gate ?? { enabled: false, rule: "" };
  const [enabled, setEnabled] = useState(partyGate.enabled);
  const [rule, setRule] = useState(partyGate.rule);

  // Reflect external updates (another window/agent edited the party gate).
  useEffect(() => {
    setEnabled(party.gate?.enabled ?? false);
    setRule(party.gate?.rule ?? "");
  }, [party.gate?.enabled, party.gate?.rule]);

  const effectiveParty: PartyGate = { enabled, rule };
  const onCount = members.filter((view) => effectiveGate(view.member.gate, effectiveParty, gateDefaults).enabled).length;

  function toggleEnabled(next: boolean) {
    setEnabled(next);
    onSetPartyGate({ enabled: next, rule });
  }
  function commitRule() {
    if (rule !== (party.gate?.rule ?? "")) {
      onSetPartyGate({ enabled, rule });
    }
  }

  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-gate-modal wb-party-gate-modal" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <MessageGateIcon size={16} className="wb-gate-accent" />
            <strong>Message Gate</strong>
            <span className="wb-mono wb-modal-sub">파티 전역 · {party.name}</span>
            <span className="wb-flex-spacer" />
            <span className="wb-gate-status-chip">{onCount} / {members.length}명 심사 중</span>
          </div>
          <button type="button" className="wb-icon-btn" title="Close" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="wb-modal-body wb-gate-modal-body">
          <div className="wb-gate-block">
            <label className="wb-gate-toggle-row">
              <span className="wb-gate-toggle-text">
                <span className="wb-gate-tile"><MessageGateIcon size={17} /></span>
                <span>
                  <strong>파티 메시지 검문 기본값</strong>
                  <small>Inherit 상태인 멤버는 이 값을 따릅니다. 멤버가 On/Off로 직접 재정의할 수 있어요.</small>
                </span>
              </span>
              <input type="checkbox" className="wb-switch" checked={enabled} onChange={(event) => toggleEnabled(event.target.checked)} />
            </label>
            {enabled && (
              <>
                <div className="wb-modal-label">통신 규칙 · 전역</div>
                <textarea
                  className="wb-gate-textarea"
                  rows={4}
                  value={rule}
                  placeholder="예: 간결하게 보내세요. 오케스트레이터 round-trip보다 멤버 간 직접 메시지를 우선하세요."
                  onChange={(event) => setRule(event.target.value)}
                  onBlur={commitRule}
                />
                <div className="wb-gate-note">리뷰어 기본 모델 <span className="wb-mono">{gateDefaults.model} · {gateDefaults.effort}</span> · 설정 → Runtime에서 변경</div>
              </>
            )}
          </div>

          <div className="wb-gate-block">
            <div className="wb-gate-block-head">
              <strong>멤버별 상태</strong>
              <span className="wb-gate-hint wb-mono">Inherit / On / Off · 즉시 적용</span>
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
                      <span className={eff.overridden ? "wb-gate-accent-live" : ""}>{eff.overridden ? "오버라이드" : "전역 규칙"}</span>
                      <span className="wb-gate-member-reviewer">{view.member.gate?.reviewer ? view.member.gate.reviewer.model : `기본값 · ${gateDefaults.model}`}</span>
                    </span>
                    <button type="button" className="wb-btn wb-btn-ghost wb-gate-edit-btn" onClick={() => onOpenMemberGate(view.name)}>편집</button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <footer className="wb-modal-foot">
          <span className="wb-flex-spacer" />
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-accent" onClick={onClose}>완료</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
