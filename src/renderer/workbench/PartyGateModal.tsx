import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Undo2, X } from "lucide-react";
import type { MemberView } from "./types";
import type { PartyDefinition } from "../../shared/types";
import { MessageGateIcon } from "./MessageGateIcon";
import { ModelCatalogModal } from "./ModelCatalogModal";
import type { RouteLike } from "./routes";
import { effectiveGate, type GateMode, type GateReviewer, type PartyGate } from "../../shared/messageGate";

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
  const [catalogOpen, setCatalogOpen] = useState(false);

  // Reflect external updates (another window/agent edited the party gate).
  useEffect(() => {
    setEnabled(party.gate?.enabled ?? false);
    setRule(party.gate?.rule ?? "");
    setReviewer(party.gate?.reviewer);
  }, [party.gate?.enabled, party.gate?.rule, party.gate?.reviewer?.model, party.gate?.reviewer?.effort]);

  // One route per catalog model — the reviewer is headless, so harness is
  // irrelevant; dedupe and prefer claude-code (mirrors the member modal).
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
                  <strong>파티 메시지 게이트 기본값</strong>
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
              </>
            )}
          </div>

          {enabled && (
            <div className="wb-gate-block">
              <label className="wb-gate-toggle-row">
                <span className="wb-gate-toggle-text">
                  <strong>리뷰어 모델 지정 · 파티 전역</strong>
                  <small>끄면 설정 → Runtime의 게이트 기본 모델을 사용합니다. 멤버가 따로 지정하면 그 값이 우선합니다.</small>
                </span>
                <input
                  type="checkbox"
                  className="wb-switch"
                  checked={Boolean(reviewer)}
                  onChange={(event) => applyReviewer(event.target.checked ? (reviewer ?? gateDefaults) : undefined)}
                />
              </label>
              {!reviewer ? (
                <div className="wb-gate-default-chip wb-mono">설정 기본값 사용 · {gateDefaults.model} · {gateDefaults.effort}</div>
              ) : (
                <button type="button" className="wb-model-picker-trigger" onClick={() => setCatalogOpen(true)}>
                  <span className="wb-mono">{reviewer.model} · {reviewer.effort}</span>
                  <ChevronDown size={14} />
                </button>
              )}
            </div>
          )}

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
                      {eff.overridden ? (
                        // The mode buttons change enablement only, so a rule
                        // override outlives an Inherit click and the badge looks
                        // stuck. This is the way to actually drop it.
                        <button
                          type="button"
                          className="wb-gate-accent-live wb-gate-clear-override"
                          title="이 멤버의 규칙 오버라이드를 지우고 전역 규칙을 따르게 합니다"
                          onClick={() => onClearMemberRule(view.name)}
                        >
                          <Undo2 size={10} /> 오버라이드
                        </button>
                      ) : (
                        <span>전역 규칙</span>
                      )}
                      <span className="wb-gate-member-reviewer">
                        {view.member.gate?.reviewer
                          ? view.member.gate.reviewer.model
                          : reviewer
                            ? `파티 · ${reviewer.model}`
                            : `기본값 · ${gateDefaults.model}`}
                      </span>
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

      {catalogOpen && (
        <ModelCatalogModal
          title="리뷰어 모델 · 파티 전역"
          icon={<MessageGateIcon size={16} className="wb-gate-accent" />}
          subtitle={<span className="wb-mono wb-modal-sub">헤드리스 · {party.name}</span>}
          routes={uniqueRoutes}
          value={{ model: (reviewer ?? gateDefaults).model, effort: (reviewer ?? gateDefaults).effort }}
          config={{ effort: true }}
          applyLabel="선택"
          onApply={(next) => applyReviewer({ model: next.model, effort: next.effort || (reviewer ?? gateDefaults).effort })}
          onClose={() => setCatalogOpen(false)}
        />
      )}
    </div>
  );
}
